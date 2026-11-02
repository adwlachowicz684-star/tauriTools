import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AF_SRC } from './srcScan';

/**
 * 零引用导出基线守卫。
 *
 * 静态扫描发现 46 个导出没有任何引用。它们分三类：
 *   · engine/boardMeta.ts 整组 11 个 —— 任务板删了三次又被加回，
 *     生产零引用、只有测试在测。**冻结标注，不删**（见该文件头）。
 *   · 类型/常量预留（ScopeInfo、ChatRequest、OS_KEYRING_* …）—— 保留。
 *   · 小工具函数（isDetached、hasUpstream、peekChannel …）—— 正是本项目
 *     反复出现的「对策写了没接上」形态，逐个判「接上 / 预留 / 删」。
 *
 * 本守卫不试图判断某一项该不该存在（那需要领域判断），只钉一件事：
 * **不许新增零引用导出**。想加一个没人用的导出，要么接上，要么进这份
 * 清单并写明理由 —— 否则就是又一处「写了却没人调」。
 *
 * 口径限制：基于词频，动态分发（字符串 key 查表）可能误判，所以是
 * 「基线 + 新增即红」，不是「必须删除」。守卫自身被排除，否则它会把
 * 清单里的名字算成引用、恒绿 —— 这类自指假守卫已经踩过十几次。
 */
const ROOT = AF_SRC;
const SELF = 'tests/orphanExports.test.ts';
const SKIP = ['node_modules', 'afts', 'dist', '.git', '__pycache__'];
const EXTS = ['.ts', '.tsx', '.js', '.mjs'];

const BASELINE = new Set<string>([
  'types.ts::NodeKind',
  'types.ts::isModule',
  'types.ts::isWait',
  'types.ts::isLog',
  'types.ts::isBeep',
  'types.ts::isPlayAudio',
  'types.ts::isClock',
  'types.ts::isConst',
  'types.ts::makeTrigger',
  'engine/boardMeta.ts::serializeMeta',
  'engine/boardMeta.ts::isFinalStatus',
  'engine/boardMeta.ts::idleStatusId',
  'engine/boardMeta.ts::canFlow',
  'engine/boardMeta.ts::nextStatuses',
  'engine/boardMeta.ts::tagColor',
  'engine/boardMeta.ts::addTag',
  'engine/boardMeta.ts::removeTag',
  'engine/boardMeta.ts::updateTag',
  'engine/boardMeta.ts::addStatus',
  'engine/boardMeta.ts::moveStatus',
  'engine/canvasParams.ts::paramNamesOf',
  'engine/canvasParams.ts::paramsToRecord',
  'engine/credentialStore.ts::CRED_STORE_KEY',
  'engine/exportDir.ts::ExportDirSetting',
  'engine/github.ts::ScopeInfo',
  'engine/llm.ts::ChatRequest',
  'engine/mcp.ts::mcpNeedOf',
  'engine/mcp.ts::MCP_NODE_CHECKLIST',
  'engine/mcpRegistry.ts::mcpServerGroups',
  'engine/modules.ts::isPackableSelected',
  'engine/nodeSpec.ts::unknownParams',
  'engine/ops.ts::isArgPart',
  'engine/osKeyring.ts::OS_KEYRING_SERVICE',
  'engine/osKeyring.ts::OS_KEYRING_ACCOUNT',
  'engine/osKeyring.ts::osKeyringHint',
  'engine/stack.ts::isInStack',
  'engine/taskTable.ts::TABLE_TOTAL_WIDTH',
  'engine/upstream.ts::hasUpstream',
  'engine/variables.ts::varRefsOf',
  'engine/variables.ts::isDetached',
  'lib/channel.ts::peekChannel',
  'lib/channel.ts::resetChannelCache',
  'lib/tauri.ts::fsListRoots',
  'lib/tauri.ts::fsDisallowRoot',
  'lib/tauri.ts::canPickDir',
  'tests/runnerRegistry.test.ts::MCP_DAT',
]);

function allSrc(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP.includes(e.name)) continue;
        walk(path.join(d, e.name));
      } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
        const abs = path.join(d, e.name);
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (rel === SELF) continue;
        out.push({ rel, src: fs.readFileSync(abs, 'utf-8') });
      }
    }
  };
  walk(ROOT);
  return out;
}

const EXP_RE = /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum|abstract\s+class)\s+(\w+)|export\s*\{([^}]*)\}/g;
const WORD_RE = /\b[A-Za-z_$][\w$]*\b/g;

function scan() {
  const files = allSrc();
  const exports: [string, string][] = [];
  const words = new Map<string, number>();
  for (const f of files) {
    for (const m of f.src.matchAll(EXP_RE)) {
      if (m[1]) { exports.push([f.rel, m[1]]); continue; }
      for (const part of (m[2] || '').split(',')) {
        const nm = part.trim().split(' as ').pop()!.trim();
        if (/^\w+$/.test(nm)) exports.push([f.rel, nm]);
      }
    }
    for (const m of f.src.matchAll(WORD_RE)) {
      words.set(m[0], (words.get(m[0]) ?? 0) + 1);
    }
  }
  const zero = exports
    .filter(([, nm]) => (words.get(nm) ?? 0) <= 1)
    .map(([rel, nm]) => `${rel}::${nm}`);
  return { files, exports, zero };
}

test('（前置）守卫读到了真实源码，不是空串', () => {
  const r = scan();
  assert.ok(r.files.length > 300, `只扫到 ${r.files.length} 个文件`);
  assert.ok(r.exports.length > 1000, `只解析出 ${r.exports.length} 个导出`);
  assert.ok(r.zero.length > 0, '一个零引用导出都没有 —— 扫描口径多半变了');
});

test('不许新增零引用导出（新增即红，接上或登记理由）', () => {
  const r = scan();
  const fresh = r.zero.filter((z) => !BASELINE.has(z));
  assert.deepEqual(fresh, [],
    `新增了 ${fresh.length} 个零引用导出：\n  ${fresh.join('\n  ')}\n` +
    '要么接上调用，要么加进 BASELINE 并在文件头写明为什么留着。');
});

test('boardMeta 那组仍登记为冻结（防止有人悄悄删掉基线项）', () => {
  const frozen = [
    'serializeMeta', 'isFinalStatus', 'idleStatusId', 'canFlow', 'nextStatuses',
    'tagColor', 'addTag', 'removeTag', 'updateTag', 'addStatus', 'moveStatus',
  ];
  for (const n of frozen) {
    assert.ok(BASELINE.has(`engine/boardMeta.ts::${n}`), `基线里少了 ${n}`);
  }
  const head = fs.readFileSync(path.join(ROOT, 'engine/boardMeta.ts'), 'utf-8');
  assert.match(head.slice(0, 1600), /冻结/, 'boardMeta.ts 文件头的冻结标注不见了');
});
