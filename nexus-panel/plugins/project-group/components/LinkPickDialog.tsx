import { useMemo, useState } from 'react';
import type { FpxConfig, LinkDetail } from '../types';
import { normalizeKey } from '../api';
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
  project, group, config, allNames, details, ci = false, onConfirm, onClose,
}: {
  project: string;
  group: string;
  config: FpxConfig;
  /**
   * 路径比较是否忽略大小写 —— **只能**由平台决定（Windows 为 true）。
   *
   * 不能就地写死 true：Linux / macOS 的文件系统大小写敏感，
   * `/g` 与 `/G` 是两个不同的项目组。按"忽略大小写"比会把指向别组的
   * 链接判成"已指向本组" → 默认勾上 → 用户一点确定就把别组链接抢过来。
   */
  ci?: boolean;
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
   * 路径比对**不能**直接用 ===，也不能就地另写一份归一。
   *
   * 后端按磁盘反查出来的目标可能带尾分隔符（`D:\\g\\` 与 `D:\\g`），
   * 同一种写法也可能混用 `\` 与 `/`。直接比会把"已连本组"判成"指向别组"：
   * 提示错 + 默认不勾选 → 用户什么都没勾，一按确定该链接就被删了。
   *
   * 此前这里是一份 `replace(/[\\/]+$/, '').toLowerCase()`，与后端
   * `store::normalize_key` 差两点，**两个方向都会改到用户没要求改的东西**：
   *   · 无条件小写：非 Windows 上把两个不同的组判成同一个 → 指向别组的链接
   *     被判成"已指向本组" → 默认勾上 → 点确定就把别组链接**抢过来**；
   *   · 不统一分隔符：`D:\g` 与 `D:/g` 判成两个 → 已连本组的被判成别组 →
   *     默认不勾 → 点确定就被**删掉**。
   *
   * 所以一律走 `api.normalizeKey`，与后端同一套规则；大小写是否忽略由 `ci`
   * 决定（Windows 才为 true，见该 prop 的说明）。
   */
  const samePath = (a: string, b: string) => normalizeKey(a, ci) === normalizeKey(b, ci);

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

  /*
   * 「全选」的取值**必须排除他组占用**的那批 —— 与 `reset` 同一口径。
   *
   * 此前是 `new Set(allNames)`，把它们一并勾上：用户点一下「全选」再点确定，
   * 就把别的项目组的链接**全抢过来了**，而他根本没打算动那边。底部说明与
   * `ownedElsewhere` 的注释都写明这类名字要"手动逐个勾"，一键全选等于绕过
   * 这道确认，且全程不报错——正是"改了用户没要求改的东西"。
   *
   * 仍然包含设置里**关掉**的名字：临时多建一个正是本弹窗存在的意义
   * （见文件头注释），那是用户的显式意图，不该替他过滤掉。
   *
   * `all` 也按这批判，不能按 `allNames.length`：默认勾选不含他组占用，
   * 按全量判会让按钮永远显示「全选」，用户点了才发现多勾了一堆。
   */
  const selectable = useMemo(
    () => allNames.filter((n) => !ownedElsewhere.has(n)),
    [allNames, ownedElsewhere],
  );
  const all = picked.size === selectable.length;
  const toggleAll = () => setPicked(all ? new Set() : new Set(selectable));

  /*
   * 只按启用名单重置，而不是全选 —— 全选会把一堆平时关着的名字都打开。
   * 同样要排除他组占用：「回到默认」若把它们勾上，等于一键抢走别处的链接。
   */
  const reset = () => setPicked(new Set(enabled.filter((n) => !ownedElsewhere.has(n))));

  /*
   * 取消勾选**且当前指向本组**的那些名字：sync 会真的把它们删掉
   * （见 core_sync_links 里 ownedByThis 那段）。
   *
   * 这个数必须显示在按钮上 —— 只写「建立 N 个」的话，"取消勾选"这个
   * 有后果的动作在界面上完全不可见，用户点完确定才发现链接少了几个，
   * 而那时对话框已经关了，无从对照。
   */
  const dropCount = useMemo(
    () => allNames.filter((n) => {
      const t = existing.get(n);
      return t !== undefined && !picked.has(n) && samePath(t, group);
    }).length,
    [allNames, existing, picked, group],
  );

  /*
   * 按钮文案与禁用判据必须**同一套口径**。
   *
   * 此前 `disabled={picked.size === 0}`：全部取消勾选（picked 为空）而其中
   * 若干已指向本组时，行上标着「将删除」、按钮也写着「删除 K 个」，
   * 而按钮是**灰的** —— 界面承诺了一个动作却拒绝执行，且不给任何解释。
   * 于是"把链接全删掉"这个正当操作做不了，用户只能留一个不想要的勾选凑数。
   *
   * 后端 `core_sync_links` 的删除判据是"不在名单里且确实指向本组"
   * （outside + ownedByThis），所以传**空名单**正是"全删"的正确写法，
   * 不是无操作——按钮不该在这种时候禁用。
   */
  const noop = picked.size === 0 && dropCount === 0;
  const confirmLabel = noop
    ? '建立 0 个链接'
    : picked.size === 0
      ? `删除 ${dropCount} 个链接`
      : dropCount > 0
        ? `建立 ${picked.size} 个、删除 ${dropCount} 个`
        : `建立 ${picked.size} 个链接`;

  return (
    <Modal
      title="选择要建立的链接"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button
            /* 纯删除时转 danger：点下去会**少**东西，用主色（"确认新建"的
               观感）会让人按错，而这里没有任何二次确认。 */
            className={picked.size === 0 && !noop ? 'p-btn danger' : 'p-btn primary'}
            disabled={noop}
            onClick={() => onConfirm(allNames.filter((n) => picked.has(n)))}
          >
            {confirmLabel}
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
          const isPicked = picked.has(n);
          /*
           * 三个徽章**都必须跟着勾选状态走**，只按"现在指向哪儿"判定会
           * 说谎 —— 而 sync 的实际动作恰恰由勾选状态决定：
           *
           *   · 指向别组但**没勾** → sync 不会动它（只删指向本组的），
           *     标「将换绑」等于告诉用户一个不会发生的后果；
           *   · 已指向本组但**取消勾选** → sync 会真把它删掉，
           *     标「已建·不会变动」等于保证了一个相反的结果。
           * 两种误报都会让人做错决定：前者不敢勾（该建的漏掉），
           * 后者放心取消（链接悄悄没了）。
           */
          const rebind = isPicked && target !== undefined && !samePath(target, group);
          const willDrop = !isPicked && target !== undefined && samePath(target, group);
          const keeps = isPicked && target !== undefined && samePath(target, group);
          return (
            <label key={n} className="fpx-pick-row">
              <input
                type="checkbox"
                checked={isPicked}
                onChange={() => toggle(n)}
              />
              <span className="p-mono">{n}</span>
              {rebind && (
                <span className="fpx-badge warn" title={`原本指向：${target}`}>
                  将换绑
                </span>
              )}
              {willDrop && (
                <span className="fpx-badge warn" title="已指向本项目组；取消勾选会在点「确定」后删除它">
                  将删除
                </span>
              )}
              {keeps && (
                <span className="fpx-badge dim" title="已指向本项目组，保持不变">已建</span>
              )}
              {!isPicked && target !== undefined && !samePath(target, group) && (
                <span className="fpx-badge dim" title={`当前指向：${target}；未勾选，本次不会改动`}>
                  他组占用
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-5, 10px)' }}>
        「将换绑」表示该名字当前指向别的项目组，建立后会被改指到本项目组——
        原指向会断开。这类名字默认<b>不勾选</b>，需要的话请手动勾上
        （勾上即表示同意把它从原项目组挪过来）。
        「将删除」表示它已指向本项目组，取消勾选会在点「确定」后真的删掉。
        指向别组又没勾的（「他组占用」）本次<b>不会</b>被改动。
        「设置」里开启「快速链接」可跳过此步，直接按默认名单建立。
      </div>
    </Modal>
  );
}
