/**
 * 无效放置要回弹（A57，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/drop-springback-test.mjs
 *
 * 对照 mindmap/tab-drag.js 的 A57（springBack）：
 * 浏览器只在 drop **被接受**时才不做回弹动画。
 * 无条件 preventDefault 会让无效放置看起来和成功一模一样 ——
 * 拖影直接消失、界面毫无变化，用户以为放下去了，其实什么也没发生。
 *
 * 正确做法：先校验，无效就不 preventDefault，让浏览器把拖影飞回原位。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const card = R('components/CardGrid.tsx');
const boxg = R('components/StackedGroups.tsx');
const icon = R('components/PresetIconGrid.tsx');

/**
 * 一个 onDrop 块里可能有**多条载荷通道**（页签 / 卡片），
 * 各自有自己的 getData → 解析 → preventDefault。
 *
 * 按"取数点"切段、逐通道断言 —— 整块只看"第一个 preventDefault"
 * 会把**另一条通道**的 preventDefault 算进来，跨通道误判。
 */
function channels(block) {
  return block.split(/(?=e\.dataTransfer\.getData\()/).filter((x) => x.includes('getData('));
}

/** 取某个 onDrop 块（从 onDrop 起到匹配的结束括号） */
function dropBlocks(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('onDrop={(e) => {', i)) >= 0) {
    let d = 0, j = src.indexOf('{', i + 'onDrop={(e) =>'.length);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) break; }
    }
    out.push(src.slice(start, j + 1));
    i = j;
  }
  return out;
}

console.log('\n=== 1. 卡片区与页签条：校验通过后才 preventDefault ===');
{
  /* 卡片区与页签条**各有**一个 onDrop，都走 DRAG_MIME ——
     只查第一个会漏掉另一个（此前就是页签条那处先 preventDefault 再解析）。 */
  const bs = dropBlocks(card).filter((x) => x.includes('DRAG_MIME'));
  /* 三处：页签条 / 卡片区容器（空白处）/ 单张卡片 */
  t('找到三处 DRAG_MIME 的 onDrop', bs.length === 3);
  bs.forEach((b, n) => {
    const cs = channels(b);
    t(`第${n + 1}处：至少一条通道`, cs.length >= 1);
    cs.forEach((c, m) => {
      if (!c.includes('e.preventDefault();')) return;   // 该通道不放东西，无需断言
      const pi = c.search(/parse\w+\(/);
      const di = c.indexOf('e.preventDefault();');
      t(`第${n + 1}处·通道${m + 1}：解析在 preventDefault 之前`, pi >= 0 && pi < di);
      /*
       * **真正的关键**：判空 return 必须**在** preventDefault 之前。
       *
       * 只断言"解析 < preventDefault"是不够的 —— 把判空挪到 preventDefault
       * 之后（先接受再判空）时，解析仍在前面，断言照样通过（**漏报**）。
       * 而那正是本测试要抓的错误。
       */
      const gi = c.search(/if \(![^)]*\) return;/);
      t(`第${n + 1}处·通道${m + 1}：判空 return 在 preventDefault 之前`, gi >= 0 && gi < di);
    });
    /* 每条通道都得有"无效就 return"兜在 preventDefault 前面 */
    t(`第${n + 1}处：无效就 return（在 preventDefault 之前）`,
      /if \(!\w+\) return;[\s\S]{0,80}?e\.preventDefault\(\);/.test(b));
    t(`第${n + 1}处：不是开头就 preventDefault`,
      !/^\s*e\.preventDefault\(\);/.test(b.split('\n').slice(1).join('\n')));
  });
  /* dragover 的 preventDefault 必须保留，否则 drop 根本不触发 */
  t('dragover 仍要 preventDefault（否则 drop 不触发）',
    /onDragOver=\{\(e\) => \{[\s\S]{0,300}?e\.preventDefault\(\)/.test(card));
}

console.log('\n=== 2. 分类框：同样规则 ===');
{
  const b = dropBlocks(boxg)[0];
  t('找到 onDrop', !!b);
  t('校验在 preventDefault 之前',
    b.indexOf('parseBoxDrag(raw)') < b.indexOf('e.preventDefault();'));
  /*
   * 用**位置顺序**比较，不要写 `{0,40}?` 这种字符窗口：
   * 中间插入新的守卫（#75 的"原地放下"）后窗口不够宽 → 假失败。
   * 真正要断言的是"return 在 preventDefault 之前"，与中间隔多少字符无关。
   */
  /*
   * **必须查存在性**（`>= 0`）：`indexOf` 找不到时返回 -1，
   * 而 `-1 < 任何正数` 恒为真 —— 反向验证时发现，把那行 return 删掉
   * 这条断言**照样通过**（漏报），等于没测。
   */
  const iRet = b.indexOf('if (!box || box.index !== from) return;');
  const iPrev = b.indexOf('e.preventDefault();');
  t('无效就 return 且不 preventDefault', iRet >= 0 && iPrev >= 0 && iRet < iPrev);
  t('stopPropagation 仍在（保层级）', /e\.stopPropagation\(\);/.test(b));
}

console.log('\n=== 3. 图标格子 / 分组：拖到自己 = 没生效 ===');
{
  const bs = dropBlocks(icon);
  t('有两处 onDrop（分组 + 图标）', bs.length >= 2);
  const g = bs.find((x) => x.includes('moveGroup'));
  t('分组：无效在前、preventDefault 在后',
    /if \(!src \|\| src === g\.name\) return;[\s\S]{0,40}?e\.preventDefault\(\);/.test(g));
  const n = bs.find((x) => x.includes('moveIcon'));
  t('图标：无效在前、preventDefault 在后',
    /if \(!src \|\| src === n\) return;[\s\S]{0,40}?e\.preventDefault\(\);/.test(n));
}

console.log('\n=== 4. 状态清理不能被回弹改动带偏 ===');
{
  /* 回弹改动把 preventDefault 往后挪了，但清状态必须照旧：
     清早了拿不到 data，清晚了竖条会残留。 */
  const b = dropBlocks(card).filter((x) => x.includes('DRAG_MIME')).at(-1);
  t('仍先取数再清状态', b.indexOf('getData(DRAG_MIME)') < b.indexOf('clearDropWithScroll()'));
  t('仍清 dropAt/over', /clearDropWithScroll\(\);/.test(b) && /setOver\(-1\);/.test(b));
  t('onDragEnd 仍兜底', /onDragEnd=\{\(\) => \{[\s\S]{0,200}?clearDropWithScroll\(\)/.test(card));
}

done();
