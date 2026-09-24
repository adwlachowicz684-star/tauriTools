/**
 * 监听开关「谎报成功」的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/watch-toggle-test.mjs
 *
 * `fpx_watch_start` / `fpx_watch_stop` 返回的是 **bool**（线程真的启/停了吗），
 * **不是**抛异常。返回 false = 没成功。
 *
 * 原来两处调用点都把它当成功：
 *   · ToolsPanel.toggleWatch —— 照样 `onSaved({ watchEnabled: true })`
 *     并记「已开始监听受保护目录」
 *   · App 的自动恢复 —— 照样记「已按上次设置恢复受保护目录监听」
 *
 * 后果链：
 *   1. 配置被写成"启用监听"，但线程没起来
 *   2. 下次进插件 `useState(config.watchEnabled)` 让按钮显示「停止监听」，
 *      实际没在监听 —— **界面说在监听，其实没有**
 *   3. 受保护目录被外部改动时**一条告警都没有**，而用户全程看到"监听中"
 *
 * 这是"防写入"这条线上最难查的一种失效：没有任何报错，
 * 只是该响的警报永远不响。
 *
 * 这里守：
 *   · 两处都必须**判 bool**，false 时走失败文案（err 级）
 *   · 失败时**不写 watchEnabled**（留旧值下次还会重试；写成 true 又起不来
 *     等于把恢复这条路也堵死）
 *   · MCP 状态取不到不能静默 `.catch(() => {})`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const tp = read('components/ToolsPanel.tsx');
const app = read('App.tsx');

/* 剥注释：下面几条断言的字面量也都写在说明里，不剥会空跑（第 22 次同类） */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');
const tpCode = strip(tp);
const appCode = strip(app);

console.log('\n=== 1. 后端返回的是 bool，不是抛异常 ===');
{
  const mod = read('../../src-tauri/src/fpx/mod.rs');
  const i = mod.indexOf('pub fn fpx_watch_start');
  const blk = mod.slice(i, i + 700);
  t('watch_start 返回 Result<bool>', /Result<bool, String>/.test(blk));
  t('返回的是"是否真的在跑"', /Ok\(watch::is_running\(\)\)/.test(blk));
  const j = mod.indexOf('pub fn fpx_watch_stop');
  const blk2 = mod.slice(j, j + 300);
  t('watch_stop 同样返回 bool', /pub fn fpx_watch_stop\(\) -> bool/.test(blk2));
}

console.log('\n=== 2. ToolsPanel：开始失败要说出来 ★ ===');
{
  t('取到返回值', /const ok = await api\.watchStart\(/.test(tpCode));
  t('失败时明确提示', /开始监听失败/.test(tpCode));
  t('提示是 err 级', /onLog\('开始监听失败[^']*', true\)/.test(tpCode));
  /*
   * 失败必须**早退**，不能继续往下写配置 + 记成功。
   * 钉"失败分支里有 return"而不只是"有这句文案" ——
   * 只钉文案的话，文案留着、return 删掉，配置照样被写成 true。
   */
  const i = tpCode.indexOf('开始监听失败');
  const seg = tpCode.slice(i, i + 200);
  t('失败后早退（不落配置）', /return;/.test(seg));
  t('失败文案说明配置未改动', /配置未改动/.test(seg));

  /* 反面证据：成功那句文案**不能**无条件跟在 watchStart 后面 */
  const iStart = tpCode.indexOf('const ok = await api.watchStart(');
  const after = tpCode.slice(iStart, iStart + 400);
  const iFail = after.indexOf('开始监听失败');
  const iSucc = after.indexOf('已开始监听受保护目录');
  /*
   * 两端都要判存在：`indexOf` 找不到返回 -1，而 `-1 < 正数` **恒真** →
   * 锚点一改写法这条就空跑（第 22 次同类，护栏第 3 组就是为它加的）。
   */
  t('成功文案在失败分支之后', iFail >= 0 && iSucc >= 0 && iFail < iSucc, `fail@${iFail} succ@${iSucc}`);
}

console.log('\n=== 3. ToolsPanel：停止失败也要说出来 ===');
{
  t('取到返回值', /const ok = await api\.watchStop\(/.test(tpCode));
  t('失败时明确提示', /停止监听失败/.test(tpCode));
  t('提示是 err 级', /onLog\('停止监听失败[^']*', true\)/.test(tpCode));
  const i = tpCode.indexOf('停止监听失败');
  const seg = tpCode.slice(i, i + 200);
  t('失败后早退（不落配置）', /return;/.test(seg));
  /* 停止失败 = 线程可能还在跑，界面不能显示成已停 */
  t('失败时不把界面切成已停', /setWatchOn\(!ok\)/.test(tpCode));
}

console.log('\n=== 4. App：自动恢复同样不能谎报 ★ ===');
{
  const i = appCode.indexOf('api.watchStart(boot.config.watchIntervalSecs)');
  t('存在自动恢复调用', i >= 0);
  const seg = appCode.slice(i, i + 500);
  t('判 bool 而不是只看 then', /\.then\(\(ok\) =>/.test(seg));
  t('false 时走失败文案', /if \(!ok\)/.test(seg));
  t('失败文案是 err 级', /线程未能启动[^']*', true\)/.test(seg));
  t('失败文案说明配置仍是启用（还会重试）', /配置仍是"启用"/.test(seg));
  const iFail2 = seg.indexOf('线程未能启动');
  const iSucc2 = seg.indexOf('已按上次设置恢复受保护目录监听');
  /* 同上：两端都判存在，否则 -1 < 正数 恒真 → 空跑 */
  t('成功文案在失败分支之后', iFail2 >= 0 && iSucc2 >= 0 && iFail2 < iSucc2, `fail@${iFail2} succ@${iSucc2}`);
}

console.log('\n=== 5. MCP 状态取不到不能静默 ===');
{
  /* `.catch(() => {})` 会让按钮停在"启动"，而 server 可能正在跑 ——
     用户点启动撞上端口占用，报错还指不到"其实已经起来了"。 */
  t('不再静默吞掉', !/\.catch\(\(\) => \{\}\)/.test(tpCode));
  t('取状态失败要记日志', /读取 MCP 状态失败/.test(tpCode));
  t('这条也是 err 级', /读取 MCP 状态失败[^`]*\$\{errText\(e\)\}`, true\)/.test(tpCode));
}

done();
