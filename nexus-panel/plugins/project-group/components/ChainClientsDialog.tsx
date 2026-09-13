import { useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import type { CustomChainClient } from '../types';
import { Modal } from './ui';

const blank = (): CustomChainClient => ({ id: '', name: '', exe: null, scheme: null });

/**
 * 手动添加连锁客户端。
 *
 * 自动检测只认常见客户端的固定安装位置与 PATH/注册表，装到非常规位置的就扫不到；
 * 有些客户端也没有可预填的深链接。这里让用户显式登记 exe 或 URL scheme，
 * 登记后强制出现在客户端列表里（绕过自动检测）。
 */
export function ChainClientsDialog({
  api, initial, onClose, onLog,
}: {
  api: Api;
  /** 当前已登记的清单 */
  initial: CustomChainClient[];
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
}) {
  const [list, setList] = useState<CustomChainClient[]>(initial.map((c) => ({ ...c })));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const patch = (i: number, p: Partial<CustomChainClient>) => {
    setList((l) => l.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
  };

  const add = () => setList((l) => [...l, blank()]);
  const remove = (i: number) => setList((l) => l.filter((_, idx) => idx !== i));

  const save = async () => {
    setErr('');
    // 校验：id 必填且互不重复，exe / scheme 至少填一个
    const ids = list.map((c) => c.id.trim());
    if (ids.some((v) => !v)) { setErr('标识不能为空'); return; }
    if (new Set(ids).size !== ids.length) { setErr('标识重复'); return; }
    for (const c of list) {
      if (!c.exe?.trim() && !c.scheme?.trim()) {
        setErr(`「${c.id}」需要至少填一项：程序路径 或 URL scheme`);
        return;
      }
    }

    setSaving(true);
    try {
      const shown = await api.saveChainClients(list.map((c) => ({
        id: c.id.trim(),
        name: c.name.trim(),
        exe: c.exe?.trim() ? c.exe.trim() : null,
        scheme: c.scheme?.trim() ? c.scheme.trim() : null,
      })));
      onLog(`已保存 ${list.length} 个自定义客户端，当前可选 ${shown.length} 个`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="自定义连锁客户端"
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="p-btn" onClick={add}>＋ 添加</button>
          <span style={{ flex: 1 }} />
          <button className="p-btn" onClick={onClose} disabled={saving}>取消</button>
          <button className="p-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="p-muted" style={{ marginBottom: 10, fontSize: 11.5 }}>
        自动检测扫不到时（装在非常规位置、或没有可预填的深链接）可在此登记。
        「标识」是内部用的唯一 id，「程序路径」优先用于打开目录，不可用则试「URL scheme」。
        两者都只能做到「唤起客户端 + 复制指令」，自动预填对话框需要客户端自己支持深链接。
      </div>

      {list.length === 0 && <div className="p-muted">还没有自定义客户端。</div>}

      {list.map((c, i) => (
        <div key={i} className="fpx-cc-row">
          <div className="fpx-cc-grid">
            <input className="p-input" placeholder="标识（如 myai）" value={c.id}
              onChange={(e) => patch(i, { id: e.target.value })} />
            <input className="p-input" placeholder="显示名" value={c.name}
              onChange={(e) => patch(i, { name: e.target.value })} />
            <input className="p-input" placeholder="程序完整路径（可选）" value={c.exe ?? ''}
              onChange={(e) => patch(i, { exe: e.target.value || null })} />
            <input className="p-input" placeholder="URL scheme（可选，如 myai）" value={c.scheme ?? ''}
              onChange={(e) => patch(i, { scheme: e.target.value || null })} />
          </div>
          <button className="p-btn danger mini" onClick={() => remove(i)}>删除</button>
        </div>
      ))}

      {err && <div className="p-muted" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
