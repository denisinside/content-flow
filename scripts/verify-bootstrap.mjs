import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const manifest = JSON.parse(read('docs/source-manifest.json'));
check(manifest.schemaVersion === 1 && typeof manifest.authorization === 'string' && manifest.authorization.length > 0, 'Invalid owner-authorized source manifest');
check(Array.isArray(manifest.sources) && manifest.sources.length === 4, 'Expected four source records');
const sourceFiles = {};
const seenPaths = new Set();
for (const entry of manifest.sources ?? []) {
  check(typeof entry.alias === 'string' && /^practical-[1-4]\.md$/.test(entry.alias) && !Object.hasOwn(sourceFiles, entry.alias), 'Invalid or duplicate source alias');
  check(typeof entry.path === 'string' && entry.path.startsWith('docs/source/') && path.dirname(path.resolve(root, entry.path)) === path.resolve(root, 'docs/source') && !seenPaths.has(entry.path), 'Invalid or duplicate source path');
  check(typeof entry.sha256 === 'string' && /^[A-F0-9]{64}$/.test(entry.sha256), 'Invalid source hash');
  if (failures.length) break;
  seenPaths.add(entry.path);
  check(fs.existsSync(path.join(root, entry.path)), `Source missing: ${entry.alias}`);
  if (fs.existsSync(path.join(root, entry.path))) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, entry.path))).digest('hex').toUpperCase();
    check(actual === entry.sha256, `Source differs from owner-authorized revision: ${entry.alias}`);
  }
  sourceFiles[entry.alias] = path.basename(entry.path);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
const spec = read('docs/SPEC.md');
const trace = read('docs/TRACEABILITY.md');
const p2 = read('docs/source/practical-2.md');
const p3 = read(`docs/source/${sourceFiles['practical-3.md']}`);
const fr = [...new Set(p2.match(/FR-\d{3}/g))];
const us = [...new Set(p2.match(/US-\d{2}/g))];
const nfr = [...p3.matchAll(/^\*\*(\d+\.\d+\.\d+)\.\*\*/gm)].map(x => `NFR-${x[1]}`);
check(fr.length === 45 && us.length === 28 && nfr.length === 34, 'Unexpected source requirement counts');
for (const id of [...fr, ...nfr]) {
  check(spec.split('\n').filter(l => l.startsWith(`| ${id} |`)).length === 1, `SPEC row missing/duplicated: ${id}`);
  check(trace.split('\n').filter(l => l.startsWith(`| ${id} |`)).length === 1, `TRACE row missing/duplicated: ${id}`);
}
for (const id of us) check(spec.includes(`${id}→`), `Story mapping absent: ${id}`);
for (const l of trace.split('\n').filter(l => /^\| (FR-|NFR-|SYS-)/.test(l))) {
  const cells = l.split('|').map(value => value.trim());
  check(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'DEFERRED'].includes(cells[5]), `Invalid traceability status: ${cells[1]}`);
  if (cells[5] === 'DONE') {
    check(cells[6] && !cells[6].startsWith('—') && cells[7] && !cells[7].startsWith('—'), `DONE row lacks implementation/evidence: ${cells[1]}`);
  }
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const authoredMd = walk(path.join(root, 'docs')).filter(p => p.endsWith('.md') && !p.includes(`${path.sep}source${path.sep}`));
authoredMd.push(path.join(root, 'AGENTS.md'));
authoredMd.push(...walk(path.join(root, '.agents/skills')).filter(p => p.endsWith('.md')));
let links = 0;
for (const p of authoredMd) {
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    links++;
    check(fs.existsSync(path.resolve(path.dirname(p), decodeURIComponent(target))), `Broken link ${path.relative(root, p)} → ${target}`);
  }
}
const cfg = read('.codex/config.toml');
const expectedSettings = { enabled: 'true', max_concurrent_threads_per_session: '6', default_subagent_model: '"gpt-6-luna"', default_subagent_reasoning_effort: '"high"', interrupt_message: 'true' };
const cfgLines = cfg.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const tables = {};
let table;
for (const line of cfgLines) {
  const heading = line.match(/^\[([^\]]+)\]$/);
  if (heading) {
    table = heading[1];
    check(!Object.hasOwn(tables, table), `Duplicate config table: ${table}`);
    tables[table] = [];
  } else if (table) tables[table].push(line);
  else check(false, 'Unexpected root setting in project config');
}
const expectedTables = {
  agents: expectedSettings,
  'mcp_servers.shadcn': {
    command: '"node"', args: '[".codex/tools/run-mcp.mjs", "shadcn", "mcp"]',
    startup_timeout_sec: '30', tool_timeout_sec: '60',
  },
  'mcp_servers.playwright': {
    command: '"node"',
    args: '[".codex/tools/run-mcp.mjs", "playwright", "--headless", "--isolated", "--browser", "chrome", "--output-dir", ".codex/artifacts/playwright"]',
    startup_timeout_sec: '30', tool_timeout_sec: '60',
  },
};
check(Object.keys(tables).length === Object.keys(expectedTables).length, 'Unexpected project config table/root model');
for (const [name, settings] of Object.entries(expectedTables)) {
  const lines = tables[name] || [];
  check(lines.length === Object.keys(settings).length, `Unexpected settings in ${name}`);
  for (const [key, value] of Object.entries(settings)) check(lines.includes(`${key} = ${value}`), `Config setting mismatch: ${name}.${key}`);
}
const roles = { explorer: ['gpt-6-luna', 'high', 'read-only'], researcher: ['gpt-6-luna', 'high', 'read-only'], implementer: ['gpt-6-luna', 'high', 'workspace-write'], tester: ['gpt-6-luna', 'high', 'workspace-write'], tester_debug: ['gpt-6-luna', 'xhigh', 'workspace-write'], reviewer: ['gpt-6-sol', 'medium', 'read-only'] };
for (const [role, [model, effort, sandbox]] of Object.entries(roles)) {
  const t = read(`.codex/agents/${role}.toml`);
  for (const [key, value] of Object.entries({ name: role, model, model_reasoning_effort: effort, sandbox_mode: sandbox })) check(t.includes(`${key} = "${value}"`), `Role ${role} mismatch ${key}`);
  check(/^description = "[^"]+"$/m.test(t), `${role} description missing`);
  check((t.match(/"""/g) || []).length === 2 && t.includes('developer_instructions = """'), `${role} multiline instructions invalid`);
  const header = t.split('developer_instructions =')[0];
  const keys = [...header.matchAll(/^(\w+)\s*=/gm)].map(m => m[1]);
  check(keys.length === 5 && keys.every(k => ['name','description','model','model_reasoning_effort','sandbox_mode'].includes(k)), `${role} unsupported header field`);
}
// The restricted TOML subset above is not a general TOML parser or effective runtime validation.
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Bootstrap checks passed: 4 sources match owner-authorized revision, ${fr.length} FR, ${nfr.length} NFR, ${us.length} story mappings, ${links} local links, ${Object.keys(roles).length} role definitions and documented config subset.`);
