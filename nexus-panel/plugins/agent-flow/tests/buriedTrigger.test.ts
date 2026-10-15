import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBuriedTriggers, collectGlobalTriggers, type TriggerCanvasView,
} from '../engine/triggerRegistry';
import { readSrc } from './srcScan';

const canvas = (id: string, name: string, nodes: { id: string; data?: Record<string, unknown> }[]): TriggerCanvasView => ({
  id, name, nodes,
});

/** 一个最小的模块解析器：moduleId 名字就是 key */
const RESOLVE: Record<string, { nodes: { id: string; data?: Record<string, unknown> }[] }> = {
  M1: {
    nodes: [
      { id: 't1', data: { kind: 'trigger', enabled: true, triggers: ['webhook'] } },
      { id: 'a1', data: { kind: 'const', value: 'v' } },
    ],
  },
  M2: { nodes: [{ id: 'inner', data: { kind: 'module', moduleId: 'M1' } }] },
  EMPTY: { nodes: [{ id: 'a', data: { kind: 'const' } }] },
};

const resolve = (d: Record<string, unknown>) => RESOLVE[String(d.moduleId ?? '')] ?? null;

test('埋在模块里的触发器能被扫出来', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'M1', label: '发版' } }])],
    resolve,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].triggerId, 't1');
  assert.equal(out[0].hostId, 'inst');
  assert.equal(out[0].hostLabel, '发版');
  assert.equal(out[0].canvasId, 'c1');
});

test('同一个触发器不会被全局收集（这正是它失效的原因）', () => {
  const g = collectGlobalTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'M1', label: '发版' } }])],
    {} as never,
  );
  assert.equal(g.length, 0, '全局扫描看不见模块内部——所以必须有另一条路把它说出来');
});

test('模块套模块：里面那层的触发器也要扫出来', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'M2', label: '外层' } }])],
    resolve,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].triggerId, 't1');
});

test('脱钩副本（inner）里的触发器同样算埋着', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{
      id: 'inst',
      data: {
        kind: 'module', moduleId: '', label: '脱钩的',
        inner: { nodes: [{ id: 't9', data: { kind: 'trigger', trigger: 'webhook' } }], edges: [] },
      },
    }])],
    resolve,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].triggerId, 't9', '脱钩副本不走模块库，但一样不会自动触发');
});

test('没有触发器的模块：不报（误报比漏报更烦）', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'EMPTY' } }])],
    resolve,
  );
  assert.equal(out.length, 0);
});

test('模块套自己：不能转不出来（环检测）', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'SELF' } }])],
    (d) => (String(d.moduleId) === 'SELF'
      ? { nodes: [{ id: 'x', data: { kind: 'module', moduleId: 'SELF' } }] }
      : null),
  );
  assert.equal(out.length, 0);
});

test('模块库里那条被删了：不报、也不崩', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{ id: 'inst', data: { kind: 'module', moduleId: 'GONE' } }])],
    resolve,
  );
  assert.equal(out.length, 0);
});

test('源码守卫：App 真的把埋着的触发器说出来（第五次防"对策写了没接上"）', () => {
  const src = readSrc('App.tsx');
  /*
   * 锚点**不能**用 collectBuriedTriggers 第一次出现的位置 ——
   * 那是 import 行，从那里往后截会拿到毫不相干的段落，
   * 于是守卫要么恒绿（窗口里碰巧有 pushLog），要么恒红（理由说不通）。
   * 锚在真正的使用处才算数。
   */
  const i = src.indexOf('collectBuriedTriggers(');
  assert.ok(i >= 0, 'App 必须调用 collectBuriedTriggers');
  const seg = src.slice(i, i + 3000);
  assert.ok(/pushLog\s*\(/.test(seg), '扫出来必须真的说出来，只算不用等于没做');
  assert.ok(/自动触发/.test(seg), '要说清后果：自动触发永远不会发生');
});

test('源码守卫：扫描不 import modules.ts（那边已经引了本文件，反过来就是循环依赖）', () => {
  const src = readSrc('engine/triggerRegistry.ts');
  assert.ok(!/from '\.\/modules'|from "\.\/modules"/.test(src), '不要反向依赖 modules.ts');
});

test('源码守卫：埋着的列表要随模块编辑结束重算（否则删了还挂着，用户以为提示是错的）', () => {
  const src = readSrc('App.tsx');
  const i = src.indexOf('const buried = useMemo');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n  );', i));
  assert.ok(
    /editingModule/.test(body),
    '依赖里必须有 editingModule —— findModule 读 localStorage，模块库变化不触发 state 更新',
  );
});

test('源码守卫：工具栏要把埋着的数量并排显示出来（计数里不算它们）', () => {
  const src = readSrc('App.tsx');
  const i = src.indexOf('buriedHere');
  assert.ok(i >= 0, '必须有 buriedHere');
  /*
   * 窗口起点取徽章自身再往前 400 字符 ——
   * 取 buriedHere 首次出现处（定义）到它之后的话，渲染区在几千行之外，
   * 截出来是空串，于是守卫恒绿而什么都没盯住。
   */
  const badge = src.indexOf('className="trg-btn-static trg-buried"');
  assert.ok(badge >= 0, '工具栏要有警告徽章');
  const seg = src.slice(badge - 400, badge + 2000);
  assert.ok(/className="trg-btn-static trg-buried"/.test(src), '工具栏要有警告徽章');
  assert.ok(/title=/.test(seg), '徽章必须能 hover 看到是哪个模块');
  assert.ok(/自动触发/.test(seg), 'title 要说清后果');
});

test('源码守卫：提示给出的做法是做得到的（不能说"拖到画布上"——模块编辑视图里拖不出去）', () => {
  const src = readSrc('App.tsx');
  assert.ok(
    !/请把触发器拖到画布上/.test(src),
    '模块编辑视图里没法把节点拖到主画布——这是在承诺一件做不到的事',
  );
  assert.ok(/编辑内部/.test(src), '要指向真正能做的地方');
});

test('自己关掉的触发器不报（误报比漏报更糟）', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{
      id: 'inst',
      data: {
        kind: 'module', moduleId: '', label: '脱钩的',
        inner: {
          nodes: [
            { id: 'off', data: { kind: 'trigger', trigger: 'webhook', enabled: false } },
            { id: 'noCard', data: { kind: 'trigger' } },
          ],
          edges: [],
        },
      },
    }])],
    resolve,
  );
  assert.equal(out.length, 0, '用户是**故意**关的；报出来会指向一个不存在的问题');
});

test('卡片全禁用也不报 —— 与全局收集同一口径', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{
      id: 'inst',
      data: {
        kind: 'module', moduleId: '', label: '脱钩的',
        inner: {
          nodes: [{
            id: 't1',
            data: {
              kind: 'trigger',
              entries: [{ id: 'e1', kind: 'webhook', enabled: false }],
            },
          }],
          edges: [],
        },
      },
    }])],
    resolve,
  );
  assert.equal(out.length, 0);
});

test('生效的那张卡类型要报出来（提示里说得更具体）', () => {
  const out = collectBuriedTriggers(
    [canvas('c1', '画布一', [{
      id: 'inst',
      data: {
        kind: 'module', moduleId: '', label: '脱钩的',
        inner: {
          nodes: [{ id: 't1', data: { kind: 'trigger', trigger: 'cron' } }],
          edges: [],
        },
      },
    }])],
    resolve,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cron');
});

test('源码守卫：埋藏判定必须用 isActiveTrigger，不能退化成 isTriggerNode', () => {
  const src = readSrc('engine/triggerRegistry.ts');
  const i = src.indexOf('export function collectBuriedTriggers');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/isActiveTrigger\s*\(/.test(body), '必须用 isActiveTrigger（与全局收集同一口径）');
  assert.ok(
    !/if \(isTriggerNode\(d\)\)/.test(body),
    '退化成 isTriggerNode 会把"用户自己关掉的"也算进去 —— 那是误报',
  );
});

test('源码守卫：多画布时日志必须带上画布名（否则用户在当前画布上找不到那个模块）', () => {
  const src = readSrc('App.tsx');
  const i = src.indexOf('const where = buried.slice');
  assert.ok(i >= 0);
  const seg = src.slice(i - 1200, i + 600);
  assert.ok(/canvasName/.test(seg), '要说清是哪张画布');
  assert.ok(/canvases\.length/.test(seg), '判据用画布数量，不用"是不是当前画布"（那会随切换变化）');
});

test('行为：多条埋藏分别来自不同画布时，各自带上自己的画布名', () => {
  const out = collectBuriedTriggers(
    [
      canvas('c1', '画布一', [{ id: 'i1', data: { kind: 'module', moduleId: 'M1', label: '发版' } }]),
      canvas('c2', '画布二', [{ id: 'i2', data: { kind: 'module', moduleId: 'M1', label: '备份' } }]),
    ],
    resolve,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((b) => b.canvasName), ['画布一', '画布二']);
  assert.equal(out[0].hostLabel, '发版');
  assert.equal(out[1].hostLabel, '备份');
});
