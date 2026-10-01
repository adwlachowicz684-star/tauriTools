/**
 * 「跨栏移动」目标页签越界必须报错，不能静默回落到最后一个页签（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/move-across-tab-test.mjs
 *
 * `sys::insert_card_into_tab` 此前是：
 *
 *     let i = tab_index.min(tabs.len() - 1);
 *
 * 越界 → 静默落到**最后一个**页签。而同一份代码里 `fpx_remove_card` 对
 * 越界的处理是明确报错，注释还白纸黑字写着「越界必须报错，不能 `if let`
 * 静默跳过……同类操作一个报错一个静默，静默那个迟早变成查不出来的问题」。
 * 这里正是那个"静默的那个"。
 *
 * 后果（跨栏移动 / 跨栏拖放 / 右键「转为项目组」三条入口共用）：
 *
 *   卡片被登记到目标栏**另一个**页签里，而前端照常记一句「已转为项目组」
 *   —— 卡片在用户眼前等于"消失了"。他只会以为按钮没反应或功能坏了，
 *   无从把它归到"页签下标不对"。
 *
 * 越界输入不是理论情况：App.tsx 的 `activeTab` 与当前快照可能不同步，
 * cycleTab 那处的注释已写明"索引先 clamp"，说明这事实际发生过；而
 * `activeTab` 正是这三条入口传进来的那个下标。
 *
 * 两道闸，缺一不可：
 *
 *   1) `insert_card_into_tab` 本身返回 Result，越界即 Err（函数契约正确）
 *   2) `fpx_move_card_across` 在 **relocate_cross_move 之前**先校验
 *
 * 第 2 条尤其不能省：`relocate_cross_move` 会真把文件夹搬到另一栏目录下。
 * 它成功了、插页签才失败时，`with_config` 的语义是"闭包返回 Err 就不落盘"
 * ——config 里仍记着旧路径，而磁盘上的文件夹已经搬走了。卡片于是彻底
 * 消失，连"搬到哪去了"的线索都不留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'sys.rs');
const MOD = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'mod.rs');
const { t, done } = makeT();

const sysSrc = fs.readFileSync(SYS, 'utf8');
const modSrc = fs.readFileSync(MOD, 'utf8');
/** 只看真代码：修复注释里就写着 tab_index.min(tabs.len() - 1)，不剥会误报。 */
const SYS_CODE = sysSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const MOD_CODE = modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 按大括号配平切出一段（避免切到别处 / 切到文件末尾） */
function sliceBlock(src, anchor) {
  const i = src.indexOf(anchor);
  if (i === -1) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

console.log('=== 1. insert_card_into_tab 的函数契约 ===');
const FN_BLK = sliceBlock(SYS_CODE, 'pub fn insert_card_into_tab');
{
  t('切到的确实是 insert_card_into_tab（不是别处）',
    FN_BLK.length > 0 && FN_BLK.includes('fn insert_card_into_tab'),
    FN_BLK.slice(0, 80));

  /* 返回 Result 才是"越界能报错"的前提；仍返回 () 就等于没改。
     只判签名，不判函数体里有没有 Err —— 后者会被别处的 Err 喂饱。 */
  t('返回 Result（越界能报错）', /->\s*Result<\(\),\s*String>/.test(FN_BLK));

  /* 旧写法：静默回落到最后一个页签。必须整段消失。 */
  t('不再有 tab_index.min(tabs.len() - 1) 静默回落',
    !/tab_index\.min\(\s*tabs\.len\(\)\s*-\s*1\s*\)/.test(FN_BLK));
  t('不再有 let i = tab_index.min', !/let\s+i\s*=\s*tab_index\.min/.test(FN_BLK));

  /* get_mut + ok_or_else：越界 → Err，而不是越界 → 换一个下标 */
  t('用 get_mut(tab_index) 取页签', /tabs\.get_mut\(\s*tab_index\s*\)/.test(FN_BLK));
  t('取不到时 ok_or_else 报越界', /ok_or_else\(\s*\|\|\s*format!\(/.test(FN_BLK));

  /* 空栏自动补「默认」页签这条正常语义不能因为改签名就丢了 */
  t('页签为空时仍自动补「默认」页签',
    /tabs\.is_empty\(\)\s*\{\s*tabs\.push\(\s*TabItem\s*\{\s*name:\s*"默认"/.test(FN_BLK));

  /* to_index 仍要夹取：插到末尾（usize::MAX）是正常调用，不是越界 */
  t('to_index 仍夹取（末位插入不受影响）',
    /to_index\.min\(/.test(FN_BLK));
}

console.log('=== 2. fpx_move_card_across 必须在搬家之前校验 ===');
const MV_BLK = sliceBlock(MOD_CODE, 'pub fn fpx_move_card_across');
{
  t('切到的确实是 fpx_move_card_across',
    MV_BLK.length > 0 && MV_BLK.includes('fn fpx_move_card_across'),
    MV_BLK.slice(0, 80));

  const A_VALIDATE = MV_BLK.indexOf('目标页签下标');
  const A_MOVE = MV_BLK.indexOf('relocate_cross_move');
  const A_INSERT = MV_BLK.indexOf('insert_card_into_tab');

  /* 顺序断言两端都要先判存在 —— 任一端为 -1 时 -1 < 正数 恒真，断言空跑 */
  t('校验存在', A_VALIDATE !== -1);
  t('物理搬家那一步存在', A_MOVE !== -1);
  t('插页签那一步存在', A_INSERT !== -1);
  t('校验在物理搬家之前（搬走了才失败会丢数据）',
    A_VALIDATE !== -1 && A_MOVE !== -1 && A_VALIDATE < A_MOVE,
    `validate=${A_VALIDATE} move=${A_MOVE}`);
  t('校验在插页签之前',
    A_VALIDATE !== -1 && A_INSERT !== -1 && A_VALIDATE < A_INSERT);

  /* 判据必须按 len().max(1)：按 len() 判会把"移到空栏"这条正常路径也拦掉
     —— 空栏时 insert_card_into_tab 会补一个「默认」页签，0 是有效的。 */
  t('判据按 len().max(1)（空栏时不误拦）', /n\.max\(1\)/.test(MV_BLK));
  t('不再有裸 len() 比较', !/if\s+idx\s*>=\s*n\b/.test(MV_BLK.replace(/n\.max\(1\)/g, '')));
}

console.log('=== 3. 两处调用都要接住 Err（漏一处就是静默） ===');
{
  /* 吃到分号为止再判尾字符：只用 `[^;]*\)` 会在最后一个 `)` 处截断，
     而 `?` 在 `)` 之后 —— 那样一条都匹配不到问号，断言恒假。 */
  const calls = (MOD_CODE.match(/insert_card_into_tab\([^;]*/g) || [])
    .map((c) => c.trim().replace(/;$/, ''));
  t('调用点共 2 处（project 分支与 group 分支）', calls.length === 2,
    `实际 ${calls.length} 处`);
  t('两处都以 ? 接住 Err', calls.filter((c) => c.endsWith('?')).length === 2,
    calls.map((c) => c.slice(-30)).join(' | '));

  /* 旧签名返回 ()，那时不需要 ?；改成 Result 后不写 ? 会被编译器警告
     must_use 吗？—— Result 是 #[must_use]，会 warning 但不报错。
     所以这条必须钉死，不能指望编译器。 */
}

console.log('=== 4. 兜底：全仓没有其他漏网的调用点 ===');
{
  /* 直接存剥注释后的那一行文本，不存行号再回头读原文 —— 剥注释会删掉整段
     块注释，剥完的行号与原文对不上，回头读会读到完全无关的那一行。 */
  const all = [];
  for (const f of ['mod.rs', 'sys.rs', 'store.rs', 'mcp.rs', 'junction.rs', 'cli.rs', 'backup.rs']) {
    const p = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', f);
    if (!fs.existsSync(p)) continue;
    const code = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    code.split('\n').forEach((line) => {
      if (line.includes('insert_card_into_tab') && !line.includes('pub fn')) {
        all.push({ f, line: line.trim().replace(/;$/, '') });
      }
    });
  }
  const withQ = all.filter((x) => x.line.endsWith('?'));
  t('全部调用点都带 ?', all.length > 0 && withQ.length === all.length,
    `带 ? ${withQ.length} / 共 ${all.length}`);
}

done();
