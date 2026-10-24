/**
 * 守卫：改名 / 删除 / 还原之后，前端不得再拿旧路径去发请求。
 *
 * 【它要钉住的 bug】
 * 卡片改完名，卡片的 data-path 更新了，但目录树节点里的 `files` 还留着旧路径
 * （`refreshBox` 只在 leaf 命中时才同步，而 leaf 是按「CUR.path 往下找」定位的，
 *   选中的是子目录、卡片在父目录那一框时就找不到）。
 * 于是第二次点同一张卡的「改名」，发出去的是旧路径，后端按 path 查 map.json
 * 查不到 → "文件不在扫描结果里"。文件明明在，只是路径过期了。
 *
 * 同一类坑还有目录框缓存 CACHE：键就是路径，改名后旧键还能命中，
 * 复用旧框就渲染出第二张带旧 data-path 的卡。
 *
 * 断言按"源码字面"钉，不跑运行时 —— 这个插件的 index.html 是内联脚本，
 * 起 jsdom 的成本远高于收益。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'index.html'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, why) => {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${why ? ' —— ' + why : ''}`);
  }
};

/* ---- 1. 后端：改名必须能认出过期路径 ---- */
{
  const rs = readFileSync(
    join(here, '../../src-tauri/src/dupview/mod.rs'),
    'utf8',
  );
  const body = (() => {
    const i = rs.indexOf('pub fn dupview_rename');
    return i < 0 ? '' : rs.slice(i, i + 2600);
  })();
  ok('dupview_rename 存在', body.length > 0);
  /* 只按 path 查 = 旧实现；改名后 map 里是 path 的函数，必然查不到 */
  ok(
    '改名不依赖"传进来的 path 必须在 map 里"',
    /position\(\|x\|\s*x\.path\s*==\s*path\)/.test(body),
    '应当先按 path 定位、失败再回退',
  );
  ok(
    '改名有 idx / 同名 兜底',
    /x\.idx\s*==\s*now/.test(body) && /x\.name\.starts_with/.test(body),
    '过期路径要能靠 idx 或同名反查到条目',
  );
  ok(
    '改名以磁盘/条目记录为准，不信过期入参',
    /Path::new\(&path\)\.exists\(\)/.test(body),
    '存在性检查后要用条目里记的真实路径',
  );
}

/* ---- 2. 前端：路径一变，以它为键的缓存要一起作废 ---- */
{
  ok(
    'CACHE 键统一走 boxKey（不再散落 path+"|" 拼接）',
    /function boxKey\(/.test(src) && /ensureBox[\s\S]{0,200}boxKey\(leaf\.path/.test(src),
  );
  ok(
    '存在"按旧路径清缓存"的函数',
    /function dropPaths\(/.test(src),
  );
  ok(
    'dropPaths 同时清目录框缓存与逐页图缓存',
    /delete CACHE\[k\]/.test(src) && /delete PAGE_CACHE\[k\]/.test(src),
    '只清一个，另一个仍会带着旧路径渲染',
  );
  {
    /* 不再用固定字符窗口（ren() 变长就会假红）：取函数起点往后的一段正文再找 */
    const at = src.indexOf('async function ren(');
    const body2 = at >= 0 ? src.slice(at, at + 3000) : '';
    ok(
      '改名成功后调用了 dropPaths',
      at >= 0 && /dropPaths\(\[path\]\)/.test(body2),
      'ren() 里必须作废旧路径的缓存',
    );
  }
}

/* ---- 3. refreshBox 定位 leaf 不能只从 CUR.path 往下找 ---- */
{
  const fn = (() => {
    const i = src.indexOf('function refreshBox(');
    return i < 0 ? '' : src.slice(i, i + 700);
  })();
  ok('refreshBox 存在', fn.length > 0);
  ok(
    'refreshBox 不再依赖 CUR.path 找 leaf',
    !/CUR\.path[\s\S]{0,120}findNode/.test(fn) && /boxLeaf\(box\)/.test(fn),
    '从 CUR.path 往下找，遇到"选中子目录、卡片在父目录"就找不到 leaf → files 不同步',
  );
  ok(
    'boxLeaf 全树查找',
    /function boxLeaf\([\s\S]{0,400}\)\(DATA\)/.test(src),
  );
}

/* ---- 4. 批量改名：索引里找不到条目不得静默 ---- */
{
  const rs = readFileSync(
    join(here, '../../src-tauri/src/dupview/mod.rs'),
    'utf8',
  );
  const body = (() => {
    const i = rs.indexOf('pub fn dupview_rename_all');
    return i < 0 ? '' : rs.slice(i, i + 7000);
  })();
  ok('dupview_rename_all 存在', body.length > 0);
  /* 只按 idx 找 = 旧实现。计划与索引不同步时必然找不到 → 静默跳过 →
     磁盘改了名、界面还显示旧名 */
  ok(
    '批量改名按 idx 找不到时还会按旧路径再找一次',
    /position\(\|x\|\s*x\.idx\s*==\s*a\.old_idx\)[\s\S]{0,200}position\(\|x\|\s*x\.path\s*==\s*old_path\)/.test(
      body,
    ),
  );
  ok(
    '两条路都找不到时会记账报错，不静默',
    /None\s*=>\s*errs\.push/.test(body),
    '静默跳过的后果是用户以为改成功了、界面却永远是旧名',
  );
  ok(
    '报错提示里指明要重新扫描',
    /请重新扫描/.test(body),
  );
}

/* ---- 5. 扫描落盘顺序：索引先于计划 ---- */
{
  const sc = readFileSync(
    join(here, '../../src-tauri/src/dupview/scan.rs'),
    'utf8',
  );
  /* 旧实现：refresh_plan（内含写计划）在 write_json(map) 之前。
     中途失败 → 计划新、索引旧 → 下一轮改名改磁盘却在索引里找不到条目。 */
  ok(
    '扫描先把 fam 算好但不落盘',
    /refresh_plan_parts/.test(sc),
  );
  const iMap = sc.indexOf('write_json(&dir.join(MAP_FILE)');
  const iPlan = sc.indexOf('plan_path(&dir)');
  ok(
    '索引先落盘、计划后落盘',
    iMap > 0 && iPlan > iMap,
    '顺序反了会留下"计划新、索引旧"的半截状态',
  );
}

/* ---- 6. 删除 / 还原 也要同步目录树里的 dim ---- */
ok(
  '删除同步目录树的 dim',
  /function setItemDim\(/.test(src) && /async function del\([\s\S]{0,900}setItemDim\(path,\s*true\)/.test(src),
  '不同步的话下一次操作会带着过期状态',
);
ok(
  '还原同步目录树的 dim',
  /async function restore\([\s\S]{0,500}setItemDim\(path,\s*false\)/.test(src),
);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
