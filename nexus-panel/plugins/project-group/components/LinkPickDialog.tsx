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
/**
 * 路径比对：去尾分隔符 + 大小写不敏感（Windows 路径语义）。
 *
 * 不能直接用 `===`：后端反查出来的目标可能带尾反斜杠，
 * 而本次传进来的 group 不一定有 —— 不等就会误判成"指向别组"，
 * 于是本已连好的名字被当成要换绑（提示错 + 默认不勾选 → 一取消就被删）。
 */
function samePath(a: string, b: string): boolean {
  const t = (x: string) => x.replace(/[\\/]+$/, '').toLowerCase();
  return t(a) === t(b);
}

export function LinkPickDialog({
  project, group, config, allNames, details, onConfirm, onClose,
}: {
  project: string;
  group: string;
  config: FpxConfig;
  /** 全部链接名（预设显示名 + 自定义），已按置顶排序 */
  allNames: string[];
  /**
   * 该项目**逐名**的当前链接明细（后端按磁盘反查）。
   *
   * 不能用整条账本记录的 `group`：一个项目的多个链接名**可以指向不同组**
   * （手工建、或从别处迁移过来就有），而账本一条记录只有一个 group。
   * 用它判定"会不会换绑"必然有行是错的 —— 见 #202。
   */
  details?: LinkDetail[];
  onConfirm: (names: string[]) => void;
  onClose: () => void;
}) {
  const enabled = useMemo(
    () => allNames.filter((n) => config.linkAgents?.[n] ?? true),
    [allNames, config.linkAgents],
  );

  /**
   * 每个名字**当前实际**指向的组（磁盘反查，不是账本登记值）。
   *
   * 读不到（权限、损坏的 junction）时不进表 —— 那时"会不会换绑"是未知的，
   * 不能当成"指向别组"处理（会误报，用户因此不敢勾，结果该名被删）。
   */
  const existing = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of details ?? []) {
      if (d.realGroup && d.realGroup.length > 0) m.set(d.name, d.realGroup);
    }
    return m;
  }, [details]);

  /** 指向别组的名字：默认**不**勾选（原版 MakeCheck 明写） */
  const ownedElsewhere = useMemo(
    () => new Set(
      [...existing.entries()]
        .filter(([, t]) => !samePath(t, group))
        .map(([n]) => n),
    ),
    [existing, group],
  );

  /*
   * 默认勾选 = 启用名单 **去掉**指向别组的那些。
   *
   * 原版注释写明："被其它项目组占用的名称……该项默认不勾选。"
   * 照做的理由：用户打开这个框通常只想建本组的链接，若别组的同名被默认勾上，
   * 直接点确定就会**把别组的链接抢过来** —— 而他根本没打算动那边。
   * 这是"改了不该改的地方"，且没有任何报错，别处只是莫名断了一条。
   */
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

  // 只按启用名单重置，而不是全选——全选会把一堆平时关着的名字都打开
  // （同样要排除别组占用的，理由与初始状态一致）
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
          // 实际指向的不是本次目标 → 这次会改指过去（同名换绑）
          const rebind = target !== undefined && !samePath(target, group);
          const dim = target !== undefined && samePath(target, group);
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
              {dim && (
                <span className="fpx-badge dim" title="已指向本项目组，不会变动">已建</span>
              )}
            </label>
          );
        })}
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-5, 10px)' }}>
        「将换绑」表示该名字当前指向别的项目组，建立后会被改指到本项目组——
        原指向会断开。这类名字默认<b>不勾选</b>——你通常只想建本组的链接，
        直接点确定不该把别处的抢过来。「设置」里开启「快速链接」可跳过此步。
      </div>
    </Modal>
  );
}
