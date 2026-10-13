import {
  defaultFileOutput, FS_OP_META, FS_FORBIDDEN, type FsOp, type TaskNodeData,
} from '../types';

/**
 * 从 CLI 输出文本里提取"被修改/创建的文件路径"，供下游节点引用。
 *
 * 为什么需要这个：agent 改完文件后，下游（审查、git 提交、条件判断）
 * 往往想知道"到底改了哪个文件"。但 CLI 输出是自然语言 + 工具调用混排，
 * 没有结构化字段，只能靠文本识别 —— 所以这里是尽力而为，
 * 识别不准时用户可以在界面上切「手动指定」。
 */

/** 已知扩展名。用它做收尾约束，能挡掉绝大部分噪声（版本号、时间、普通单词） */
const KNOWN_EXT = new Set([
  // 代码
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php',
  'swift', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'ml', 'hs',
  'lua', 'pl', 'pm', 'r', 'jl', 'dart', 'zig', 'nim', 'ex', 'exs', 'erl',
  // 前端 / 样式
  'vue', 'svelte', 'astro', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  // 配置 / 数据
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'gradle', 'cmake', 'mk', 'make', 'lock', 'sum', 'mod',
  // 文档 / 其他
  'md', 'mdx', 'txt', 'rst', 'log', 'csv', 'tsv', 'sql', 'graphql', 'gql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
  'zip', 'tar', 'gz', 'bz2',
]);

/** 没有扩展名但确实是文件的常见名字（小写比对） */
const NAME_ONLY = new Set([
  'dockerfile', 'makefile', 'gnumakefile', 'cmakelists.txt',
  'readme', 'readme.md', 'license', 'changelog', 'contributing',
  'go.mod', 'go.sum', 'cargo.toml', 'package.json', 'tsconfig.json',
  'requirements.txt', 'pipfile', 'gemfile', 'procfile', 'rakefile',
  '.gitignore', '.env', '.editorconfig', '.dockerignore', '.eslintrc',
  '.prettierrc', '.babelrc', '.npmrc', '.nvmrc',
]);

/** 这些前缀说明是网址而不是文件路径 */
const URL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;

export type FileRef = {
  /** 原始文本里匹配到的样子 */
  raw: string;
  /** 拼接并规范化 workdir 之后的路径；已是绝对路径时等于原始值（仅规范化） */
  abs: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 目录部分 */
  dir: string;
  /** 扩展名（不含点，小写）；没有则为空串 */
  ext: string;
};

/**
 * 切词用的分隔符。
 *
 * 除了空白和标点，还把 CJK 字符也算作分隔符 ——
 * agent 输出里常见「创建文件src/foo.ts成功」这种中文直接粘连的情况，
 * 不切的话会混进一大串中文，识别不出来。
 */
const SPLIT = /[\s`"'"'"'()[\]{}<>,;|*!?]+|[　-〿一-鿿＀-￯]+/g;

/**
 * 去掉首尾的杂标点，但不吃掉末尾的扩展名。
 *
 * 开头的点号必须保留：`./a.ts`、`../a.ts` 是相对路径，
 * `.gitignore`、`.env` 是隐藏文件名 —— 一律去掉会把它们全改坏
 * （`./config.yml` 会变成 `/config.yml`，被误判成绝对路径）。
 * 所以开头只去引号，结尾才去标点。
 */
function trimToken(t: string): string {
  return t.replace(/^['"“”‘’]+/, '').replace(/[.,;:!?'"“”‘’]+$/, '');
}

/** 兼容 / 与 \ 的 dirname */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

/** 兼容 / 与 \ 的 basename */
function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 取扩展名（小写，不含点） */
function extOf(p: string): string {
  const name = basenameOf(p);
  const i = name.lastIndexOf('.');
  // 点开头（.gitignore）视为无扩展名
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

const WIN_RE = /^[A-Za-z]:[\\/]/;

/**
 * 规范化路径里的 . 与 ..
 *
 * 拼接 workdir 后会出现 `/work/proj/./a.ts`、`/work/proj/../shared/a.rs`
 * 这类"能跑但很难看"的路径，直接传给下游容易让人误判改到了哪个文件。
 */
export function normalizePath(p: string): string {
  const win = WIN_RE.test(p);
  const unc = p.startsWith('\\\\');
  let prefix = '';
  if (win) prefix = p.slice(0, 2) + '\\';
  else if (unc) prefix = '\\\\';
  else if (p.startsWith('/')) prefix = '/';

  const isAbs = prefix !== '';
  const rest = p.slice(prefix.length);
  const sep = win || unc ? '\\' : '/';

  const out: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // 相对路径开头的 .. 要保留；绝对路径到了根就丢弃
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(part);
  }
  return prefix + out.join(sep);
}

/**
 * 判断一个 token 是不是像文件路径。
 *
 * 判据（满足其一）：
 *  1. 含路径分隔符，且末段有已知扩展名
 *  2. 含路径分隔符，且末段是无扩展名的常见文件名（如 .../Makefile）
 *  3. 不含分隔符，但有已知扩展名（如 main.py）
 *  4. 不含分隔符，整体是常见文件名（如 Dockerfile）
 */
function looksLikePath(token: string): boolean {
  if (!token || token.length < 2 || token.length > 260) return false;
  if (URL_PREFIX.test(token)) return false;
  // 纯数字或以数字开头的一串（1.2.3 / 2024-01-01）不是路径
  if (/^\d/.test(token)) return false;
  // 含非法字符
  if (/[<>|]/.test(token)) return false;

  const name = basenameOf(token);
  const ext = extOf(token);
  const nameLower = name.toLowerCase();
  const hasSep = token.includes('/') || token.includes('\\');

  if (hasSep) {
    if (KNOWN_EXT.has(ext)) return true;
    if (NAME_ONLY.has(nameLower)) return true;
    return false;
  }
  if (KNOWN_EXT.has(ext)) return true;
  if (NAME_ONLY.has(nameLower)) return true;
  return false;
}

/**
 * 从文本提取文件路径。
 *
 * @param text 待扫描的文本（一般用节点的 CLI 输出）
 * @param workdir 节点的工作目录；相对路径会拼到它上面生成 abs
 */
export function extractFileRefs(text: string, workdir?: string): FileRef[] {
  if (!text) return [];

  const seen = new Set<string>();
  const refs: FileRef[] = [];
  const wd = (workdir ?? '').trim().replace(/[\\/]+$/, '');

  for (const rawToken of text.split(SPLIT)) {
    const token = trimToken(rawToken);
    if (!looksLikePath(token)) continue;

    const joined = !isAbsolute(token) && wd ? `${wd}/${token}` : token;
    const abs = normalizePath(joined);

    // 去重：同一次输出里同一个文件常被反复提及
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    refs.push({
      raw: token,
      abs,
      name: basenameOf(token),
      dir: dirnameOf(token),
      ext: extOf(token),
    });
  }
  return refs;
}

/**
 * 把 FileRef[] 展开成模板可用的字段表。
 *
 * 默认字段名是固定的（file / files / fileName ...），
 * 下游直接写 {{n1.file}} 即可，不需要先配置什么。
 */
export function buildFileFields(refs: FileRef[]): Record<string, string> {
  if (refs.length === 0) {
    return {
      file: '', files: '', fileRel: '', fileName: '', fileNames: '',
      fileDir: '', fileExt: '', fileCount: '0',
    };
  }
  const first = refs[0];
  return {
    file: first.abs,
    files: refs.map((r) => r.abs).join('\n'),
    fileRel: first.raw,
    fileName: first.name,
    fileNames: refs.map((r) => r.name).join('\n'),
    fileDir: first.dir || dirnameOf(first.abs),
    fileExt: first.ext,
    fileCount: String(refs.length),
  };
}

/** 文件参数的默认字段名，界面用它生成可点击的引用 chip */
export const FILE_FIELD_NAMES = [
  'file', 'files', 'fileRel', 'fileName', 'fileNames', 'fileDir', 'fileExt', 'fileCount',
] as const;

export const FILE_FIELD_HINT: Record<string, string> = {
  file: '第一个文件的完整路径',
  files: '全部文件路径（换行分隔）',
  fileRel: '第一个文件的原始路径（未拼 workdir）',
  fileName: '第一个文件的文件名',
  fileNames: '全部文件名（换行分隔）',
  fileDir: '第一个文件所在目录',
  fileExt: '第一个文件的扩展名',
  fileCount: '识别到的文件数量',
};

/**
 * 文件字段的**短名** —— 输出卡片上那一格要放得下。
 *
 * 与 FILE_FIELD_HINT 的区别是用途：hint 是悬浮提示里那句完整说明，
 * 这个是一两个字的格子标题。直接拿 hint 当标签的话，
 * 「第一个文件的完整路径」会把卡片撑成一整行。
 *
 * 字段**清单**仍然只有 FILE_FIELD_NAMES 一处 ——
 * 这两张表只是同一批 key 的两种说法。
 */
export const FILE_FIELD_LABEL: Record<string, string> = {
  file: '文件路径',
  files: '全部路径',
  fileRel: '原始路径',
  fileName: '文件名',
  fileNames: '全部文件名',
  fileDir: '所在目录',
  fileExt: '扩展名',
  fileCount: '文件数',
};

/**
 * 文件字段的**值种类** —— 输出端口登记时要带上，不写则一律按文本。
 *
 * 只有 fileCount 是数量。它确实是 `String(refs.length)`、值本身是字符串，
 * 但语义是"有几个文件"：下游拿它做「文件数 > 3」是最自然的用法，
 * 而按文本登记会把这条线判成「错参」——**把本来正确的接法标红**，
 * 这比漏报更糟。消费方本来就会 num() 解析，登记成 num 不会让运行时出错。
 *
 * 与 LABEL / HINT 同理：字段**清单**仍然只有 FILE_FIELD_NAMES 一处，
 * 这几张表只是同一批 key 的几种说法。
 */
export const FILE_FIELD_KIND: Record<string, 'num' | 'text'> = {
  fileCount: 'num',
};

/** 手动模式：把用户填的多行文本当成路径列表 */
export function parseManualPaths(text: string, workdir?: string): FileRef[] {
  const wd = (workdir ?? '').trim().replace(/[\\/]+$/, '');
  const refs: FileRef[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    const abs = normalizePath(!isAbsolute(p) && wd ? `${wd}/${p}` : p);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      raw: p,
      abs,
      name: basenameOf(p),
      dir: dirnameOf(p),
      ext: extOf(p),
    });
  }
  return refs;
}

/**
 * 决定这个节点"改了哪些文件"。
 *
 * 手动模式优先：自动识别是尽力而为，一旦用户明确指定了路径，
 * 就应该完全信任用户的输入，不再从输出里猜。
 *
 * 放在这里而不是 runner.ts：节点执行器抽到 engine/runners/ 后拿不到
 * runner 的模块级函数，而文件字段的解析本来就属于 files 这一层。
 */
export function resolveFileRefs(d: TaskNodeData, output: string): FileRef[] {
  const cfg = d.fileOutput ?? defaultFileOutput();
  if (!cfg.enabled) return [];
  if (cfg.mode === 'manual') return parseManualPaths(cfg.manualPaths, d.workdir);
  return extractFileRefs(output, d.workdir);
}

/* ------------------------------------------------------------------ */
/* 文件操作节点的路径校验                                              */
/* ------------------------------------------------------------------ */

/**
 * 这个操作需不需要「目标路径」。
 *
 * 判据取自 types.ts 的 FS_OP_META，**不在这里另写一份** ——
 * 以前 nodeValidate 里手写了一份 `new Set(['copy','move','rename'])`，
 * 与 FS_OP_META.needsTarget 是两张表。后果不是"现在错了"，而是
 * **将来加一个需目标的操作时只有一处会跟上**：面板会出现目标输入框、
 * 校验却不说它必填，于是红点不亮、跑起来才失败。
 * （那份手写表里还有个 'rename' —— FsOp 里根本没有这个取值。）
 */
export function fsNeedsTarget(op: string): boolean {
  return Boolean(FS_OP_META[op as FsOp]?.needsTarget);
}

/** 会不会改动磁盘 */
export function fsDestructive(op: string): boolean {
  return Boolean(FS_OP_META[op as FsOp]?.destructive);
}

/** 统一成 `/` + 小写，好与 FS_FORBIDDEN 比对（Windows 路径不区分大小写） */
function cmpPath(p: string): string {
  const s = normalizePath(String(p ?? '').trim()).replace(/\\/g, '/').toLowerCase();
  /* 尾部斜杠去掉：'/data/' 与 '/data' 是同一个目录 */
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * 路径是不是落在「绝不允许改动」的名单里。
 *
 * ================= 为什么要有这道 =================
 *
 * FS_FORBIDDEN 在 types.ts 里定义了很久，注释写着
 * 「这些路径绝不允许被删除 —— 误删根目录或系统目录代价太大」，
 * 而**全仓没有任何一处消费它** —— 那句注释从未生效。
 *
 * 是不是冗余？Rust 侧只接受授权根目录内的路径，默认范围仅应用数据目录，
 * 所以 `/etc` 平时确实会被拒。**但用户可以自己授权任意目录**
 * （fsAllowRoot）—— 图省事把 `/` 加进去是很常见的做法，
 * 那一刻这道防线就变成了唯一的一道。
 *
 * 更实际的理由是**报错文案**：没有它时用户看到的是 Rust 的 IO 错误
 * 或"目标目录不可写"，于是去查磁盘权限；而真正原因是"这个路径不该动"。
 *
 * ================= 为什么只对改动磁盘的操作生效 =================
 *
 * 只读操作（read / list / exists / stat）读 `/etc` 是正常需求 ——
 * 判掉它属于误报，而误报比漏报更糟：用户会去改一个本来能跑的节点。
 */
export function fsForbidden(path: string, op: string): boolean {
  if (!fsDestructive(op)) return false;
  const p = cmpPath(path);
  if (!p) return false;
  /*
   * 只比"完全相等"是不够的 —— `/etc/passwd` 不等于 `/etc`，
   * 于是覆盖系统配置文件这道防线形同虚设，只挡住了删整个目录
   * （而那本来就是极少见的用法）。所以禁用位置**及其下面的全部**都拦。
   *
   * 形状与 exportDir 的 withinRoots 一致（相等 或 前缀 + 分隔符）。
   * '/' 这一项只匹配根本身：`'/' + '/'` 是 '//'，任何规范化后的路径
   * 都不会以它开头 —— 所以删 `/data` 不受影响，只有 '/' 自己被拦。
   */
  return FS_FORBIDDEN.some((f) => {
    const ff = cmpPath(f);
    if (!ff) return false;
    return p === ff || p.startsWith(ff + '/');
  });
}

/**
 * 渲染之后的路径能不能用。返回空串表示没问题。
 *
 * ================= 为什么运行时还要再校验一遍 =================
 *
 * 编辑期的校验（nodeValidate 的 vFs）只看**填了没填**，
 * 而路径支持模板 —— `{{n1.output}}` 在编辑期是一个合法的非空值，
 * 圆点是绿的。运行时 n1 没产出，模板**原样保留**（见 engine/template），
 * 于是 fs_op 收到的是字面量 `{{n1.output}}`：
 *
 *   · write / mkdir → 磁盘上真的多出一个叫 `{{n1.output}}` 的东西
 *   · delete        → 去删一个叫这名字的路径
 *
 * 不报错、日志干净，而结果完全不是用户要的。
 * 这类"跑了但结果是错的"比直接失败难查得多。
 *
 * ================= 为什么不校验内容 =================
 *
 * write / append 的 content 空着是合法的（建空文件、追加空串），
 * 判它缺参会让用户去填一个本来就该空着的值。
 */
export function fsRenderIssue(
  op: string, path: string, target: string, hasUnresolved: (s: string) => boolean,
): string {
  if (!String(path ?? '').trim()) {
    return '路径是空的 —— 上游没产出，模板变量没渲染出值';
  }
  if (hasUnresolved(path)) {
    return '路径里有没渲染出来的模板变量 —— 会拿字面量当路径用，去检查上游有没有产出';
  }
  if (fsNeedsTarget(op)) {
    if (!String(target ?? '').trim()) {
      return '这个操作需要目标路径，而它是空的';
    }
    if (hasUnresolved(target)) {
      return '目标路径里有没渲染出来的模板变量 —— 会拿字面量当路径用';
    }
    if (fsForbidden(target, op)) {
      return `目标路径 ${target} 属于不允许改动的位置`;
    }
  }
  if (fsForbidden(path, op)) {
    return `${path} 属于不允许改动的位置 —— 换一个路径`;
  }
  return '';
}
