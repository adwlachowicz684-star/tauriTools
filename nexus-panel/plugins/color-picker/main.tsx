import { useEffect, useRef, useState } from 'react';
import { bootServiceReactPlugin } from '../../src/nexus-react';
import { PRESET_COLORS, DEFAULT_COLOR, normalizeHex, hexToHsv } from './color';
import { ColorPicker } from './ColorPicker';
import './style.css';

/**
 * 取色服务（kind:'service'）· React 入口
 * ------------------------------------------------------------
 * 把完整色盘（与 project-group 内联用的是**同一个组件**）以模态弹窗的形式
 * 提供给所有插件：
 *
 *   const hex = await ctx.services.color.pick('#3E63DD');   // 取消返回 null，不用 try/catch
 *
 * 为什么是"共享组件 + 服务包壳"而不是"内联改成调服务"：
 *   内联色盘的价值在于**实时预览** —— 拖动时外面的卡片跟着变色；
 *   模态弹窗拿不到中间态，改过去就是降级。
 *   所以两边共用同一份组件实现，各取所需的能力。
 *
 * 依赖方向是单向的：project-group → color-picker。
 * 没有循环依赖。
 */

/** 一次"取色会话"的上下文；同一时刻只会有一个 */
type Session = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  initial: string;
  custom: string[];
  /** 是否允许返回 null（表示"清除颜色"） */
  allowNull: boolean;
  /**
   * 实时预览事件名。
   *
   * 给了的话，用户每拖动一次就 emit 一次当前色 —— 调用方
   * `ctx.on(name, (hex) => ...)` 就能**实时看到外面在变**，
   * 不必等确定。不给就不发（避免无谓广播）。
   */
  previewEvent?: string;
  emitFn?: ((e: string, p: unknown) => void) | null;
};

/* 模块级：methods 是静态注册的，拿不到 React 的 setState，
   所以用一个可变的"当前会话"槽位做桥 ——
   服务同一时刻只处理一次调用，不存在并发问题。 */
let current: Session | null = null;
let setView: ((s: { open: boolean; initial: string; custom: string[]; showDefaultTag?: boolean }) => void) | null = null;
/* ctx.store 由 openSession 注入到模块级槽位。
   方法表是静态注册的，拿不到 React 组件内的 ref，
   所以与 setView 一样用模块级变量中转。 */
let storeSlot: { set: (k: string, v: unknown) => Promise<boolean> } | null = null;

/** 服务面板：只在有会话时渲染色盘，其余时间留空（容器平时移出视口） */
function ServicePanel() {
  const [view, setLocalView] = useState<{
    open: boolean; initial: string; custom: string[]; showDefaultTag?: boolean;
  }>({ open: false, initial: DEFAULT_COLOR, custom: [] });
  const hexRef = useRef<string | null>(view.initial);
  const customRef = useRef<string[]>(view.custom);

  useEffect(() => {
    setView = setLocalView;
    return () => { setView = null; };
  }, []);

  if (!view.open) return null;

  return (
    <div className="cp-shell">
      <ColorPicker
        value={view.showDefaultTag ? null : view.initial}
        customColors={view.custom}
        onChange={(hex) => {
          hexRef.current = hex;
          /* 实时预览：拖到哪就广播到哪。
             调用方 ctx.on(previewEvent, ...) 就能跟着变 ——
             模态弹窗**也能**实时预览，只是要把变化"喊出去"。 */
          if (current?.previewEvent && current?.emitFn) {
            current.emitFn(current.previewEvent, hex);
          }
        }}
        onSaveCustom={(colors) => {
          customRef.current = colors;
          /* 持久化！React 化时丢过一次这个能力 ——
             不存的话用户收藏的色关掉面板就没了，
             而内联用法是会存进配置里的，两边体感就不一样了。 */
          storeSlot?.set('custom', colors).catch(() => {});
        }}
        onLog={() => { /* 服务里没有日志面板，静默 */ }}
      />
      <div className="cp-actions">
        <button
          className="p-btn"
          onClick={() => {
            /*
             * 取消**不用 reject**，而是 resolve(null)。
             *
             * 取消是正常流程（用户就是不想改），不是异常 ——
             * 用异常表达会让每个调用方都得写 try/catch 才能"一行调起"，
             * 漏了就是 unhandled rejection。
             *
             * 约定：
             *   resolve(值)   —— 用户选了
             *   resolve(null) —— 用户取消（或清除了颜色）
             *   reject(错误)  —— 真出错（服务没装/挂载失败/超时/崩溃）
             */
            current?.resolve(null);
            current = null;
            setLocalView((v) => ({ ...v, open: false }));
          }}
        >
          取消
        </button>
        <button
          className="p-btn primary"
          onClick={() => {
            const hex = hexRef.current;
            /* 用户点了"恢复默认"（hex 为 null）但调用方不认 null 时，
               回退到起始色而不是返回 null —— 否则调用方拿到 null 会当成"没选"。 */
            current?.resolve(
              hex === null && !current.allowNull ? view.initial : hex,
            );
            current = null;
            setLocalView((v) => ({ ...v, open: false }));
          }}
        >
          确定
        </button>
      </div>
    </div>
  );
}

/** 打开会话：返回一个在用户点确定/取消时才 settle 的 Promise */
async function openSession(
  args: { initial?: string | null; custom?: string[]; allowNull?: boolean; previewEvent?: string } = {},
  emitFn?: ((e: string, p: unknown) => void) | null,
  store?: { get: (k: string, d?: unknown) => Promise<unknown>; set: (k: string, v: unknown) => Promise<boolean> } | null,
) {
  /* 调用方没给起始色时用共享的 DEFAULT_COLOR ——
   此前这里硬编码 '#3E63DD'，与内联的 '#7C8CFF' 不一致：
   同一个"默认"在两个入口是两个颜色。 */
  const initial = normalizeHex(args.initial || '') || DEFAULT_COLOR;
  /*
   * 起始值要能表达"没设色"。
   *
   * 内联用法直接传 null，ColorPicker 内部用它作两件事：
   *   · 预览块上显示「默认」标记
   *   · 面板起点仍用 DEFAULT_COLOR（不然用户没得可拖）
   *
   * 服务此前把 null 归一化成一个具体色，于是「默认」标记不显示 ——
   * 同一个"未设置"状态，两个入口长得不一样。
   */
  const isUnset = args.initial === null || args.initial === undefined;
  const custom = Array.isArray(args.custom) ? args.custom : [];
  /* 没传 custom 就读持久化的 —— 让"我的常用色"与内联一样跨调用保留。
     内联是存进插件配置里的，服务用 ctx.store，行为对齐。 */
  const saved = store ? ((await store.get('custom', [])) as string[]) || [] : [];
  const effective = custom.length ? custom : saved;
  storeSlot = store ?? null;

  setView?.({
    open: true,
    initial,
    custom: effective,
    showDefaultTag: isUnset,
  });
  return new Promise((resolve, reject) => {
    /* 必须先建会话再开面板 ——
       反过来（先开再建）会有一帧窗口，用户极快点确定会拿到 null。 */
    current = {
      resolve: resolve as (v: unknown) => void,
      reject: reject as (e: Error) => void,
      initial, custom: effective, allowNull: !!args.allowNull,
      previewEvent: args.previewEvent, emitFn: emitFn ?? null,
    };
  });
}

bootServiceReactPlugin(
  () => <ServicePanel />,
  {
    async describe() {
      return {
        name: '取色服务', version: '2.0.0',
        methods: ['describe', 'pick', 'normalize', 'presets'],
        /* 声明用的是共享组件 —— 供插件面板展示，也让调用方知道
           这个服务的能力与内联色盘完全对齐（不是弱化版）。 */
        implementation: 'shared-component',
      };
    },

    /**
     * 打开取色面板，返回 '#RRGGBB'；
     * 传 previewEvent 可实时接收拖动中的颜色变化。
     */
    async pick(args = {}, ctx?: any) {
      return openSession(args, ctx?.emit, ctx?.store);
    },

    /** 纯计算：归一化，非法返回 null */
    async normalize({ color } = {}) { return normalizeHex(color); },

    /** 24 个预设色 */
    async presets() { return [...PRESET_COLORS]; },

    /** 取当前色的 HSV（调用方想自己画格子时用） */
    async hsv({ color } = {}) { return hexToHsv(normalizeHex(color) || DEFAULT_COLOR); },
  },
);
