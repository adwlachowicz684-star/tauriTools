import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { ArgLine } from './ArgCell';
import type { BriefPart } from '../engine/ops';
import { BEEP_PRESET_META, CONST_TYPE_LABEL, normBoolText, type ConstValueType, type BeepNodeData, type WaitNodeData, type LogNodeData, type PlayAudioNodeData, type ClockNodeData, type ConstNodeData } from '../types';
import type {
  WaitFlowNode, LogFlowNode, BeepFlowNode, PlayAudioFlowNode,
  ClockFlowNode, ConstFlowNode,
} from '../flowTypes';

/**
 * 工具节点的画布卡片。
 *
 * 这六种节点的画布结构完全一样（一行摘要），各写一个组件会多出六份
 * 几乎相同的 60 行 —— 与 GenericNode 同样的理由，合成一个。
 *
 * ================= 摘要为什么画成下凹的参数格 =================
 *
 * 以前这里是一整串 `<code>{summary}</code>`：
 * 「3000 毫秒」「普通 · 你好」看着只是一行说明文字，
 * 看不出哪部分是你填的参数、更点不动 —— 改一个值必须打开右侧面板。
 *
 * 画成下凹的格子之后，参数与说明文字一眼可分，并且**点一下就能改**
 * （数字/文本变输入框，级别/音效这类"只能选的"弹下拉）。
 */

function Card({
  id, type, data, selected, tag, parts,
}: {
  id: string;
  type: string;
  data: { label?: string; status?: string };
  selected?: boolean;
  tag: string;
  parts: BriefPart[];
}) {
  return (
    <NodeShell id={id} type={type} data={data} selected={selected} tag={tag}>
      <ArgLine nodeId={id} type={type} data={data as Record<string, unknown>} parts={parts} />
    </NodeShell>
  );
}

/** 一个可就地编辑的参数格 */
function val(key: string, text: string, raw: string): BriefPart {
  return { role: 'val', text, key, raw, edit: { key, kind: 'text' } };
}

/**
 * 只能选的（级别、音效）：画成运算符那一种格子，点一下弹下拉。
 *
 * raw 给的是**当前值**而不是显示文字 —— 下拉要靠它定位"现在选的是哪一项"。
 */
function pick(key: string, text: string, raw: string): BriefPart {
  return { role: 'op', text, raw, edit: { key, kind: 'select' } };
}

/** 毫秒数太长读着累，超过 1 秒就换成秒 */
function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒` : `${ms} 毫秒`;
}

export function WaitNode({ id, data, selected }: NodeProps<WaitFlowNode>) {
  const d = data as WaitNodeData;
  const rawMs = d.ms === undefined || d.ms === null ? '' : String(d.ms);
  /*
   * 模板值（{{上游.output}}）不能走 humanMs —— Number() 会得 NaN，
   * 显示成「NaN 毫秒」，而节点上存的其实是一个合法的模板。
   */
  const isTpl = rawMs.includes('{{');
  const shown = isTpl ? rawMs : humanMs(Number(d.ms ?? 0));
  return (
    <Card
      id={id}
      type="wait"
      data={d}
      selected={selected}
      tag="等待"
      parts={[val('ms', shown, rawMs)]}
    />
  );
}

export function LogNode({ id, data, selected }: NodeProps<LogFlowNode>) {
  const d = data as LogNodeData;
  const level = String(d.level ?? 'info');
  const text = String(d.text ?? '').trim();
  return (
    <Card
      id={id}
      type="log"
      data={d}
      selected={selected}
      tag="日志标记"
      parts={[
        /*
         * 级别做成下拉（三选一），内容做成输入框。
         *
         * 以前两者都在 tag 与一行文本里，改都要去面板 ——
         * 而这个节点**总共就两个参数**，卡片上却一个都点不了。
         */
        pick('level', level === 'error' ? '✗ 错误' : level === 'warn' ? '⚠ 警告' : 'ℹ 普通', level),
        ...(text
          ? [val('text', text, text)]
          /* 留空是**合法配置**（记上游内容），所以给的是说明文字而非空参数格 */
          : [{ role: 'text' as const, text: '（留空则记上游内容）' }]),
      ]}
    />
  );
}

export function BeepNode({ id, data, selected }: NodeProps<BeepFlowNode>) {
  const d = data as BeepNodeData;
  /*
   * 缺省 'preset'：老存档没有 source 字段，而它们当初的行为正是系统音效。
   * 用 `=== 'file'` 之外的写法（比如默认 file）会让老节点凭空变成一个
   * 「没填文件路径」的坏节点 —— 而它其实是好的。
   */
  const isFile = d.source === 'file';
  const preset = String(d.preset ?? 'success');
  const meta = BEEP_PRESET_META[d.preset ?? 'success'];
  const vol = Math.round(Number(d.volume ?? 0.6) * 100);
  const volPart = val('volume', `${vol}%`, String(d.volume ?? 0.6));

  /*
   * 文件模式：显示文件名，但**编辑初值是完整路径**。
   * 用文件名当初值的话，点一下输入框里就只剩文件名，
   * 一失焦等于把完整路径改成了文件名 —— 不报错，只是运行时找不到文件。
   */
  if (isFile) {
    const p = String(d.path ?? '').trim();
    const name = p ? p.split(/[\\/]/).pop() ?? p : '（未填文件）';
    return (
      <Card
        id={id}
        type="beep"
        data={d}
        selected={selected}
        tag="播放声音"
        parts={[
          { role: 'text', text: '文件' },
          val('path', name, p),
          { role: 'text', text: '·' },
          volPart,
          ...(d.waitForEnd === false ? [{ role: 'text' as const, text: '· 不等待' }] : []),
        ]}
      />
    );
  }

  return (
    <Card
      id={id}
      type="beep"
      data={d}
      selected={selected}
      tag="播放声音"
      parts={[
        pick('preset', meta?.label ?? preset, preset),
        { role: 'text', text: '·' },
        volPart,
      ]}
    />
  );
}

/*
 * 注意类型参数与**组件名**不是一回事：
 * 组件叫 PlayAudioNode（下面 playAudio.ts 就是按这个名字 import 去当 Canvas 的），
 * 而它的节点类型是 PlayAudioFlowNode —— 同目录其它卡片都是 XxxFlowNode，
 * 唯独这里写成了 PlayAudioNode，于是 NodeProps<…> 收到的是**组件自己**，
 * 类型全部退化成 any，卡片看着能跑，但 props 一处都校验不到。
 */
export function PlayAudioNode({ id, data, selected }: NodeProps<PlayAudioFlowNode>) {
  const d = data as PlayAudioNodeData;
  const p = String(d.path ?? '').trim();
  const name = p ? p.split(/[\\/]/).pop() ?? p : '（未填文件）';
  /*
   * 显示的只是文件名，编辑的初值必须是**完整路径**。
   *
   * 用文件名当初值的话，点一下输入框里就只剩文件名，
   * 一失焦等于把完整路径改成了文件名 —— 且不报错，只是运行时找不到文件。
   */
  return (
    <Card
      id={id}
      type="play-audio"
      data={d}
      selected={selected}
      tag="播放音频"
      parts={[
        val('path', name, p),
        ...(d.waitForEnd === false ? [{ role: 'text' as const, text: '· 不等待' }] : []),
      ]}
    />
  );
}

export function ClockNode({ id, data, selected }: NodeProps<ClockFlowNode>) {
  const d = data as ClockNodeData;
  const fmt = String(d.format ?? '');
  return (
    <Card
      id={id}
      type="clock"
      data={d}
      selected={selected}
      tag="当前时间"
      parts={fmt ? [val('format', fmt, fmt)] : [{ role: 'text', text: '（用默认格式）' }]}
    />
  );
}

export function ConstNode({ id, data, selected }: NodeProps<ConstFlowNode>) {
  const d = data as ConstNodeData;
  const v = d.value === undefined || d.value === null ? '' : String(d.value);
  /*
   * 布尔常量的值走下拉（真 / 假），其余走输入框。
   *
   * 三种种类共用同一个 value 字段、按 valueType 分流，
   * 卡片上必须跟着分 —— 一律给输入框的话，布尔常量可以填进
   * 「是」「maybe」这类下游认不出的值，而面板里明明是下拉。
   */
  const vt: ConstValueType = d.valueType ?? 'text';
  const isBool = vt === 'bool';
  /*
   * 布尔走 dropdown，且显示值与**运行输出**用同一份规范化。
   *
   * 不共用的话：老存档里存着「是」「maybe」这类写法时，卡片显示「（空）」
   * 而运行输出 'false'/'true' —— 看着没值、跑着有值，是最难查的一类。
   */
  const boolNorm = normBoolText(v);
  const cell: BriefPart = isBool
    ? pick('value', boolNorm === 'true' ? '真' : '假', boolNorm)
    : val('value', v, v);
  /*
   * 种类也画成一格（下拉）—— 三种常量合并成一个节点之后，
   * 切种类不能只剩"打开面板改一项"这条老路。
   */
  const kind: BriefPart = pick('valueType', CONST_TYPE_LABEL[vt], vt);
  return (
    <Card
      id={id}
      type="const"
      data={d}
      selected={selected}
      tag="常量"
      parts={v ? [kind, cell] : [kind, { role: 'text', text: '（空）' }]}
    />
  );
}
