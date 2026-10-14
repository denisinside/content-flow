BEGIN;
SET LOCAL search_path TO contextflow;

-- Repair only the dependency selection in the existing scoped purge function.
-- The root authorization, retention, lock, journal, trigger and grant contracts
-- remain those established by the prior additive migrations.
DO $$
DECLARE
  function_source text;
  original_acl pg_catalog.aclitem[];
  repaired_acl pg_catalog.aclitem[];
  original_security_definer boolean;
  repaired_security_definer boolean;
  original_config text[];
  repaired_config text[];
  previous_declarations text;
  replacement_declarations text;
  previous_block text;
  replacement_block text;
BEGIN
  function_source := pg_catalog.pg_get_functiondef(
    'contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure
  );
  SELECT p.proacl,p.prosecdef,p.proconfig
    INTO original_acl,original_security_definer,original_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid='contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure;

  previous_declarations := $previous$
DECLARE nullable_columns text; disabled_trigger record; pending_count integer; total_deleted integer:=0; changed integer; iteration integer:=0; ignored_fk_ids oid[]:='{}'; selected_fk oid;
$previous$;
  replacement_declarations := $replacement$
DECLARE nullable_columns text; disabled_trigger record; pending_count integer; total_deleted integer:=0; changed integer; iteration integer:=0; ignored_fk_ids oid[]:='{}'; selected_fk oid;
DECLARE parent_candidate record; fk_edge record; edge_match boolean; edge_blocked boolean; blocker_names text; child_scope_join text; parent_scope_join text;
$replacement$;
  IF pg_catalog.strpos(function_source, previous_declarations)=0
     OR pg_catalog.strpos(
       pg_catalog.substr(function_source,pg_catalog.strpos(function_source,previous_declarations)+pg_catalog.length(previous_declarations)),
       previous_declarations
     )>0 THEN
    RAISE EXCEPTION 'Project purge declarations changed; refusing live-dependency repair';
  END IF;
  function_source := pg_catalog.replace(function_source, previous_declarations, replacement_declarations);

  previous_block := $previous$
  LOOP
    iteration:=iteration+1;
    IF iteration>500 THEN RAISE EXCEPTION 'purge dependency walk did not converge' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_temp.m43_purge_targets) THEN EXIT; END IF;
    selected_table:=NULL;
    SELECT parent.name INTO selected_table FROM pg_temp.m43_purge_targets parent
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint fk JOIN pg_class child_rel ON child_rel.oid=fk.conrelid JOIN pg_namespace child_ns ON child_ns.oid=child_rel.relnamespace
      JOIN pg_temp.m43_purge_targets child ON child.name=child_rel.relname
      WHERE fk.contype='f' AND fk.confrelid=to_regclass(format('contextflow.%I',parent.name))
        AND child_ns.nspname='contextflow' AND child.name<>parent.name AND NOT fk.oid=ANY(ignored_fk_ids)
    ) ORDER BY parent.name LIMIT 1;
    IF selected_table IS NULL THEN
      -- Break only nullable references between tables inside the fixed allowlist; mandatory or external dependencies fail closed.
      SELECT child.name,string_agg(format('%I=NULL',a.attname),', ' ORDER BY ck.ord),fk.oid
        INTO selected_child,nullable_columns,selected_fk
      FROM pg_constraint fk
      JOIN pg_class child_rel ON child_rel.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=child_rel.relnamespace
      JOIN pg_temp.m43_purge_targets child ON child.name=child_rel.relname
      JOIN pg_class parent_rel ON parent_rel.oid=fk.confrelid
      JOIN pg_temp.m43_purge_targets parent ON parent.name=parent_rel.relname
      JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY ck(attnum,ord) ON true
      JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=ck.attnum
      WHERE fk.contype='f' AND ns.nspname='contextflow' AND child.name<>parent.name AND NOT a.attnotnull AND a.attname<>'projectId'
        AND NOT fk.oid=ANY(ignored_fk_ids)
      GROUP BY child.name,fk.oid ORDER BY child.name LIMIT 1;
      IF selected_child IS NULL THEN RAISE EXCEPTION 'purge graph has an unbreakable dependency' USING ERRCODE='55000'; END IF;
      IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_child) THEN
        EXECUTE format('UPDATE contextflow.%I SET %s WHERE "projectId"=$1',selected_child,nullable_columns) USING target_project;
      ELSE
        EXECUTE format('UPDATE contextflow.%I x SET %s FROM contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_child,nullable_columns) USING target_project;
      END IF;
      ignored_fk_ids:=array_append(ignored_fk_ids,selected_fk);
      CONTINUE;
    END IF;
    IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_table) THEN
      EXECUTE format('DELETE FROM contextflow.%I WHERE "projectId"=$1',selected_table) USING target_project;
    ELSE
      EXECUTE format('DELETE FROM contextflow.%I x USING contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_table) USING target_project;
    END IF;
    GET DIAGNOSTICS changed=ROW_COUNT; total_deleted:=total_deleted+changed;
    DELETE FROM pg_temp.m43_purge_targets WHERE name=selected_table;
  END LOOP;
$previous$;
  replacement_block := $replacement$
  LOOP
    iteration:=iteration+1;
    IF iteration>500 THEN RAISE EXCEPTION 'purge dependency walk did not converge' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_temp.m43_purge_targets) THEN EXIT; END IF;

    -- A catalog edge blocks deletion only when a real child row and its real
    -- parent row both belong to this selected Project graph.
    selected_table:=NULL;
    blocker_names:=NULL;
    FOR parent_candidate IN
      SELECT pt.name,pt.has_project_id
      FROM pg_temp.m43_purge_targets pt ORDER BY pt.name
    LOOP
      edge_blocked:=false;
      FOR fk_edge IN
        SELECT child.name AS child_name, parent.name AS parent_name, fk.conname,
          child.has_project_id AS child_has_project_id, parent.has_project_id AS parent_has_project_id,
          pg_catalog.string_agg(
            pg_catalog.format('c.%I = p.%I',ca.attname,pa.attname),
            ' AND ' ORDER BY ck.ord
          ) AS join_predicate
        FROM pg_catalog.pg_constraint fk
        JOIN pg_catalog.pg_class child_rel ON child_rel.oid=fk.conrelid
        JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid=child_rel.relnamespace
        JOIN pg_temp.m43_purge_targets child ON child.name=child_rel.relname
        JOIN pg_catalog.pg_class parent_rel ON parent_rel.oid=fk.confrelid
        JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid=parent_rel.relnamespace
        JOIN pg_temp.m43_purge_targets parent ON parent.name=parent_rel.relname
        JOIN LATERAL pg_catalog.unnest(fk.conkey) WITH ORDINALITY ck(attnum,ord) ON true
        JOIN LATERAL pg_catalog.unnest(fk.confkey) WITH ORDINALITY pk(attnum,ord) ON pk.ord=ck.ord
        JOIN pg_catalog.pg_attribute ca ON ca.attrelid=fk.conrelid AND ca.attnum=ck.attnum
        JOIN pg_catalog.pg_attribute pa ON pa.attrelid=fk.confrelid AND pa.attnum=pk.attnum
        WHERE fk.contype='f' AND child_ns.nspname='contextflow' AND parent_ns.nspname='contextflow'
          AND child.name<>parent.name AND parent.name=parent_candidate.name
        GROUP BY child.name,parent.name,fk.conname,child.has_project_id,parent.has_project_id
        ORDER BY child.name,fk.conname
      LOOP
        IF fk_edge.child_has_project_id THEN
          child_scope_join:='';
        ELSE
          child_scope_join:='JOIN contextflow."Job" cj ON cj."id"=c."jobId"';
        END IF;
        IF fk_edge.parent_has_project_id THEN
          parent_scope_join:='';
        ELSE
          parent_scope_join:='JOIN contextflow."Job" pj ON pj."id"=p."jobId"';
        END IF;
        IF fk_edge.child_has_project_id AND fk_edge.parent_has_project_id THEN
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM contextflow.%I c %s JOIN contextflow.%I p ON %s WHERE c."projectId"=$1 AND p."projectId"=$1)',
            fk_edge.child_name,child_scope_join,fk_edge.parent_name,fk_edge.join_predicate
          ) INTO edge_match USING target_project;
        ELSIF fk_edge.child_has_project_id THEN
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM contextflow.%I c %s JOIN contextflow.%I p ON %s %s WHERE c."projectId"=$1 AND pj."projectId"=$1)',
            fk_edge.child_name,child_scope_join,fk_edge.parent_name,fk_edge.join_predicate,parent_scope_join
          ) INTO edge_match USING target_project;
        ELSIF fk_edge.parent_has_project_id THEN
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM contextflow.%I c %s JOIN contextflow.%I p ON %s WHERE cj."projectId"=$1 AND p."projectId"=$1)',
            fk_edge.child_name,child_scope_join,fk_edge.parent_name,fk_edge.join_predicate
          ) INTO edge_match USING target_project;
        ELSE
          EXECUTE pg_catalog.format(
            'SELECT EXISTS (SELECT 1 FROM contextflow.%I c %s JOIN contextflow.%I p ON %s %s WHERE cj."projectId"=$1 AND pj."projectId"=$1)',
            fk_edge.child_name,child_scope_join,fk_edge.parent_name,fk_edge.join_predicate,parent_scope_join
          ) INTO edge_match USING target_project;
        END IF;
        IF edge_match THEN
          edge_blocked:=true;
          blocker_names:=concat_ws(', ',blocker_names,pg_catalog.format('%s->%s [%s]',fk_edge.child_name,fk_edge.parent_name,fk_edge.conname));
        END IF;
      END LOOP;
      IF NOT edge_blocked THEN
        selected_table:=parent_candidate.name;
        EXIT;
      END IF;
    END LOOP;

    IF selected_table IS NULL THEN
      RAISE EXCEPTION 'purge graph has live cyclic dependencies: %',coalesce(blocker_names,'unknown') USING ERRCODE='55000';
    END IF;
    IF (SELECT has_project_id FROM pg_temp.m43_purge_targets WHERE name=selected_table) THEN
      EXECUTE pg_catalog.format('DELETE FROM contextflow.%I WHERE "projectId"=$1',selected_table) USING target_project;
    ELSE
      EXECUTE pg_catalog.format('DELETE FROM contextflow.%I x USING contextflow."Job" j WHERE x."jobId"=j."id" AND j."projectId"=$1',selected_table) USING target_project;
    END IF;
    GET DIAGNOSTICS changed=ROW_COUNT; total_deleted:=total_deleted+changed;
    DELETE FROM pg_temp.m43_purge_targets WHERE name=selected_table;
  END LOOP;
$replacement$;
  IF pg_catalog.strpos(function_source, previous_block)=0
     OR pg_catalog.strpos(
       pg_catalog.substr(function_source,pg_catalog.strpos(function_source,previous_block)+pg_catalog.length(previous_block)),
       previous_block
     )>0 THEN
    RAISE EXCEPTION 'Project purge dependency walk changed; refusing live-dependency repair';
  END IF;
  function_source := pg_catalog.replace(function_source, previous_block, replacement_block);

  previous_block := $previous$  UPDATE contextflow."Outline" SET "currentRevisionId"=NULL WHERE "projectId"=target_project;
$previous$;
  replacement_block := $replacement$  UPDATE contextflow."Outline" SET "currentRevisionId"=NULL WHERE "projectId"=target_project;
  UPDATE contextflow."Outline" SET "currentApprovedRevisionId"=NULL WHERE "projectId"=target_project;
$replacement$;
  IF pg_catalog.strpos(function_source, previous_block)=0
     OR pg_catalog.strpos(
       pg_catalog.substr(function_source,pg_catalog.strpos(function_source,previous_block)+pg_catalog.length(previous_block)),
       previous_block
     )>0 THEN
    RAISE EXCEPTION 'Project purge pointer-clear block changed; refusing live-dependency repair';
  END IF;
  function_source := pg_catalog.replace(function_source, previous_block, replacement_block);

  IF pg_catalog.strpos(function_source, 'purge graph has live cyclic dependencies')=0
     OR pg_catalog.strpos(function_source, 'currentApprovedRevisionId"=NULL')=0 THEN
    RAISE EXCEPTION 'Project purge repair postcondition failed';
  END IF;
  EXECUTE function_source;
  SELECT p.proacl,p.prosecdef,p.proconfig
    INTO repaired_acl,repaired_security_definer,repaired_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid='contextflow.purge_project_graph_scoped(uuid,uuid,integer,boolean)'::pg_catalog.regprocedure;
  IF repaired_acl IS DISTINCT FROM original_acl
     OR repaired_security_definer IS DISTINCT FROM original_security_definer
     OR repaired_config IS DISTINCT FROM original_config THEN
    RAISE EXCEPTION 'Project purge function privileges or execution context changed during repair';
  END IF;
END $$;

COMMIT;
