/**
 * ACL 保护的预设档位（#22）。
 *
 * 两个开关（防删除 denyDelete / 防写入 denyWrite）理论上有 4 种组合，
 * 但用户真正想要的只有四种**有名字的档位**，而不是"随便勾"。
 * 逐个勾的问题不是麻烦，而是**说不清自己在设什么** ——
 * 只勾"防写入"意味着能删但不能改，这几乎没人想要。
 */

export interface LockPreset {
  id: string;
  label: string;
  /** 一键设置后这两个开关分别是多少 */
  denyDelete: boolean;
  denyWrite: boolean;
  /**
   * 「账面固定」（#21）：只登记在案，**不落系统权限**。
   * 排在两个 ACL 档位之后 —— 它是"更轻"的选择，不是更强的。
   */
  accountOnly: boolean;
  /** 档位说明：这一档"挡住了什么" */
  hint: string;
}

/**
 * 档位顺序按**保护强度递增**，与界面上的排列一致。
 *
 * 顺序不能随意调：用户是"从左到右挑一个越来越强的"，
 * 打乱顺序后每次都要重新读一遍，档位就失去了意义。
 */
export const LOCK_PRESETS: LockPreset[] = [
  {
    id: 'none',
    label: '无保护',
    denyDelete: false,
    denyWrite: false,
        accountOnly: false,
    hint: '解除该文件夹的全部 ACL 保护',
  },
  {
    id: 'delete',
    label: '防删除',
    denyDelete: true,
    denyWrite: false,
        accountOnly: false,
    hint: '禁止删除（重命名也会被拦），内容仍可改',
  },
  {
    id: 'write',
    label: '防写入',
    denyDelete: false,
    denyWrite: true,
        accountOnly: false,
    hint: '目录变只读，但可以被删掉',
  },
  {
    id: 'full',
    label: '完全保护',
    denyDelete: true,
    denyWrite: true,
    accountOnly: false,
    hint: '既不能删也不能改，最强的一档',
  },
  {
    id: 'account',
    label: '账面固定',
    denyDelete: false,
    denyWrite: false,
    accountOnly: true,
    hint: '只登记在案做标记，不改系统权限（也就不必管理员权限）',
  },
];

/** 手动勾出的、不属于任何档位的组合（理论上不存在，但界面要能兜住） */
export const CUSTOM_PRESET_ID = 'custom';

/**
 * 当前开关组合对应哪个档位。
 *
 * 四个组合**恰好**覆盖四种情况，所以正常只会返回档位 id；
 * 返回 `custom` 只是给"将来新增开关"留的兜底 ——
 * 那时不写这个分支，界面就会显示"当前是某个档位"而实际不是，
 * 用户照着档位名理解就会理解错。
 */
export function presetOf(
  denyDelete: boolean, denyWrite: boolean, accountOnly: boolean,
): string {
  const hit = LOCK_PRESETS.find(
    (p) => p.denyDelete === denyDelete && p.denyWrite === denyWrite
      && p.accountOnly === accountOnly,
  );
  return hit ? hit.id : CUSTOM_PRESET_ID;
}

/**
 * 应用某个档位：**清掉档外的选项**。
 *
 * 这一点是 #22 的关键 —— 档位不是"再加一个开关"，
 * 而是"把状态整体设成这一档"。若只做叠加，
 * 从"防删除"切到"防写入"会变成"又防删又防写"，
 * 用户以为切换了档位，实际保护越来越重，
 * 而且界面上看不出（两个框都勾着，像是就这一档）。
 */
export function applyPreset(
  id: string,
): { denyDelete: boolean; denyWrite: boolean; accountOnly: boolean } | null {
  const p = LOCK_PRESETS.find((x) => x.id === id);
  if (!p) return null;
  return { denyDelete: p.denyDelete, denyWrite: p.denyWrite, accountOnly: p.accountOnly };
}
