import { UPDATE_SOURCE_META, type UpdateNodeData } from '../../types';
import { UpdateTestPanel } from '../../components/inspectors/UpdateTestPanel';
import type { FieldDef } from '../../components/inspectors/fields';

/**
 * B站与公众号共用的字段清单。
 *
 * 两个源的差异只在"UID + Cookie"与"订阅地址"这两组上，
 * 用 when 按 source 分流，比在一个面板里写 if 分支清楚：
 * 新增第三个源时，只要再加一组 when 即可，不动其它字段。
 */
export const updateFields: FieldDef[] = [
  {
    type: 'text',
    key: 'biliUid',
    label: 'UP 主',
    placeholder: 'UID 或 space.bilibili.com 主页链接',
    when: (d) => d.source === 'bilibili',
  },
  {
    type: 'select',
    key: 'biliMode',
    label: '抓取方式',
    options: [
      { value: 'rss', label: '订阅源（免 Cookie）' },
      { value: 'api', label: 'B站接口（更及时，建议填 Cookie）' },
    ],
    when: (d) => d.source === 'bilibili',
  },
  {
    type: 'textarea',
    key: 'biliCookie',
    label: 'Cookie（可选）',
    rows: 2,
    placeholder: '浏览器里复制的整条 Cookie',
    hint: '绕过风控用。只填 SESSDATA 往往不够，B站还会看 buvid3 / _uuid，直接粘整条最省事',
    when: (d) => d.source === 'bilibili' && d.biliMode === 'api',
  },
  {
    type: 'text',
    key: 'feedUrl',
    label: '订阅源地址',
    placeholder: 'https://.../feed.xml',
    hint: UPDATE_SOURCE_META.wechat.hint,
    when: (d) => d.source === 'wechat',
  },
  {
    type: 'text',
    key: 'userAgent',
    label: 'User-Agent（可选）',
    placeholder: '留空用默认值',
    hint: '部分源会拒绝默认的非浏览器 UA',
  },
  {
    type: 'switch',
    key: 'firstRunAsUpdate',
    label: '',
    placeholder: '首次运行（还没有基线）时算作更新',
    hint: '默认关闭：刚配好就触发一次下游通常是误报',
  },
  {
    type: 'select',
    key: 'outputFormat',
    label: '输出格式',
    options: [
      { value: 'bool', label: '只输出 true / false' },
      { value: 'detail', label: '附带标题、链接、时间' },
    ],
  },
  {
    type: 'number',
    key: 'timeoutSec',
    label: '超时（秒）',
    min: 1,
    max: 120,
  },
];

/** 试跑与重置基线。挂在字段清单之后 */
export function updateFooter(p: {
  node: { id: string };
  patch: (patch: Record<string, unknown>) => void;
}) {
  return (
    <UpdateTestPanel
      node={p.node as never}
      onChange={p.patch}
    />
  );
}

export type { UpdateNodeData };
