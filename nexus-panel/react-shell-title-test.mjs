/**
 * React 版外壳：插件栏的标题 / 副标题必须**只认宿主上报的那一份**
 * ------------------------------------------------------------------
 * 修的那个 bug：`src/App.tsx` 给 <Stage> 传的是**自己重算**的
 *
 *     title    = activePlugin?.name ?? '未选择插件'
 *     subtitle = `${type === 'iframe' ? '沙箱模式' : '同页模式'} · v${version}`
 *
 * 而宿主（js/host.js）在挂载完成时会上报 `hooks.onTitle / onSubtitle`，
 * 并且插件可以用 `ctx.shell.title('…')` **改掉**标题。
 *
 * 两处后果：
 *   · title —— 插件改名后宿主会上报新值，而重算出来的永远是 manifest.name，
 *     **插件栏不跟着变**（只有标题栏变，因为它读的是 state）。
 *     原生版 shell.js 的 onTitle 同时写 #bar-title 与 #tb-title，两处同源，
 *     所以这个不一致**只在 React 版出现**。
 *   · subtitle —— 更彻底：上报的值被存进 state 后**从没人读过**，
 *     插件栏另算一份把它顶掉了。宿主说什么都白说。
 *
 * 同类形状在本项目出现过多次（UpdateCard 的 note：算出来了却不渲染），
 * 所以这里钉的是"上报值必须真的走到渲染"，而不是"源码里有那几行"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf-8');
const APP = 'src/App.tsx';
const SHELL = 'js/shell.js';

let pass = 0;
let fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` → ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` → ${detail}` : ''}`);
  }
};

console.log('— 第 1 节：插件栏的标题来自宿主上报，不再自己重算 —');
{
  const app = stripComments(read(APP));
  // <Stage ...> 那一段：从 <Stage 起到它结束
  const stage = app.match(/<Stage[\s\S]*?\/>/)?.[0] || '';
  t('切到 <Stage> 那一段（不是空跑）', stage.length > 0, `${stage.length} 字符`);

  t('title 用的是宿主上报的 state ★', /\btitle=\{title\}/.test(stage), stage.match(/\btitle=\{[^}]*\}/)?.[0] || '（没有）');
  t('title 不再从 activePlugin 重算 ★', !/title=\{activePlugin/.test(stage));
  t(
    'App.tsx 里不再出现"未选择插件"的重算兜底',
    !/activePlugin\?\.name \?\? '未选择插件'/.test(app),
  );

  t('subtitle 用的是宿主上报的 state ★', /\bsubtitle=\{subtitle\}/.test(stage), stage.match(/\bsubtitle=\{[^}]*\}/)?.[0] || '（没有）');
  t('subtitle 不再按 type/version 重算 ★', !/subtitle=\{activePlugin/.test(stage));
  t(
    'App.tsx 里不再自己拼"沙箱模式"（那是宿主该上报的）',
    !/沙箱模式/.test(app),
    app.match(/沙箱模式/)?.[0] || '（已无）',
  );
}

console.log('\n— 第 2 节：宿主上报的接线还在（onTitle / onSubtitle）—');
{
  const app = stripComments(read(APP));
  const hooks = app.match(/hooks:\s*\{[\s\S]*?\n {6}\}/)?.[0] || app;
  t('createHost 的 hooks 里接了 onTitle', /onTitle:\s*setTitle/.test(hooks));
  t('createHost 的 hooks 里接了 onSubtitle ★', /onSubtitle:\s*setSubtitle/.test(hooks));
  t(
    '宿主确实会调这两个上报（js/host.js）',
    /hooks\.onTitle\?\./.test(read('js/host.js')) && /hooks\.onSubtitle\?\./.test(read('js/host.js')),
  );
}

console.log('\n— 第 3 节：原生版两处同源（React 版要对齐的就是这个行为）—');
{
  const shell = stripComments(read(SHELL));
  const onTitle = shell.match(/onTitle:[^\n]*\n?[^\n]*/)?.[0] || '';
  t('原生版 onTitle 同时写插件栏与标题栏 ★', /#bar-title/.test(onTitle) && /#tb-title/.test(onTitle), onTitle.slice(0, 80));
  const onSub = shell.match(/onSubtitle:[^\n]*/)?.[0] || '';
  t('原生版 onSubtitle 写进了插件栏 ★', /#bar-sub/.test(onSub), onSub.slice(0, 80));
}

console.log('\n— 第 4 节：宿主上报的副标题内容（React 版现在收得到）—');
{
  const host = stripComments(read('js/host.js'));
  t(
    '宿主上报的是"模式 · 版本"这一串',
    /onSubtitle\?\.\([\s\S]{0,220}?沙箱模式/.test(host),
    host.match(/沙箱模式/)?.[0] || '（没有）',
  );
  t(
    '上报的是 manifest 派生值，React 版不需要再算一遍',
    /manifest\s*\?\s*`\$\{manifest\.type/.test(host) || /manifest\s*\?\s*[^\n]*manifest\.type/.test(host),
  );
}

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
