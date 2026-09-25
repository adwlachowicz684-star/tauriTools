/**
 * 「进行中」提示回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/busy-indicator-test.mjs
 *
 * 覆盖三件容易做错的事：
 *   1. 忙态必须是**计数**，不能是布尔 —— 布尔下并发操作中先结束的那个
 *      会把 busy 置回 false，而另一个还在跑
 *   2. 「进行中」必须**延迟显示**且**显示后至少停留一会儿** ——
 *      立刻显示会让每次保存都闪一下，比不显示更糟
 *   3. 浮层必须 `pointer-events: none` —— 它浮在日志区按钮上面
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

/** 只看**代码**：注释里也会写这些字，拿注释判定会把删掉的代码判成还在 */
const strip = (s) => s.split('\n')
  .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l))
  .join('\n');

console.log('=== 1. 忙态是计数，不是布尔 ===');
{
  const hook = strip(read('hooks/useFpx.ts'));
  t('声明的是计数而不是布尔（反面证据）', !/const \[busy, setBusy\] = useState\(false\)/.test(hook));
  t('有 busyCount', /const \[busyCount, setBusyCount\] = useState\(0\)/.test(hook));
  t('run 开始时 +1', /setBusyCount\(\(c\) => c \+ 1\)/.test(hook));
  t('run 结束时 -1', /setBusyCount\(\(c\) => Math\.max\(0, c - 1\)\)/.test(hook));
  /* 布尔写法下就是这两句，留着任何一个都说明没改干净 */
  t('不再有 setBusy(true)（反面证据）', !/setBusy\(true\)/.test(hook));
  t('不再有 setBusy(false)（反面证据）', !/setBusy\(false\)/.test(hook));
  t('对外仍是布尔 busy', /busy: busyCount > 0/.test(hook));
}

console.log('\n=== 2. 标签要透出去，界面才知道在做什么 ===');
{
  const hook = strip(read('hooks/useFpx.ts'));
  t('有 busyLabel 状态', /const \[busyLabel, setBusyLabel\] = useState\(''\)/.test(hook));
  t('run 里写入 label', /setBusyLabel\(label\)/.test(hook));
  t('返回 busyLabel', /busy: busyCount > 0, busyLabel,/.test(hook));
}

console.log('\n=== 3. 真正挂到界面上 ===');
{
  const app = strip(read('App.tsx'));
  t('引入了 BusyIndicator', /import \{ BusyIndicator \} from '\.\/components\/BusyIndicator'/.test(app));
  t('挂载了 BusyIndicator', /<BusyIndicator /.test(app));
  t('busy 传进去了', /busy=\{s\.busy\}/.test(app));
  t('label 传进去了', /label=\{s\.busyLabel\}/.test(app));
}

console.log('\n=== 4. 延迟显示 + 最短停留 ===');
{
  const src = strip(read('components/BusyIndicator.tsx'));
  t('有延迟参数', /delay = 250/.test(src));
  t('有最短停留参数', /minShow = 600/.test(src));
  /* 只看这两个参数不够 —— 参数定义了却没用才是同类问题最爱长的形状 */
  t('延迟真的用上了', /setTimeout\(\(\) => \{[\s\S]{0,80}setShown\(true\)[\s\S]{0,20}\}, delay\)/.test(src));
  t('最短停留真的用上了',
    /const left = busyHideDelay\(shownRef\.current, Date\.now\(\) - startRef\.current, minShow\)/.test(src));
  /* 算出来却没传给定时器 = 等于没做最短停留，多钉一层 */
  t('停留时长真的传给了定时器', /setTimeout\(\(\) => \{[\s\S]{0,160}?\}, left\)/.test(src));
  t('没显示过就直接结束（短操作不排隐藏定时器）', /if \(!shownRef\.current\) return;/.test(src));
  /* shownRef 不能进依赖数组：进去会让 busy 期间 startRef 被反复重置 */
  t('依赖数组不含 shown', /\}, \[busy, delay, minShow\]\);/.test(src));
}

console.log('\n=== 5. 无障碍与不挡操作 ===');
{
  const src = strip(read('components/BusyIndicator.tsx'));
  /* 容器常驻 DOM：临时挂载的 live region 屏幕阅读器读不到 */
  t('容器常驻（不是 busy 时才渲染）', !/if \(!busy\) return null/.test(src));
  t('有 role=status', /role="status"/.test(src));
  t('有 aria-live', /aria-live="polite"/.test(src));
  /* 转圈是装饰，不该被读出来 */
  t('转圈标记 aria-hidden', /aria-hidden="true"/.test(src));

  const css = read('style.css');
  t('样式里有 .fpx-busy', /\.fpx-busy \{/.test(css));
  t('不挡点击（pointer-events: none）', /\.fpx-busy \{[\s\S]{0,400}?pointer-events: none/.test(css));
  t('层级低于弹窗遮罩（不盖住弹窗）', /\.fpx-busy \{[\s\S]{0,400}?z-index: 40/.test(css));
  t('尊重减少动效偏好', /prefers-reduced-motion: reduce[\s\S]{0,200}fpx-busy-dot/.test(css));
}

console.log('\n=== 6. 时间逻辑真跑（穷举，不只是文本）===');
{
  /*
   * 整个组件含 JSX，node 里跑不了（没有 esbuild，同 drag-payload-test 的处境）。
   * 所以把**不含 JSX 的两个纯函数**切出来单独加载 ——
   * 它们恰好是最容易写错的部分：写错了的表现是"闪一下就没了"
   * 或"该消失了还杵在那儿"，只在特定时长下复现，手测撞不准。
   */
  const full = read('components/BusyIndicator.tsx');
  const start = full.indexOf('export function busyHideDelay');
  const end = full.indexOf('export interface BusyIndicatorProps');
  t('能定位到两个纯函数（切片锚点有效）', start >= 0 && end > start);

  const os = await import('node:os');
  const tmp = path.join(os.tmpdir(), `busy-pure.${process.pid}.ts`);
  fs.writeFileSync(tmp, full.slice(start, end));
  const mod = await loadTs(tmp);
  fs.rmSync(tmp, { force: true });

  const { busyHideDelay, busyText } = mod;
  t('导出 busyHideDelay', typeof busyHideDelay === 'function');
  t('导出 busyText', typeof busyText === 'function');

  const MIN = 600;
  t('没显示过 → 立刻隐藏（0ms）', busyHideDelay(false, 0, MIN) === 0);
  t('刚显示就结束 → 补足整段最短时长', busyHideDelay(true, 0, MIN) === MIN);
  t('已显示 300ms → 还需补 300ms', busyHideDelay(true, 300, MIN) === 300);
  t('已显示超时 → 立即隐藏', busyHideDelay(true, 900, MIN) === 0);
  /* 时钟回拨 / 负数：不该因此停留得比最短时长还久 */
  t('已显示时长为负 → 不超过最短时长', busyHideDelay(true, -50, MIN) === MIN);

  let ok = true;
  for (let e = -200; e <= 1500; e += 7) {
    const d = busyHideDelay(true, e, MIN);
    if (!(d >= 0 && d <= MIN)) { ok = false; break; }
    if (busyHideDelay(false, e, MIN) !== 0) { ok = false; break; }
  }
  t('穷举：结果恒在 [0, minShow] 内，且未显示恒为 0', ok);

  /* 文案：隐藏时必须为空，否则屏幕阅读器会念出没有宾语的「进行中」 */
  t('隐藏时文案为空', busyText(false, '备份') === '');
  t('显示时说清在做什么', busyText(true, '备份') === '正在备份…');
  t('不同 label 都带上（不是写死一个）', busyText(true, '重新读取配置') === '正在重新读取配置…');
}

done();
