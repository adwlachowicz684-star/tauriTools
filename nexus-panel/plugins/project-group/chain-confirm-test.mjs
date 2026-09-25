/**
 * 发送前确认弹窗回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/chain-confirm-test.mjs，然后
 *         node plugins/project-group/chain-confirm-test.mjs
 *
 * 覆盖 #43 的两件容易做错的事：
 *   1. 「不再提示」必须是**会话级**，不能写进 config
 *      （写进去 = 勾一次永久关掉，等误发时想不起来是哪里关的）
 *   2. 两个发送入口（面板 / 侧边栏-快捷键）都要弹确认，
 *      只做一个 = 另一条路完全绕过确认
 *   3. 预览与发送要用同一套后端解析，否则"看到的"和"发出的"会漂
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const { t, done } = makeT();

const C = await loadTs(path.join(HERE, 'utils/confirmOnce.ts'));

console.log('\n=== 1. 「不再提示」是会话级 ===');
t('初始需要确认', C.needConfirm() === true);
t('初始 isSkipConfirm 为假', C.isSkipConfirm() === false);
C.setSkipConfirm(true);
t('设为不再提示后 needConfirm 为假', C.needConfirm() === false);
t('isSkipConfirm 同步为真', C.isSkipConfirm() === true);
C.setSkipConfirm(false);
t('可以再改回来', C.needConfirm() === true);
{
  /* 关键：**不能落盘**。源码里不应出现任何存储相关调用 */
  const src = fs.readFileSync(path.join(HERE, 'utils/confirmOnce.ts'), 'utf8');
  t('不写 localStorage', !/localStorage/.test(src));
  t('不调后端存储（ctx.store / saveConfig）',
    !/ctx\.store|saveConfig|store\.set/.test(src));
  t('不写 config（只是模块级变量）', !/FpxConfig/.test(src));
  const srcPanel = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
  t('面板里的勾选项不走 onSaved',
    /if \(skip\) setSkipConfirm\(true\);/.test(srcPanel)
    && !/onSaved\(\{[^}]*skip/i.test(srcPanel));
}

console.log('\n=== 2. 两个入口都要确认 ===');
{
  const panel = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
  /* 侧边栏入口的接线已抽到 `hooks/useChainActions`。
     这里同时读两处：只盯 App.tsx 的话，重构一次就误报一次"功能没了"，
     而**误报比漏报更伤** —— 报多了就会被当成噪音忽略掉。 */
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8')
    + fs.readFileSync(path.join(HERE, 'hooks/useChainActions.ts'), 'utf8');
  t('面板入口有 needConfirm 判断', /if \(!needConfirm\(\)\)/.test(panel));
  t('面板入口会先取预览', /chainPreview\(/.test(panel));
  t('侧边栏/快捷键入口也有 needConfirm 判断', /if \(!needConfirm\(\)\)/.test(app));
  t('侧边栏入口也会取预览', /chainPreview\(/.test(app));
  /* 侧边栏入口的确认框已随弹窗块移到 `components/DialogsHub.tsx` ——
     断言必须跟着走，否则重构一次就误报一次"功能没了"。 */
  t('侧边栏入口会渲染确认框',
    /ChainConfirmDialog/.test(app) || /ChainConfirmDialog/.test(
      fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8')));
  /* 只做一个入口的漏洞：runActionOnSelection 若直接调 sendAction 就绕过了 */
  const runBody = app.match(/const runActionOnSelection = \([\s\S]*?\n  \};/);
  t('runActionOnSelection 走的是带确认的入口',
    !!runBody && /requestSendAction/.test(runBody[0]) && !/void sendAction\(/.test(runBody[0]));
}

console.log('\n=== 3. 预览与发送同源（后端）===');
{
  const rsPath = path.join(ROOT, 'src-tauri/src/fpx/mod.rs');
  if (!fs.existsSync(rsPath)) {
    console.log('（跳过：未找到 mod.rs）');
  } else {
    const rs = fs.readFileSync(rsPath, 'utf8');
    t('存在 fpx_chain_preview', /pub fn fpx_chain_preview/.test(rs));
    const m = rs.match(/pub fn fpx_chain_preview[\s\S]*?\n\}/);
    const body = m ? m[0] : '';
    t('预览用 resolve_prompt（与发送同一套）', /resolve_prompt/.test(body));
    t('预览也过路径收口（不能靠预览读任意路径）',
      /must_be_under/.test(body));
    t('已注册到 invoke_handler',
      fs.readFileSync(path.join(ROOT, 'src-tauri/src/main.rs'), 'utf8')
        .includes('fpx_chain_preview'));
  }
}

console.log('\n=== 4. 预览失败不该拦住发送 ===');
{
  const panel = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8')
    + fs.readFileSync(path.join(HERE, 'hooks/useChainActions.ts'), 'utf8');
  /* 预览只是"看一眼"，它失败就把发送整个卡死，是典型的"辅助功能反客为主" */
  t('面板：预览失败时降级为直接发送', /预览失败，直接发送/.test(panel));
  t('侧边栏：预览失败时降级为直接发送', /预览失败，直接发送/.test(app));
  t('降级路径里带了原因（不是静默）', /errText\(e\)/.test(panel) || /errText\(e\)/.test(app));
}

console.log('\n=== 5. 确认框本身 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/ChainConfirmDialog.tsx'), 'utf8');
  t('文本可编辑（有 onChange）', /onChange=/.test(dlg));
  t('空文本不能确认', /disabled=\{busy \|\| !draft\.trim\(\)\}/.test(dlg));
  t('有「本次运行期间不再提示」勾选项', /本次运行期间不再提示/.test(dlg));
  /* 只看**用户看得见**的 JSX 文案：注释里出现"永久"是在解释为什么不落盘，
     拿注释去判定会把正确的代码判成错的 */
  const jsx = dlg.slice(dlg.indexOf('return ('));
  t('可见文案写明是"运行期间"（不是永久）', !/永久|始终/.test(jsx));
  /* 两个入口共用同一个组件，避免改一处忘一处 */
  const panel = fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8')
    + fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8');
  t('面板与侧边栏共用同一个确认框组件',
    /ChainConfirmDialog/.test(panel) && /ChainConfirmDialog/.test(app));
  t('确认框独立成文件（不是各写一份）',
    fs.existsSync(path.join(HERE, 'components/ChainConfirmDialog.tsx')));
}

console.log('\n=== 6. 发送失败不该留下副作用 ===');
{
  /* 只看**代码**：注释里也会写这些字，拿注释判定会把删掉的代码判成还在 */
  const strip = (s) => s.split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l))
    .join('\n');
  const panel = strip(fs.readFileSync(path.join(HERE, 'components/ToolsPanel.tsx'), 'utf8'));
  const hook = strip(fs.readFileSync(path.join(HERE, 'hooks/useChainActions.ts'), 'utf8'));

  const i = panel.indexOf('if (client) {');
  t('面板：能定位到「写回默认客户端」那段', i >= 0);
  const seg = i >= 0 ? panel.slice(i, i + 360) : '';
  t('面板：只在发送成功时写回默认客户端',
    /if \(r\.ok\) onSaved\(\{ chainClient: client \}\)/.test(seg));
  t('面板：不再无条件写回（反面证据）', !/^\s*if \(client\) onSaved\(/m.test(panel));
  t('面板：失败时说明默认没变', /默认客户端未改动/.test(seg));
  t('侧边栏：ok=false 也清防抖时间戳',
    /if \(!r\.ok\) lastSentAt\.current\.delete\(key\)/.test(hook));
}

done();
