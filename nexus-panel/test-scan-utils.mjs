/**
 * 扫描类测试的共用工具
 * ============================================================
 * 本仓库的测试大量做法是「读源码文本 → 正则匹配 → 断言」。
 * 这类扫描有个反复踩的坑：**注释和代码共用一套字符集**，正则分不清。
 *
 * 已发生过多次同类事故：
 *   - 注释里写了 `.fpx-links-bar { gap: 8px }` → 被当成"已定义"，
 *     死类名扫描形同虚设（明明没定义却报"已修复"）
 *   - 注释里引用旧写法 `export { STYLE_PARAMS } from ...` →
 *     核对远端时误判成"修复没生效"
 *   - 幽灵规则改成「注释停用」后，停用块里留着完整的 `.add-row { ... }`
 *     规则体 → 令牌守卫把停用块当真规则，导致紧随其后的 `.kind-btn`
 *     报"无阴影来源"（CSS 里明明写着 var(--ctl-shadow)）
 *
 * 所以：**凡是读 CSS/JS/TSX 做文本扫描的，一律先过这里**。
 * 全仓只此一份实现，避免各写一份再漂移（此前有 4 份各自内联的版本）。
 */

/* ---- 剥块注释 ---- */

/**
 * 去掉 /* … *\/ 块注释，替换成一个空格（不是空串）。
 *
 * 为什么是空格而不是空串：
 *   `a/* x *\/\/ b` 若替换成空串会粘成 `ab`，空格则保持 `a b`，
 *   不会把相邻 token 意外连起来。
 *
 * 为什么**不处理** `//` 行注释：
 *   CSS 里没有 `//`；而 JS/TSX 里 `https://`、`file://` 这类 URL 会被
 *   误当成注释开头，把整行后半截吞掉。收益远小于风险，故不支持。
 *   需要剥行注释的场景请自行处理，不要改这个函数。
 *
 * 为什么**不处理**字符串字面量里的 `/*`：
 *   实测全仓疑似案例 42 处，**几乎全部落在测试文件自身**（它们本来就在
 *   处理注释逻辑，注释里还引用了 `/*` 符号本身）。生产代码基本为零。
 *   为这极少的情况引入字符串状态机，反而会带进真正的解析 bug
 *   （模板串、转义、嵌套引号都很难做对）。故保持简单语义。
 */
export function stripComments(code) {
  return String(code).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 块注释 + `//` 行注释一起剥（扫 JS/TSX/Rust 时用）。
 *
 * 与 stripComments 的区别：JS/TS/RS 里确实有 `//` 注释，而 CSS 没有。
 *
 * 为什么行注释的判据是 `(^|\s)\/\/` 而不是裸 `\/\/`：
 *   `https://`、`file://`、路径 `a//b` 里的 `//` 前面是 `:` 或 `:` 以外的
 *   非空白字符，裸判据会把整行后半截吞掉 —— 实测会连真实代码一起剥掉。
 *   行首、行尾（`x = 1; // 说明`）、缩进后这三种真注释形态，其 `//` 前面
 *   必然是行首或空白，都能被 `(^|\s)` 覆盖，所以这个判据**既安全又不漏**。
 */
export function stripCommentsJs(code) {
  return stripComments(code).replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * 块注释，替换成**空串**（stripComments 是替换成空格）。
 *
 * 什么时候必须用这个而不能用 stripComments：
 *   扫 Rust 标注、扫连续 token 时（`#[tauri::command]`、`fn` 紧邻注释等），
 *   留一个空格会把原本连续的记号切断，导致匹配失败。
 *   实测 command-consistency 用空格版会掉 24 项 —— 不是误报，是匹配不上。
 *
 * 什么时候反而**不该**用这个：
 *   注释夹在两个记号中间时（`a`、注释、`b`），去掉注释会把它们直接粘成
 *   一个不存在的记号 `ab`。扫 CSS / 扫类名时请用 stripComments（留空格），
 *   不要图省事用这个。
 */
export function stripCommentsFlat(code) {
  return String(code).replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * stripCommentsFlat + 行注释（扫 mindmap 这类 JS/TSX 源码时用）。
 *
 * 为什么行注释判据是 `(^|\s)` 而不是裸 `\/\/`：
 *   历史内联写法用的是"裸的行注释正则"（匹配两个斜杠直到行尾），它会把
 *   `https://`、`file://` 从斜杠处起整行后半截吞掉 —— 扫到含 URL 的源码时，
 *   断言其实在检查一段
 *   被截断的文本（可能假绿）。mindmap-test 里这种写法有 55 处。
 *   实测：全量换成 `(^|\s)` 后 3035 项断言结果完全不变 —— 说明**当前**
 *   被扫内容里没有 URL，属潜在风险而非现存 bug；但换成安全判据之后，
 *   将来有人往被扫文件里加 URL 也不会再踩。
 */
export function stripCommentsFlatJs(code) {
  return stripCommentsFlat(code).replace(/(^|\s)\/\/.*$/gm, '$1');
}

/* ---- 便捷读文件 ---- */

import { readFileSync } from 'node:fs';

/** 读文件并直接剥注释 —— 覆盖 `stripComments(readFileSync(p,'utf8'))` 这个高频组合 */
export function readStripped(path) {
  return stripComments(readFileSync(path, 'utf8'));
}

/* ---- 汇总行解析 ---- */
/**
 * 测试脚本末尾那行「通过 N 项，失败 M 项」—— 全仓不统一，这里把每种写法列全。
 *
 * ⚠️ 曾经漏掉「数字在前」那一族（"依赖清单：59 通过 / 0 失败"），后果不是漏报 ——
 *    退出码 0 却解析不出汇总行 → 被判成「可疑」，把 246 条断言的 runtime-deps、
 *    59 条的 deps-manifest 一起列进"可疑"，真可疑项淹没在假警报里，体检单从此没人看。
 *
 * 解析不出时返回 `pass: null`（不是 0）—— 调用方靠它区分
 *   · 跑完了但是 0 条断言（pass === 0，可疑）
 *   · 根本没跑到汇总行（pass === null，崩在半路）
 * 两者在体检单上是两回事，混成一个值就会把"崩了"当成"通过"。
 *
 * 判据只留这一份：sweep-tests.mjs（体检）与 cwd-invariant-test.mjs
 * （换目录跑结果必须一致）都从这里 import。分成两份会各改各的，
 * 一边认得出、一边认不出，体检单上就只有一半可信。
 */
export const SUMMARY = [
  /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/,
  /(\d+)\s*passed\s*,\s*(\d+)\s*failed/i,
  /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/,
  /通过\s*(\d+)\s*项/,
  /(\d+)\s*\/\s*(\d+)\s*(?:通过|通过项)/,
  /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/,   // 数字在前：deps-manifest / runtime-deps / theme-tokens / publish-update
  /(\d+)\s*项通过/,                      // 只报通过数：md-render
];

export function parseSummary(out) {
  for (const re of SUMMARY) {
    const m = String(out).match(re);
    if (m) return { pass: Number(m[1]), fail: m[2] !== undefined ? Number(m[2]) : 0 };
  }
  return { pass: null, fail: null };
}
