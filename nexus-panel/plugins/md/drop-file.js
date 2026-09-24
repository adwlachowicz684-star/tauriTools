/**
 * md 插件 —— 拖入（E1）判定逻辑
 * ============================================================
 * 刻意做成**纯函数**，不碰 DOM、不碰 React：
 * 这样能在 node 里直接跑（md-drop-test.mjs），
 * 而不是靠"人眼看界面拖一下"来验证。
 *
 * 为什么不需要文件路径（这是本文件存在的前提）
 * ------------------------------------------------------------
 * project-group 拖入要的是**路径**（要把目录登记进配置），
 * 所以它被 `dragDropEnabled` 的取值卡住：
 *   true  → Tauri 接管，拿得到路径，但 HTML5 拖放失效
 *   false → HTML5 拖放可用，只有 File 对象，**拿不到路径**
 *
 * 而 md 阅读要的是**内容**，不是路径 ——
 * `File.text()` 直接就把全文读出来了。
 * 所以本插件在 `dragDropEnabled: false`（宿主现值）下**照样能拖入**，
 * 不需要动那个配置，也不卷入 project-group 那边的取舍。
 */

/** 超过这个体积不再读：一篇 md 到这个量级，读进来编辑器也会卡死 */
export const MAX_DROP_BYTES = 2 * 1024 * 1024;

/**
 * 一眼看上去像 Markdown / 纯文本的扩展名。
 *
 * 刻意**宽容**：不是这些后缀也不拒绝，交给后面的二进制检测兜底。
 * 原因是很多人把 md 存成 .txt、或者直接无扩展名；
 * 用白名单硬卡会挡掉一堆正常文件，而漏放行一个文本文件的代价是零。
 */
export const TEXT_EXT = /\.(md|markdown|mdown|mkd|mdtext|mdtxt|txt|text|rst|org)$/i;

/**
 * 拖进来的到底是什么。
 *
 * @param {{
 *   files?: ArrayLike<{name?:string,size?:number}>,
 *   items?: ArrayLike<{webkitGetAsEntry?: () => ({isDirectory?:boolean}|null)}>,
 * }} dt  dataTransfer（真事件或测试里的同形对象都行）
 * @returns {{
 *   kind: 'empty'|'folder'|'too-large'|'text'|'binary-unknown',
 *   file?: {name?:string,size?:number},
 *   message?: string,
 *   extra?: number,
 * }}
 *
 * 四种 kind 的含义：
 *   empty          —— 一个文件都没有（拖的是**文字或链接**）
 *   folder         —— 拖的是文件夹
 *   too-large      —— 超体积上限
 *   text           —— 可以读
 *   binary-unknown —— 扩展名不在白名单里，需要在读完之后再做二进制检测
 *
 * 刻意不在这里就按扩展名拒掉非白名单文件：
 * 只读扩展名判断不了它是不是文本，读完之后看有没有 \0 才准。
 */
export function classifyDrop(dt) {
  const files = Array.from(dt?.files || []);
  const items = Array.from(dt?.items || []);

  /* ① 先看有没有真文件。
     拖一段选中的文字进来时 types 里有 text/plain 但 files 是空的 ——
     不判这一步，就会拿 undefined 去读，弹"打开失败"，
     而用户拖的是文字，根本不该有这一步（project-group 早期就是这么错的）。 */
  if (!files.length) {
    return { kind: 'empty', message: '拖进来的不是文件（文字或链接读不出内容）' };
  }

  /* ② 文件夹：webkitGetAsEntry 是标准 API，drop 时同步可读。
     文件夹本身没有内容可读（要递归遍历），所以直接拒，
     并明确说"请拖入文件" —— 说"不支持"用户不知道该改成什么。 */
  const isDir = items.some((it) => {
    try {
      return it?.webkitGetAsEntry?.()?.isDirectory === true;
    } catch {
      return false;
    }
  });
  if (isDir) {
    return { kind: 'folder', message: '请拖入文件，不是文件夹' };
  }

  const file = files[0];
  const extra = files.length - 1;

  /* ③ 体积：before 读，读进来再判就已经占掉内存了 */
  if (typeof file?.size === 'number' && file.size > MAX_DROP_BYTES) {
    return {
      kind: 'too-large',
      file,
      extra,
      message: `文件过大（${formatBytes(file.size)}），上限 ${formatBytes(MAX_DROP_BYTES)}`,
    };
  }

  const name = String(file?.name || '');
  if (TEXT_EXT.test(name)) return { kind: 'text', file, extra };
  /* 扩展名不在白名单 —— 不拒，读完之后再看是不是二进制 */
  return { kind: 'binary-unknown', file, extra };
}

/**
 * 多文件时给用户的说明。
 *
 * 只取第一个但**必须说清楚**：静默丢弃会让用户以为打开的就是想要那个，
 * 看内容发现不对时不会想到"原来拖了两个"。
 */
export function multiFileNote(extra) {
  if (!extra || extra <= 0) return '';
  return `一次只能打开一个文件，已打开第 1 个（另有 ${extra} 个被忽略）`;
}

/**
 * 读完之后判断是不是二进制。
 *
 * 判据只用 \0：文本文件里出现 NUL 字节基本不可能，
 * 而图片/pdf/压缩包里几乎必然出现 —— 简单且够准。
 *
 * 为什么需要这一步：扩展名可以骗人（.md 里塞张图、或者无扩展名的文本）。
 * 只看扩展名会把二进制当文本渲染出一屏乱码，
 * 而用户看到的是"插件坏了"，不会想到文件类型不对。
 */
export function looksBinary(text) {
  if (typeof text !== 'string') return true;
  return text.indexOf('\u0000') !== -1;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 从文件名里取展示用的标题。
 * 去掉扩展名：源区本来就显示的是内容，标题再带 .md 是重复信息。
 */
export function titleOf(name) {
  return String(name || '').replace(/\.[^./\\]+$/, '') || '未命名';
}
