/**
 * 插件配置「说了保存其实没保存」
 * ====================================================================
 * 抽屉里的「严格沙箱」开关与「插件自选主题」两个下拉，写的是 localStorage。
 * 存储不可用（配额满 / 隐私模式 / 严格沙箱下被拒）时 `setItem` 会抛 ——
 * 那时**一个字节都没写进去**，而旧写法照样：
 *
 *   ① 开关：把按钮画成「已开启」+ 状态点变 on，再弹「已保存，重载插件后生效」
 *   ② 下拉：弹「已保存」，而主题是即时生效的 —— 写失败时 host 收不到
 *      配置变更事件、不会重推变量，插件外观一动不动
 *
 * 两处的后果都是**界面说 A、磁盘上是 B**，且全程不报错：
 * 用户照着「已保存」去重载插件，值还是旧的，只会以为"这个功能坏了"。
 * 谎报成功比不报更糟 —— 不报他还会再点一次，报了成功他就不会再确认了。
 *
 * 为什么是"抽出来真跑"而不是查源码里有没有那几个字：
 *   源码里有 `saved` 证明不了失败时开关真的停在原值上；
 *   源码里有 `sel.value = prev` 证明不了它排在失败分支里。
 *   所以三处调用点都按括号配平抽出后**实跑**，断言的是"调用之后界面停在哪"。
 *
 * 运行：node plugin-config-save-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.join(HERE, 'js/plugin-config.js');
const DTS = path.join(HERE, 'js/plugin-config.d.ts');
const SHELL = path.join(HERE, 'js/shell.js');
const REACT = path.join(HERE, 'src/components/SandboxSection.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/*
 * 崩溃必须显式失败，不能靠"进程退出"来表达 ——
 * 脚本崩在半路会把后面的断言全吃掉，报告上看着像"只红了几条"，
 * 其实后面的证据一条都没跑（本项目反复栽在这一条上）。
 */
process.on('unhandledRejection', (e) => {
  fail++;
  console.log(`❌ 出现未处理的 Promise 拒绝 → ${e?.message || e}`);
});

/* ---------------- 括号配平切片 ----------------
 * 用 indexOf('}') 取函数体会在内层 if 的右括号处截断 ——
 * 切片看着拿到了，其实只剩半截，后面的断言全成了"验了个空壳"。 */
function sliceBalanced(src, startMark, label) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`抽取失败（找不到起点）：${label}`);
  const open = src.indexOf('{', i);
  if (open < 0) throw new Error(`抽取失败（起点后没有 {）：${label}`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`抽取失败（括号不配平）：${label}`);
}

/* ================================================================
 * 第 1 节：plugin-config.js —— 如实回答落没落盘
 * ================================================================ */
{
  /*
   * 可控的 localStorage：**先装好再 import** —— 模块里没有顶级副作用读它，
   * 但 import 之后再去换 globalThis 上的对象，拿到的还是同一份引用才行，
   * 所以这里用一个可变对象、靠 throwNext 切换行为，而不是换引用。
   */
  const mem = new Map();
  let throwNext = false;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (throwNext) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      mem.set(k, String(v));
    },
  };
  /* Node 的 globalThis 不是 EventTarget，`dispatchEvent?.` 会被静默跳过 ——
     那样"没落盘却广播了"这条根本验不到。装一个最小的事件总线。 */
  const events = [];
  const subs = [];
  globalThis.addEventListener = (type, fn) => subs.push({ type, fn });
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = (ev) => { events.push(ev); subs.forEach((s) => s.fn(ev)); return true; };
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class { constructor(type, opt) { this.type = type; this.detail = opt?.detail; } };
  }

  const m = await import('./js/plugin-config.js');

  /* 一、成功 */
  throwNext = false;
  const r1 = m.savePluginConfig('p1', { isolated: true });
  t('写成功时 saved=true', r1.saved === true, `saved=${r1.saved}`);
  t('写成功时回的是合并后的配置', r1.config && r1.config.isolated === true, JSON.stringify(r1.config));
  t('写成功时读得到新值', m.getPluginConfig('p1').isolated === true);
  t('写成功时广播一次（host 靠它重推主题）', events.length === 1, `events=${events.length}`);

  /* 二、失败 ★ */
  events.length = 0;
  throwNext = true;
  const r2 = m.savePluginConfig('p1', { isolated: false });
  t('★ 写失败时 saved=false（而不是 undefined / true）', r2.saved === false, `saved=${r2.saved}`);
  t('★ 写失败时磁盘上仍是旧值', m.getPluginConfig('p1').isolated === true,
    `磁盘=${m.getPluginConfig('p1').isolated}`);
  t('★ 写失败时不广播（没落盘不能让宿主按新值重推）', events.length === 0, `events=${events.length}`);
  t('写失败时仍回出"想设的值"（供调用方回滚用）', r2.config && r2.config.isolated === false);

  /* 三、setPluginConfig 的对外契约不能变（插件侧按"回配置对象"在用） */
  throwNext = false;
  const r3 = m.setPluginConfig('p1', { themeDark: 'graphite' });
  t('setPluginConfig 仍只回配置对象（不破坏插件侧契约）',
    r3 && typeof r3 === 'object' && !('saved' in r3), JSON.stringify(r3));

  /* 四、d.ts 必须跟着导出 —— 声明漏了就是"类型说没有、实际有" */
  const dts = fs.readFileSync(DTS, 'utf8');
  t('d.ts 声明了 savePluginConfig（否则 React 侧编译不过）', /export function savePluginConfig\(/.test(dts));
}

/* ================================================================
 * 第 2 节：shell.js 的沙箱开关 —— 失败必须拨回去
 * ================================================================ */
const shellSrc = fs.readFileSync(SHELL, 'utf8');
const onclickSrc = sliceBalanced(shellSrc, 'btn.onclick = () => {', 'shell.js 沙箱开关 onclick');
t('抽到 shell.js 的沙箱开关（源结构没变）',
  /savePluginConfig/.test(onclickSrc) && /toast\(/.test(onclickSrc));

function buildToggle(wasOn, saved) {
  const toasts = [], cls = [], attrs = [], texts = [];
  const btn = {
    classList: { toggle: (c, on) => cls.push(`${c}=${on}`) },
    setAttribute: (k, v) => attrs.push(`${k}=${v}`),
  };
  const txt = { set textContent(v) { texts.push(v); }, get textContent() { return texts.at(-1); } };
  const desc = { textContent: '' };
  const fn = new Function(
    'btn', 'txt', 'desc', 'texts', 'toast', 'getPluginConfig', 'savePluginConfig', 'manifest', 'keyName',
    `${onclickSrc}; return btn.onclick;`,
  );
  const run = fn(btn, txt, desc, {},
    (msg, type) => toasts.push({ msg: String(msg), type }),
    () => ({ [('isolated')]: wasOn }),
    (id, patch) => ({ config: { isolated: !wasOn }, saved }),
    { id: 'p1' }, 'isolated');
  run();
  return { toasts, cls, attrs, text: texts.at(-1) ?? null, desc: desc.textContent };
}

{
  const ok = buildToggle(false, true);
  t('成功时开关画成已开启', ok.cls.some((x) => x === 'on=true'), JSON.stringify(ok.cls));
  t('成功时说已保存', ok.toasts.some((x) => x.type === 'ok' && /已保存/.test(x.msg)), JSON.stringify(ok.toasts));

  const bad = buildToggle(false, false);
  t('★ 失败时开关拨回原样（不停在没落盘的值上）',
    bad.cls.some((x) => x === 'on=false'), JSON.stringify(bad.cls));
  t('★ 失败时 aria-pressed 跟着回原样', bad.attrs.some((x) => x === 'aria-pressed=false'), JSON.stringify(bad.attrs));
  t('★ 失败时不再说「已保存」', !bad.toasts.some((x) => /已保存/.test(x.msg)), JSON.stringify(bad.toasts));
  t('失败时明确说没保存成', bad.toasts.some((x) => x.type === 'err' && /没能保存/.test(x.msg)),
    JSON.stringify(bad.toasts));
  t('失败时把原因也说了（不是只说"失败"）',
    bad.toasts.some((x) => /本地存储|配额|隐私/.test(x.msg)), JSON.stringify(bad.toasts));
}

/* ================================================================
 * 第 3 节：shell.js 的主题下拉 —— 失败必须拨回 + 不能说已保存
 * ================================================================ */
const onchangeSrc = sliceBalanced(shellSrc, 'sel.onchange = () => {', 'shell.js 主题下拉 onchange');

function buildSelect(prevVal, newVal, saved) {
  const toasts = [];
  const sel = { value: newVal };
  const fn = new Function(
    'cfg', 'sel', 'toast', 'savePluginConfig', 'manifest', 'key',
    `${onchangeSrc}; return sel.onchange;`,
  );
  fn({ themeDark: prevVal }, sel,
    (msg, type) => toasts.push({ msg: String(msg), type }),
    () => ({ config: {}, saved }), { id: 'p1' }, 'themeDark')();
  return { toasts, value: sel.value };
}

{
  const ok = buildSelect('', 'graphite', true);
  t('成功时下拉停在新选的那套', ok.value === 'graphite', `value=${ok.value}`);
  t('成功时说已保存', ok.toasts.some((x) => x.type === 'ok' && /已保存/.test(x.msg)), JSON.stringify(ok.toasts));

  const bad = buildSelect('', 'graphite', false);
  t('★ 失败时下拉拨回原样（不能停在没生效的那套上）', bad.value === '', `value=${bad.value}`);
  t('★ 失败时不再说「已保存」', !bad.toasts.some((x) => /已保存/.test(x.msg)), JSON.stringify(bad.toasts));
  t('失败时明确说没保存成', bad.toasts.some((x) => x.type === 'err' && /没能保存/.test(x.msg)),
    JSON.stringify(bad.toasts));
}

/* ================================================================
 * 第 4 节：React 版 SandboxSection —— 同样的判据
 * ================================================================ */
{
  const reactSrc = fs.readFileSync(REACT, 'utf8');
  const writeSrc = sliceBalanced(reactSrc, 'const write = (patch', 'SandboxSection write')
    .replace(': Record<string, unknown>', '');
  t('抽到 React 版的 write（源结构没变）', /savePluginConfig/.test(writeSrc) && /setErr/.test(writeSrc));

  function buildWrite(saved) {
    const cfgs = [], errs = [];
    const fn = new Function(
      'manifest', 'savePluginConfig', 'setCfg', 'setErr', 'bump',
      `${writeSrc}; return write;`,
    );
    const write = fn({ id: 'p1' },
      () => ({ config: { isolated: true }, saved }),
      (v) => cfgs.push(v), (v) => errs.push(v), () => {});
    write({ isolated: true });
    return { cfgs, errs };
  }

  const ok = buildWrite(true);
  t('成功时把新配置落到界面', ok.cfgs.length === 1 && ok.cfgs[0].isolated === true, JSON.stringify(ok.cfgs));
  t('成功时清掉上一次的失败提示', ok.errs.length === 1 && ok.errs[0] === null, JSON.stringify(ok.errs));

  const bad = buildWrite(false);
  t('★ 失败时界面停在原值（一次都不 setCfg）', bad.cfgs.length === 0, JSON.stringify(bad.cfgs));
  t('★ 失败时把原因说出来', bad.errs.length === 1 && /没能|没有生效|写不进/.test(String(bad.errs[0])),
    JSON.stringify(bad.errs));

  /* 两处入口都得走 write —— 只改一处的话，另一处照样"点了有反应、其实没存" */
  t('沙箱开关走 write（不再自己调 setPluginConfig）',
    /const toggle = \(key: 'isolated'\) => write\(/.test(reactSrc), 'toggle');
  t('主题下拉走 write（不再自己调 setPluginConfig）',
    /onChange=\{\(e\) => write\(\{/.test(reactSrc), 'themeRow');
  t('失败提示渲染在分组之上（两处入口共用一句）',
    /\{err \? \(/.test(reactSrc) && reactSrc.indexOf('{err ? (') < reactSrc.indexOf('<SettingGroup'));
}

/* ================================================================
 * 第 5 节：兜底 —— 凡是说「已保存」的调用点，都必须先知道存没存成
 * ================================================================ */
{
  const exts = ['.js', '.tsx', '.ts'];
  const skip = ['node_modules', '.git', 'dist', 'runtime-plugins', 'build'];
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) files.push(p);
    }
  })(HERE);

  const liars = [];
  let claims = 0, inScope = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    /* 只找"报成功"的那几句：说了保存，就必须真的知道保存了 */
    const re = /toast\(\s*'已保存/g;
    let m;
    while ((m = re.exec(src))) {
      claims++;
      /*
       * 窗口要够宽：开关那一处从取值到报成功之间夹着整整一段注释，
       * 取 400 字符会把真正的调用点切在窗口外 —— 于是"没用 savePluginConfig"
       * 是窗口太窄造成的假象，不是代码有问题（恒假的反向）。
       *
       * 同时只把**写插件配置**的那些纳入（窗口里出现过 PluginConfig）：
       * 「已保存：某文件」「已保存配色」走的是别的写入路径，各有各的判据，
       * 混进来只会让这条断言变成"谁都过不了"的噪音。
       */
      const near = src.slice(Math.max(0, m.index - 1000), m.index);
      if (!/PluginConfig\(/.test(near)) continue;
      inScope++;
      if (!/savePluginConfig/.test(near)) liars.push(path.relative(HERE, f));
    }
  }
  t('确实扫到了说「已保存」的调用点（扫描本身没落空）', claims > 0, `claims=${claims}`);
  t('其中确实有写插件配置的（范围没被收成空集）', inScope > 0, `inScope=${inScope}`);
  t('★ 说「已保存」的地方用的都是 savePluginConfig（没有一处直接 setPluginConfig）',
    liars.length === 0, liars.join(', '));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
