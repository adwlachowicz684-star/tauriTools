import { useMemo, useState } from 'react';
import type { FpxConfig, LinkDetail } from '../types';
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
  project, group, config, allNames, details, onConfirm, onClose,
}: {
  project: string;
  group: string;
  config: FpxConfig;
  /** 全部链接名（预设显示名 + 自定义），已按置顶排序 */
  allNames: string[];
  /*
   * 逐条链接明细（#198），用来判断哪些名字已经建过、指向哪儿。
   *
   * 这里**必须**用 details 而不是整卡账本 links：
   * 账本一条记录只有一个 group，而同一个项目的多个链接名**可以指向不同
   * 的组**（手工建、或从别处迁移过来就有）。拿它判定换绑必然有行判错：
   *   · 实际指向别组、但账本 group == 本次目标 → 不显示「将换绑」，
   *     用户点确定，别处的链接被悄悄抢走；
   *   · 实际指向本组、但账本 group != 本次目标 → 误显示「将换绑」，
   *     用户不敢勾 → 该名不在名单里且指向本组 → **被删掉**。
   *     即：什么都没勾，链接却没了。
   */
  details?: LinkDetail[];
  onConfirm: (names: string[]) => void;
  onClose: () => void;
}) {
  const enabled = useMemo(
    () => allNames.filter((n) => config.linkAgents?.[n] ?? true),
    [allNames, config.linkAgents],
  );

  /*
   * 路径比对**不能**直接用 ===。
   *
   * 后端按磁盘反查出来的目标可能带尾分隔符（`D:\\g\\` 与 `D:\\g`），
   * 而 Windows 路径大小写不敏感。直接比会把"已连本组"判成"指向别组"：
   * 提示错 + 默认不勾选 → 用户什么都没勾，一按确定该链接就被删了。
   */
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a: string, b: string) => norm(a) === norm(b);

  /*
   * 该名字当前是否已建链接、指向哪儿（用于「将换绑」提示）。
   *
   * 取 realGroup（后端按磁盘反查的**真实**指向）而不是 group（账本登记值）：
   * 两者在手工改过、迁移过、或建链失败残留下会不一致，而这时用户看到的
   * 是磁盘上的实情 —— 按登记值提示等于告诉他一个不存在的事实。
   *
   * 读不到目标（realGroup 为空）就**不进表**：那是"不知道"，不是"没连"。
   * 进表会让它显示成"将换绑"，而实际可能根本没建过。
   */
  const existing = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of details ?? []) {
      if (d.realGroup && d.realGroup.length > 0) m.set(d.name, d.realGroup);
    }
    return m;
  }, [details]);

  /*
   * 已被**别的项目组**占用的名字。
   *
   * 这些名字默认不勾选（原版 MakeCheck 明写）：默认勾上的话，
   * 用户直接点确定就把别组链接抢过来了 —— 而他根本没打算动那边。
   */
  const ownedElsewhere = useMemo(() => {
    const s = new Set<string>();
    for (const [name, target] of existing) {
      if (!samePath(target, group)) s.add(name);
    }
    return s;
  }, [existing, group]);

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(enabled.filter((n) => !ownedElsewhere.has(n))),
  );

  const toggle = (n: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });

  const all = picked.size === allNames.length;
  const toggleAll = () => setPicked(all ? new Set() : new Set(allNames));

  /*
   * 只按启用名单重置，而不是全选 —— 全选会把一堆平时关着的名字都打开。
   * 同样要排除他组占用：「回到默认」若把它们勾上，等于一键抢走别处的链接。
   */
  const reset = () => setPicked(new Set(enabled.filter((n) => !ownedElsewhere.has(n))));

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
        <button className="p-btn sm" style={{padding: '0 8px'}} onClick={toggleAll}>
          {all ? '全不选' : '全选'}
        </button>
        <button className="p-btn sm" style={{padding: '0 8px'}} onClick={reset}>
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
          const rebind = target !== undefined && !samePath(target, group);
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
              {target !== undefined && samePath(target, group) && (
                <span className="fpx-badge dim" title="已指向本项目组，不会变动">已建</span>
              )}
            </label>
          );
        })}
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-5, 10px)' }}>
        「将换绑」表示该名字当前指向别的项目组，建立后会被改指到本项目组——
        原指向会断开。这类名字默认<b>不勾选</b>，需要的话请手动勾上
        （勾上即表示同意把它从原项目组挪过来）。
        「设置」里开启「快速链接」可跳过此步，直接按默认名单建立。
      </div>
    </Modal>
  );
}
