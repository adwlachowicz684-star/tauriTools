/**
 * 备份「镜像删除」的前置条件回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/backup-mirror-guard-test.mjs
 *
 * 守的是一件事：**源目录枚举不完整时，绝不能做镜像删除。**
 *
 * 镜像删除的判据是"备份目录里有、而 src_files 里没有的相对路径 = 源里已删掉"。
 * 这个判据只有在 src_files 覆盖了源目录**全部**文件时才成立。
 *
 * 而 collect_source 对枚举失败是"记一条错误然后继续"（权限不足、Windows 上文件
 * 被占用、目录回路都走这条），此时 src_files 是残缺的 —— 那些没枚举到的文件在
 * 镜像判据里与"源里已删掉"**完全无法区分**，于是会被从备份里删掉。
 *
 * 后果比报错严重得多：源还在，但备份里那一份没了。而备份存在的唯一意义就是
 * "源出事时还有一份"。用户看到的只是上面几条枚举失败 + 一个 deleted_files 计数，
 * 两者看起来毫无关系。
 *
 * 为什么是结构性断言而不是"跑一遍 Rust"：
 *   沙箱里 cargo 编译整个 tauri 工程跑不动。所以这里钉的是**代码结构**：
 *   不完整标记必须在 collect_source 之前取、跳过必须在镜像删除循环之前发生。
 *   判据一律**剥注释后再匹配** —— 否则把真实代码删掉、只留说明注释，断言照样通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripComments as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const SRC = fs.readFileSync(
  path.join(HERE, '../../src-tauri/src/fpx/backup.rs'), 'utf8');

/** 剥掉行注释与块注释，只留代码（字符串里的 // 不动，本文件不靠字符串判据） */
function stripComments(s) {
  return strip(s).replace(/^\s*\/\/.*$/gm, '');
}
const code = stripComments(SRC);

console.log('\n=== 1. 枚举完整性要在 collect_source 之前取基线 ===');
{
  const iBase = code.indexOf('let errs_before = r.errors.len()');
  /* 必须找**调用点**而不是定义：函数定义 `fn collect_source(` 在文件里更靠前，
     拿它当锚点的话"基线取在调用之前"这条会恒假，看着像没写基线。 */
  const iCollect = code.indexOf('collect_source(src_root,');
  t('有 errs_before 基线', iBase >= 0);
  t('有 collect_source 调用', iCollect >= 0);
  t('基线取在 collect_source 之前', iBase >= 0 && iCollect >= 0 && iBase < iCollect,
    `base=${iBase} collect=${iCollect}`);

  const iIncomplete = code.indexOf('let incomplete = ');
  t('有 incomplete 标记', iIncomplete >= 0);
  t('incomplete 在 collect_source 之后判定',
    iIncomplete >= 0 && iCollect >= 0 && iIncomplete > iCollect,
    `collect=${iCollect} incomplete=${iIncomplete}`);
  /* 反面证据：不能是永远为假的常量 */
  t('incomplete 由错误数变化算出（不是写死 false）',
    /let incomplete = r\.errors\.len\(\) > errs_before;/.test(code));
}

console.log('\n=== 2. 跳过发生在镜像删除之前 ===');
{
  const iAppend = code.indexOf('if append_only');
  const iSkip = code.indexOf('if incomplete');
  /* 锚点必须用**代码**而不是那句 `// 2) 镜像删除` 注释：剥注释后注释已经没了，
     用注释当锚点会得到 -1，于是"顺序"那条恒假（第 N 次踩同一个坑）。
     镜像删除那一步的代码特征就是遍历目标目录删多余文件。 */
  const iMirror = code.indexOf('for p in walk(dst_root, true)');

  t('有 append_only 早退', iAppend >= 0);
  t('有 incomplete 跳过', iSkip >= 0);
  t('有镜像删除那一步', iMirror >= 0);

  t('顺序：append_only → incomplete 跳过 → 镜像删除',
    iAppend >= 0 && iSkip >= 0 && iMirror >= 0 && iAppend < iSkip && iSkip < iMirror,
    `append=${iAppend} skip=${iSkip} mirror=${iMirror}`);

  /* 跳过分支里必须真的 return，否则只是加了个空判断 */
  const block = code.slice(iSkip, iMirror);
  t('跳过分支里有 return', /return Ok\(\(\)\);/.test(block));
  /* 必须说出来，不能静默跳过 —— 静默的话用户以为备份清理过了 */
  t('跳过分支里会记一条错误', /r\.errors\.push\(/.test(block));
  t('记的是"[跳过]"，与"[失败]"区分开',
    /\[跳过\]/.test(block) && /镜像删除/.test(block));

  /* 反面证据：镜像删除那一步本身不能被删掉（功能是需要的，只是要加前置条件） */
  t('镜像删除步骤仍在（不是靠删功能来"修"）',
    /for p in walk\(dst_root, true\)/.test(code));
}

console.log('\n=== 3. 注释里说明的判据与代码一致 ===');
{
  /* 上一轮修过一类问题：注释承诺代码没做的事。这里反过来核一次：
     注释说"枚举失败会记错误然后继续"，代码里 collect_source 必须真是这样。 */
  const iFn = code.indexOf('fn collect_source(');
  const fnBody = code.slice(iFn, iFn + 2600);
  t('collect_source 枚举失败时记错误', /r\.errors\.push\([^)]*枚举/.test(fnBody));
  t('collect_source 枚举失败后继续（不是直接 return Err 整棵树）',
    /Err\(e\) => \{ r\.errors\.push\([\s\S]{0,120}?return; \}/.test(fnBody));
}

done();
