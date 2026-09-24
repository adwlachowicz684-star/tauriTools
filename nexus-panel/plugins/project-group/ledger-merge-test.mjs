/**
 * 账本并入（#202）· deploy_skill renamed（#94）· 工具开关两列（#131）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/ledger-merge-test.mjs
 *
 * 这三项都是"核对后发现有问题"而修的，不是从零实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));
/* 上两级才是 nexus-panel：Rust 源码不在插件目录里 */
const RS = (rel) => strip(fs.readFileSync(path.join(HERE, '../..', rel), 'utf8'));

const mod = RS('src-tauri/src/fpx/mod.rs');
const mcp = RS('src-tauri/src/fpx/mcp.rs');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. #202 新建链接名必须**并入**，不能覆盖 ===');
{
  /*
   * 覆盖会丢掉之前已建、且磁盘上仍然存在的链接 ——
   * junction 还在，账本里却查不到，界面显示"未链接"，且没有任何报错。
   * 首次建链时原清单为空，两种写法结果相同，所以只在补充建链时暴露。
   */
  t('有 merge_link_names', /pub\(crate\) fn merge_link_names\(/.test(mod));
  t('已有记录走并入', /merge_link_names\(&mut r\.names, names\);/.test(mod));
  t('新记录也走并入（去重）', /let mut acc: Vec<String> = Vec::new\(\);/.test(mod)
    && /merge_link_names\(&mut acc, names\);/.test(mod));
  t('不再整份覆盖', !/^\s*r\.names = names;\s*$/m.test(mod));
}

console.log('\n=== 2. 去重要大小写不敏感 ===');
{
  /* Windows 下 .OpenCode 与 .opencode 是同一个目录，精确比较会漏掉真重名 */
  /*
   * 必须**限定在 merge_link_names 块内**断言：文件里另一处（跨盘判定）
   * 也用了同一个方法，全文匹配的话"把这里改成精确比较"仍会命中那一处，
   * 断言形同虚设（反向验证时才发现）。
   */
  const i = mod.indexOf('pub(crate) fn merge_link_names');
  const blk = mod.slice(i, mod.indexOf('\n}', i));
  t('用 eq_ignore_ascii_case', /eq_ignore_ascii_case/.test(blk));
  t('重复才跳过', /if !dup \{/.test(mod));
}

console.log('\n=== 3. #94 deploy_skill 同名避让 + renamed 标志 ===');
{
  /* 避让：同名就加 2、3… 后缀 */
  t('有避让循环', /while p\.exists\(\) \{/.test(mcp));
  t('后缀递增', /n = format!\("\{base_name\}\{i\}"\);/.test(mcp));
  /* renamed：调用方推不准（名字经 sanitize_name 清洗过） */
  t('返回四元组', /Result<\(String, String, String, bool\), String>/.test(mcp));
  t('renamed 由比较得出', /let renamed = final_name != base_name;/.test(mcp));
  t('返回里带 renamed', /"renamed": r\.3,/.test(mcp));
}

console.log('\n=== 4. #131 MCP 工具开关两列 ===');
{
  const seg = css.slice(css.indexOf('.fpx-toollist {'));
  const b = seg.slice(0, seg.indexOf('/* min-width'));
  t('用 grid', /display: grid;/.test(b));
  t('auto-fill + 最小宽（窄屏退回单列）', /grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\);/.test(b));
  /* 硬分两列的话窄屏每项只剩半宽，等宽工具名会被截断到看不清 */
  t('不是写死两列', !/repeat\(2,/.test(b));
  /* grid 项默认 min-width:auto，长名会把轨道撑开，两列变一列半 */
  t('子项 min-width:0', /\.fpx-toollist \.fpx-check \{[^}]*min-width: 0;/.test(css));
}

console.log('\n=== 5. #86 编辑器「跟随系统」选项 ===');
{
  const tools = R('components/ToolsPanel.tsx');
  /*
   * 后端早已支持（editToolPath 为空 → open_default），缺的只是**入口** ——
   * 没有它，用户一旦选过编辑器就退不回去（只能手工清配置），
   * 等于这个能力不存在。
   */
  t('有跟随系统项', /跟随系统/.test(tools));
  /* 必须是可点的一项，而不是"清空"按钮：用户要看到当前处于哪种状态 */
  t('是列表里的一项', /className=\{`fpx-editoritem\$\{!config\.editToolPath \? ' active' : ''\}`\}/.test(tools));
  t('选中态按"未设置"判定', /!config\.editToolPath \? ' active' : ''/.test(tools));
  /*
   * 空串要走后端存 None，本地草稿也必须传 null 而不是 '' ——
   * 否则 active 判定（!editToolPath）会判成"没跟随系统"，显示与配置不一致。
   */
  t('本地草稿传 null', /onSaved\(\{ editToolPath: exe \|\| null \}\)/.test(tools));
  t('日志区分两种情况', /exe \? `已设置编辑器：\$\{exe\}` : '已改为跟随系统/.test(tools));
}

console.log('\n=== 6. #165 色值非法要在**写入时**挡住 ===');
{
  t('有校验函数', /pub\(crate\) fn is_hex_color\(c: &str\) -> bool/.test(mod));
  t('校验 3 位与 6 位', /hex\.len\(\) == 3 \|\| hex\.len\(\) == 6/.test(mod));
  t('必须是十六进制', /hex\.iter\(\)\.all\(\|x\| x\.is_ascii_hexdigit\(\)\)/.test(mod));
  t('必须以 # 开头', /if b\.first\(\) != Some\(&b'#'\) \{ return false; \}/.test(mod));
  t('写入前校验', /if !is_hex_color\(&c\) \{/.test(mod));
  t('非法直接报错', /return Err\(format!\("非法色值/.test(mod));
  /* 读时不校验：存量配置里可能已有非法值，拒读会让现有颜色也显示不出来 */
  t('读取路径未加校验', !/fn core_set_tag_color[\s\S]{0,400}?load_config[\s\S]{0,200}?is_hex_color/.test(mod));
}

console.log('\n=== 4. 账本两种历史形态都要认（#452 相关，原版 LoadStrict 明写）★★ ===');
{
  /*
   * 原版 `LinkRecordService.LoadStrict` 明写：
   *   「兼容 {clusters,links} 对象 或 **裸数组** 两种历史格式」
   *
   * 本版此前只认 `{links:[...]}` 对象形态。用**更早版本原版工具**写出来的
   * 裸数组账本会被判成"损坏"：文件完好、数据一条不少，但工具报
   * 「JSON 解析失败」并顺带**拦住全部写入**（guard_against_corrupt）。
   *
   * 用户看到的只是"账本坏了"，而真相是"我们不认这个格式" ——
   * 报错完全指向不了原因，他也无从知道该手动改什么。
   */
  const store = RS('src-tauri/src/fpx/store.rs');

  /* 一、两种形态都要在类型里 */
  t('有 RecordFile 双形态类型', /enum RecordFile/.test(store));
  /* untagged 是关键：不带它的话 serde 会按"带标签的枚举"去解析，
     两种形态都匹配不上。 */
  t('用 untagged（否则两种形态都匹配不上）', /#\[serde\(untagged\)\]/.test(store));
  t('有对象形态变体（links）', /Object \{[\s\S]{0,120}links: Vec<LinkRecord>/.test(store));
  t('有裸数组形态变体', /Array\(Vec<LinkRecord>\)/.test(store));

  /* 二、两个读取入口都要换成它（漏一处 = 从那个入口读仍是"损坏"） */
  t('load_records_strict 用它',
    /load_strict::<RecordFile>\(&dir\.join\("link-record\.json"\)\)/.test(store));
  t('load_records 用它',
    (store.match(/load_strict::<RecordFile>/g) || []).length >= 2,
    '命中 ' + (store.match(/load_strict::<RecordFile>/g) || []).length + ' 处');
  t('load_records_from_exact 也用它',
    /read_json_any::<RecordFile>\(path\)/.test(store));

  /* 三、**反面证据**：不允许再有只认 links 的局部 struct */
  t('没有残留的局部 File 结构体（反面证据）',
    !/struct File \{[\s\S]{0,120}links: Vec<LinkRecord>/.test(store));

  /* 四、写入仍然只写对象形态（不写裸数组） */
  t('save_records 仍写对象形态',
    /struct File<'a> \{ links: &'a \[LinkRecord\] \}/.test(store));
  /*
   * 不写 `clusters`：原版 `LinkRecordFile.Clusters` 是 `List<object>`，
   * 从头到尾**从未被填充**，只是历史遗留的占位键；
   * 每条记录的 `Cluster` 也是建链时写死 `""`、**全库无任何读取**。
   * 照搬只会把一个死字段搬过来（判 ➖）。
   */
  /*
   * 这条**第一版误匹配了自己的注释**：RS() 只剥块注释（slash-star 那种），
   * 不剥 `///` 文档注释，而上面那段说明里就写了 {clusters,links}
   * → 断言恒真（空跑）。
   *
   * （注释里也不能直接写块注释的起止符，否则提前闭合、后面全成裸代码。）
   *
   * 改成先去掉整行的 `//` 注释再判：真正要钉的是**代码里没有这个字段**，
   * 不是"文件里不出现这个词"。
   */
  const codeOnly = store
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  t('不写 clusters 死字段（代码层面）', !/clusters/.test(codeOnly),
    '含 clusters 的行：' + (codeOnly.split('\n').filter((l) => /clusters/.test(l))[0] || '无'));
}

done();
