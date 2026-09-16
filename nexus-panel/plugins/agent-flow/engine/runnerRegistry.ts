/**
 * 执行器注册表 —— 引擎侧的纯逻辑版本。
 *
 * 为什么不放 nodes/ 里跟节点定义一起：
 * nodes/defs/* 每个文件都 import 了 React 组件（画布卡片、属性面板），
 * 而 runner.ts 是**纯逻辑层** —— 单元测试在 Node 下直接跑它，
 * 没有 DOM、也不加载 React。让 runner 去 import nodes 会把整个 UI 层
 * 拖进引擎，测试就跑不起来了。
 *
 * 所以执行器单独放 engine/runners/（同样是每节点一个文件，但不含 React），
 * 这里再把它们按 data.kind 汇总成一张表。
 *
 * 与 nodes/defs/ 里的 `run` 字段指向**同一个函数**，不是两份实现：
 *   nodes/defs/task.ts   → run: runTask   （供 UI 侧自描述）
 *   本文件               → task: runTask   （供引擎分发）
 * 新增节点时两处都要挂上。漏挂引擎这张表的话该节点会"直通"（不报错、不产出），
 * 现有 694 项测试会立刻失败 —— 所以漏了是能被发现的。
 */
import type { RunContext } from './runContext';
import { runTask } from './runners/task';
import { runTrigger } from './runners/trigger';
import { runCondition } from './runners/condition';
import { runParallel } from './runners/parallel';
import { runLoop } from './runners/loop';
import { runFs } from './runners/fs';
import { runOcr } from './runners/ocr';
import { runTranslate } from './runners/translate';
import { runUpdate } from './runners/update';
import { runGithubUpdate } from './runners/githubUpdate';
import { runGithubPush } from './runners/githubPush';
import { runGenericHttp } from './runners/genericHttp';
import { runExtract } from './runners/extract';
import { runWait } from './runners/wait';
import { runLog } from './runners/log';
import { runBeep } from './runners/beep';
import { runPlayAudio } from './runners/playAudio';
import { runClock } from './runners/clock';
import { runConst } from './runners/const';

export type NodeRunner = (ctx: RunContext) => Promise<void>;

const RUNNERS: Record<string, NodeRunner | undefined> = {
  task: runTask,
  trigger: runTrigger,
  condition: runCondition,
  parallel: runParallel,
  loop: runLoop,
  fs: runFs,
  ocr: runOcr,
  translate: runTranslate,
  // bili / wechat 两个 type 共用一份 data（kind='update'），执行器也共用
  update: runUpdate,
  'github-update': runGithubUpdate,
  'github-push': runGithubPush,
  'generic-http': runGenericHttp,
  extract: runExtract,
  wait: runWait,
  log: runLog,
  beep: runBeep,
  'play-audio': runPlayAudio,
  clock: runClock,
  const: runConst,
};

/**
 * 取某节点数据的执行器。
 *
 * TaskNodeData 历史原因没有 kind 字段，缺省按 'task' 处理 ——
 * 这正是重构前那条 if 链的最后一段（任务节点是兜底分支）的语义。
 */
export function getRunner(data: unknown): NodeRunner | undefined {
  const kind =
    data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string'
      ? (data as { kind: string }).kind
      : 'task';
  return RUNNERS[kind];
}
