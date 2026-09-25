import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AF_SRC, stripComments } from './srcScan';
import { UPDATE_SIDEBAR_SOURCES, type UpdateSource } from '../types';

/**
 * 侧栏入口（presets）必须写在 def.meta 里。
 *
 * ================= 为什么单独盯这一条 =================
 *
 * 注册表读的是 def.meta.presets（见 nodes/registry.tsx 的 allPresets），
 * 写在 def 顶层的那份它根本不看，而是静默回退成"只列一条"。
 *
 * 后果不报错：侧栏里少几个入口而已，界面看着完全正常 ——
 * 「更新检测」本该按源展开成 B站 / 公众号 / 小红书 / 仓库四条，
 * 写错位置就只剩一条，新增的小红书那条直接不出现。
 *
 * 类型检查其实能抓到（NodeDef 上没有这个属性），
 * 但这个项目里 styles.css 那种整份覆盖出过事，
 * 多一道运行时守卫不是为了替代类型，而是为了在被覆盖后仍能报出来。
 */

const DEFS_DIR = path.join(AF_SRC, 'nodes', 'defs');

/** 顶层键：用来定"第几层算 def 的顶层" */
const TOP_KEYS = ['type', 'dataKind', 'meta', 'create', 'Canvas', 'Inspector', 'fields', 'run'];

/** 剥掉字符串字面量 —— 里面的 ':'、'{' 不该参与层数计算 */
function stripStrings(src: string): string {
  return src
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 每个字符所在的花括号层数。
 *
 * 开括号处记的是**进入之前**的层数，于是 `registerNode({` 里的
 * `type:` 与 `meta:` 层数相同，而 meta 里的 `presets:` 更深一层。
 */
function depthMap(s: string): number[] {
  const d: number[] = new Array(s.length);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') {
      d[i] = depth;
      depth += 1;
    } else if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      d[i] = depth;
    } else {
      d[i] = depth;
    }
  }
  return d;
}

function depthsOfKey(s: string, key: string): number[] {
  const d = depthMap(s);
  const re = new RegExp(`\\b${key}\\s*:`, 'g');
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(d[m.index] ?? 0);
  return out;
}

function defFiles(): string[] {
  if (!fs.existsSync(DEFS_DIR)) return [];
  return fs
    .readdirSync(DEFS_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => path.join('nodes', 'defs', f));
}

test('presets 必须写在 meta 里（写在 def 顶层会被注册表静默忽略）', () => {
  const files = defFiles();
  assert.ok(files.length > 0, '应当能读到 nodes/defs 下的节点定义');

  const wrong: string[] = [];
  for (const rel of files) {
    const abs = path.join(AF_SRC, rel);
    const s = stripStrings(stripComments(fs.readFileSync(abs, 'utf-8')));
    const presets = depthsOfKey(s, 'presets');
    if (presets.length === 0) continue;

    const topDeps = TOP_KEYS.flatMap((k) => depthsOfKey(s, k));
    assert.ok(topDeps.length > 0, `${rel} 里没找到任何顶层键，守卫自身的判据失效了`);
    const top = Math.min(...topDeps);

    for (const d of presets) {
      if (d <= top) wrong.push(`${rel}（第 ${d} 层，顶层是第 ${top} 层）`);
    }
  }
  assert.deepEqual(wrong, [], `这些定义把 presets 写在了 def 顶层，侧栏只会列出一条：\n${wrong.join('\n')}`);
});

test('更新检测按源在侧栏展开（小红书是其中之一）', () => {
  const abs = path.join(AF_SRC, 'nodes', 'defs', 'update.tsx');
  const raw = stripComments(fs.readFileSync(abs, 'utf-8'));
  const s = stripStrings(raw);

  // presets 必须在 meta 里 —— 上一条是通用守卫，这里再钉一次具体节点，
  // 因为它是「新增的源在侧栏里根本不出现」这件事唯一会被发现的地方
  const presets = depthsOfKey(s, 'presets');
  assert.ok(presets.length > 0, '更新检测应当给出 presets');
  const top = Math.min(...TOP_KEYS.flatMap((k) => depthsOfKey(s, k)));
  assert.ok(
    Math.min(...presets) > top,
    '更新检测的 presets 不在 meta 里 —— 侧栏只会出现一条「更新检测」，小红书那条消失',
  );

  /*
   * 种类清单搬到了 types.ts（UPDATE_SIDEBAR_SOURCES），def 只引用它。
   *
   * 这里读常量而不是在 def 源码里找 `'wechat'` 这类字面量：
   * 盯字面量的话，一改成引用常量就**假失败** —— 实现方式变了，行为没变。
   * 而"小红书那条根本不出现"这个真问题，靠的是常量里确实有它。
   */
  assert.match(raw, /UPDATE_SIDEBAR_SOURCES/, 'presets 应当引用侧栏种类清单常量');
  for (const k of ['bilibili', 'wechat', 'xiaohongshu', 'github']) {
    assert.ok(
      UPDATE_SIDEBAR_SOURCES.includes(k as UpdateSource),
      `侧栏应当列出 ${k}`,
    );
  }
});
