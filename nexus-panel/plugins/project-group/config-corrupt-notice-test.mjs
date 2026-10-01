/**
 * config.json 损坏时启动必须告知（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/config-corrupt-notice-test.mjs
 *
 * 启动原先用 `store::load_config(&dir)`，而它内部是
 * `load_config_strict(...).unwrap_or_else(FpxConfig::default)` ——
 * 文件读不出来就**静默返回一份空配置**。
 *
 * 于是界面表现得像全新安装：页签、卡片登记、链接、锁全都不见了，
 * 而没有任何一句话说明为什么。用户看到"东西全没了"，最自然的反应是
 * 重新添加一遍，不会想到"文件坏了"；更糟的是他随便改一个设置，
 * 前端就把这份空配置整份写回磁盘（fpx_save_config 收的是前端传来的
 * 完整 config）—— 把还能抢救的原件覆盖掉。
 *
 * 原件本身是救得回来的：`load_strict` 在损坏时已经 quarantine 另存了
 * .corrupt 副本。但用户不知道它在哪，也就不会去找。
 *
 * 而 `config_issues` 补不上这条提示 —— 它在 JSON 解析失败时
 * `return Vec::new()`（注释说"解析失败由加载路径负责报错"），
 * 可加载路径恰恰不报错。两处各自合理，合起来就是一句提示都没有。
 *
 * 修法：新增 `load_config_noting`，与 `load_config` 同一套加载规则，
 * 只多一样东西 —— 损坏时把原因与现场路径一并交回，由启动显示出来。
 *
 * 判据（都是真代码，剥注释后比对）：
 *   1. 启动走 noting 版，不再走静默版
 *   2. 损坏提示排在 notices 首位（前端只弹首条 toast）
 *   3. 提示里必须带上现场路径（只说"读取失败"用户还是找不到数据）
 *   4. 纯只读路径仍走 load_config，不重复提示
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const STORE = fs.readFileSync(path.join(RS, 'store.rs'), 'utf8');
const MOD = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
const { t, done } = makeT();

/* 只看真代码：本文件的说明里写满了 load_config / Corrupted 这些字样，
   不剥注释的话删掉实现也照样"通过"。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const STORE_C = strip(STORE);
const MOD_C = strip(MOD);

/** 按大括号配平切出一段（避免切到别处 / 切到文件末尾） */
function sliceBlock(src, anchor, open = '{') {
  const i = src.indexOf(anchor);
  if (i === -1) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === open) { depth++; started = true; }
    else if (c === (open === '{' ? '}' : ')')) {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

console.log('\n=== 1. store.rs：load_config_noting 的损坏分支 ===');
const NOTING = sliceBlock(STORE_C, 'pub fn load_config_noting');
{
  t('切到的确实是 load_config_noting 自身（不是切空 / 切到别处）',
    NOTING.startsWith('pub fn load_config_noting'));
  t('切到的这段含 Corrupted 分支',
    NOTING.includes('Corrupted'), '');

  const iCorr = NOTING.indexOf('LoadOutcome::Corrupted');
  t('Corrupted 分支存在', iCorr !== -1);
  const corr = iCorr === -1 ? '' : NOTING.slice(iCorr);

  /* 关键是"给默认值**并且**带出原因"，只做一半都不行：
     只给默认值 = 原来的静默；只带原因不给默认值 = 启动直接失败。 */
  t('损坏时仍给一份可用配置（不阻断启动）',
    /FpxConfig::default\(\)/.test(corr));
  t('损坏时返回非空提示（不再静默）',
    /vec!\[format!\(/.test(corr));
  t('提示里带上现场路径（用户得知道去哪儿找）',
    /backup\.display\(\)/.test(corr));
  t('提示里带上失败原因', /\{reason\}/.test(corr));
  t('提示说明"保存会覆盖"（否则用户照常改设置就丢了）',
    corr.includes('保存任何设置都会用这份空配置覆盖'));
}

console.log('\n=== 2. store.rs：正常分支与 load_config 同一套规则 ===');
{
  const ok = NOTING.slice(0, NOTING.indexOf('LoadOutcome::Corrupted'));
  t('正常分支也补默认页签', /ensure_default_tabs\(&mut cfg\)/.test(ok));
  t('正常分支也夹取范围', /ensure_ranges\(&mut cfg\)/.test(ok));
  t('正常分支也跑迁移（否则 schema 升级在启动这条路上不生效）',
    /migrate_config\(&mut cfg\)/.test(ok));
  t('正常分支不带提示（没坏就别刷屏）', /Vec::new\(\)/.test(ok));
}

console.log('\n=== 3. mod.rs：启动改用 noting 版 ===');
const BOOT = sliceBlock(MOD_C, 'pub fn fpx_bootstrap');
{
  /* 锚点必须落在真代码上：本文件的说明里也有 fpx_bootstrap 这几个字。 */
  t('切到的确实是 fpx_bootstrap 自身', BOOT.startsWith('pub fn fpx_bootstrap'));
  t('启动走 store::load_config_noting', /store::load_config_noting\(&dir\)/.test(BOOT));
  /* 注意子串：load_config_noting 本身含 load_config，
     所以必须锚定 `load_config(&dir)` 这个**完整调用形状**。 */
  t('启动不再走静默的 store::load_config(&dir)',
    !/store::load_config\(&dir\)/.test(BOOT));
}

console.log('\n=== 4. 损坏提示排在 notices 首位（前端只弹首条 toast）===');
{
  /* 顺序断言两端都要先判存在：任一端 -1 时 -1 < 正数 恒真 → 空跑。 */
  const iNoting = BOOT.indexOf('store::load_config_noting');
  const iExtend = BOOT.indexOf('notices.extend(');
  t('顺序两端锚点都存在', iNoting !== -1 && iExtend !== -1, `${iNoting},${iExtend}`);
  t('notices 由 noting 初始化、之后才 extend 体检结果', iNoting < iExtend);
  /* 前端 useFpx 那条：notes[0] 弹 toast，其余只进日志。
     所以"损坏"必须比"有几个键不认识"更靠前，否则最要紧的那句根本不弹。 */
  t('前端确实用首条弹 toast（这条断言是上面那条的理由）',
    /ctx\.toast\(notes\[0\]/.test(strip(fs.readFileSync(
      path.join(HERE, 'hooks', 'useFpx.ts'), 'utf8'))));
}

console.log('\n=== 5. 只读路径不变（不重复提示）===');
{
  t('load_config 仍在（其余只读入口继续用它）',
    /pub fn load_config\(dir: &Path\) -> FpxConfig/.test(STORE_C));
  t('load_config 仍保持静默回默认（只有会显示出来的入口才报错）',
    /load_config_strict\(dir\)\.unwrap_or_else\(FpxConfig::default\)/.test(STORE_C));
  /* config_issues 补不上这条：解析失败时它返回空。
     钉住这个事实，否则后人会以为"体检里加一句就行"，而它拿不到原因。 */
  const ISSUES = sliceBlock(STORE_C, 'pub fn config_issues');
  t('切到的确实是 config_issues 自身', ISSUES.startsWith('pub fn config_issues'));
  t('config_issues 在解析失败时返回空（所以必须靠 noting 补）',
    /Err\(_\) => return Vec::new\(\)/.test(ISSUES));
}

console.log('\n=== 6. 兜底：每一个 bootstrap 变体都必须带提示 ===');
{
  /* 不只看 fpx_bootstrap 一处：将来若有人另起一个启动入口
     （比如给 MCP 用的 boot 变体），漏改会被这里抓到。
     判据是"逐个 bootstrap 函数检查"，不是"至少有一处用了 noting"
      —— 后者在新增第二个入口且漏改时依然通过。 */
  const names = [...MOD_C.matchAll(/pub fn (fpx_\w*boot\w*)\(/g)].map((m) => m[1]);
  t('至少有一个 bootstrap 入口', names.length >= 1, names.join('、'));
  let allNoting = names.length > 0;
  for (const n of names) {
    const seg = sliceBlock(MOD_C, `pub fn ${n}(`);
    if (!/store::load_config_noting\(/.test(seg) || /store::load_config\(&dir\)/.test(seg)) {
      allNoting = false;
    }
  }
  t('所有 bootstrap 入口都走 noting 版（新增入口漏改会被抓到）', allNoting,
    names.join('、'));
}

done();
