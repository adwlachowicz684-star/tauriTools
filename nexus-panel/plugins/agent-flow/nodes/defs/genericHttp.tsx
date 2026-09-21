import { makeGenericHttpNode, HTTP_METHODS, type HttpMethod } from '../../types';
import { HttpCard } from '../../components/GenericNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runGenericHttp } from '../../engine/runners/genericHttp';
import { registerNode } from '../registry';

/**
 * 通用 HTTP 请求节点 —— "参数型自定义节点"的主力。
 *
 * 存在的理由：此前要接一个新的外部服务（天气、股价、自建接口…）就得写一份
 * 节点定义 + 一个执行器 + 挂三处注册表。多数场景其实只是"发个请求、拿回文本"，
 * 与具体服务无关。这里把它参数化，接新服务变成填几个框。
 */
const fields: FieldDef[] = [
  {
    // 方法与地址同行：地址是主信息，方法是个短前缀，分行会让地址被挤窄
    type: 'custom',
    spec: { keys: ['method', 'url'], kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    key: 'url',
    render: (p) => (
      <div className="p-row">
        <select
          className="p-input"
          style={{ width: 96, flex: 'none' }}
          value={String(p.d.method ?? 'GET')}
          onChange={(e) => p.patch({ method: e.target.value })}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          className="p-input"
          value={String(p.d.url ?? '')}
          placeholder="https://api.example.com/v1/..."
          onChange={(e) => p.patch({ url: e.target.value })}
        />
      </div>
    ),
  },
  {
    type: 'textarea',
    key: 'headersText',
    label: '请求头',
    rows: 3,
    placeholder: '每行一条，如：\nX-Token: abc123',
    hint: '留空即可；填了 Authorization 就不会再自动加凭据令牌',
  },
  {
    type: 'textarea',
    key: 'body',
    label: '请求体',
    rows: 5,
    placeholder: '{"key": "value"}，支持 {{上游.output}}',
    when: (d) => d.method === 'POST' || d.method === 'PUT' || d.method === 'PATCH',
    hint: '请求体里可以引用上游输出',
  },
  {
    type: 'switch',
    key: 'bodyIsJson',
    label: '',
    placeholder: '按 JSON 发送（自动补 Content-Type）',
    when: (d) => d.method === 'POST' || d.method === 'PUT' || d.method === 'PATCH',
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'generic-http' },
  {
    type: 'number',
    key: 'timeoutSec',
    label: '超时（秒）',
    min: 1,
    max: 300,
    inline: true,
  },
  {
    type: 'number',
    key: 'maxBytesKb',
    label: '响应上限（KB）',
    min: 1,
    max: 10240,
    inline: true,
    hint: '防止异常大的响应把面板拖垮',
  },
  {
    type: 'switch',
    key: 'failOnHttpError',
    label: '',
    placeholder: '4xx / 5xx 算失败',
    hint: '关掉则把错误响应也当正常输出，交给下游判断',
  },
  {
    type: 'note',
    content: '输出响应正文。状态码存在 {{本节点.status}}，配合「数据提取」节点可取出 JSON 字段。',
  },
];

registerNode({
  type: 'generic-http',
  dataKind: 'generic-http',
  meta: {
    varGroups: ['http-endpoint'],
    label: 'HTTP 请求',
    color: '#0ea5e9',
    category: 'external',
    idPrefix: 'http',
    sub: '填地址与参数即可调任意接口',
  },
  create: (id, partial) => makeGenericHttpNode(id, (partial ?? {}) as never).data,
  Canvas: HttpCard,
  fields: () => fields,
  run: runGenericHttp,
});
