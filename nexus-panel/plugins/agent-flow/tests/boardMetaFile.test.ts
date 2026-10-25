import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as pathmod from 'node:path';

import * as tauri from '../lib/tauri';
import { metaPathOf, commitMeta, loadMeta } from '../engine/boardMetaFile';
import { emptyMeta } from '../engine/boardMeta';
import { isParseableJson } from '../engine/taskBoardFile';

/*
 * 三份清单（tasks / attachments / boardmeta）并排放在**同一个导出目录**里。
 *
 * 这一组测的是第三份（boardmeta）：它曾经没有像另两份那样
 * 在写盘前检查「文件坏没坏」，于是手改坏了一个字节的配置文件
 * 会在下一次编辑时被**整份覆盖** —— 而损坏的 JSON 往往手改几行就能救回来，
 * 一盖就永远没了。
 *
 * 更糟的是它报 `overwritten: false`（"没覆盖任何东西"）——
 * 在文件刚被整份盖掉的这一刻，那句话是假的。
 */

/* ---- 把文件 IO 接到真磁盘上（测试环境没有 Tauri） ---- */
type Req = { op: string; path: string; content?: string };
const REAL = {
  fileOp: (tauri as never as Record<string, unknown>).fileOp,
  canExportToFile: (tauri as never as Record<string, unknown>).canExportToFile,
  ensureDir: (tauri as never as Record<string, unknown>).ensureDir,
  writeTextFile: (tauri as never as Record<string, unknown>).writeTextFile,
};
const T = tauri as never as Record<string, unknown>;

function stubFs(on: boolean): void {
  if (!on) {
    T.fileOp = REAL.fileOp;
    T.canExportToFile = REAL.canExportToFile;
    T.ensureDir = REAL.ensureDir;
    T.writeTextFile = REAL.writeTextFile;
    return;
  }
  T.canExportToFile = () => true;
  T.ensureDir = async () => ({ ok: true, text: 'ok' });
  /*
   * writeTextFile 也要接：写路径是 tauri.js **内部**直接调自己的 fileOp
   * （不是走 exports.fileOp），只打 fileOp 的话写操作会落到真实通道上，
   * 在 node 里抛"需要运行在桌面端"。
   */
  T.writeTextFile = async (p2: string, content: string) => {
    fs.writeFileSync(p2, content ?? '');
    return { ok: true, text: 'ok' };
  };
  T.fileOp = async (req: Req) => {
    if (req.op === 'read') {
      if (!fs.existsSync(req.path)) return { ok: false, text: 'No such file or directory' };
      return { ok: true, text: fs.readFileSync(req.path, 'utf8') };
    }
    if (req.op === 'write') {
      fs.writeFileSync(req.path, req.content ?? '');
      return { ok: true, text: 'ok' };
    }
    if (req.op === 'mkdir') {
      fs.mkdirSync(req.path, { recursive: true });
      return { ok: true, text: 'ok' };
    }
    return { ok: false, text: `unsupported op ${req.op}` };
  };
}

function withTmp(): { dir: string; p: string; clean: () => void } {
  const dir = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'af-boardmeta-'));
  const p = metaPathOf(dir, 'proj-1', '项目甲');
  return { dir, p, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 一个"手改坏了一个字节"的配置文件 */
function corruptText(): string {
  return JSON.stringify(emptyMeta('proj-1', '项目甲')).replace('"tags"', '"tags" @#$%');
}

test('文件坏掉时 commitMeta 必须抛错、一个字节都不写', async () => {
  const { p, clean } = withTmp();
  stubFs(true);
  try {
    fs.writeFileSync(p, corruptText());
    const before = fs.readFileSync(p, 'utf8');
    assert.equal(isParseableJson(before), false, '前置条件：这确实是坏文件');

    const mine = { ...emptyMeta('proj-1', '项目甲'), updatedAt: 1 };
    await assert.rejects(
      () => commitMeta(p, emptyMeta('proj-1', '项目甲'), mine),
      /已损坏/,
      '坏文件必须中止写入',
    );
    assert.equal(fs.readFileSync(p, 'utf8'), before, '原文件必须原封不动');
  } finally {
    stubFs(false);
    clean();
  }
});

test('文件坏掉时 loadMeta 不能当成"没配过"', async () => {
  const { p, clean } = withTmp();
  stubFs(true);
  try {
    fs.writeFileSync(p, corruptText());
    /*
     * 退化成默认配置的话，界面显示"这个项目还没配过状态"，
     * 用户照着"没配过"去加第一条 —— 保存时就把坏文件整份盖掉了。
     */
    await assert.rejects(() => loadMeta(p, 'proj-1', '项目甲'), /已损坏/);
  } finally {
    stubFs(false);
    clean();
  }
});

/** 只盯"坏的要拦"的话，把空文件也拦掉同样通过 —— 那是误伤（第一次用本来就是空的） */
test('空文件不算损坏：第一次用要能正常写入', async () => {
  const { p, clean } = withTmp();
  stubFs(true);
  try {
    const mine = { ...emptyMeta('proj-1', '项目甲'), updatedAt: 1 };
    const out = await commitMeta(p, emptyMeta('proj-1', '项目甲'), mine);
    assert.equal(out.overwritten, false);
    assert.ok(fs.existsSync(p), '第一次用要写出文件');
    assert.equal(isParseableJson(fs.readFileSync(p, 'utf8')), true);
  } finally {
    stubFs(false);
    clean();
  }
});

/** 判据不能把"别人改过"这件事一起吞掉 —— 覆盖必须照样报告 */
test('磁盘上更新时仍要报 overwritten', async () => {
  const { p, clean } = withTmp();
  stubFs(true);
  try {
    const theirs = { ...emptyMeta('proj-1', '项目甲'), updatedAt: 999 };
    fs.writeFileSync(p, JSON.stringify(theirs));
    const base = emptyMeta('proj-1', '项目甲');
    const mine = { ...emptyMeta('proj-1', '项目甲'), updatedAt: 5 };
    const out = await commitMeta(p, base, mine);
    assert.equal(out.overwritten, true, '别人的更新必须报告');
    assert.equal(fs.readFileSync(p, 'utf8'), JSON.stringify(theirs), '不能覆盖掉别人的');
  } finally {
    stubFs(false);
    clean();
  }
});

/*
 * 三个 hook（useTaskBoard / useAttachments / useBoardMeta）刻意保持同一形状，
 * useBoardMeta 开头也这么承诺。写盘失败时前两个都会退回已落盘的那份，
 * 这一条盯住第三个别掉队：不退回的话界面停在"没存成的值"上，
 * 报错归报错、值照样显示成改过的样子。
 */
test('写盘失败时 useBoardMeta 要退回已落盘的那份', () => {
  if (!ROOT) return;
  const src = fs.readFileSync(pathmod.join(ROOT, 'hooks/useBoardMeta.ts'), 'utf8');
  const at = src.indexOf('catch (e: unknown)');
  const end = src.indexOf('catch (e: unknown)', at + 1);
  assert.ok(at >= 0 && end < 0, '应只有一处 catch（在 apply 的写队列里）');
  assert.ok(
    /setBoth\(baseRef\.current\)/.test(src),
    '失败要退回 baseRef（已落盘的那份）',
  );
});

/* ------------------------------------------------------------------ */
/* 判据必须复用同一份，不另抄                                          */
/* ------------------------------------------------------------------ */

/*
 * 源码不在测试目录里，靠 AF_SRC 指过去；没设就跳过 ——
 * 否则在没带源码的环境里跑，每条都因"读不到文件"而红，那是假失败。
 */
const ROOT = process.env.AF_SRC || '';

test('boardmeta 复用任务板那一份"坏没坏"判据，不另写一份', () => {
  if (!ROOT) return;
  const src = fs.readFileSync(pathmod.join(ROOT, 'engine/boardMetaFile.ts'), 'utf8');
  assert.ok(
    /isParseableJson/.test(src),
    'boardMetaFile 必须用 isParseableJson 判"文件坏没坏"',
  );
  /*
   * 只查"用了"还不够 —— 自己抄一份实现也叫用了。
   * 必须是从定义处（taskBoardFile）引过来的。
   */
  assert.ok(
    /import\s*\{[^}]*isParseableJson[^}]*\}\s*from\s*'\.\/taskBoardFile'/.test(src)
      || /from\s*'\.\/attachmentFile'/.test(src),
    '判据必须来自 taskBoardFile（定义处），不能在本文件另写一份',
  );
  // 本文件里不许出现"自己判断能不能解析"的写法
  assert.ok(
    !/function\s+isParseableJson/.test(src),
    'boardMetaFile 里出现了 isParseableJson 的定义 —— 那是第三份实现',
  );
});
