/**
 * 布局高度链测试（开发用，可删）
 *
 * 起因：#main 定义了 grid-template-rows: 54px 1fr，但它只有一个子元素
 * #main-inner —— 于是 main-inner 被塞进第一行（54px），
 * 它内部再分 54px + 1fr 时，#plugin-bar 吃掉全部高度，#stage 只剩 0。
 * 表现是"只看得见插件标题栏，内容区全空"，而且所有插件都这样。
 *
 * 这类问题 jsdom 测不出来（它不做布局计算），只能静态核对：
 * 容器声明的网格行数，必须与实际子元素数量一致。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const css = readFileSync('./css/neumorphism.css', 'utf8');
const html = readFileSync('./index.html', 'utf8');

/** 取出某选择器规则里 grid-template-rows 的值（按分号切，忽略注释行） */
function gridRows(selector) {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace('#', '#')}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  if (!m) return null;
  const body = m[2].split('\n').filter((l) => !l.trim().startsWith('/*')).join('\n');
  const r = /grid-template-rows:\s*([^;]+);/.exec(body);
  return r ? r[1].trim() : null;
}

/** 粗略统计某 id 容器的直接子元素个数：靠缩进层级判断 */
function childCount(id) {
  const lines = html.split('\n');
  const openRe = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`);
  let start = -1, indent = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openRe.test(lines[i])) { start = i; indent = lines[i].match(/^\s*/)[0].length; break; }
  }
  if (start < 0) return -1;
  let n = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = line.match(/^\s*/)[0].length;
    if (ind <= indent) break;                       // 回到同级或更外层 → 结束
    if (ind === indent + 2 && /^\s*<[a-z]+/.test(line) && !line.trim().startsWith('</')) n++;
  }
  return n;
}

console.log('\n=== 网格行数 vs 实际子元素数 ===');
for (const sel of ['#app', '#main', '#main-inner']) {
  const rows = gridRows(sel);
  const kids = childCount(sel.slice(1));
  if (!rows) { t(`${sel} 未声明 grid-template-rows`, true, '按默认流布局'); continue; }
  // 数声明里有几个行轨道（minmax(...) 算一个）
  const tracks = rows.replace(/minmax\([^)]*\)/g, 'X').split(/\s+(?![^(]*\))/).filter(Boolean).length;
  t(`${sel} 行数(${tracks}) 与子元素数(${kids}) 一致`,
    tracks === kids || kids === -1,
    `rows: ${rows}`);
}

console.log('\n=== 关键高度链 ===');
// 只要 #main 不放回 "54px 1fr"，就不会再塌陷
t('#main 不再声明两行（否则 main-inner 只占 54px）',
  !/54px\s+1fr/.test(gridRows('#main') || ''), gridRows('#main'));
t('#main-inner 仍是 54px + 1fr（标题栏 + 舞台）',
  /54px\s+1fr/.test(gridRows('#main-inner') || ''), gridRows('#main-inner'));
t('#stage 有定位上下文（stage-scroll 是 absolute）',
  /#stage\s*\{[^}]*position:\s*relative/.test(css));
t('#stage-scroll 用 inset 铺满且可滚动',
  /#stage-scroll\s*\{[^}]*inset:[^;]+;[^}]*overflow:\s*auto/.test(css));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
