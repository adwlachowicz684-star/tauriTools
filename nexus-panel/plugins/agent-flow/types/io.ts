/**
 * types.ts 第 4 卷：io。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { NodeSize, NodeStatus } from './core';

/* ------------------------------------------------------------------ */
/* 文件 / 文件夹操作节点                                                */
/* ------------------------------------------------------------------ */

export type FsOp =
  | 'read'     // 读文件全文
  | 'write'    // 写文件（覆盖）
  | 'append'   // 追加到文件末尾
  | 'copy'     // 复制文件或目录
  | 'move'     // 移动 / 重命名
  | 'delete'   // 删除文件或目录
  | 'list'     // 列出目录条目
  | 'mkdir'    // 创建目录
  | 'exists'   // 是否存在
  | 'stat';    // 大小 / 修改时间等元信息

/* ------------------------------------------------------------------ */
/* 通用 HTTP 请求节点（参数型：填参数即可调任意接口，不用写代码）     */
/* ------------------------------------------------------------------ */

/** 请求方法。只列常用的，够用即止 —— 列全了反而不好选 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type GenericHttpNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'generic-http';
  label: string;
  /** 请求地址，支持 {{模板变量}} */
  url: string;
  method: HttpMethod;
  /**
   * 请求头，每行一条 `Name: value`，支持 {{模板变量}}。
   * 用文本域而不是键值对编辑器：后者在面板里要占很多行，
   * 而多数请求只有 1~3 个头。
   */
  headersText: string;
  /** 请求体，仅 POST/PUT/PATCH 用；支持 {{模板变量}} */
  body: string;
  /** 请求体按 JSON 发送时自动补 Content-Type */
  bodyIsJson: boolean;
  timeoutSec: number;
  /** 响应最大字节数，防止一个异常大的响应把面板拖垮 */
  maxBytesKb: number;
  /** 从凭据库取令牌，自动加 Authorization: Bearer <token> */
  credentialId: string;
  /** 4xx/5xx 是否算节点失败。关掉则把错误响应也当正常输出，交给下游判断 */
  failOnHttpError: boolean;
};

/* ------------------------------------------------------------------ */
/* 数据提取节点（把上游一大段文本裁成下游能用的值）                    */
/* ------------------------------------------------------------------ */

export type ExtractMode = 'json' | 'regex' | 'line' | 'text';

export const EXTRACT_MODE_META: Record<ExtractMode, { label: string; spec: string; hint: string }> = {
  json: {
    label: 'JSON 路径',
    spec: '路径',
    hint: '如 data.items[0].title；也认 data.items.0.title 与 [0].title',
  },
  regex: {
    label: '正则表达式',
    spec: '正则',
    hint: '默认取第 1 个捕获组；没写捕获组则取整段匹配',
  },
  line: {
    label: '按行取',
    spec: '行规则',
    hint: 'first / last / 行号（0 起，负数倒数）/ 包含的文字',
  },
  text: {
    label: '原样输出',
    spec: '',
    hint: '不做处理，直接把上游文本传给下游',
  },
};

export type ExtractNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'extract';
  label: string;
  mode: ExtractMode;
  /** 各模式的参数：JSON 路径 / 正则 / 行规则 */
  spec: string;
  /** 正则模式下取第几个捕获组 */
  group: number;
  /** 提取失败时是否让节点失败。关掉则输出空串、流程继续 */
  failOnMiss: boolean;
  /** 去掉首尾空白 */
  trim: boolean;
};

export type FsNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'fs';
  label: string;
  op: FsOp;
  /** 主路径，支持 {{模板变量}} */
  path: string;
  /** copy / move 的目标路径 */
  target: string;
  /** write / append 的内容，支持 {{模板变量}} */
  content: string;
  /** list: 是否递归 */
  recursive: boolean;
  /** delete: 是否允许删非空目录 */
  force: boolean;
  /** 只打印将执行的操作，不真正改动磁盘 */
  dryRun: boolean;
  /** read 最大字节数，超出截断 */
  maxBytes: number;
  /** list: 文件名过滤后缀，空数组表示全部 */
  exts: string[];
  status: NodeStatus;
  output: string;
  error: string;
};

export const FS_OP_META: Record<FsOp, {
  label: string;
  hint: string;
  needsTarget: boolean;
  needsContent: boolean;
  /** 会改动磁盘的操作，界面上标红提醒 */
  destructive: boolean;
}> = {
  read:   { label: '读文件',   hint: '读取文本文件内容',                 needsTarget: false, needsContent: false, destructive: false },
  write:  { label: '写文件',   hint: '写入内容，已存在则覆盖',           needsTarget: false, needsContent: true,  destructive: true  },
  append: { label: '追加内容', hint: '在文件末尾追加',                   needsTarget: false, needsContent: true,  destructive: true  },
  copy:   { label: '复制',     hint: '复制文件或整个目录',               needsTarget: true,  needsContent: false, destructive: true  },
  move:   { label: '移动',     hint: '移动或重命名',                     needsTarget: true,  needsContent: false, destructive: true  },
  delete: { label: '删除',     hint: '删除文件或目录',                   needsTarget: false, needsContent: false, destructive: true  },
  list:   { label: '列目录',   hint: '列出目录下的条目',                 needsTarget: false, needsContent: false, destructive: false },
  mkdir:  { label: '建目录',   hint: '创建目录（含父级）',               needsTarget: false, needsContent: false, destructive: true  },
  exists: { label: '判断存在', hint: '返回 true / false',                needsTarget: false, needsContent: false, destructive: false },
  stat:   { label: '查看信息', hint: '大小、类型、修改时间',             needsTarget: false, needsContent: false, destructive: false },
};

/** 这些路径绝不允许被删除——误删根目录或系统目录代价太大 */
export const FS_FORBIDDEN: string[] = [
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/system', '/windows',
  'C:\\', 'C:\\Windows', 'C:\\Windows\\System32',
];
