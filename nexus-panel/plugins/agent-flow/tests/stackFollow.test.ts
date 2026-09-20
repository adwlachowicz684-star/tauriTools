import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planStackDrop, snapPosOf } from '../engine/stack';

/**
 * 拖动**串中间的一环**时，它下面的整串要跟着走。
 *
 * ================= 起因 ====================
 *
 * 三块串起来：P → A → B。拖 A 挪一点点（不到脱开阈值）：
 *
 *   拖动中   onStackDrag 让 B 跟随 A 的位移 —— 串保持完整
 *   松手时   planStackDrop 判定 A 要**归位**回 P 下方
 *           → 只有 A 的位置被改，B 停在跟随拖动后的位置
 *           → A 归位了、B 没归位：**A 和 B 在显示上分开，关系却还在**
 *
 * 用户看到的就是"挪一点点，两块裂开了但还连着"。
 *
 * 不只是归位 —— 正向吸附（A 吸到另一个节点下面）同样只改 A。
 */

const ROOT = process.env.AF_SRC ?? path.resolve(__dirname, '..');

const W = 200;
const H = 76;

const N = (id: string, x: number, y: number, stackParent?: string) => ({
  id, position: { x, y }, measured: { width: W, height: H },
  data: stackParent ? { stackParent } : {},
});

/** P → A → B 三块，A 在中间 */
function chain() {
  const P = N('P', 100, 100);
  const A = N('A', 100, 176, 'P');   // A 挂在 P 下
  const B = N('B', 100, 252, 'A');   // B 挂在 A 下
  return { P, A, B };
}

test('拖动串中间的一环归位时，它的下级要跟着', () => {
  const { P, A, B } = chain();
  /*
   * A 被拖到 (106, 182)（偏 6px，不到脱开阈值），
   * 拖动中 B 已经跟着挪到 (106, 258)。
   */
  const dragged = N('A', 106, 182, 'P');
  const movedB = N('B', 106, 258, 'A');

  const plan = planStackDrop([P, dragged, movedB], dragged, {
    oldParent: 'P', moved: false, exclude: new Set(['A', 'B']),
  });

  // A 要归位到 P 下方
  assert.deepEqual(plan.position, snapPosOf(P));

  /*
   * 关键：B 必须跟着回到 A 下方。
   * 少了它，A 归位了、B 还在偏移处 —— 两块裂开却仍连着。
   */
  const fb = plan.followers ?? [];
  const b = fb.find((m) => m.id === 'B');
  assert.ok(b, '归位时下级要出现在 followers 里');
  assert.deepEqual(b!.position, { x: 106 - 6, y: 258 - 6 }, '下级按同样位移跟随');
});

test('正向吸附到新父下面时，下级也要跟着', () => {
  const P = N('P', 100, 100);
  const Q = N('Q', 400, 400);            // 新目标
  const A = N('A', 400, 476 + 8);        // A 被拖到 Q 下方偏 8px
  const B = N('B', 400, 476 + 8 + H, 'A');

  const plan = planStackDrop([P, Q, A, B], A, {
    oldParent: 'P', moved: true, exclude: new Set(['A', 'B']),
  });
  assert.equal(plan.stackParent, 'Q', '要吸到 Q 下面');
  assert.deepEqual(plan.position, snapPosOf(Q));
  const b = (plan.followers ?? []).find((m) => m.id === 'B');
  assert.ok(b, '吸附时下级要跟着 —— 否则 A 移走了、B 留在原地，串断成两截');
});

test('没有下级时 followers 为空（不影响现有的两块嵌合）', () => {
  const P = N('P', 100, 100);
  const A = N('A', 104, 180, 'P');
  const plan = planStackDrop([P, A], A, {
    oldParent: 'P', moved: false, exclude: new Set(['A']),
  });
  assert.deepEqual(plan.position, snapPosOf(P));
  assert.deepEqual(plan.followers ?? [], []);
});

/* ------------------------------------------------------------------ */

test('App 真的应用了 followers', () => {
  /*
   * engine 算出来不算完 —— App 不应用的话等于没修。
   * 这条盯住集成层（上一类"两处都要改，改一处"的坑）。
   *
   * 要剥注释：注释里为说明"少了它会怎样"会把字段名原样写出来，
   * 不剥的话把调用删了检查照样通过（假阴性）。
   */
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    app,
    /plan\.followers/,
    'App 要读 plan.followers —— 只算不用等于没修',
  );
  assert.match(
    app,
    /moves\?\.get\(n\.id\) \?\? follow\?\.get\(n\.id\)/,
    'followers 要真的参与落位',
  );
});
