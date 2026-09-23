import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.AF_SRC || path.resolve(__dirname, '..');
/** nexus-panel/ */
const PANEL = path.resolve(ROOT, '..', '..');

/*
 * ================= 拖放进不了画布：环境问题，不是代码问题 =================
 *
 * ================= 症状 =================
 *
 * 从左侧节点库拖节点到画布，松手后**什么都没发生**；
 * 而按住 Ctrl 单击同一个条目能正常添加。
 * 表现为"拖放坏了"，于是排查方向一直被引向事件系统与坐标换算。
 *
 * ================= 根因 =================
 *
 * 桌面端是 Tauri（WebView2 / WebKitGTK）壳。Tauri 默认
 * `dragDropEnabled: true`，它会**接管 webview 的拖放**，
 * 用于支持"把文件拖进窗口"。接管之后，页面内部的
 * HTML5 拖放（draggable + dragstart/dragover/drop）拿不到 drop 事件。
 *
 * Tauri 文档原话：禁用它是"在 Windows 上使用前端 HTML5 拖放 API 的前提"。
 *
 * 开发时跑 `vite dev` 是浏览器，不受这个开关影响 —— 于是
 * "开发时好好的、打包后拖不动"，很难联想到是打包配置。
 *
 * ================= 为什么可以直接关掉 =================
 *
 * 全仓库没有任何一处依赖"拖文件进窗口"：
 * 选目录走的是 js/dialog.js 的对话框，不是拖放。
 * 关掉没有功能损失。
 *
 * ================= 这条守卫盯什么 =================
 *
 * 配置文件是 JSON，**写不了注释**。所以"为什么是 false"只能落在这里。
 * 改回 true 会让拖放再次静默失效 —— 而它失效的样子是"没反应"，
 * 没有任何报错，谁改谁知道不了。
 */
test('Tauri 不接管拖放（否则页面内 HTML5 拖放拿不到 drop）', () => {
  const conf = path.join(PANEL, 'src-tauri', 'tauri.conf.json');
  assert.ok(fs.existsSync(conf), '找不到 tauri.conf.json');

  const raw = fs.readFileSync(conf, 'utf-8');
  /* JSON 不支持注释，所以先剥掉再解析（万一将来换成 json5） */
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const c = JSON.parse(json);
  const win = c?.app?.windows?.[0];
  assert.ok(win, 'tauri.conf.json 里没有 windows[0]');
  assert.equal(
    win.dragDropEnabled, false,
    'dragDropEnabled 必须是 false —— 为 true 时 Tauri 会接管拖放，'
    + '页面内的 HTML5 拖放（侧栏拖节点进画布）收不到 drop 事件',
  );
});

/*
 * 反过来也要盯：拖放一旦失败，必须**有反馈**。
 *
 * "拖了没反应"是最难查的一类问题 —— 它和"事件没触发"、
 * "坐标算错落到视口外"、"环境接管了拖放"在界面上长得一模一样。
 * 静默 return 等于把这三者的区分信息全丢掉。
 */
test('拖放解析失败时不静默（要有日志提示）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf-8');

  /* spawnNode：preset 找不到 */
  const i = app.indexOf('const spawnNode = useCallback');
  assert.ok(i > 0, '找不到 spawnNode');
  const block = app.slice(i, i + 3000);
  assert.ok(
    /if\s*\(!preset\)\s*\{[\s\S]{0,200}?pushLog/.test(block),
    'spawnNode 里 preset 找不到时仍静默 return —— 拖了没反应无从区分原因',
  );

  /* onDrop：payload 读不出来 */
  const j = app.indexOf('const onDrop = useCallback');
  assert.ok(j > 0, '找不到 onDrop');
  const dblock = app.slice(j, j + 3000);
  assert.ok(
    /if\s*\(!payload\)\s*\{[\s\S]{0,200}?pushLog/.test(dblock),
    'onDrop 里 payload 读不出来时仍静默 return',
  );
});

/*
 * 拖放落点必须直接给屏幕坐标。
 *
 * screenToFlowPosition 内部自己减容器偏移（xyflow 源码里
 * getBoundingClientRect 那一行），调用处再减一次 wrapperRef 的 bounds
 * 就是减两遍 —— 落点整体往左上偏一个侧栏宽度，
 * 拖到画布左侧算出负坐标，节点落到视口外。
 *
 * 表现同样是"拖进去没反应"（节点加了但看不见），
 * 与上面那条环境问题是**两个独立的因**，都要盯。
 */
test('拖放落点直接传屏幕坐标（不重复减容器偏移）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf-8');
  const i = app.indexOf('const flowPosOf = useCallback');
  assert.ok(i > 0, '找不到 flowPosOf');
  const block = app.slice(i, i + 400);

  assert.match(block, /screenToFlowPosition/, 'flowPosOf 要走 screenToFlowPosition');
  assert.doesNotMatch(block, /getBoundingClientRect/,
    'flowPosOf 不能再自己减容器偏移 —— screenToFlowPosition 内部已经减了');
  assert.doesNotMatch(block, /bounds\.left|bounds\.top/,
    'flowPosOf 不能再减 wrapperRef 的 bounds');
});
