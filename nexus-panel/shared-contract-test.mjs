/**
 * 共享模块契约测试
 * ============================================================
 * 守的是「同一件事只有一份实现」这件事本身。
 *
 * 起因（第 30 轮架构核对）：主面板 ↔ 插件的边界上，有几样东西被抄成了
 * 两份，两份各自都能跑，于是长期没人发现它们**不一致**：
 *
 *   · 快捷键匹配：host.js 认小键盘数字、不认 F5/esc/space/'?'；
 *     plugin-sdk.js 正好相反。插件声明 Ctrl+F5 → 注册成功、永不触发、
 *     **不报错**。
 *   · 平台判断：host.js / plugin-sdk.js / shell-shortcuts.js 三份，
 *     连读 platform 还是 userAgent 都不一样。
 *   · 存储键：host.js 与 plugin-sdk.js 各自拼 `nexus:<id>:<k>`。
 *     两种挂载模式落到同一份 localStorage，键名岔开就是
 *     "这边存的、那边读不到"，且不报错（读不到只是返回默认值）。
 *
 * 这类问题的共同形状是**两侧各自看自己代码都没问题**，所以光有
 * 单侧测试永远抓不到 —— 必须有一条判据同时看两侧。
 *
 * 本文件只做两件事：
 *   ① 钉住"实现只有一份、两侧都在用它"（源码级，防再次分叉）
 *   ② 钉住"合并后的语义是两边的并集"（行为级，防合并时丢行为）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* 保偏移剥注释：源码判据不能被注释里的说明文字骗过去
   （"这里不再有 X" 这句话本身含 X，不剥注释就会假绿）。 */
import { stripCommentsJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, rel), 'utf8');
const code = (rel) => stripCommentsJs(src(rel));

let pass = 0; let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${extra ? ` → ${extra}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`); }
};

/* ================================================================
   1. 快捷键：实现只有一份，三处都用它
   ================================================================ */
console.log('\n--- 1. 快捷键判据只此一份 ---');

const ACC = 'js/accel.js';
const hostC = code('js/host.js');
const sdkC = code('js/plugin-sdk.js');
const shellC = code('js/shell-shortcuts.js');
const cfgC = code('js/plugin-config.js');

/*
 * 手拼字面量的判据。
 *
 * ⚠️ 第一版写的是 /nexus:\$\{/，对 plugin-config.js 的
 *    `nexus:plugin-cfg:${id}` **永远为真**（判绿）——
 *    因为 `nexus:` 与 ${ 之间还隔着 plugin-cfg。
 *    实测把它改回手拼，守卫照样 42/0 全绿，是一条假绿。
 *
 * 所以判据必须允许中间有内容，但不能跨出这个字符串字面量
 * （用 [^`'"\n] 隔断，免得把别处的无关代码也算进来）。
 */
const HAND_ROLLED = /nexus:[^`'"\n]*\$\{/;

t('共享模块存在', (() => { try { src(ACC); return true; } catch { return false; } })());

/* 三处**不得**再有本地实现 —— 这是"只此一份"的正面判据。
   注意用剥注释后的源码：注释里会讲到这些函数名，不剥就永远为真。 */
t('host.js 不再自带 accelMatches 实现', !/function\s+accelMatches\s*\(/.test(hostC));
t('plugin-sdk.js 不再自带 matchCombo 实现', !/function\s+matchCombo\s*\(/.test(sdkC));
t('plugin-sdk.js 不再自带 parseCombo 实现', !/function\s+parseCombo\s*\(/.test(sdkC));
t('plugin-sdk.js 不再自带 isMac 实现', !/function\s+isMac\s*\(/.test(sdkC));
t('shell-shortcuts.js 不再自带 isMac 实现', !/function\s+isMac\s*\(/.test(shellC));

/* 三处**必须**真的引用了共享模块 —— 否则上面五条会因为"两边都删光了"而全绿，
   那是最危险的假绿：没有实现了，判据反而通过。 */
t('host.js 引用共享模块', /from\s+'\.\/accel\.js'/.test(hostC));
t('plugin-sdk.js 引用共享模块', /from\s+'\.\/accel\.js'/.test(sdkC));
t('shell-shortcuts.js 引用共享模块', /from\s+'\.\/accel\.js'/.test(shellC));

/* 元断言：判据认得出合成样本（不是"永远为真"） */
{
  const probe = 'function accelMatches(e, accel) { return false; }';
  t('判据认得出内联实现（合成样本）', /function\s+accelMatches\s*\(/.test(stripCommentsJs(probe)));
  t('判据不误伤"调用"写法（不是见到名字就红）',
    !/function\s+accelMatches\s*\(/.test(stripCommentsJs('if (!accelMatches(e, accel)) return;')));
}

/*
 * 全仓扫描：**plugins/ 也在范围内**。
 *
 * 上面五条只看了 host / sdk / shell 三处（收敛时改动的那三个文件），
 * 于是 plugins/toolbar-inspector/module.js 里抄的第三份 isMac 一直没被发现——
 * 它与 accel.js 那份**逐字相同**。
 *
 * 逐字相同比语义分叉更隐蔽：语义分叉至少现在就报错，逐字相同现在一切正常，
 * 直到谁改了 accel.js 那份（换判据、加 iPad），这里不跟着变 —— 于是
 * 「按钮提示里写的键」和「实际触发的键」成了两回事，且不报错：
 * 用户看到「⌘+Shift+D」按下去没反应，不会想到提示读的是另一份。
 *
 * 只扫改动过的三个文件 = 只守住了收敛范围的一半。
 */
{
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'target', '__pycache__', '.vite', 'docs']);
  const EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx']);
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(join(HERE, d), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (EXTS.has(extname(e.name))) files.push(rel);
    }
  })('');
  /* 生产代码：排除测试（里面有合成样本，是判据的自检素材）
     与 .d.ts（类型声明不是实现，且 plugin-sdk.d.ts 刻意保留具名导出）。 */
  const prod = files.filter((f) => !/-test\.mjs$/.test(f) && !/\.test\.[tj]sx?$/.test(f)
    && !f.endsWith('.d.ts'));
  const OWN = /(?:function\s+|const\s+)(?:isMac|accelMatches|parseCombo|matchCombo)\s*[=(]/;
  const owners = prod.filter((f) => OWN.test(code(f)));

  t('生产代码里只有 accel.js 一份快捷键实现（全仓扫，含 plugins/）',
    owners.length === 1 && owners[0] === ACC, `命中=[${owners}]`);
  /* 防"扫描范围为空"的恒绿：范围一旦空了，上面那条永远为真。 */
  t('扫描范围非空（防恒绿）', prod.length > 100, `生产文件 ${prod.length} 个`);
  t('扫描范围确实含 plugins/（否则等于没扫插件）',
    prod.some((f) => f.startsWith('plugins/')), `plugins 下 ${prod.filter((f) => f.startsWith('plugins/')).length} 个`);
  t('判据认得出内联实现（合成样本）', OWN.test(stripCommentsJs('function isMac() { return false; }')));
  t('判据也认得出 const 箭头形态（合成样本）', OWN.test(stripCommentsJs('const isMac = () => false;')));
  t('判据不误伤 import 写法', !OWN.test(stripCommentsJs("import { isMac } from '../../js/accel.js';")));
}

/* ================================================================
   2. 合并后的语义是两边的并集（行为级）
   ================================================================ */
console.log('\n--- 2. 语义取并集（两边原本能匹配的都仍匹配）---');

const { parseCombo, matchCombo, accelMatches, isMac } = await import('./js/accel.js');

const ev = (o) => ({
  key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o,
});

/* 来自 SDK 那份的行为：功能键 / esc / space / '?' */
t("功能键 f5 可匹配（原宿主那份不认）", accelMatches(ev({ key: 'F5', code: 'F5' }), 'f5'));
t("esc 可匹配（原宿主那份不认）", accelMatches(ev({ key: 'Escape', code: 'Escape' }), 'esc'));
t("space 可匹配", accelMatches(ev({ key: ' ', code: 'Space' }), 'space'));
t("'?' 可匹配", accelMatches(ev({ key: '?', shiftKey: true }), 'shift+?'));
t("super 与 meta 同义", accelMatches(ev({ key: 'k', metaKey: true }), 'super+k'));

/* 来自宿主那份的行为：数字键兼容主键盘与小键盘 */
t("主键盘数字匹配 Digit", accelMatches(ev({ key: '1', code: 'Digit1', ctrlKey: true }), 'ctrl+1'));
t("小键盘数字匹配 Numpad（原 SDK 那份不认）", accelMatches(ev({ key: '1', code: 'Numpad1', ctrlKey: true }), 'ctrl+1'));
t("小键盘数字在无 code 时按 key 匹配", accelMatches(ev({ key: '1', ctrlKey: true }), 'ctrl+1'));
t("数字键不按 ctrl 就不触发（修饰键仍严格）", !accelMatches(ev({ key: '1', code: 'Digit1' }), 'ctrl+1'));

/* 两边共有的严格性：修饰键必须精确，未声明的没按才算匹配 */
t('修饰键必须精确（多按 alt 不触发）', !accelMatches(ev({ key: 'k', ctrlKey: true, altKey: true }), 'ctrl+k'));
t('功能键不会被同名普通键误触发', !accelMatches(ev({ key: 'k' }), 'f5'));
t('非法 combo 永不匹配', !accelMatches(ev({ key: 'k', ctrlKey: true }), 'ctrl+') && !accelMatches(ev({ key: 'k' }), ''));

/* mod 的平台差异：非 macOS 认 Ctrl */
{
  const nonMac = !isMac();
  t(`mod 按平台展开（当前视为${nonMac ? '非 Mac' : 'Mac'}）`,
    nonMac
      ? accelMatches(ev({ key: 'k', ctrlKey: true }), 'mod+k') && !accelMatches(ev({ key: 'k', metaKey: true }), 'mod+k')
      : accelMatches(ev({ key: 'k', metaKey: true }), 'mod+k') && !accelMatches(ev({ key: 'k', ctrlKey: true }), 'mod+k'));
}
t('parseCombo 无主键时返回 null', parseCombo('ctrl+shift+') === null && parseCombo('') === null);

/* ================================================================
   3. 存储键：两侧同源
   ================================================================ */
console.log('\n--- 3. 存储键两侧同源 ---');

const { storeKey, storePrefix, pluginCfgKey } = await import('./js/plugin-store.js');

t('共享模块存在', (() => { try { src('js/plugin-store.js'); return true; } catch { return false; } })());

/* 两侧都不得再手写字面量 —— 这是"岔开"的唯一入口 */
t('host.js 不再手拼 nexus:<id>: 字面量', !HAND_ROLLED.test(hostC));
t('plugin-sdk.js 不再手拼 nexus:<id>: 字面量', !HAND_ROLLED.test(sdkC));
t('plugin-config.js 不再手拼 nexus:<id>: 字面量', !HAND_ROLLED.test(cfgC));
t('host.js 引用共享模块', /from\s+'\.\/plugin-store\.js'/.test(hostC));
t('plugin-sdk.js 引用共享模块', /from\s+'\.\/plugin-store\.js'/.test(sdkC));
t('plugin-config.js 引用共享模块', /from\s+'\.\/plugin-store\.js'/.test(cfgC));

/* 卸载清理（host.js 侧）与配置读写（plugin-config.js 侧）用的是**同一个**
   cfg 键函数 —— 两边拼法岔开就是"卸载了配置还在"，且不报错。 */
t('cfg 键两侧同源（卸载清理 = 配置读写的键）',
  /pluginCfgKey/.test(hostC) && /pluginCfgKey/.test(cfgC));

/* 两侧调用形态必须一致 —— 只 import 了还不够，
   一边用 storeKey(id,k) 一边用别的写法照样会岔开。 */
const callShape = (c) => [...c.matchAll(/storeKey\(\s*([A-Za-z_$][\w$]*)\.id\s*,\s*([A-Za-z_$][\w$.]*)\)/g)]
  .map((m) => `${m[1]}.id|${m[2]}`);
const hostShapes = callShape(hostC);
const sdkShapes = callShape(sdkC);
t('两侧 storeKey 调用形态一致（否则读到两个键）',
  hostShapes.length > 0 && sdkShapes.length > 0
  && hostShapes.every((s) => sdkShapes.includes(s)) && sdkShapes.every((s) => hostShapes.includes(s)),
  `host=[${hostShapes}] sdk=[${sdkShapes}]`);

/* 形态与产出 */
t('storeKey 产出 nexus:<id>:<k>', storeKey('demo', 'a') === 'nexus:demo:a');
t('storePrefix 带结尾冒号（否则 nexus:ab: 会被 nexus:a 误伤）', storePrefix('demo') === 'nexus:demo:');
t('pluginCfgKey 与 store 分开存', pluginCfgKey('demo') === 'nexus:plugin-cfg:demo'
  && !pluginCfgKey('demo').startsWith(storePrefix('demo')));

/* 卸载清理的边界：账本前缀不能落进 store 前缀的清理范围，
   否则卸载插件会把"将来手工清理"的依据一起删掉。 */
{
  const fsC = code('js/plugin-fs.js');
  const m = fsC.match(/const\s+PREFIX\s*=\s*'([^']+)'/);
  t('取得到文件账本前缀', !!m, m ? m[1] : '未找到');
  if (m) {
    const fp = m[1];
    const bad = ['demo', 'my-plugin', 'a', 'toolbar-inspector']
      .filter((id) => fp.startsWith(storePrefix(id)) || storePrefix(id).startsWith(fp));
    t('账本前缀与 store 前缀不相交（否则卸载会误删账本）', bad.length === 0, bad.length ? `相交于 ${bad}` : '');
  }
  /* plugin-fs.js 刻意保持零运行时依赖（N59：沙盒依赖会被 npm install 裁剪），
     所以**不许**为了"统一前缀"让它依赖共享模块。这条钉住那个取舍。 */
  t('plugin-fs.js 保持零依赖（未 import 共享模块）', !/from\s+'\.\/plugin-store\.js'/.test(fsC));
}

/* 元断言 */
{
  const probe = "localStorage.getItem(`nexus:${manifest.id}:${payload.k}`)";
  t('判据认得出手拼字面量（合成样本）', HAND_ROLLED.test(stripCommentsJs(probe)));
  /* 上面那条假绿的回归测试：中间还隔着 plugin-cfg 的写法也必须认出来 */
  t('判据认得出"中间还有内容"的写法（合成样本）',
    HAND_ROLLED.test(stripCommentsJs('const KEY = (id) => `nexus:plugin-cfg:${id}`;')));
  t('判据不误伤注释里的说明（已剥注释）',
    !HAND_ROLLED.test(stripCommentsJs('// 键形如 `nexus:${id}:${k}`，见共享模块')));
  t('共享模块的调用不算手拼（不误伤调用方）',
    !HAND_ROLLED.test(stripCommentsJs('const k = storeKey(id, k);')));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
