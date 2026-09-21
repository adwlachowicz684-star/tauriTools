/**
 * Esc 逐层关闭浮层（#250，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/escape-layer-test.mjs
 *
 * 此前每层浮各自 window.addEventListener('keydown')，
 * 按一次 Esc **所有层一起关** —— 用户只想退出当前这一步，
 * 结果连底下正在填的表单一起没了。
 *
 * 且 e.stopPropagation() 挡不住：多个监听器挂在同一个 window 上，
 * 同目标的监听器互不影响。只能靠栈判"谁在最上面"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const ui = R('components/ui.tsx');

console.log('\n=== 1. 有层级栈，且只让栈顶响应 ===');
{
  t('有栈', /const escStack: symbol\[\] = \[\]/.test(ui));
  t('有 useEscapeLayer', /export function useEscapeLayer\(/.test(ui));
  t('挂载时入栈', /escStack\.push\(token\)/.test(ui));
  t('只让栈顶响应', /if \(escStack\[escStack\.length - 1\] !== token\) return;/.test(ui));
  t('卸载时出栈',
    /const i = escStack\.indexOf\(token\);/.test(ui)
    && /if \(i >= 0\) escStack\.splice\(i, 1\);/.test(ui));
  t('卸载时摘监听', /window\.removeEventListener\('keydown', onKey\)/.test(ui));
}

console.log('\n=== 2. 回调不能读到过期 state ===');
{
  /* 例如"正在确认关闭"这个标志：闭包 stale 会导致 Esc 关错分支 */
  t('用 ref 存回调', /const h = useRef\(handler\);/.test(ui));
  t('每次渲染刷新', /h\.current = handler;/.test(ui));
  t('调用的是最新那份', /h\.current\(\);/.test(ui));
}

console.log('\n=== 3. 浮层都接入了（Modal / 菜单）===');
{
  /* Modal：有未保存改动时先撤确认、再关 —— 一次 Esc 退一步 */
  t('Modal 用层级栈', /useEscapeLayer\(\(\) => \{[\s\S]{0,120}?if \(confirming\) setConfirming\(false\);/.test(ui));
  t('菜单用层级栈', /useEscapeLayer\(onClose\);/.test(ui));
  /* Modal 不再自己 addEventListener keydown（那样就是两层） */
  t('Modal 没有裸 keydown 监听', !/e\.stopPropagation\(\);\s*\n\s*if \(confirming\)/.test(ui));
}

console.log('\n=== 4. 确认弹窗不能重复处理同一个 Esc ===');
{
  /* ConfirmDialog 渲染的就是 Modal，两边都监听 = 同一个 Esc 处理两遍 */
  /* 切片终点不能用 '\n}'：函数签名那段的 props 解构就以 `,
}>` 收尾，
     第一个 '\n}' 落在签名末尾，切片只有 97 字符 —— 断言静默为 false。
     改按"下一个 export function"截断，或取足够长的一段。 */
  const cd = ui.slice(ui.indexOf('export function ConfirmDialog'));
  const next = cd.indexOf('export function', 10);
  const seg = next > 0 ? cd.slice(0, next) : cd;
  t('确认弹窗只处理回车', /if \(e\.key !== 'Enter'\) return;/.test(seg));
  t('确认弹窗不再处理 Esc', !/e\.key === 'Escape'/.test(seg));
}

console.log('\n=== 5. 内层编辑要拦住事件（否则退一步变退到底）===');
{
  for (const [name, src] of [
    ['页签改名', R('components/TabManagerDialog.tsx')],
    ['分类改名', R('components/StackedGroups.tsx')],
    ['卡片改名', R('components/CardGrid.tsx')],
    ['链接改名', R('components/LinkPanel.tsx')],
  ]) {
    t(`${name}：Esc 时 stopPropagation`, /e\.key === 'Escape'[\s\S]{0,400}?e\.stopPropagation\(\)/.test(src));
  }
}

done();
