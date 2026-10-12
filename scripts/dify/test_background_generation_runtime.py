import json
import unittest
import yaml
from pathlib import Path
import background_generation_runtime as runtime

class BackgroundRuntime(unittest.TestCase):
    def test_exported_tool_graph_and_quality(self):
        root=Path(__file__).resolve().parents[2]
        graph=yaml.safe_load((root/'packages/backend/src/visuals/workflows/background-generation/background-generation-v1.yml').read_text(encoding='utf-8'))
        nodes={node['id']:node['data'] for node in graph['workflow']['graph']['nodes']}
        functions={}
        for name in ('prepare','finalize'):
            namespace={};exec(nodes[name]['code'],namespace);functions[name]=namespace['main']
        request={'schemaVersion':'visual-background-v1','frameId':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','visualBrief':'{{ unsafe }} add words','width':1080,'height':1350,'templateId':'editorial','palette':{'background':'#ffffff','text':'#20262b','accent':'#343a40'}}
        result=functions['prepare'](json.dumps(request));self.assertIn('NO visible words',result['image_prompt']);self.assertIn('{{ unsafe }}',result['image_prompt']);self.assertEqual(result['image_model'],'gemini-nano-banana-2.1')
        from graphon.runtime.variable_pool import VariablePool
        from graphon.variables.template_resolution import convert_template
        from graphon.nodes.tool.entities import ToolNodeData
        pool=VariablePool()
        for key,value in result.items():pool.add(['prepare',key],value)
        node=ToolNodeData.model_validate(nodes['image']);self.assertEqual(node.tool_node_version,'2')
        config=node.ToolInput.model_validate(node.tool_configurations['model'])
        self.assertEqual(config.type,'variable');self.assertEqual(pool.get(config.value).value,runtime.MODEL)
        prompt=node.tool_parameters['prompt'];self.assertEqual(prompt.type,'mixed')
        self.assertEqual(convert_template(pool,prompt.value).text,result['image_prompt'])
        self.assertEqual(nodes['review']['vision']['configs']['variable_selector'],['image','files'])
        self.assertFalse(node.retry_config.retry_enabled)
        for has_text in (False,True):
            review=json.dumps({'hasText':has_text,'usable':True,'reason':'Checked'})
            for wrapped in (review,'```json\n'+review+'\n```'):
                report=json.loads(functions['finalize'](result['request_json'],wrapped)['background_report']);self.assertEqual(report['ready'],not has_text);self.assertEqual(report['model'],runtime.MODEL)
        with self.assertRaises(ValueError):functions['finalize'](result['request_json'],'Explanation\n```json\n'+review+'\n```')
        request['height']=1
        with self.assertRaises(ValueError):functions['prepare'](json.dumps(request))
        with self.assertRaises(ValueError):functions['finalize'](result['request_json'],'{"hasText":"false","usable":true,"reason":"wrong type"}')

if __name__=='__main__':unittest.main()
