/**
 * 路径比较键 —— **整个插件只有这一份实现**。
 *
 * 为什么单独成文件（而不是继续放在 `api.ts` 里）：
 * `api.ts` 里有 `const call = <T>(...)` 这类泛型箭头，测试工具剥类型时
 * 加载不了它（会 SyntaxError）。于是凡想单测的纯函数都不能挂在 api.ts 上，
 * 否则只能靠"源码里有 normalizeKey 这几个字"这类文本断言 ——
 * 而文本断言证明不了判据真的对（大小写 / 尾杠到底有没有归一）。
 *
 * `utils/tabs.ts` 要用它，正是被这条卡住才拆出来的。
 *
 * `api.ts` 另有一行转发它，供既有调用方使用 —— **转发而已，不要在那边
 * 再写一份实现**。
 *
 * ⚠️ 注释里不要写出 import 语句的形状（指名相对路径那种）：测试工具递归
 * 解析依赖时按"相对路径 import"扫**整份源码（含注释）**，会把注释里的
 * 那段当成真 import 去加载，路径对不上就 ENOENT，而报错指向测试工具
 * 内部，很难想到是注释里的字样闯的祸。（这句警告自己就踩过一次。）
 */

/**
 * 路径比较键：去首尾空白 → 去尾部分隔符 → 统一分隔符为正斜杠。
 *
 * `ci`（case-insensitive）**必须**由调用方按平台传入：
 *   - Windows：NTFS / FAT 文件名大小写不敏感，`Foo` 与 `foo` 是同一目录 → 传 true
 *   - Linux / macOS：大小写敏感，两者是**两个不同的目录** → 传 false
 *
 * 默认 false 是刻意的：宁可漏匹配（大不了选中态没跟上，看得见），
 * 也不能误合并（标签色 / 图标 / ACL 锁 / 链接记录互相覆盖，看不见）。
 *
 * 与 Rust 侧 store::normalize_key 同规则 —— 那边也只在 `cfg!(windows)` 时转小写。
 * 早期这里无条件 toLowerCase，与后端不一致，在 Linux/macOS 上会把 A/a 判成同一路径。
 *
 * ⚠️ 改这里必须同时看 `store::normalize_key`：两处一旦分叉，
 * 表现是"同一张卡片，路径写法对得上时操作生效、对不上时静默改到别处"。
 */
export function normalizeKey(p: string, ci = false): string {
  const s = p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return ci ? s.toLowerCase() : s;
}
