/**
 * 布局高度链测试（开发用，可删）
 *
 * 背景：这个 bug 报了两次，第一次只修好了一半。
 *
 *   第一轮：#main 声明了两行（54px 1fr）但只有一个子元素，
 *           #main-inner 被塞进第一行，#stage 只剩 0。
 *   第二轮：改完 #main 后仍然无效 —— 真正的塌陷点在 #body：
 *           它只声明了 grid-template-columns，行是隐式 auto，
 *           高度由内容决定。而 #stage-scroll 是 absolute、不贡献内容高度，
 *           于是整条链自我实现地塌到只剩 54px 的标题栏。
 *
 * 症状永远是「所有插件只看得见标题，看不见内容」，
 * 而 jsdom 不做布局计算，运行时测试根本看不出来 —— 只能静态校验。
 *
 * 核心规则：链条上每个 grid 容器都必须**显式声明** grid-template-rows，
 *          且用 minmax(0, 1fr) 而不是裸 1fr（1fr 的最小尺寸是 auto，
 *          内容一超高就会把行撑破）。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const css = readFileSync('./css/neumorphism.css', 'utf8');

/** 取某选择器规则块（去掉注释行后） */
function rule(sel) {
  const m = new RegExp(`(^|\\n)\\s*${sel.replace(/[#.]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!m) return null;
  return m[2].split('\n').filter((l) => !l.trim().startsWith('/*')).join('\n');
}
const decl = (body, prop) => {
  // 必须加左边界，否则 min-height 会被当成 height 匹配上
  const m = new RegExp(`(?:^|[;\\s{])${prop}\\s*:\\s*([^;]+);`).exec(body || '');
  return m ? m[1].trim() : null;
};

/* 从 #app 到 #stage-scroll 的完整高度链。
   每一层都必须把高度“传下去”，断一层就全塌。 */
const CHAIN = [
  { sel: '#app',        note: '根容器：100vh + 标题栏/主体两行' },
  { sel: '#body',       note: '侧边栏 + 主区（列布局，但行也要声明）' },
  { sel: '#main',       note: '主区外框（padding 留给 main-inner 投影）' },
  { sel: '#main-inner', note: '插件标题栏 54px + 舞台占满剩余' },
  { sel: '#stage',      note: '舞台：给 stage-scroll 做定位上下文' },
];

console.log('\n=== 1. 高度链逐层校验 ===');
let prevIsGridWithRows = false;   // 上一层是不是"已声明 rows 的 grid 容器"
for (const { sel, note } of CHAIN) {
  const body = rule(sel);
  if (!body) { t(`${sel} 规则存在`, false); continue; }

  const isGrid = /display\s*:\s*grid/.test(body);
  const rows = decl(body, 'grid-template-rows');
  const height = decl(body, 'height');

  if (isGrid) {
    // grid 容器：必须显式声明行，否则行是隐式 auto、高度由内容决定
    t(`${sel} 显式声明了 grid-template-rows`, !!rows, rows || '(缺失 → 行变 auto，高度塌陷)');
    if (rows) {
      // 每个自适应轨道都要带 minmax(0, ...)，裸 1fr 会被内容撑破
      const flexible = rows.split(/\s+(?![^(]*\))/).filter((x) => /fr\)?$/.test(x) || x === '1fr');
      const bare = flexible.filter((x) => x === '1fr');
      t(`${sel} 的自适应轨道用了 minmax(0, …)`, bare.length === 0,
        bare.length ? `裸 1fr: ${bare.join(', ')}` : rows);
    }
  } else {
    /* 非 grid 容器（如 #stage）：自身不需要 height，
       只要它是某个已声明 rows 的 grid 容器的 item，就会被 stretch 到轨道高度。
       但若它脱了文档流（absolute/fixed），高度就得另说。 */
    const pos = decl(body, 'position');
    const outOfFlow = pos === 'absolute' || pos === 'fixed';
    t(`${sel} 高度由父级 grid 轨道 stretch 得到`,
      !outOfFlow && !!(height || prevIsGridWithRows),
      outOfFlow ? `已脱流(${pos})，需另行保证高度` : (height || '父级轨道 stretch'));
  }
  console.log(`       └ ${note}`);
  // 供下一层判断：本层能不能把高度传下去
  prevIsGridWithRows = isGrid && !!rows;
}

console.log('\n=== 2. 叶子容器：#stage-scroll ===');
const ssBody = rule('#stage-scroll');
t('#stage-scroll 用 absolute 脱离文档流',
  decl(ssBody, 'position') === 'absolute', decl(ssBody, 'position'));
t('#stage-scroll 用 inset 铺满 #stage',
  !!decl(ssBody, 'inset'), decl(ssBody, 'inset'));
t('#stage-scroll 可滚动', decl(ssBody, 'overflow') === 'auto', decl(ssBody, 'overflow'));

/* 这是最容易被忽略的一条：absolute 元素不贡献父容器高度，
   所以 #stage 的高度必须靠 grid 轨道给，而不能指望内容撑开。
   上面第 1 步已经校验了 #stage 在 grid 行里，这里再明确记一笔。 */
console.log('\n=== 3. 关键约束：absolute 不撑高父容器 ===');
t('#stage 是 grid item（高度来自轨道而非内容）',
  /grid-template-rows/.test(rule('#main-inner') || ''));
/* 第二层隐患：百分比高度需要父级有确定的 height。
   .plugin-wrap 原先只有 min-height:100%，自身 height 仍是 auto，
   于是 .plugin-frame 的 min-height:100% 没有参照物、退化成 auto，
   iframe 退回默认高度（150px），在 overflow:hidden 的 #stage 里基本看不见。 */
t('.plugin-wrap 显式给了 height: 100%（否则子级百分比高度失效）',
  decl(rule('.plugin-wrap'), 'height') === '100%',
  decl(rule('.plugin-wrap'), 'height') || '(只有 min-height)');
t('.plugin-frame 显式给了 height: 100%',
  decl(rule('.plugin-frame'), 'height') === '100%',
  decl(rule('.plugin-frame'), 'height') || '(只有 min-height)');
t('.plugin-root 保留 min-height（同页插件需要能撑开滚动）',
  decl(rule('.plugin-root'), 'min-height') === '100%');

console.log('\n=== 4. 回归锚点（针对两次报错的具体写法） ===');
t('#body 不再是“只声明 columns”',
  !!decl(rule('#body'), 'grid-template-rows'),
  decl(rule('#body'), 'grid-template-rows') || '(第二轮塌陷点)');
t('#main 不再声明两行',
  !/\b54px\s+1fr\b/.test(decl(rule('#main'), 'grid-template-rows') || ''),
  decl(rule('#main'), 'grid-template-rows'));

console.log('\n=== 4. iframe 插件页：主面板的 html,body 规则必须被覆盖 ===');
/*
 * js/plugin-sdk.js 在每个 iframe 插件页的 body 上加 .nexus-iframe-plugin，
 * 但**此前全仓零配套 CSS 规则** —— 标记了却没人用，等于没标记。
 *
 * 后果：插件页也引入了本文件，于是吃到
 *     html, body { height: 100%; overflow: hidden; }
 * 那是给主面板的（滚动交给 #stage-scroll）。iframe 内部没有 #stage-scroll，
 * 只剩"禁止滚动"这一半 —— 内容超出即被裁掉，而 iframe 高度锁 100%
 * 不随内容长高，超出部分**永久不可达**。
 *
 * 横向也一样：.p-grid 是 minmax(220px, 1fr)，容器再窄网格项也不肯
 * 小于 220px，于是卡片被撑得比 body 宽、右边缺一截。
 */
const sdk = readFileSync('./js/plugin-sdk.js', 'utf8');
const iframeBody = rule('body.nexus-iframe-plugin');
t('body.nexus-iframe-plugin 有配套规则（此前为零）', !!iframeBody);
t('JS 确实打了这个标记（否则规则是死代码）',
  /classList\.add\('nexus-iframe-plugin'\)/.test(sdk));
/* overflow 必须是 auto/scroll —— hidden 就等于没修 */
t('覆盖了 overflow（不再是 hidden）',
  /auto|scroll/.test(decl(iframeBody, 'overflow') || ''),
  decl(iframeBody, 'overflow'));
/*
 * ⚠️ 这条最要紧：**不能**顺手把 height 改成 auto。
 * settings 插件的 #root 是 height:100%（plugins/settings/settings.css），
 * 它靠 body 这个确定高度当参照物；body 高度一变 auto，那条 100% 退化成
 * auto，设置页的分栏布局当场塌掉。只改 overflow 就不碰这条依赖。
 */
t('没有动 height（否则 settings 的 #root height:100% 会塌）',
  decl(iframeBody, 'height') === null,
  decl(iframeBody, 'height') || '(未设置)');
/* 规则必须写在共用的 neumorphism.css：iframe 插件都引它，
   写在某个插件的私有 CSS 里则只有那一个插件受益。 */
t('规则写在共用的 neumorphism.css', css.includes('body.nexus-iframe-plugin'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
