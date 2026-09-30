/**
 * MCP「布尔 / 整数参数」类型不符必须报错，不能静默按默认走（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-typed-args-test.mjs
 *
 * tools/list 里这些参数标了 `"type": "boolean"` / `"integer"`，
 * 但 AI 客户端（尤其模型手写的 arguments）常写成 `"true"` / `"2"` / `2.0`。
 * 此前统一用 `and_then(|v| v.as_bool()).unwrap_or(默认)`：类型不符 → None
 * → **静默按默认走**，命令照常返回成功。
 *
 * 后果按严重度排：
 *
 *   · `denyDelete: "true"` → false → 保护**没设上**。更糟的是三个 false
 *     会落到 note 的 else 分支，回包写成「已解除全部 ACL 保护并退出
 *     账面固定」—— 用户要求上锁，回包却说已解锁，全程无报错。
 *
 *   · `appendOnly: "false"` → true → 想做镜像同步（含删除）却只做了新增，
 *     备份目录里多出一堆源里早已删掉的旧文件，而回包说"完成"。
 *
 *   · `tab_index: "1"` → None → 当"没传"，登记到**自动选的页签**，
 *     不是调用方指定的那个。
 *
 *   · `x: 1920.0` → None → **静默回退成跟随鼠标**。于是回包给出的是
 *     鼠标处那个点的颜色，而 AI 会当成 (1920,1080) 的颜色报给用户。
 *     这正是 coord 那条注释写明"必须报错"的场景，换条路绕过去了。
 *
 * 共同点：**调用方明说了，却被当成没说**，且默认值的方向决定了后果大小
 * —— 默认值恰好是"更安全的一侧"时看不出来，反过来就是静默做错事。
 *
 * 判据：没传（或显式 null）才用默认值；传了但类型不对一律报错。
 * 报错好过静默 —— 前者调用方能立刻改对，后者会一直错下去还不知道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_PATH = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx', 'mcp.rs');
const { t, done } = makeT();

const MCP = fs.readFileSync(MCP_PATH, 'utf8');
/** 只看真代码：本文件的修复注释里就写着 and_then(|v| v.as_bool())，不剥会误报。 */
const CODE = MCP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 按大括号配平切出一段（避免切到别处 / 切到文件末尾） */
function sliceBlock(src, anchor, open = '{') {
  const i = src.indexOf(anchor);
  if (i === -1) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === open) { depth++; started = true; }
    else if (c === (open === '{' ? '}' : ')')) {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

console.log('=== 1. 两个取值助手确实存在 ===');
const B_BLK = sliceBlock(CODE, 'let b = |k: &str');
const U_BLK = sliceBlock(CODE, 'let u = |k: &str');
{
  t('b() 存在（布尔参数统一入口）', B_BLK.length > 0, B_BLK.slice(0, 120));
  t('u() 存在（非负整数统一入口）', U_BLK.length > 0, U_BLK.slice(0, 120));

  /* 三分支缺一不可：缺"类型不符 → Err"就等于没修（回到静默按默认走） */
  t('b() 没传/显式 null 用默认值', /None \| Some\(Value::Null\) => Ok\(dflt\)/.test(B_BLK));
  t('b() 真布尔取到值', /Some\(Value::Bool\(v\)\) => Ok\(\*v\)/.test(B_BLK));
  t('b() 类型不符 → Err（不是静默回默认）', /Some\(v\) => Err\(err\(/.test(B_BLK));

  t('u() 没传/显式 null → None', /None \| Some\(Value::Null\) => Ok\(None\)/.test(U_BLK));
  t('u() 非负整数取到值', /Some\(n\) => Ok\(Some\(n\)\)/.test(U_BLK));
  t('u() 类型不符 → Err（不能静默当"没传"）', /None => Err\(err\(/.test(U_BLK));
  t('u() 用 as_u64（负数会被挡掉）',
    /as_u64/.test(U_BLK) && !/as_i64/.test(U_BLK));
}

console.log('\n=== 2. coord：传了但解析不出必须报错，不能回退跟随鼠标 ===');
const COORD = sliceBlock(CODE, 'let coord = |k: &str');
{
  t('coord 存在', COORD.length > 0, COORD.slice(0, 120));
  t('不传 → Ok(None)（跟随鼠标仍是合法路径）',
    /None \| Some\(Value::Null\) => Ok\(None\)/.test(COORD));
  t('解析不出 → Err（不再静默跟随鼠标）',
    /None => Err\(err\(/.test(COORD));
  t('Err 文案提示"不传则跟随鼠标"（给出可走的路）',
    /不传则跟随鼠标/.test(COORD));
  t('整数取到后仍挡超范围', /i32::try_from/.test(COORD));
}

console.log('\n=== 3. schema 声明 ↔ 运行时取值：逐个对照（兜底扫描）===');
{
  /* 从 tools/list 里解析出所有 boolean / integer 参数。
     顺序不能反：先看 schema 声明了什么，再查运行时有没有接住 ——
     反过来（只看运行时用了哪些）新增参数忘了校验就扫不到。 */
  const decl = [...MCP.matchAll(/"(\w+)":\s*\{\s*"type":\s*"(boolean|integer)"/g)]
    .map((m) => ({ name: m[1], type: m[2] }));
  const bools = [...new Set(decl.filter((d) => d.type === 'boolean').map((d) => d.name))];
  const ints = [...new Set(decl.filter((d) => d.type === 'integer').map((d) => d.name))];

  t('扫到了 boolean 参数（至少 5 个）', bools.length >= 5, bools.join(','));
  t('扫到了 integer 参数（至少 3 个）', ints.length >= 3, ints.join(','));
  t('boolean 含 appendOnly（默认 true，方向与安全相反）',
    bools.includes('appendOnly'));

  for (const n of bools) {
    t(`boolean「${n}」走 b()（类型不符会报错）`,
      new RegExp(`b\\("${n}"`).test(CODE));
  }
  for (const n of ints) {
    const reads = (CODE.match(new RegExp(`u\\("${n}"\\)|coord\\("${n}"\\)`, 'g')) || []).length;
    const declares = decl.filter((d) => d.name === n).length;
    /* 按**声明条数**比，不能只判"存在"：tab_index 在两个工具里各声明一次，
       只判存在的话撤掉其中一处照样通过 —— 而漏的那一处正是静默回退的口子。 */
    t(`integer「${n}」每处声明都有校验（${reads}/${declares}）`,
      reads >= declares && declares > 0, `声明 ${declares}、读取 ${reads}`);
  }

  /* 分支级：两个工具各自都要接住，不能只靠"全文件里出现过" */
  const cfBlk = sliceBlock(CODE, '"create_folder" => {');
  const acBlk = sliceBlock(CODE, '"add_card" => {');
  t('create_folder 分支里用 u() 取 tab_index', cfBlk !== '' && /u\("tab_index"\)/.test(cfBlk));
  t('add_card 分支里用 u() 取 tab_index', acBlk !== '' && /u\("tab_index"\)/.test(acBlk));
}

console.log('\n=== 4. 不再有"类型不符 → 静默按默认走"的裸提取 ===');
{
  /* 这三行是本轮要消灭的形状：and_then 拿到 None 就用 unwrap_or 兜住 */
  t('没有裸 as_bool 提取', !/and_then\(\|v\| v\.as_bool\(\)\)/.test(CODE));
  t('没有裸 as_u64 提取', !/and_then\(\|v\| v\.as_u64\(\)\)/.test(CODE));
  t('没有裸 as_i64 提取', !/and_then\(\|v\| v\.as_i64\(\)\)/.test(CODE));
  t('没有 unwrap_or 兜布尔默认', !/as_bool\(\)\)\.unwrap_or/.test(CODE));
  t('没有 unwrap_or 兜整数默认', !/as_u64\(\)\)\.unwrap_or/.test(CODE));
}

console.log('\n=== 5. 默认值方向没被改动（不能顺手改语义）===');
{
  t('appendOnly 默认仍是 true（安全侧）', /b\("appendOnly", true\)/.test(CODE));
  t('set_lock 四个开关默认仍 false（老调用方行为不变）',
    /b\("denyDelete", false\)/.test(CODE)
    && /b\("denyWrite", false\)/.test(CODE)
    && /b\("accountOnly", false\)/.test(CODE)
    && /b\("remove", false\)/.test(CODE));
  t('tab_index 仍可选（没传不报错）',
    (CODE.match(/u\("tab_index"\)\?/g) || []).length === 2);
}

console.log('\n=== 6. 助手定义在取参之前（作用域）===');
{
  /* 顺序比较必须**两端都先判存在**：删掉任一端时 indexOf 返回 -1，
     -1 < 正数 恒真 → 断言空跑（这类假绿在这个项目里踩过很多次）。 */
  const iB = CODE.indexOf('let b = |k: &str');
  const iU = CODE.indexOf('let u = |k: &str');
  const iOut = CODE.indexOf('let out = match name');
  const iPatch = CODE.indexOf('as_object_mut');
  t('顺序比较的四个锚点都存在', iB !== -1 && iU !== -1 && iOut !== -1 && iPatch !== -1,
    `${iB},${iU},${iOut},${iPatch}`);
  t('b/u 定义在 let out = match name 之前', iB < iOut && iU < iOut);
  t('b/u 定义在别名补参之后（不会读到补进去的值之前的状态）',
    iB > iPatch && iU > iPatch);
}

done();
