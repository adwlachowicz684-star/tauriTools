/**
 * 输入法（IME）组合期间的按键：这一下归输入法，不归界面。
 *
 * 中文 / 日文输入时，**回车是「把候选词上屏」，Esc 是「取消这次组合」**——
 * 都不是界面上那个「确定 / 取消」。组合中浏览器照样派发 keydown
 * （Chrome / Edge 给 `isComposing`，部分 IME 与老 Safari 只给 keyCode 229），
 * 不拦的后果按严重度排：
 *
 *   1. **改名弹窗**（RenameDialog / RenameContentDialog）：
 *      拼音打完按回车选词 → 文件夹被改名成拼音串，弹窗还关上了。
 *      磁盘上真多出一个叫 `xinmingcheng` 的目录，而用户以为自己在选词，
 *      **全程没有任何报错**。层级改名更糟：一次改写 N 个条目的物理名。
 *   2. **新建 / 自定义名**（dialogCards 新建目录、LinkPanel 自定义链接名）：
 *      同上，建出一个名字是拼音的目录或链接名。
 *   3. **页签 / 分类改名**（CardGrid、TabManagerDialog、StackedGroups、
 *      LinkPanel 改名行）：写进 config 的也是拼音串，刷新后还在。
 *   4. **Esc**：只是丢掉刚打的字、不写盘，但一样要拦——否则用户
 *      想取消候选词，整个弹窗却关了。
 *
 * **只在组合中那一帧放行**：拦下来之后输入法照常上屏，用户再按一次回车
 * （此时已不在组合中）才真的提交。所以这不是"禁用回车键"，
 * 是"这一下回车归输入法"。
 *
 * 两条判据都留着：`isComposing` 是标准属性；`keyCode === 229` 是那些
 * 不给 isComposing 的环境**唯一**的线索（229 即"这个键被 IME 吃掉了"
 * 的约定值）。只认一条会在某个浏览器 / 某个输入法上漏。
 *
 * **传 `e.nativeEvent`，不是合成事件 `e`**：React 的合成键盘事件不转发
 * `isComposing`，只有原生事件上有。传错会得到 false —— 也就是守卫静默
 * 失效、回到不拦的老样子，所以调用点一律写成 `isComposing(e.nativeEvent)`。
 */
export function isComposing(n?: { isComposing?: boolean; keyCode?: number }): boolean {
  if (!n) return false;
  return n.isComposing === true || n.keyCode === 229;
}
