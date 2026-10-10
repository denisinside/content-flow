"""Compose exported prompts using the pinned Graphon implementation."""
import json

from jinja2 import StrictUndefined
from jinja2.sandbox import SandboxedEnvironment
from graphon.model_runtime.entities.message_entities import ImagePromptMessageContent
from graphon.nodes.llm.llm_utils import handle_list_messages


class LocalJinjaRenderer:
    def render_template(self, template, inputs):
        return SandboxedEnvironment(undefined=StrictUndefined, autoescape=False).from_string(template).render(inputs)


def render_messages(data, pool):
    return handle_list_messages(messages=data.prompt_template, context='',
        jinja2_variables=data.prompt_config.jinja2_variables, variable_pool=pool,
        vision_detail_config=ImagePromptMessageContent.DETAIL.HIGH,
        template_renderer=LocalJinjaRenderer())


def message_text(message):
    if isinstance(message.content, str):
        return message.content
    return ''.join(part.data for part in message.content or [])


def editorial_request(node):
    messages = render_messages(node.node_data, node.graph_runtime_state.variable_pool)
    user = next(message_text(message) for message in messages if message.role.value == 'user')
    prefix, suffix = '<editorial_request>\n', '\n</editorial_request>'
    if not user.startswith(prefix) or not user.endswith(suffix):
        raise ValueError('Editorial request envelope was not rendered')
    return json.loads(user[len(prefix):-len(suffix)])
