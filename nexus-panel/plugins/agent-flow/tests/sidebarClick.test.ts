/**
 * 侧栏点击行为的回归测试。
 *
 * 组件本身挂 React 测不了（测试链路只剥类型、不转 JSX），
 * 所以这里守的是**源码里那几条关键约束**。
 *
 * 为什么值得为几条字符串写测试：这个行为改过一次
 * （原来单击即添加，误触后改成 Ctrl+点击），
 * 很容易在后续重构中被"顺手改回去"而不自知。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * 测试是在 $OUT/tests 下跑的，相对路径到不了仓库。
 * 沿用既有约定：run-tests.sh 会 export AF_SRC（插件根目录）。
 * 详见 scripts/run-tests.sh 里那段关于 Windows 原生路径的说明。
 */
const SRC = join(process.env.AF_SRC ?? process.cwd(), 'components/Sidebar.tsx');
let raw = '';
try {
  raw = readFileSync(SRC, 'utf-8');
} catch {
  raw = '';
}

/** 先剥掉块注释：注释里为了说明这个坑，正好要原样写出坏写法 */
const CODE = raw.replace(/\/\*[\s\S]*?\*\//g, '');

test('（前置）能读到 Sidebar 源码', () => {
  assert.ok(raw.length > 0, '读不到源码时下面几条会假失败，先明确报出来');
});

test('普通点击不能再直接添加节点', () => {
  assert.ok(
    !/onClick=\{\(\) =>\s*!disabled && onAdd/.test(CODE),
    '侧栏条目不应在普通 onClick 里直接 onAdd —— 那正是误触的来源',
  );
});

test('添加要走 Ctrl / ⌘ 判断', () => {
  assert.ok(
    /ctrlKey|metaKey/.test(CODE),
    '必须有修饰键判断，否则又回到单击即添加',
  );
  // 修饰键成立时才 onAdd
  assert.ok(
    /if \(e\.ctrlKey \|\| e\.metaKey\)[\s\S]{0,120}onAdd/.test(CODE),
    'onAdd 应发生在 ctrlKey/metaKey 分支里',
  );
});

test('普通点击要有反馈（展开说明），不是静默无反应', () => {
  assert.ok(
    /setOpenKey/.test(CODE),
    '普通点击应切换展开态；静默无反应会让人以为界面坏了从而反复点击',
  );
});

test('说明块带「按住 Ctrl 点击添加」的引导', () => {
  assert.ok(
    /side-desc-add/.test(CODE) && /Ctrl/.test(CODE),
    '展开后要告诉用户怎么添加，否则点开说明就卡住了',
  );
});

test('重命名 / 删除按钮要阻止冒泡', () => {
  assert.ok(
    /stopPropagation/.test(CODE),
    '不阻止冒泡的话，点 ✎ 会顺带触发展开',
  );
});

test('提示文案已同步为新的操作方式', () => {
  assert.ok(
    !/拖到画布，或点击直接添加/.test(CODE),
    '旧文案还写着"点击直接添加"，与实现不符',
  );
});
