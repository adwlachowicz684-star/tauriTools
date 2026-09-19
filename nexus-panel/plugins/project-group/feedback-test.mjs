/**
 * 面板内操作反馈条回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/feedback-test.mjs
 *
 * #9 的关键不是"多了一个条子"，而是**它与 toast 分工不同**：
 *   · 反馈条能回看，但固定在顶部，操作在底部时它在屏幕外
 *   · toast 一闪而过，但立刻出现在视线里
 * 所以错误必须两者都给，普通提示以反馈条为主。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const {
  FEEDBACK_MAX, pushFeedback, dismissFeedback, clearFeedback, feedbackTime,
} = await loadTs(path.join(HERE, 'utils/feedback.ts'));

console.log('\n=== 1. 追加与排序 ===');
{
  let f = [];
  f = pushFeedback(f, '第一条');
  t('追加一条', f.length === 1);
  t('正文正确', f[0].text === '第一条');
  f = pushFeedback(f, '第二条');
  /* **最新在最上面**：面板很长时，追加在末尾要滚到底才看得到 */
  t('最新的排在首位', f[0].text === '第二条', f.map((x) => x.text).join(','));
  t('旧的往后移', f[1].text === '第一条');
}

console.log('\n=== 2. 上限与丢弃策略 ===');
{
  let f = [];
  for (let i = 1; i <= FEEDBACK_MAX + 3; i++) f = pushFeedback(f, `第${i}条`);
  t(`不超过 ${FEEDBACK_MAX} 条`, f.length === FEEDBACK_MAX, `${f.length} 条`);
  /* 丢**最旧的**，保留最近的。
     加了 FEEDBACK_MAX+3 条，保留最近 FEEDBACK_MAX 条，
     所以最旧那条是第 (FEEDBACK_MAX+3) - FEEDBACK_MAX + 1 = 第 4 条 ——
     期望别想当然写成"第 FEEDBACK_MAX 条"。 */
  const oldest = FEEDBACK_MAX + 3 - FEEDBACK_MAX + 1;
  t('丢的是最旧的', f[f.length - 1].text === `第${oldest}条`, f[f.length - 1].text);
  t('保留最近的一条', f[0].text === `第${FEEDBACK_MAX + 3}条`);
  /* 上限不能太大：攒几百条就成了第二个日志区，把面板内容挤下去 */
  t('上限是个小数（不是第二个日志区）', FEEDBACK_MAX <= 8, String(FEEDBACK_MAX));
}

console.log('\n=== 3. 错误标记 ===');
{
  let f = pushFeedback([], '正常', false);
  t('普通反馈 isError=false', f[0].isError === false);
  f = pushFeedback([], '失败', true);
  t('错误反馈 isError=true', f[0].isError === true);
  t('默认非错误', pushFeedback([], 'x')[0].isError === false);
}

console.log('\n=== 4. 关闭与清空 ===');
{
  let f = pushFeedback(pushFeedback([], 'a'), 'b');
  const id = f[1].id;
  f = dismissFeedback(f, id);
  t('关掉指定那条', f.length === 1 && f[0].text === 'b');
  /* id 不匹配则原样返回（不能误删别的） */
  t('id 不匹配时原样返回', dismissFeedback(f, 99999).length === 1);
  t('清空', clearFeedback().length === 0);
  t('id 唯一', (() => {
    let g = [];
    for (let i = 0; i < 10; i++) g = pushFeedback(g, `x${i}`);
    return new Set(g.map((x) => x.id)).size === g.length;
  })());
}

console.log('\n=== 5. 时间显示 ===');
{
  const d = new Date();
  d.setHours(9, 5, 3);
  const s = feedbackTime(d.getTime());
  t('时分秒补零', s === '09:05:03', s);
  t('是 HH:MM:SS 形态', /^\d{2}:\d{2}:\d{2}$/.test(s));
}

console.log('\n=== 6. 界面接线 ===');
{
  const st = fs.readFileSync(path.join(HERE, 'Settings.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('渲染反馈条', /fpx-feedback/.test(st));
  /* 空列表不渲染 —— 不留一块空白占位 */
  t('空列表不渲染', /\{fbs\.length > 0 && \(/.test(st));
  /* 追加走 pushFeedback（含上限与排序），不能直接 push */
  t('走 pushFeedback', /pushFeedback\(prev, m, isError\)/.test(st));
  t('没有裸 push 到数组', !/setFbs\(\(prev\) => \[.*prev\]\)/.test(st));
  /* **错误必须同时 toast**：反馈条在顶部、操作在底部时它看不见 */
  t('错误额外 toast', /if \(isError\) ctx\.toast\(m, 'err'\)/.test(st));
  /* 普通提示不刷屏（只进反馈条） */
  t('普通提示不 toast', !/ctx\.toast\(m, isError \? 'err' : 'ok'\)/.test(st));

  /* 每条都能单独关掉 */
  t('可单条关闭', /dismissFeedback\(prev, f\.id\)/.test(st));
  t('可全部清空', /setFbs\(clearFeedback\(\)\)/.test(st));

  /* 样式：吸顶（否则底部操作时看不见） */
  t('反馈条吸顶', /\.fpx-feedback\s*\{[^}]*position: sticky/.test(cssNC));
  /* 错误与正常要能一眼区分 */
  t('错误行有独立配色', /\.fpx-feedback-row\.err/.test(cssNC));
  t('关闭按钮有键盘可见态', /\.fpx-feedback-x:focus-visible/.test(cssNC));
}

done();
