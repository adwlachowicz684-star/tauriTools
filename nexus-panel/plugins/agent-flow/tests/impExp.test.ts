import test from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, stripComments } from './srcScan';

/**
 * 三个导入器是同一份结构（都是 `{ version, <字段>: [...] }` 包装、
 * 都认裸数组、都支持 merge / replace），因此共用同一条防线。
 *
 * 只盯"某处有没有调用"是不够的 —— 调用了一个空壳函数照样通过。
 * 所以行为由各测试文件实测（见 modules.test.ts / variables.test.ts /
 * customPresets.test.ts），这里只盯**三处都接上了同一条**。
 */
const IMPORTERS = [
  { file: 'engine/customPresets.ts', noun: '预设' },
  { file: 'engine/modules.ts', noun: '模块' },
  { file: 'engine/variables.ts', noun: '变量' },
] as const;

test('三个导入器都要接上同一条 replace 防线（各写一遍就是各漏一遍）', () => {
  for (const f of IMPORTERS) {
    const src = stripComments(readSrc(f.file));
    assert.ok(
      /assertNoReplaceWipe\s*\(/.test(src),
      `${f.file} 必须在落库之前调用 assertNoReplaceWipe —— 不然文件全是坏条目时，replace 会顺带清空原有的`,
    );
    assert.ok(
      new RegExp(`noun:\\s*'${f.noun}'`).test(src),
      `${f.file} 的错误信息要说清是「${f.noun}」，不然看不出没动的是哪一批`,
    );
  }
});

test('防线只能有一处：导入器里不许再手写同样的判定', () => {
  for (const f of IMPORTERS) {
    const src = stripComments(readSrc(f.file));
    const inline = /list\.length\s*>\s*0\s*&&\s*(?:result|r)\.added/.test(src)
      || /\+\s*updated\s*===?\s*0/.test(src);
    assert.ok(
      !inline,
      `${f.file} 里还在手写"全都失败"的判定 —— 该用 assertNoReplaceWipe，`
        + '手写一份就是两份口径（改一处漏一处）',
    );
  }
});
