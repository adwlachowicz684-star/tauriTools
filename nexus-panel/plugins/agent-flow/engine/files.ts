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
