import { useEffect, useRef, useState } from 'react';
import { bootServiceReactPlugin } from '../../src/nexus-react';
import { PRESET_COLORS, DEFAULT_COLOR, normalizeHex, hexToHsv } from './color';
import { ColorPicker } from './ColorPicker';
import './style.css';

/**
 * 取色服务（kind:'service'）· React 入口
 * ------------------------------------------------------------
 * 整个弹窗就是服务插件本身：色盘在**自己的 iframe** 里跑，
 * 拖动时的预览变化发生在插件内部，不需要跨文档通信。
 * 调用方只需要最终那个结果。
 *
 *   const r = await ctx.services.color.pick({ initial, custom: saved });
 *   if (r.hex) apply(r.hex);
 *   save(r.custom);   // 取消了也要存
 *
 * 与"内嵌组件"的区别（两者可以并存，各取所需）：
 *   · 内嵌 —— 同步 onChange 回调、体感与 project-group 完全一致、需 React
 *   · 服务 —— 一行调起、框架无关、结果是模态形态
 */

/** 预设色与自定义色：调用方给什么就显示什么，改了什么原样带回去 */
type Session = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  initial: string;
  custom: string[];
  preset?: string[];
  allowNull: boolean;
  /**
   * 实时预览事件名（**可选**）。
   *
   * 默认不需要：色盘在自己的弹窗里，拖动时它自带的预览块就在变，
   * 用户看得见。只有调用方想让**自己界面上的色块**跟着变时才给。
   */
  previewEvent?: string;
  emitFn?: ((e: string, p: unknown) => void) | null;
};

/** 取色结果 */
export type PickResult = {
  /** 选中的颜色；取消或清除为 null */
  hex: string | null;
  /** 最新的自定义常用色 —— **无论确定还是取消**都该存起来 */
  custom: string[];
};

/* 方法表是静态注册的，拿不到 React 的 setState，
   所以用模块级槽位做桥 —— 服务同一时刻只处理一次调用，无并发问题。 */
let current: Session | null = null;
let setView: ((s: {
  open: boolean; initial: string; custom: string[];
  preset?: string[]; showDefaultTag?: boolean;
}) => void) | null = null;

/** 服务面板：只在有会话时渲染色盘，其余时间留空（容器平时移出视口） */
function ServicePanel() {
  const [view, setLocalView] = useState<{
    open: boolean; initial: string; custom: string[];
    preset?: string[]; showDefaultTag?: boolean;
  }>({ open: false, initial: DEFAULT_COLOR, custom: [] });
  const hexRef = useRef<string | null>(view.initial);
  const customRef = useRef<string[]>(view.custom);

  useEffect(() => {
    setView = setLocalView;
    return () => { setView = null; };
  }, []);

  /** 收摊：把结果（含最新 custom）交回去 */
  const finish = (hex: string | null) => {
    const s = current;
    current = null;
    setLocalView((v) => ({ ...v, open: false }));
    /*
     * custom **无论确定还是取消都要带回去** ——
     * 用户可能刚收藏了几个色然后点取消，丢掉就等于白收藏。
     *
     * 这也是为什么不让服务自己存：服务是单例、被多个调用方共用，
     * 它存一份会让 A 的收藏串到 B 那里。
     */
    s?.resolve({ hex, custom: customRef.current ?? [] } as PickResult);
  };

  if (!view.open) return null;

  return (
    <div className="cp-shell">
      <ColorPicker
        value={view.showDefaultTag ? null : view.initial}
        customColors={view.custom}
        preset={view.preset}
        onChange={(hex) => {
          hexRef.current = hex;
          /* 实时预览（可选）：给了 previewEvent 才往外面喊 */
          if (current?.previewEvent && current?.emitFn) {
            current.emitFn(current.previewEvent, hex);
          }
        }}
        onSaveCustom={(colors) => { customRef.current = colors; }}
        onLog={() => { /* 服务里没有日志面板，静默 */ }}
      />
      <div className="cp-actions">
        <button className="p-btn" onClick={() => finish(null)}>
          取消
        </button>
        <button
          className="p-btn primary"
          onClick={() => {
            const hex = hexRef.current;
            /* 用户点了"恢复默认"（hex 为 null）但调用方不认 null 时，
               回退到起始色 —— 否则调用方拿到 null 会当成"没选"。 */
            finish(hex === null && !current?.allowNull ? view.initial : hex);
          }}
        >
          确定
        </button>
      </div>
    </div>
  );
}

async function openSession(
  args: {
    initial?: string | null; custom?: string[]; preset?: string[];
    allowNull?: boolean; previewEvent?: string;
  } = {},
  emitFn?: ((e: string, p: unknown) => void) | null,
) {
  const initial = normalizeHex(args.initial || '') || DEFAULT_COLOR;
  /*
   * 起始值要能表达"没设色"：预览块显示「默认」标记，
   * 但面板起点仍用 DEFAULT_COLOR（不然用户没得可拖）。
   */
  const isUnset = args.initial === null || args.initial === undefined;

  setView?.({
    open: true,
    initial,
    custom: Array.isArray(args.custom) ? args.custom : [],
    preset: Array.isArray(args.preset) ? args.preset : undefined,
    showDefaultTag: isUnset,
  });
  return new Promise((resolve, reject) => {
    /* 必须先建会话再开面板 ——
       反过来（先开再建）会有一帧窗口，用户极快点确定会拿到 null。 */
    current = {
      resolve: resolve as (v: unknown) => void,
      reject: reject as (e: Error) => void,
      initial,
      custom: Array.isArray(args.custom) ? args.custom : [],
      preset: Array.isArray(args.preset) ? args.preset : undefined,
      allowNull: !!args.allowNull,
      previewEvent: args.previewEvent, emitFn: emitFn ?? null,
    };
  });
}

bootServiceReactPlugin(
  () => <ServicePanel />,
  {
    async describe() {
      return {
        name: '取色服务', version: '3.0.0',
        methods: ['describe', 'pick', 'normalize', 'presets', 'hsv'],
        /* 用的是与内联相同的共享组件，能力不打折 */
        implementation: 'shared-component',
      };
    },

    /**
     * 打开取色面板。
     *
     * 返回 `{ hex, custom }`：
     *   · hex —— 选中的颜色，取消为 null
     *   · custom —— 最新自定义色，**取消也要存**（用户可能刚收藏完就取消）
     *
     * 调用方把自己的 custom 传进来、把返回的 custom 存起来，
     * 就能"下次打开还记住"，且各调用方互不干扰。
     */
    async pick(args = {}, ctx?: any) {
      return openSession(args, ctx?.emit);
    },

    /** 纯计算：归一化，非法返回 null */
    async normalize({ color } = {}) { return normalizeHex(color); },

    /** 默认 24 个预设色（调用方可通过 pick 的 preset 覆盖） */
    async presets() { return [...PRESET_COLORS]; },

    /** 取当前色的 HSV（调用方想自己画格子时用） */
    async hsv({ color } = {}) { return hexToHsv(normalizeHex(color) || DEFAULT_COLOR); },
  },
);
