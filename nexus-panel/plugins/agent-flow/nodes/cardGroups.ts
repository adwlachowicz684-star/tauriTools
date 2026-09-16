import { registerCardGroup, type CardGroupDef } from '../engine/paramCards';

/**
 * 内置卡片组。
 *
 * 新增一组卡片在这里注册一条即可，不用改任何节点 ——
 * 节点只是声明「我支持哪些组」（meta.cardGroups）。
 */

const asText = (v: unknown): string => String(v ?? '').trim();

/** GitHub 仓库地址：owner / repo / branch */
export const GITHUB_REPO_GROUP: CardGroupDef = {
  group: 'github-repo',
  label: '地址卡片',
  keys: ['owner', 'repo', 'branch'],
  name: '仓库',
  summary: (v) => {
    const owner = asText(v.owner);
    const repo = asText(v.repo);
    if (!owner && !repo) return '（空）';
    const base = repo ? `${owner}/${repo}` : owner;
    const branch = asText(v.branch);
    return branch ? `${base} · ${branch}` : base;
  },
  /*
   * 至少要有 repo 才算一张能用的地址卡片。
   * 放宽到"三项都必填"会误伤：更新检测节点允许留空 branch（用默认分支），
   * 那是正当用法，不该被卡住。
   */
  validate: (v) => (asText(v.repo) ? null : '没填仓库名，套上去也是空的'),
};

/** HTTP 请求地址：url / method */
export const HTTP_ENDPOINT_GROUP: CardGroupDef = {
  group: 'http-endpoint',
  label: '接口卡片',
  keys: ['url', 'method'],
  name: '接口',
  summary: (v) => {
    const url = asText(v.url);
    if (!url) return '（空）';
    const m = asText(v.method);
    return m ? `${m} ${url}` : url;
  },
  validate: (v) => {
    const url = asText(v.url);
    if (!url) return '没填地址';
    if (!/^https?:\/\//i.test(url)) return '地址要以 http:// 或 https:// 开头';
    return null;
  },
};

/** 大模型配置：llm 对象（provider / model / apiKey…） */
export const LLM_CONFIG_GROUP: CardGroupDef = {
  group: 'llm-config',
  label: '模型卡片',
  keys: ['llm'],
  name: '模型',
  summary: (v) => {
    const llm = (v.llm ?? {}) as Record<string, unknown>;
    const provider = asText(llm.provider);
    const model = asText(llm.model);
    if (!provider && !model) return '（空）';
    return model ? `${provider} · ${model}` : provider;
  },
  /*
   * 不校验 apiKey 是否已填：密钥走凭据中心或加密保险箱，
   * 卡片里存的是模型与供应商，本来就不该带密钥。
   */
  validate: (v) => {
    const llm = (v.llm ?? {}) as Record<string, unknown>;
    return asText(llm.provider) || asText(llm.model) ? null : '没选供应商或模型';
  },
};

/** 命令工作目录（CLI 类节点） */
export const WORKDIR_GROUP: CardGroupDef = {
  group: 'workdir',
  label: '目录卡片',
  keys: ['workdir'],
  name: '工作目录',
  summary: (v) => asText(v.workdir) || '（空）',
  validate: (v) => (asText(v.workdir) ? null : '没填目录'),
};

let done = false;

/** 幂等：多处 import 也只注册一次 */
export function registerBuiltinCardGroups(): void {
  if (done) return;
  done = true;
  registerCardGroup(GITHUB_REPO_GROUP);
  registerCardGroup(HTTP_ENDPOINT_GROUP);
  registerCardGroup(LLM_CONFIG_GROUP);
  registerCardGroup(WORKDIR_GROUP);
}
