import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 节点库「说明」的呈现方式。
 *
 * ================= 要什么 ====================
 *
 * 说明**一律走悬浮窗**（NodeTip），列表里不再内联铺任何说明行。
 *
 * 标题右侧那个开关控制的是**被动触发**：
 *   开 → 鼠标掠过条目即弹说明浮层（预览）
 *   关 → 只有点击才打开（钉住）
 *
 * ================= 为什么不再在条目下铺一行 ====================
 *
 * 铺行有两个问题：
 *   ① 列表整体变长、条目错位 —— 铺开前找到的位置全变了
 *   ② 侧栏只有 260px，一行放不下，说明被截成半句，反而更想点开看
 *
 * ================= 守卫什么 ====================
 *
 * ① 开关存在，两个态可辨（文案本身要能看出开/关）
 * ② 列表里**没有**内联说明行（这是本轮的核心：说明只走浮层）
 * ③ 每条节点用自己的 type 取说明
 *    以前写 `getDef(g.presets[0].type)` —— 用分组**第一条**的，
 *    于是同组里没有 hint 的预设会显示别人的说明。
 *    说明张冠李戴，而它看起来完全正常，是最难发现的那一类。
 * ④ 开关关着时，掠过仍能看到一句（原生 title）——
 *    否则关掉开关等于说明彻底消失
 */

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');
const SB = path.join(ROOT, 'components/Sidebar.tsx');

/** 剥注释 —— 注释里为说明"以前错在哪"会把旧写法原样写出来，不剥会假阴性 */
function strip(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}

function sidebar(): string {
  return strip(fs.readFileSync(SB, 'utf-8'));
}

test('有说明开关，且两个态可辨', () => {
  const t = sidebar();
  assert.match(t, /setHoverDesc/, '没有 hoverDesc 状态');
  // 文案本身要能看出开还是关 —— 只写"说明"的话点了不知道生效没有
  assert.match(t, /hoverDesc \? '悬停说明 开' : '悬停说明 关'/);
  // 开着时按钮自己也要变样：否则光看按钮分不清当前是哪一态
  assert.match(t, /side-head-btn'\s*\+\s*\(hoverDesc \? ' is-on' : ''\)/);
});

test('列表里不再内联铺说明行（说明只走浮层）', () => {
  /*
   * 这是本轮的核心。
   *
   * 铺行会造成列表错位（铺开前找到的位置全变了），
   * 而且 260px 一行放不下，说明被截成半句。
   *
   * 不能只查"文件里不含 side-desc-brief"——
   * 注释里为了说明"为什么挪走"，正好要把这个类名原样写出来，
   * 那样检查永远通过（假阴性）。所以匹配的是**渲染动作**。
   */
  const t = sidebar();
  assert.ok(
    !/side-desc-brief\s*["']?[^>]{0,80}>/.test(t),
    '条目下又铺了说明行 —— 说明应该只走悬浮窗',
  );
  // 悬浮窗本体要在
  assert.match(t, /<NodeTip/, '说明要走 NodeTip 浮层');
});

test('浮层弹出时条目不挂原生 title（否则双重提示）', () => {
  /*
   * 两者都给的话，悬停一处会同时冒两个提示：
   * 浏览器的原生 tooltip + 我们的浮层，互相挡、还错位。
   *
   * 所以 title 必须是"浮层会弹 → 不挂"的条件式，
   * 不能是无条件的一个字符串。
   */
  const t = sidebar();

  /*
   * 从**反向**查：无条件挂 title 的写法长这样
   *     title={ disabled ? '运行中不可添加' : `...` }
   * 只要它还在，就说明某处仍在双重提示。
   *
   * 不能只从正向数"有几处写了条件式" ——
   * 侧栏有两类条目（内置节点 / MCP 工具），
   * 只改一处的话正向检查照样通过（假阴性）。
   */
  assert.ok(
    !/title=\{\s*disabled\s*\?/.test(t),
    '有条目仍无条件挂原生 title —— 浮层弹出时会双重提示',
  );
  // 两类条目都要条件化
  assert.equal(
    (t.match(/hoverDesc\s*&&\s*!disabled/g) ?? []).length, 2,
    '内置节点与 MCP 工具的 title 都要按浮层会不会弹来定',
  );
});

test('浮层不弹时仍有兜底：原生 title 带说明', () => {
  /*
   * 关掉开关后浮层不弹。若原生 title 也没有，
   * 说明就彻底看不见了 —— 用户会以为功能坏了。
   */
  const t = sidebar();
  assert.match(t, /\$\{desc\}/, '兜底 title 要带上那一句说明');
});

test('操作引导搬进浮层（不再依赖原生 title）', () => {
  /*
   * 引导原先写在条目的原生 title 里。
   * 现在浮层弹出时 title 不挂了，引导必须搬进浮层，
   * 否则开着开关时反而看不到"怎么添加"。
   */
  const t = sidebar();
  assert.match(t, /side-desc-add/, '浮层里要有操作引导');
  // 引导统一在一处收尾，不再每个类型各写一遍
  assert.equal((t.match(/side-desc-add/g) ?? []).length, 1,
    '操作引导只该有一处，多处会各自漂移');
});

test('每条节点用自己的 type 取说明', () => {
  const t = sidebar();
  /*
   * 这是当初那个 bug 的直接位置。
   * 不剥注释的话，注释里那句"以前写的是 def（= g.presets[0].type…）"
   * 会让检查永远通过 —— 是假阴性。
   */
  assert.ok(
    !/getDef\(g\.presets\[0\]\.type\)/.test(t),
    '不该用分组第一条节点的 def 取说明 —— 同组里会显示错的说明',
  );
  assert.match(t, /getDef\(p\.type\)/, '每条预设要按自己的 type 取 def');
});

test('MCP 工具也能看说明', () => {
  /*
   * MCP 是独立子组件，浮层的开关要透传下去。
   * 漏传的话：内置节点有说明、MCP 工具没有 ——
   * 看着像"MCP 工具本来就没说明"，实际是漏传。
   */
  const t = sidebar();
  assert.match(t, /onHover=\{onHover\}/, 'MCP 子组件的悬停回调要接上');
});


