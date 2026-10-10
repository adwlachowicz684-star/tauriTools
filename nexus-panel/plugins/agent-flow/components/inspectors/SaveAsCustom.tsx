import { addCustomPreset } from '../../engine/customPresets';
import { hadInlineSecret } from '../../engine/sanitize';
import { prompt, alert } from '../../../../js/dialog.js';
import { getDef } from '../../nodes/registry';

/**
 * 「存为自定义」按钮。
 *
 * 抽成组件是因为它要出现在 5 个地方：字段型面板的标题行，
 * 以及条件 / 循环 / 并发 / 触发器这四个整体自定义面板的节点名称行。
 * 复制 5 遍的话，改文案或改存储方式就要同步 5 处。
 */
export default function SaveAsCustom({ node }: {
  node: { id: string; type: string; data: unknown };
}) {
  const def = getDef(node.type);

  /*
   * 老类型不给存。
   *
   * 与 allPresets() / 导入预设同一条判据（canPresetOn）。少了这一道的话：
   * 老节点照样能点「存为自定义」，提示也确实存进去了，
   * 而侧栏不列出 legacy 的自定义预设 —— **存完了却找不到**。
   * 不报错，用户只会以为保存失败或侧栏坏了。
   *
   * 标 legacy 的意思是"已并入另一个节点"：它仍然可运行（老画布要用），
   * 但不该再成为新节点的起点。禁用而非隐藏 —— 隐藏的话用户连为什么没有
   * 这个按钮都无从知道。
   */
  if (def.meta.legacy) {
    return (
      <button
        className="mini save-as-custom"
        disabled
        title={`「${def.meta.label}」已并入另一个节点，不能再作为新节点的起点`}
      >
        存为自定义
      </button>
    );
  }

  const onSave = async () => {
    const d = (node.data ?? {}) as Record<string, unknown>;
    const name = await prompt({
      title: '存为自定义节点',
      message: '之后可从左侧「自定义」分组里直接拖出来用。',
      placeholder: '节点名称',
      defaultValue: String(d.label ?? def.meta.label),
      validate: (v: string) => (v && v.trim() ? null : '请填个名字'),
    });
    if (!name) return;
    /*
     * 存的是配置：engine/customPresets 会剥掉 status / output / last* 等
     * 运行时状态，所以之后拖出来的都是干净的、待运行的节点。
     */
    const leaked = hadInlineSecret(node.data);
    addCustomPreset({ name, baseType: node.type, data: node.data });
    /*
     * 直接填在节点里的令牌不会被存进预设（预设是明文存储，不能当密钥仓库用），
     * 但连接引用会保留。不说明的话，用户拖出新节点会发现令牌空了却不知为何。
     */
    if (leaked) {
      await alert({
        title: '已存为自定义节点',
        message: '节点里直接填写的令牌不会被保存（预设是明文存储）。'
          + '改用连接管理器的连接即可随预设一起复用。',
      });
    }
  };

  return (
    <button
      className="mini save-as-custom"
      title="把当前配置存成自定义节点，之后可从左侧「自定义」分组直接拖出来用"
      onClick={() => void onSave()}
    >
      存为自定义
    </button>
  );
}
