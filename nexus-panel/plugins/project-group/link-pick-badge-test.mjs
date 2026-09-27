/**
 * 链接勾选对话框：徽章必须跟着「勾选状态」走
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-pick-badge-test.mjs
 *
 * 为什么单独测它：对话框确认后走的是 syncLinks（多退少补），
 * 动作由**勾选状态**决定 —— 而徽章此前只看"现在指向哪儿"，
 * 于是出现两种相反方向的误报：
 *   · 指向别组但没勾 → 标「将换绑」，而 sync 根本不会动它；
 *   · 已指向本组但取消勾选 → 标「已建·不会变动」，而 sync 会真删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

/* 剥块注释：断言不能靠注释里的字样通过 —— 那是本仓踩过 25 次的坑 */
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => fs.readFileSync(path.join(HERE, n), 'utf8');

const dlgSrc = R('components/LinkPickDialog.tsx');
const dlg = strip(dlgSrc);
const mod = strip(R('../../src-tauri/src/fpx/mod.rs'));

console.log('\n=== 1. 三个判据都取自源码并真跑一遍 ===');
{
  /* 必须**逐个**从源码里抓出来，手写一份等于测自己写的副本 */
  const grab = (name) => {
    const re = new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);');
    const m = re.exec(dlg);
    return m ? m[1] : '';
  };
  const rebind = grab('rebind');
  const willDrop = grab('willDrop');
  const keeps = grab('keeps');

  t('抓到 rebind 判据', rebind.length > 0, rebind);
  t('抓到 willDrop 判据', willDrop.length > 0, willDrop);
  t('抓到 keeps 判据', keeps.length > 0, keeps);

  /*
   * 每条都必须含 isPicked —— 缺了它徽章就退回"只看指向"，
   * 而这正是本次要修的东西（文本断言只钉名字的话，整段改写照样通过）。
   */
  t('rebind 跟着勾选状态', /isPicked/.test(rebind), rebind);
  t('willDrop 跟着勾选状态', /isPicked/.test(willDrop), willDrop);
  t('keeps 跟着勾选状态', /isPicked/.test(keeps), keeps);

  /* 真跑：把三条源码表达式塞进一个函数里执行 */
  const run = (isPicked, target) => {
    const samePath = (a, b) => a === b;
    const group = '/G';
    const body = `const rebind = ${rebind};const willDrop = ${willDrop};const keeps = ${keeps};
      return { rebind, willDrop, keeps };`;
    return new Function('isPicked', 'target', 'samePath', 'group', body)(
      isPicked, target, samePath, group,
    );
  };

  const THIS = '/G';
  const OTHER = '/H';

  /* ① 取消勾选 + 已指向本组 → 会被删，必须标「将删除」 */
  {
    const r = run(false, THIS);
    t('取消勾选+本组 → 将删除', r.willDrop === true && r.rebind === false && r.keeps === false, JSON.stringify(r));
  }
  /* ② 勾选 + 已指向本组 → 保持不变 */
  {
    const r = run(true, THIS);
    t('勾选+本组 → 已建不变', r.keeps === true && r.willDrop === false && r.rebind === false, JSON.stringify(r));
  }
  /* ③ 未勾选 + 指向别组 → sync 不动它，绝不能标「将换绑」 */
  {
    const r = run(false, OTHER);
    t('未勾选+别组 → 三徽章都不亮', !r.rebind && !r.willDrop && !r.keeps, JSON.stringify(r));
  }
  /* ④ 勾选 + 指向别组 → 真的会换绑 */
  {
    const r = run(true, OTHER);
    t('勾选+别组 → 将换绑', r.rebind === true && r.willDrop === false, JSON.stringify(r));
  }
  /* ⑤⑥ 读不到目标 = 不知道，一律不亮（进表会显示成"将换绑"） */
  {
    const a = run(false, undefined);
    const b = run(true, undefined);
    t('读不到目标时一律不亮', !a.rebind && !a.willDrop && !a.keeps && !b.rebind && !b.willDrop && !b.keeps);
  }
}

console.log('\n=== 2. 界面上四种状态都要有出口 ===');
{
  t('有「将删除」徽章', /将删除/.test(dlg));
  t('「将删除」是告警色', /fpx-badge warn[\s\S]{0,200}?将删除/.test(dlg));
  t('有「他组占用」徽章', /他组占用/.test(dlg));
  t('「已建」不再承诺不会变动', !/不会变动/.test(dlg));
  /* 行内徽章与底部说明必须一致，否则用户读到两套说法 */
  t('底部说明提到「将删除」', /「将删除」/.test(dlg));
  t('底部说明澄清他组占用不动', /他组占用[\s\S]{0,80}?不会[\s\S]{0,20}?被改动/.test(dlg));
}

console.log('\n=== 3. 按钮必须写出删除数 ===');
{
  /* 只写「建立 N 个」的话，取消勾选这个有后果的动作在界面上完全不可见 */
  t('按钮按删除数分支', /dropCount\s*>\s*0/.test(dlg));
  t('按钮带删除数', /删除 \$\{dropCount\} 个/.test(dlg));
  t('dropCount 只数本组且未勾选的', /!picked\.has\(n\)\s*&&\s*samePath\(t, group\)/.test(dlg));
  const iBtn = dlg.indexOf('dropCount > 0');
  const iMemo = dlg.indexOf('const dropCount');
  t('dropCount 定义在使用之前', iMemo >= 0 && iMemo < iBtn);
}

console.log('\n=== 4. 路径比对仍走同一套规则 ===');
{
  /* 就地另写一份归一 = 两个方向都会改到用户没要求改的东西（见该文件注释） */
  t('走 normalizeKey', /normalizeKey\(a, ci\) === normalizeKey\(b, ci\)/.test(dlg));
  t('不就地小写', !/\.toLowerCase\(\)/.test(dlg));
  t('不就地 replace 分隔符', !/replace\(\/\[\\\\\/\]\+\$/.test(dlg));
  t('ci 只由平台决定', /ci=\{boot\.platform === 'windows'\}/.test(strip(R('components/DialogsHub.tsx'))));
}

console.log('\n=== 5. 后端：sync 只删指向本组的 ===');
{
  const i = mod.indexOf('pub(crate) fn core_sync_links');
  const seg = i < 0 ? '' : mod.slice(i, i + 6000);
  t('切到 core_sync_links', i >= 0);
  /* 删之前必须逐个确认实际指向 —— 否则指向别组的会被一起删掉 */
  t('删除前逐个反查实际目标', /let to_remove[\s\S]{0,400}?resolve_of\(n\)/.test(seg));
  t('只删指向本次目标组的', /store::normalize_key\(&t\) == target_key/.test(seg));
  /* 确认走的是 sync 而不是 create：create 不删，取消勾选会看起来生效了却还在 */
  const hub = strip(R('components/DialogsHub.tsx'));
  t('确认后走 syncLinks', /s\.syncLinks\(confirmLink\.project/.test(hub));
}

done();
