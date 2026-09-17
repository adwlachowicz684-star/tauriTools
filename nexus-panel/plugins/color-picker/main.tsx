import { useEffect, useRef, useState } from 'react';
import { bootServiceReactPlugin } from '../../src/nexus-react';
import { PRESET_COLORS, normalizeHex, hexToHsv } from './color';
import { ColorPicker } from './ColorPicker';
import './style.css';

/**
 * 取色服务（kind:'service'）· React 入口
 * ------------------------------------------------------------
 * 把完整色盘（与 project-group 内联用的是**同一个组件**）以模态弹窗的形式
 * 提供给所有插件：
 *
 *   const hex = await ctx.services.color.pick('#3E63DD');
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
};

/* 模块级：methods 是静态注册的，拿不到 React 的 setState，
   所以用一个可变的"当前会话"槽位做桥 ——
   服务同一时刻只处理一次调用，不存在并发问题。 */
let current: Session | null = null;
let setView: ((s: { open: boolean; initial: string; custom: string[] }) => void) | null = null;

/** 服务面板：只在有会话时渲染色盘，其余时间留空（容器平时移出视口） */
function ServicePanel() {
  const [view, setLocalView] = useState<{ open: boolean; initial: string; custom: string[] }>({
    open: false, initial: '#3E63DD', custom: [],
  });
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
        value={view.initial}
        customColors={view.custom}
        onChange={(hex) => { hexRef.current = hex; }}
        onSaveCustom={(colors) => { customRef.current = colors; }}
        onLog={() => { /* 服务里没有日志面板，静默 */ }}
      />
      <div className="cp-actions">
        <button
          className="p-btn"
          onClick={() => {
            /* 用户取消 —— 与"清掉颜色"是两回事，后者是 resolve(null) */
            current?.reject(new Error('已取消'));
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
function openSession(args: { initial?: string; custom?: string[]; allowNull?: boolean } = {}) {
  const initial = normalizeHex(args.initial || '') || '#3E63DD';
  const custom = Array.isArray(args.custom) ? args.custom : [];
  setView?.({ open: true, initial, custom });
  return new Promise((resolve, reject) => {
    /* 必须先建会话再开面板 ——
       反过来（先开再建）会有一帧窗口，用户极快点确定会拿到 null。 */
    current = {
      resolve: resolve as (v: unknown) => void,
      reject: reject as (e: Error) => void,
      initial, custom, allowNull: !!args.allowNull,
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

    /** 打开取色面板，返回 '#RRGGBB'；allowNull 时可返回 null 表示清除颜色 */
    async pick(args = {}) { return openSession(args); },

    /** 纯计算：归一化，非法返回 null */
    async normalize({ color } = {}) { return normalizeHex(color); },

    /** 24 个预设色 */
    async presets() { return [...PRESET_COLORS]; },

    /** 取当前色的 HSV（调用方想自己画格子时用） */
    async hsv({ color } = {}) { return hexToHsv(normalizeHex(color) || '#3E63DD'); },
  },
);
