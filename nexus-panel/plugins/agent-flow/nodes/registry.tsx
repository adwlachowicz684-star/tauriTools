import type { NodeProps, NodeTypes } from '@xyflow/react';
import {
  NODE_CATEGORY_META,
  type NodeCategory, type NodeDef, type NodePreset, type NodeInspectorProps,
} from './types';
import { loadCustomPresets, presetKey, presetIdOf, dataOf } from '../engine/customPresets';

/*
 * re-export 卡片组的查询函数。
 * 字段层（components/inspectors/fields.tsx）必须从这里拿 getCardGroup，
 * 不能走 nodes/index —— 后者会 import 全部 defs/*，而 defs/* 的 Canvas
 * 指向画布卡片组件，形成 卡片 → nodes/index → defs → 卡片 的环。
 * 引擎层的 paramCards 不依赖任何节点，从 registry 转出是安全的。
 */
export { getCardGroup, allCardGroups } from '../engine/paramCards';

/**
 * 注册表本体。
 *
 * 用 Map 而不是对象字面量：键是用户数据里来的字符串（node.type），
 * 用对象可能被 __proto__ / constructor 之类的键打到原型链上。
 *
 * 本模块**只许依赖纯类型模块**（本文件 + ./types + ./store）。
 * 一旦它 import 了带组件的模块，就会和 nodes/defs/* 形成环 —— defs/* 在模块
 * 顶层调 registerNode()，而环里的本文件那时只走到 import 阶段，下面的 const
 * 仍在 TDZ，于是抛「Cannot access 'defs' before initialization」。脚本在模块
 * 求值阶段中断，SDK 末尾的 post({ type: 'ready' }) 执行不到，外壳只会干等 10s
 * 报「iframe 插件握手超时」，连错误原因都传不出来。详见
 * components/inspectors/inspectorOf.tsx 的注释（原先挂在本文件的那个函数）。
 */
const defs = new Map<string, NodeDef>();
/** data.kind → def。多个 type 共用一份 data 时（bili/wechat），取先注册的 */
const byDataKind = new Map<string, NodeDef>();

/** 注册一种节点。同名重复注册会直接抛错 —— 静默覆盖会让两种节点互相顶掉 */
export function registerNode(def: NodeDef): void {
  if (defs.has(def.type)) {
    throw new Error(`节点类型重复注册：${def.type}`);
  }
  defs.set(def.type, def);
  if (!byDataKind.has(def.dataKind)) byDataKind.set(def.dataKind, def);
}

/**
 * 未知节点类型的兜底。
 *
 * 什么时候会遇到：
 *  - 画布里存着某个后来被移除/改名的节点（尤其是以后允许用户自定义节点，
 *    删掉自定义节点后，历史画布里仍然留着那个 type）
 *  - 别人分享过来的工作流用了你这台机器没装的节点
 *
 * 没有兜底的话，nodeTypes / Inspector / runner 三处会拿到 undefined，
 * React 直接白屏 —— 用户连自己的画布都删不掉了。
 * 这里给一个"看得见但不能跑"的占位：能选中、能删、能看出缺了什么。
 */
/**
 * 按类型缓存兜底定义。
 *
 * getDef() 在渲染里被反复调用，未注册的类型每次都走到本函数。若不缓存，
 * 每次都新造一份 def —— 它的 Canvas / Inspector 也都是新的函数引用，
 * React 于是把画布卡片和属性面板当成"另一种组件"卸载重建：画布闪烁、
 * 面板里的输入框失焦。已注册的类型返回的是 defs 里那份稳定引用，不受影响，
 * 所以这个坑只在未注册节点上出现，很容易被漏掉。
 */
const fallbacks = new Map<string, NodeDef>();

function makeFallback(type: string): NodeDef {
  const hit = fallbacks.get(type);
  if (hit) return hit;
  return buildFallback(type);
}

function buildFallback(type: string): NodeDef {
  const Canvas = ({ selected }: NodeProps) => (
    <div className={`node-card kind-unknown ${selected ? 'is-selected' : ''}`}>
      <div className="node-head">
        <span className="node-kind">未知</span>
      </div>
      <div className="node-title">未注册的节点</div>
      <div className="node-brief">{type}</div>
      <div className="node-err">本机没有这个节点类型，无法运行（可安全删除）</div>
    </div>
  );
  const Inspector = ({ node }: NodeInspectorProps) => (
    <aside className="inspector">
      <div className="insp-title">
        <span className="title-input" style={{ flex: 1 }}>未注册的节点</span>
        <span className="insp-kind">未知</span>
      </div>
      <div className="tip warn">
        节点类型 <code>{node.type ?? '（缺失）'}</code> 在本机没有注册，
        可能是自定义节点被移除，或这份工作流来自另一个环境。
        <br />
        这个节点无法运行，但画布的其余部分不受影响。
      </div>
    </aside>
  );
  const def: NodeDef = {
    type,
    dataKind: type,
    meta: { label: '未注册', color: '#64748b', category: 'flow', idPrefix: 'unk' },
    create: () => ({ kind: 'unknown' }) as never,
    Canvas,
    Inspector,
  };
  fallbacks.set(type, def);
  return def;
}

/**
 * 取节点定义。
 *
 * 参数可能是 undefined（老画布的节点可能没写 type），
 * 所以签名收 undefined 并在内部兜底，而不是让调用方挨个判空。
 */
export function getDef(type: string | undefined | null): NodeDef {
  if (type && defs.has(type)) return defs.get(type)!;
  return makeFallback(type || 'unknown');
}

export function hasDef(type: string | undefined | null): boolean {
  return !!type && defs.has(type);
}

/**
 * 按 data.kind 取定义 —— 执行引擎的分发入口。
 *
 * 取不到时返回按 type 兜底的那份 unknown 定义：执行器缺失的节点会被判成
 * 「无执行器」直通，而不是抛异常炸掉整轮运行。
 */
export function getDefByDataKind(data: unknown): NodeDef {
  const kind =
    data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string'
      ? (data as { kind: string }).kind
      // TaskNodeData 历史原因没有 kind 字段，缺省按任务节点处理
      : 'task';
  return byDataKind.get(kind) ?? makeFallback(kind);
}

/** 全部已注册定义，按注册顺序 */
export function allDefs(): NodeDef[] {
  return [...defs.values()];
}

/**
 * 侧栏条目：把每个类型的预设展开成一维列表。
 * 多数类型只有一个预设，有 variants 的（任务的两种 CLI）会展开成多项。
 */
export function allPresets(): NodePreset[] {
  const out: NodePreset[] = [];
  for (const def of defs.values()) {
    const { presets, label, color } = def.meta;
    const list = presets?.() ?? [{ key: def.type, label, color, init: () => def.create('') }];
    for (const p of list) out.push({ ...p, type: def.type });
  }

  /*
   * 用户自定义节点。
   *
   * 复用基础类型的 type —— 执行器、画布卡片、属性面板因此全部自动继承，
   * 差别只有初始参数。这是"自定义"该有的形态：配参数，不写代码。
   *
   * 基础类型不可用时（跨环境导入过来、而本机没这种节点）直接跳过：
   * 显示一个拖出来就报错的条目，比不显示更糟。
   */
  for (const cp of loadCustomPresets()) {
    if (!hasDef(cp.baseType)) continue;
    const def = getDef(cp.baseType);
    out.push({
      key: presetKey(cp.id),
      type: cp.baseType,
      label: cp.name,
      color: cp.color ?? def.meta.color,
      hint: `自定义 · 基于${def.meta.label}`,
      // 每次返回新对象：多个实例若共享同一份，改一个会串到另一个上
      init: () => dataOf(cp),
    });
  }

  return out;
}

/** 按分组整理，供侧栏渲染。空分组不返回 */
export function presetsByCategory(): Array<{ category: NodeCategory; label: string; presets: NodePreset[] }> {
  const groups = new Map<NodeCategory, NodePreset[]>();
  for (const p of allPresets()) {
    const def = getDef(p.type);
    /*
     * 自定义预设统一归到「自定义」组。
     * 不归的话它会跟着基础类型混进"外部服务"之类的组里，
     * 用户分不清哪条是自己存的、哪条是内置的，也就无从删除。
     */
    const cat: NodeCategory = presetIdOf(p.key) ? 'custom' : def.meta.category;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }
  const order = Object.keys(NODE_CATEGORY_META) as NodeCategory[];
  return order
    .filter((c) => (groups.get(c)?.length ?? 0) > 0)
    .map((c) => ({ category: c, label: NODE_CATEGORY_META[c].label, presets: groups.get(c)! }));
}

/** 画布的 nodeTypes 映射（xyflow 要的就是 type → 组件） */
export function buildNodeTypes(): NodeTypes {
  const map: NodeTypes = {};
  for (const def of defs.values()) map[def.type] = def.Canvas;
  return map;
}
