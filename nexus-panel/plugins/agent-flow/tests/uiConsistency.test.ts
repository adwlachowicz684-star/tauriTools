import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 界面一致性的源码级守卫。
 *
 * 这类问题**测试跑不出来**（界面看着也正常），只有人工比对才发现，
 * 而且改一处忘另一处时不会报错 —— 所以只能用源码级检查盯着。
 *
 * 注意：检查前要剥掉块注释。注释里为了说明"为什么不能这么写"，
 * 正好要把坏写法原样写出来 —— **不剥的话说明本身就会让检查永远失败**。
 */

const ROOT = process.env.AF_SRC || path.resolve(__dirname, '..');
const COMP = path.join(ROOT, 'components');

function stripComments(src: string): string {
  // 只剥 /* */ 块注释；行注释里的中文句号不影响这些检查
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function read(p: string): string {
  return stripComments(fs.readFileSync(p, 'utf-8'));
}

function comps(): string[] {
  if (!fs.existsSync(COMP)) return [];
  return fs.readdirSync(COMP).filter((f) => f.endsWith('.tsx'));
}

/* ================= 状态文案 ================= */

/*
 * NodeShell 是**定义处**，本身就是那份真相，排除掉 ——
 * 不排除的话这两条永远失败，进而逼人为了过测试去改坏定义。
 */
const DEFINER = 'NodeShell.tsx';

test('状态文案不整份重抄（要用 NODE_STATUS_TEXT 展开）', () => {
  const bad = comps().filter((f) => {
    if (f === DEFINER) return false;
    const s = read(path.join(COMP, f));
    // 完整抄一遍默认五档 = 两份真相
    return /idle:\s*'待运行'[\s\S]{0,200}running:/.test(s);
  });
  assert.deepEqual(bad, [], `这些组件整份抄了 statusText：${bad.join(', ')}`);
});

test('覆盖写法的组件都从 NodeShell 引 NODE_STATUS_TEXT', () => {
  for (const f of comps()) {
    if (f === DEFINER) continue;
    const s = read(path.join(COMP, f));
    if (!s.includes('NODE_STATUS_TEXT')) continue;
    assert.ok(
      /import\s*\{[^}]*NODE_STATUS_TEXT/.test(s),
      `${f} 用了 NODE_STATUS_TEXT 却没 import`,
    );
  }
});

/* ================= 颜色 ================= */

test('卡片不硬编码节点类型色（走注册表）', () => {
  /*
   * 模块卡片以前写死 '#f59e0b'，与注册表里的 color 是两份 ——
   * 改注册表配色时卡片不变，且**没有任何提示**。
   */
  const bad = comps().filter((f) => /typeColor=\{['"]#[0-9a-fA-F]{3,8}['"]/.test(read(path.join(COMP, f))));
  assert.deepEqual(bad, [], `这些组件硬编码了 typeColor：${bad.join(', ')}`);
});

/* ================= 运行时字段清单 ================= */

test('RUNTIME_KEYS 全项目只有一处定义', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const defs = engines.filter((f) =>
    /const\s+RUNTIME_KEYS\s*=/.test(read(path.join(ROOT, 'engine', f))));
  assert.deepEqual(defs, ['runtimeKeys.ts'], `运行时字段清单抄了多份：${defs.join(', ')}`);
});

test('stripRuntime 的实现只在 runtimeKeys.ts', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const impl = engines.filter((f) =>
    /function\s+stripRuntime\b/.test(read(path.join(ROOT, 'engine', f))));
  assert.deepEqual(impl, ['runtimeKeys.ts'], `stripRuntime 抄了多份：${impl.join(', ')}`);
});

/* ================= 存储键 ================= */

test('存储键统一 agent-flow 前缀', () => {
  const engines = fs.readdirSync(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.ts'));
  const bad: string[] = [];
  for (const f of engines) {
    const s = read(path.join(ROOT, 'engine', f));
    for (const m of s.matchAll(/_KEY\s*=\s*'([^']+)'/g)) {
      if (!m[1].startsWith('agent-flow')) bad.push(`${f}:${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `这些存储键没有 agent-flow 前缀：${bad.join(', ')}`);
});


/* ================= 密钥清单必须同源 ================= */

/*
 * 保险箱（canvasStore 的 SECRET_FIELDS）与脱敏（sanitize 的 SECRET_PATHS）
 * 曾经是**抄成两份**的清单，而前者少了 'config.token'。
 *
 * 后果：webhook 校验 token 被认出来是密钥，却不会被挖进保险箱 ——
 * 明文留在画布存档与导出文件里，且不报错、测试不红。
 *
 * 这是"同一件事两处写"最危险的一种：抄的是安全清单。
 */
test('SECRET_FIELDS 直接复用 SECRET_PATHS，不再自己抄一份', () => {
  /*
   * 必须先剥注释 —— 本文件的 read() 不剥。
   * 而注释里为说明"以前漏了什么"会把旧数组原样写出来，
   * 不剥的话**把清单改回错的检查依然通过**（假阴性）。
   * 这与 classNames 那条守卫踩的是同一个坑。
   */
  /*
   * 正则用**拼接**构造，不写字面量：
   * 字面量里的 /* 与 *​/ 会被 strip-ts.py 当成注释边界吃掉，
   * 生成的 .mjs 直接语法错误（这是这个脚本第四次带来这类麻烦）。
   */
  const blockComment = new RegExp('/' + '\\*' + '[\\s\\S]*?' + '\\*' + '/', 'g');
  const f = read(path.join(ROOT, 'engine/canvasStore.ts')).replace(blockComment, '');
  assert.ok(
    /const SECRET_FIELDS = SECRET_PATHS;/.test(f),
    '保险箱必须直接用 sanitize 的清单，抄一份就会漏字段',
  );
  assert.ok(
    !/const SECRET_FIELDS = \['llm\.apiKey'/.test(f),
    '不能再出现手写的密钥字段数组',
  );
  assert.ok(
    /import \{ SECRET_PATHS \} from '\.\/sanitize';/.test(f),
    '要从 sanitize 引入',
  );
});

/* ================= 并发刷新要有代号守卫 ================= */

test('MCP 刷新用 seq 守卫，避免旧结果覆盖新结果', () => {
  const app = read(path.join(ROOT, 'App.tsx'));
  assert.ok(/mcpRefreshSeq/.test(app), '并发刷新要有代号');
  /*
   * 匹配**具体那一条** return 语句，不能只查"文件里有这个比较" ——
   * finally 里还有一处 `seq === mcpRefreshSeq.current`，
   * 只查子串的话，把真正的守卫删掉检查依然通过（假阴性）。
   */
  assert.ok(
    /if \(seq !== mcpRefreshSeq\.current\) return;/.test(app),
    '拿到结果后要先确认自己还是最新那次，否则旧刷新会覆盖新结果',
  );
});

/* ================= 异步失败不能被静默吞掉 ================= */

test('startWatch 必须 catch（否则监听失败无任何提示）', () => {
  const app = read(path.join(ROOT, 'App.tsx'));
  const i = app.indexOf('startWatch(');
  assert.ok(i > 0, '要有 startWatch 调用');
  const tail = app.slice(i, i + 600);
  assert.ok(/\.catch\(/.test(tail), 'startWatch 的 Promise 必须 catch');
});
