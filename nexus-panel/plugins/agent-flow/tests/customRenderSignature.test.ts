import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * custom 字段的 render 逃生口：传参签名必须一致。
 *
 * ================= 起因 ====================
 *
 * FileParamsPanel 的 onChange 原先是**双参数** `(id, patch)`，
 * 而 task.tsx 传的是 `p.patch`（单参数，只收 patch）。
 *
 * 于是「+ 添加参数」点下去：
 *   · 第二个实参（真正的 patch）被丢弃
 *   · 第一个实参 node.id 被当成 patch 对象
 *   · params 一个都没写进去，反而把 "task1a2b" 展开成
 *     {0:'t',1:'a',…} 污染了节点 data
 *
 * 用户看到的是**"点了没反应"**，实际还在悄悄写脏数据 ——
 * 比单纯的没反应更糟，因为坏掉的数据会跟着存档一直留着。
 *
 * 而 task.tsx 那边的 `as never` 把类型检查整个绕过，编译器一声不吭。
 *
 * ================= 守卫什么 ====================
 *
 * ① 三个自定义面板的 onChange 一律单参数
 *    签名不一致本身就是这类 bug 的温床：调用方每次都得先想
 *    "这个组件接一个还是两个参数"，想错一次就是"点了没反应"。
 *
 * ② 调用方不许再写 `(id, patch) => ...` 这种适配器
 *    出现它就是"两边签名对不上"的信号 —— 应该去改签名，不是就地适配。
 */

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');

function src(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** 去掉注释 —— 注释里为了说明"以前错在哪"会把旧写法原样写出来，不剥会假阴性 */
function strip(srcText: string): string {
  return srcText.replace(/\/\*[\s\S]*?\*\//g, '');
}

const SHARED = strip(src('components/inspectors/shared.tsx'));

const PANELS = [
  'FileParamsPanel',
  'LlmConfigPanel',
  'OrderPicker',
] as const;

for (const name of PANELS) {
  test(`${name} 的 onChange 是单参数（只收 patch）`, () => {
    /*
     * 定位该组件的 props 类型块，只在块内找 ——
     * 全文搜 `onChange: (` 的话，别的组件的签名会混进来，
     * 于是把其中一个改坏也可能碰巧通过。
     */
    const at = SHARED.indexOf(`export function ${name}(`);
    assert.ok(at > 0, `找不到 ${name}`);
    const block = SHARED.slice(at, at + 1200);
    assert.ok(
      /onChange:\s*\(patch:\s*Record<string,\s*unknown>\)\s*=>\s*void/.test(block),
      `${name} 的 onChange 必须是单参数 (patch: Record<string, unknown>) => void`,
    );
    // 反向：不许再出现双参数写法
    assert.ok(
      !/onChange:\s*\(\s*id:\s*string/.test(block),
      `${name} 不该再要求传 id —— 调用方的 p.patch 自带节点 id`,
    );
  });
}

test('调用方一律写 onChange={p.patch}，不再有 (id, patch) 适配器', () => {
  const files = fs.readdirSync(path.join(ROOT, 'nodes/defs'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `nodes/defs/${f}`);

  let checked = 0;
  for (const rel of files) {
    const t = strip(src(rel));
    /*
     * `(id, patch) =>` 这种适配器就是签名不一致的信号。
     * 出现它说明调用方在"就地适配"而不是去改签名 ——
     * 下次再有新面板，同样的问题会再犯一次。
     */
    assert.ok(
      !/\(\s*id\s*,\s*patch\s*\)\s*=>/.test(t),
      `${rel} 里有 (id, patch) 适配器 —— 说明两边签名不一致，请改签名而不是适配`,
    );
    if (/onChange=\{p\.patch\}/.test(t)) checked += 1;
  }
  // 至少得有调用点，否则这个检查是空的
  assert.ok(checked > 0, '没有任何节点用 onChange={p.patch}，检查是不是写错了');
});

test('FileParamsPanel 内部不再传 node.id 给 onChange', () => {
  /*
   * 这是当初那个 bug 的直接位置：
   *  patchParams = (next) => onChange(node.id, { params: next })
   * 传了 id，而 onChange 只收 patch。
   */
  const block = SHARED.slice(
    SHARED.indexOf('export function FileParamsPanel('),
    SHARED.indexOf('export function FileParamsPanel(') + 900,
  );
  assert.ok(!/onChange\([^)]*node\.id/.test(block), 'onChange 只收 patch，不该传 node.id');
});
