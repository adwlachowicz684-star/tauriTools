import {
  makeTriggerNode, TRIGGER_META,
  type TriggerKind, type TriggerNodeData,
} from '../../types';
import TriggerNode from '../../components/TriggerNode';
import { TriggerInspector } from '../../components/inspectors/TriggerInspector';
import { runTrigger } from '../../engine/runners/trigger';
import { registerNode } from '../registry';

registerNode({
  type: 'trigger',
  dataKind: 'trigger',
  meta: {
    label: '触发器',
    color: '#eab308',
    category: 'trigger',
    idPrefix: 'tr',
    /*
     * 以前这里列的是"手动 / 定时 / Cron / …"——那是**有哪些方式**，
     * 不是"这个节点是干什么的"。挑节点时前者没用（面板里本来就列着），
     * 后者才有用。
     */
    sub: '流程的起点 —— 决定什么时候开跑',
  },
  /*
   * makeTriggerNode 的签名是 (id, **triggers**, partial) ——
   * 第二个参数是触发方式，不是数据补丁。
   *
   * 以前这里写成 makeTriggerNode(id, partial)：
   * 而调用方一律是 create(id)（不传补丁），于是 triggers = [undefined]。
   * 落盘后变成 [null]，属性面板取 TRIGGER_META[selected[0]].hint 时
   * 抛 TypeError，整棵 React 树崩掉 —— 就是"拖入触发器后画布消失"。
   */
  create: (id, partial) => {
    const p = (partial ?? {}) as Partial<TriggerNodeData>;
    const kinds: TriggerKind[] = Array.isArray(p.triggers) && p.triggers.length > 0
      ? p.triggers
      : ['manual'];
    const data = makeTriggerNode(id, kinds, p).data;
    /*
     * 顺带落一份**条目**（触发条件卡片）。
     *
     * 不落的话新节点只有老的 `triggers` 数组，界面上会显示卡片、
     * 但一改动才发现条目不存在 —— 而迁移是"读时才算"，
     * 此刻看不出来有没有，等出问题时已经改了一半。
     */
    const entries = (data as unknown as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) {
      (data as unknown as Record<string, unknown>).entries =
        kinds.map((k, i) => ({ id: `te${id}${i}`, kind: k, enabled: true, config: {} }));
    }
    return data;
  },
  Canvas: TriggerNode,
  Inspector: TriggerInspector,
  run: runTrigger,
});
