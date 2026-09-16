import { useMemo, useState } from 'react';
import type { FpxConfig, LinkRow } from '../types';
import { Modal } from './ui';

/**
 * 建链时选择链接名（对应原版 LinkPickDialog）。
 *
 * 后端 `fpx_create_link` 本来就接受 `names` 参数，但前端从没传过——
 * 于是每次建链都是"按设置里启用的名字全建一遍"，没法临时只建某几个，
 * 也没法临时多建一个（得先去设置里开开关再回来拖一次）。
 *
 * 默认勾选 = 设置里已启用的名字（`linkAgents[name] ?? true`，缺失视为开启，
 * 与后端 `enabled_names` 的判定保持一致）。
 *
 * 「将换绑」提示：后端 `create_one` 对已存在的链接是**先删再建**，
 * 所以指向别的项目组的同名链接会被改指到新目标。这是个有后果的动作，
 * 必须让用户事先看见，而不是建完才发现别处断了。
 */
export function LinkPickDialog({
  project, group, config, allNames, links, onConfirm, onClose,
}: {
  project: string;
  group: string;
  config: FpxConfig;
  /** 全部链接名（预设显示名 + 自定义），已按置顶排序 */
  allNames: string[];
  /** 当前账本，用来判断哪些名字已经建过、指向哪儿 */
  links: LinkRow[];
  onConfirm: (names: string[]) => void;
  onClose: () => void;
}) {
  const enabled = useMemo(
    () => allNames.filter((n) => config.linkAgents?.[n] ?? true),
    [allNames, config.linkAgents],
  );

  const [picked, setPicked] = useState<Set<string>>(() => new Set(enabled));

  /** 该名字当前是否已建链接、指向哪儿（用于「将换绑」提示）。 */
  const existing = useMemo(() => {
    const row = links.find((l) => l.project === project);
    const m = new Map<string, string>();
    if (row) for (const n of row.names ?? []) m.set(n, row.group ?? '');
    return m;
  }, [links, project]);

  const toggle = (n: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });

  const all = picked.size === allNames.length;
  const toggleAll = () => setPicked(all ? new Set() : new Set(allNames));

  // 只按启用名单重置，而不是全选——全选会把一堆平时关着的名字都打开
  const reset = () => setPicked(new Set(enabled));

  return (
    <Modal
      title="选择要建立的链接"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button
            className="p-btn primary"
            disabled={picked.size === 0}
            onClick={() => onConfirm(allNames.filter((n) => picked.has(n)))}
          >
            建立 {picked.size} 个链接
          </button>
        </>
      }
    >
      <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)', marginBottom: 'var(--sp-5, 10px)' }}>
        项目：<span className="p-mono">{project}</span>
      </div>
      <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)', marginBottom: 'var(--sp-6, 12px)' }}>
        项目组：<span className="p-mono">{group}</span>
      </div>

      <div className="p-row" style={{ marginBottom: 'var(--sp-4, 8px)' }}>
        <button className="p-btn" style={{ height: 26, padding: '0 8px' }} onClick={toggleAll}>
          {all ? '全不选' : '全选'}
        </button>
        <button className="p-btn" style={{ height: 26, padding: '0 8px' }} onClick={reset}>
          回到默认
        </button>
        <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
          已选 {picked.size} / {allNames.length}
        </span>
      </div>

      <div className="fpx-pick-list">
        {allNames.length === 0 && (
          <div className="p-muted">（没有可用的链接名，请先到「设置」里添加）</div>
        )}
        {allNames.map((n) => {
          const target = existing.get(n);
          // 有记录、且指向的不是本次目标 → 这次会改指过去
          const rebind = target !== undefined && target !== group;
          return (
            <label key={n} className="fpx-pick-row">
              <input
                type="checkbox"
                checked={picked.has(n)}
                onChange={() => toggle(n)}
              />
              <span className="p-mono">{n}</span>
              {rebind && (
                <span className="fpx-badge warn" title={`原本指向：${target}`}>
                  将换绑
                </span>
              )}
              {target === group && (
                <span className="fpx-badge dim" title="已指向本项目组，不会变动">已建</span>
              )}
            </label>
          );
        })}
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-5, 10px)' }}>
        「将换绑」表示该名字当前指向别的项目组，建立后会被改指到本项目组——
        原指向会断开。「设置」里开启「快速链接」可跳过此步，直接按默认名单建立。
      </div>
    </Modal>
  );
}
