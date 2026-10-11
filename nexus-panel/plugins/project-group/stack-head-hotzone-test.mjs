/**
 * 分类标题栏空白区可点（对齐原版 OnGroupBoxHeaderUp：非文字区零延迟切换）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/stack-head-hotzone-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsJs as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
/* 剥注释走全仓共用实现（test-scan-utils.mjs） */
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const stack = R('components/StackedGroups.tsx');
const css = R('style.css');

console.log('\n=== 1. 空白区立即切换（零延迟）===');
{
  /*
   * 名字按钮那一块要延后 220ms 好让双击改名有机会取消它，
   * 但那份延迟不该波及整个标题栏 —— 折个叠还要等一下，
   * 手快的会觉得"点了没反应"。
   */
  t('head 上挂了点击', /className="fpx-stack-head"[\s\S]{0,400}?onClick=\{\(e\) => \{/.test(stack));
  /*
   * 只认真正落在 head 上的点击。
   * 否则点箭头按钮会切换两次（展开又折回去），而那看起来像随机失灵。
   */
  t('只认落在空白区', /if \(e\.target !== e\.currentTarget\) return;/.test(stack));
  /* 正在拖分类时不误触 */
  t('拖拽中不切换', /if \(dragFrom !== -1\) return;/.test(stack));
  /* 立即 toggle，不进 setTimeout */
  const seg = stack.slice(
    stack.indexOf('onClick={(e) => {\n                if (e.target !== e.currentTarget) return;'),
    stack.indexOf('onDragStart={(e) => {'),
  );
  t('空白区不带延迟', seg.includes('toggle(i);') && !seg.includes('setTimeout'), seg.length ? '' : '未取到段');
}

console.log('\n=== 2. 名字区仍延后（双击改名不能被吃掉）===');
{
  /*
   * 钉**意图**而不是钉变量名：这两条原先写的是 `clickTimer.current`
   * （单个共用 ref 的旧实现），改成按分类下标分开存之后必然误报 ——
   * 而守的本意是"折叠延后 220ms、双击能取消它"，与用几个槽位无关。
   */
  const ANCHOR = 'title="单击折叠 / 双击重命名"';
  const nameSeg = stack.slice(stack.indexOf(ANCHOR));
  t('名字按钮那一段取到了', nameSeg.length > 200, `${nameSeg.length} 字节`);
  t('名字按钮延后 220ms', /window\.setTimeout\(\(\) => \{[\s\S]{0,300}?\}, 220\);/.test(nameSeg));
  /* 只认"取消**这一个分类**的"，共用一个槽位的写法这里就该红 */
  t('双击取消这一个分类待执行的折叠',
    /onDoubleClick=\{\(\) => \{[\s\S]{0,300}?clickTimers\.current\.get\(i\)[\s\S]{0,200}?clearTimeout\(prev\)/.test(nameSeg));
  t('按分类下标分开存（不共用一个槽位）', /clickTimers\.current\.set\(i, id\)/.test(nameSeg));
}

console.log('\n=== 3. 空白区要有实际宽度才点得到 ===');
{
  /*
   * 此前 `.fpx-stack-spacer { flex: 0; width: 0 }` ——
   * 宽度为 0 的元素点不到，热区等于不存在。
   */
  t('spacer 有宽度', /\.fpx-stack-spacer \{ flex: 1; min-width: 8px; cursor: pointer; \}/.test(css));
  t('不再 width: 0', !/\.fpx-stack-spacer \{ flex: 0; width: 0; \}/.test(css));
  /* 光标要提示可点 */
  t('spacer 光标可点', /\.fpx-stack-spacer \{[^}]*cursor: pointer/.test(css));
}

done();
