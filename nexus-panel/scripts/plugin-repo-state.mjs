#!/usr/bin/env node
/**
 * 12 个插件私有仓「断点续跑状态」的唯一入口。
 * 核验 / 增量刷新 / 整仓初始化三条通道共用，不许各写一份 try/catch。
 *
 * ⛔ 为什么不能把 JSON.parse 失败当成「还没有状态文件」
 * ------------------------------------------------------------
 * 这份文件是防覆盖的唯一依据：它记着哪些仓是我方建的、上次推到哪个 commit。
 * 502 / Ctrl-C 把它写坏半份（或人为改坏）时，旧写法 catch 之后返回 {}：
 *   · create 侧：12 个仓全变成 owned=false，被判成「别人的仓」而拒绝覆盖；
 *   · refresh 侧：刷新成功却以空对象为底重写，抹掉其余 11 个仓的历史；
 *   · verify 侧：12 仓全报「状态落后」，用户按提示跑 --fix-state 会拿这份
 *     空对象写回去，把损坏洗白成一份只剩 commit 的「合法」状态，输出仍是
 *     ✅ 已校准。
 * 三种后果都不报错，只看输出分不出来。verify 里那句注释早已写明这个风险，
 * 而代码恰好把它静默掉了 —— 注释承诺了代码没做的事。
 *
 * 口径：文件不存在 = 首次运行，允许空状态；文件存在但不可读 / 不可解析 /
 * 顶层不是对象 = 必须停下并明说，绝不静默回退，也不允许 --fix-state 校准。
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadPluginRepoState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, state: {}, missing: true, reason: '' };
    }
    return {
      ok: false, state: {}, missing: false,
      reason: `状态文件不可读（${e.code || e.message}）：${statePath}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false, state: {}, missing: false,
      reason: `状态文件 JSON 不可解析（${e.message}）：${statePath}；`
        + '可能写到一半被中断，拒绝当成空状态',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false, state: {}, missing: false,
      reason: `状态文件结构异常（顶层应为对象）：${statePath}`,
    };
  }
  return { ok: true, state: parsed, missing: false, reason: '' };
}

/** 原子写。父目录必须已存在 —— 绝不 mkdir 造出一个假的 .git 目录。 */
export function savePluginRepoState(statePath, state) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`状态文件父目录不存在，拒绝创建假 git 目录：${dir}`);
  }
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

export function resetPluginRepoState(statePath) {
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}

/**
 * 状态漂移判定（纯函数，核验脚本与守卫都真跑它）。
 * loadError 非空时 canFix 恒 false：损坏绝不能被 --fix-state 洗白。
 * heads 为 Map<repo, headSha>。
 */
export function stateDriftReport({
  state, loadError = '', heads, fix = false,
  drift = 0, netFail = 0, expectedCount = 0,
}) {
  const lines = [];
  if (loadError) {
    lines.push(`  ⛔ ${loadError}`);
    lines.push('  ⛔ 状态文件损坏：拒绝校准，也拒绝把损坏记成「状态落后」');
    return { lines, stateDrift: 1, canFix: false, fatal: true };
  }
  let stateDrift = 0;
  for (const [repo, head] of heads) {
    const want = state[repo] && state[repo].commit;
    if (want !== head) {
      lines.push(`  ⚠️  ${repo}: 状态 commit ${String(want).slice(0, 8)} != HEAD ${head.slice(0, 8)}`);
      stateDrift++;
    }
  }
  const canFix = fix && stateDrift > 0 && drift === 0 && netFail === 0
    && heads.size === expectedCount;
  return { lines, stateDrift, canFix, fatal: false };
}
