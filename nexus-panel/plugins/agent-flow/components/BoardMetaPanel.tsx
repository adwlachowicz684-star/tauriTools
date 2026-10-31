import { useState } from 'react';
import {
  type BoardMeta, type StatusDef, type TagDef, TAG_PALETTE,
  addStatus, removeStatus, updateStatus, setNext, moveStatus,
  addTag, removeTag, updateTag,
} from '../engine/boardMeta';

/**
 * 状态流程与标签的设置面板。
 *
 * ================= 为什么要能自己设流程 =================
 *
 * 写死 todo/doing/done 意味着所有人必须用同一套流程，
 * 而真实流程千差万别（有的要"待评审""测试中"）。
 * 硬编码流程会逼团队迁就工具 —— 这正是市面工具都把工作流做成可配的原因。
 *
 * ================= 流转规则为什么必须显式配 =================
 *
 * 只改状态名、不约束流转，会出现"待办 → 已完成"一步跳过去，
 * 或"已完成"被随手拖回"进行中"。前者让流程形同虚设，
 * 后者让统计口径变脏（已完成数忽高忽低）。
 *
 * 所以每个状态都要写明"能走到哪"，界面上也只给这些选项。
 *
 * ================= 关于挂起与取消 =================
 *
 * 这两条是点名要的，也是本设计里最容易被合并错的一对：
 *   挂起 = 还要接着做，只是现在推不动
 *   取消 = 不做了
 * 合并成一个"不推进"状态的话，复盘时无法区分
 * "暂时卡住"与"已经放弃"，僵尸任务就堆在列表里没人清。
 */

export function BoardMetaPanel({
  meta, canWrite, notice, onChange, onClose,
}: {
  meta: BoardMeta;
  canWrite: boolean;
  notice: string;
  onChange: (next: (m: BoardMeta) => BoardMeta) => void;
  onClose: () => void;
}) {
  return (
    <div className="bmp-mask" onClick={onClose}>
      <div className="bmp" onClick={(e) => e.stopPropagation()}>
        <div className="bmp-head">
          <span className="bmp-title">状态流程与标签</span>
          <span className="task-grow" />
          <button type="button" className="mini" onClick={onClose}>关闭</button>
        </div>

        {notice ? <div className="bmp-notice">{notice}</div> : null}
        {!canWrite ? (
          <div className="nx-empty bmp-empty">需要设置导出目录，配置才有地方落盘。</div>
        ) : null}

        <div className="bmp-body">
          <StatusSection meta={meta} onChange={onChange} />
          <TagSection meta={meta} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function StatusSection({ meta, onChange }: {
  meta: BoardMeta;
  onChange: (next: (m: BoardMeta) => BoardMeta) => void;
}) {
  const [newName, setNewName] = useState('');
  return (
    <section className="bmp-sec">
      <div className="bmp-sec-title">
        状态流程
        <span className="bmp-sec-hint">顺序即表格里状态列的排序；「能走到」决定下拉里给哪些选项</span>
      </div>

      {meta.statuses.map((s, i) => (
        <StatusRow
          key={s.id}
          meta={meta}
          def={s}
          index={i}
          total={meta.statuses.length}
          onChange={onChange}
        />
      ))}

      <div className="bmp-add">
        <input
          className="p-input bmp-add-input"
          value={newName}
          placeholder="新状态名"
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className="mini"
          disabled={!newName.trim()}
          onClick={() => {
            onChange((m) => addStatus(m, newName).meta);
            setNewName('');
          }}
        >
          + 添加状态
        </button>
      </div>
    </section>
  );
}

function StatusRow({ meta, def, index, total, onChange }: {
  meta: BoardMeta;
  def: StatusDef;
  index: number;
  total: number;
  onChange: (next: (m: BoardMeta) => BoardMeta) => void;
}) {
  const [name, setName] = useState(def.name);
  return (
    <div className="bmp-row">
      <span className="bmp-swatchs">
        {TAG_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={`ttb-swatch${c === def.color ? ' is-on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => onChange((m) => updateStatus(m, def.id, { color: c }))}
          />
        ))}
      </span>

      <input
        className="p-input bmp-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== def.name) {
            onChange((m) => updateStatus(m, def.id, { name }));
          }
        }}
      />

      <label className="bmp-check" title="终态不能再流出（避免「已完成」被随手拖回去）">
        <input
          type="checkbox"
          checked={def.final}
          onChange={(e) => onChange((m) => updateStatus(m, def.id, { final: e.target.checked }))}
        />
        终态
      </label>

      <span className="task-grow" />

      <span className="bmp-move">
        <button type="button" className="mini" disabled={index === 0} onClick={() => onChange((m) => moveStatus(m, def.id, -1))}>↑</button>
        <button type="button" className="mini" disabled={index === total - 1} onClick={() => onChange((m) => moveStatus(m, def.id, 1))}>↓</button>
      </span>

      <button
        type="button"
        className="att-x"
        title="删除这个状态（任务上已用的会保留旧 id，不会静默改成别的）"
        onClick={() => onChange((m) => removeStatus(m, def.id))}
      >
        ✕
      </button>

      {def.final ? null : (
        <div className="bmp-next">
          <span className="bmp-next-k">能走到</span>
          <span className="bmp-next-v">
            {meta.statuses.filter((x) => x.id !== def.id).map((x) => {
              const on = def.next.indexOf(x.id) >= 0;
              return (
                <button
                  key={x.id}
                  type="button"
                  className={`af-tag af-tag-btn${on ? ' is-on' : ''}`}
                  style={{ background: `${x.color}1f`, color: x.color, borderColor: `${x.color}59` }}
                  onClick={() => onChange((m) => setNext(
                    m,
                    def.id,
                    on ? def.next.filter((y) => y !== x.id) : [...def.next, x.id],
                  ))}
                >
                  {x.name}
                </button>
              );
            })}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

function TagSection({ meta, onChange }: {
  meta: BoardMeta;
  onChange: (next: (m: BoardMeta) => BoardMeta) => void;
}) {
  const [newName, setNewName] = useState('');
  const [color, setColor] = useState<string>(TAG_PALETTE[0]);
  return (
    <section className="bmp-sec">
      <div className="bmp-sec-title">
        标签
        <span className="bmp-sec-hint">在表格的标签列点「+」就能直接挂；在这里统一改名字与颜色</span>
      </div>

      {meta.tags.length === 0 ? (
        <div className="bmp-hint">还没有标签。</div>
      ) : (
        meta.tags.map((t) => <TagRow key={t.id} def={t} onChange={onChange} />)
      )}

      <div className="bmp-add">
        <input
          className="p-input bmp-add-input"
          value={newName}
          placeholder="新标签名"
          onChange={(e) => setNewName(e.target.value)}
        />
        <span className="ttb-swatches">
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`ttb-swatch${c === color ? ' is-on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => setColor(c)}
            />
          ))}
        </span>
        <button
          type="button"
          className="mini"
          disabled={!newName.trim()}
          onClick={() => {
            onChange((m) => addTag(m, newName, color).meta);
            setNewName('');
          }}
        >
          + 添加标签
        </button>
      </div>
    </section>
  );
}

function TagRow({ def, onChange }: {
  def: TagDef;
  onChange: (next: (m: BoardMeta) => BoardMeta) => void;
}) {
  const [name, setName] = useState(def.name);
  return (
    <div className="bmp-row">
      <span className="ttb-swatches">
        {TAG_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={`ttb-swatch${c === def.color ? ' is-on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => onChange((m) => updateTag(m, def.id, { color: c }))}
          />
        ))}
      </span>
      <input
        className="p-input bmp-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== def.name) onChange((m) => updateTag(m, def.id, { name }));
        }}
      />
      <span className="bmp-preview">
        <span
          className="af-tag"
          style={{ background: `${def.color}1f`, color: def.color, borderColor: `${def.color}59` }}
        >
          {def.name}
        </span>
      </span>
      <span className="task-grow" />
      <button
        type="button"
        className="att-x"
        title="删除标签（挂过的任务不会自动摘掉，会显示成已删除的样子）"
        onClick={() => onChange((m) => removeTag(m, def.id))}
      >
        ✕
      </button>
    </div>
  );
}
