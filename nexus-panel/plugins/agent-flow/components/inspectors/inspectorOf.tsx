import { makeInspector } from './fields';
import type { NodeDef, NodeInspectorProps } from '../../nodes/types';

/**
 * 取该节点的属性面板组件。
 *
 * 没写 Inspector 的节点：用 fields 清单自动生成（基础面板）。
 * 连 fields 都没有的：给一个说明面板而不是空白 ——
 * 空白会让"这个节点还没实现面板"看起来像"面板坏了"。
 *
 * 为什么放在这里而不是 nodes/registry.tsx（它原先在那里）：
 * 本函数是 registry 唯一需要 React 组件的地方，而 fields 会（经 shared →
 * engine/*、以及 nodes/index 桶文件）绕回 nodes/defs/*，defs/* 又在**模块顶层**
 * 调 registerNode() —— registry 于是形成环：registry → fields → nodes/index
 * → defs/task → registry。
 *
 * ESM 求值到环里的 registry 时它只走到 import 阶段，写在里面的 `const defs`
 * 尚在 TDZ，defs/task 顶层那次 registerNode() 当场抛
 * 「Cannot access 'defs' before initialization」——脚本在模块求值阶段就中断，
 * SDK 末尾的 post({ type: 'ready' }) 根本没执行到，外壳只能干等 10s 报
 * 「iframe 插件握手超时」。
 *
 * 把本函数挪到 components 侧之后，registry 的依赖只剩纯类型模块，环就不存在了。
 * 这条不变量要守住：**nodes/registry 不得 import 任何会（直接或间接）回到
 * nodes/index 的模块**，需要组件就往 components/ 里放。
 */
export function inspectorOf(def: NodeDef): NonNullable<NodeDef['Inspector']> {
  // 返回类型写成 NonNullable：三条分支都必然给出一个组件，
  // 而 NodeDef['Inspector'] 本身是可选的 —— 照抄它会让调用方
  // （Inspector.tsx）拿到「可能是 undefined」的 Panel，白挨两个类型错。
  if (def.Inspector) return def.Inspector;
  if (def.fields) return makeInspector(def.fields, def.panelFooter);
  return function EmptyInspector({ node }: NodeInspectorProps) {
    return (
      <aside className="inspector">
        <div className="insp-title">
          <span className="title-input" style={{ flex: 1 }}>{def.meta.label}</span>
          <span className="insp-kind">{def.meta.label}</span>
        </div>
        <div className="tip">
          这个节点还没有配置面板（{node.type ?? '未知类型'}）。
        </div>
      </aside>
    );
  };
}
