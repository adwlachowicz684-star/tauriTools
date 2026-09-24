/**
 * 自动备份「显示必须与实际一致」（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/backup-auto-truth-test.mjs
 *
 * 这一片钉的是同一件事的三个面：**自动备份不能说谎**。
 *
 *   1. 每次保存设置都重起线程 → 计时被无限推迟 → 实际一次都不跑，
 *      但面板显示"运行中"、日志写"已启用"。
 *   2. 备份跑失败也照样把"上次备份时间"写成刚刚 → 面板谎报成功。
 *   3. 数据目录读不到时按"间隔 0"处理 → 把正在跑的备份悄悄停掉。
 *
 * 三者的共同点是：界面/日志**主动**给了一个与事实相反的安全感，
 * 而用户要等到真需要恢复时才发现备份目录是空的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const backup = strip(fs.readFileSync(path.join(RS, 'backup.rs'), 'utf8'));
const mod = strip(fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8'));
const dlg = fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8');

/** 取某个 pub fn 的正文：到下一个顶层 `pub fn` 为止 */
const fnBody = (src, sig) => {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const rest = src.slice(i);
  const j = rest.indexOf('\npub fn ', 1);
  const k = rest.indexOf('\nfn ', 1);
  const end = [j, k].filter((x) => x > 0);
  return end.length ? rest.slice(0, Math.min(...end)) : rest;
};

console.log('\n=== 1. start_auto：已在运行则忽略（不重起线程）===');
{
  const body = fnBody(backup, 'pub fn start_auto');
  t('取到 start_auto 正文', body.length > 0);
  const guard = body.indexOf('if is_auto_running() { return true; }');
  const gen = body.indexOf('AUTO_GEN.fetch_add');
  /* 两端都判存在：indexOf 找不到返回 -1，而 -1 < 正数 恒真 —— 会空跑 */
  t('有"已运行则忽略"的早退', guard >= 0);
  t('领新代次仍然在', gen >= 0);
  t('且早退必须在新代次之前（否则先重起了再判断，等于没判断）',
    guard >= 0 && gen >= 0 && guard < gen);
}

console.log('\n=== 2. 自动线程：看 run 的结果，失败不推进"上次备份"===');
{
  const body = fnBody(backup, 'pub fn start_auto');
  t('自动线程不再吞掉 run 的结果', !/let _ = run\(/.test(body));
  t('收集了 errors', /errs\.extend\(r\.errors/.test(body));
  t('只在无错时才更新 AUTO_LAST', /errs\.is_empty\(\)/.test(body));
  const empty = body.indexOf('if errs.is_empty()');
  const lastWrite = body.indexOf('AUTO_LAST.lock()');
  t('AUTO_LAST 的写入在 is_empty 分支之后（失败时绝不写）',
    empty >= 0 && lastWrite >= 0 && empty < lastWrite);
  t('失败原因记进 AUTO_ERR', /AUTO_ERR\.lock\(\)/.test(body));
}

console.log('\n=== 3. AutoStatus 带 lastError ===');
{
  const st = backup.slice(backup.indexOf('pub struct AutoStatus'));
  const seg = st.slice(0, st.indexOf('\n}') + 2);
  t('结构体有 last_error', /pub last_error: Option<String>/.test(seg));
  t('auto_status 回填了它', /last_run,\s*last_error\s*\}/.test(backup));
  t('前端类型也声明了', /lastError: string \| null;/.test(
    fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8')));
}

console.log('\n=== 4. auto_sync：数据目录读不到时不能按 0 处理 ===');
{
  const body = fnBody(mod, 'pub fn fpx_backup_auto_sync');
  t('取到 fpx_backup_auto_sync 正文', body.length > 0);
  /* 反面证据：原来的 `Err(_) => 0` 会走到 stop_auto，把运行中的备份悄悄停掉 */
  t('不再有 Err(_) => 0', !/Err\(_\)\s*=>\s*0/.test(body));
  t('解析失败时保持现状并如实回传', /Err\(_\)\s*=>\s*return backup::is_auto_running\(\)/.test(body));
}

console.log('\n=== 5. 前端：以实际是否运行为准写日志 + 优先显示失败原因 ===');
{
  /* 只看输入框里的 autoMinutes 就写"已启用"，是又一次假成功 */
  t('日志以 running 为准', /\}\s*else if \(running\)\s*\{/.test(dlg));
  t('没起来时明确报错', /自动备份未能启动/.test(dlg));
  t('失败原因优先于"上次备份时间"', /status\?\.lastError/.test(dlg));
  t('失败用危险色（不能混在普通说明里）', /status\?\.lastError[\s\S]{0,200}var\(--danger\)/.test(dlg));
}

done();
