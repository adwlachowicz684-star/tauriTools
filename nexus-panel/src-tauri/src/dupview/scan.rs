//! 扫描主流程：遍历 → 渲染首页 → 三级筛选 → 落成 map.json。
//!
//! 【为什么扫描要放后台线程】
//! 429 份卷子 × 平均 12 页，光渲染首页缩略图就要几分钟。放在命令里同步跑
//! 会卡死 UI 线程（表现为整个面板白屏无响应）。所以命令只负责启动线程并
//! 立刻返回，前端轮询 dupview_scan_status 画进度条。
//!
//! 【取消】
//! 用户关掉插件时置 cancel，扫描循环每处理完一个文件查一次。
//! 之所以不做"每页查"：一页的渲染只有几十毫秒，查标志的收益抵不上
//! 多一次锁开销，而一个文件的粒度已经足够让取消感觉是"立刻生效"的。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::sim::{self, CSIM_THR, MAE_THR};
use super::{DupState, Item, ListOut, Root, TreeNode};

/// 学科顺序：列表页的排序依据，按高中常规顺序排，不是字典序。
const SUBJ: [&str; 9] = [
    "语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治",
];

/// 扫描状态文件所在子目录由 super::data_dir 提供，这里只管相对名。
const MAP_FILE: &str = "_work/map.json";

/// 稳定编号：取路径 MD5 前 8 位。
///
/// 用路径而不是序号 —— 序号会随扫描顺序变化，一旦变了，
/// 上一轮生成的缩略图就全部对不上，等于缓存全废。
fn idx_of(path: &str) -> String {
    let h = md5::compute(path.as_bytes());
    format!("{:x}", h)[..8].to_string()
}

/// 在一段文本里找学科关键词。
fn subj_in(text: &str) -> Option<&'static str> {
    SUBJ.iter().find(|k| text.contains(**k)).map(|k| *k)
}

/// 摘掉 `(缺英语)` `(无数学)` 这类"否定说明"片段，其余括号内容保留。
///
/// 目录名常写成 `…南京中华中学(10.17-10.18)(缺英语)` —— 意思是"这套卷子唯独缺英语"，
/// 拿它去做关键词匹配，整目录的化学卷子都会被判成英语。匹配前先摘掉这类括号。
fn strip_neg(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut buf = String::new();
    let mut pair: Option<(char, char)> = None; // (开括号, 闭括号)
    for c in text.chars() {
        match pair {
            None if c == '(' || c == '（' => {
                pair = Some(if c == '(' { ('(', ')') } else { ('（', '）') });
                buf.clear();
            }
            None => out.push(c),
            Some((op, cl)) if c == cl => {
                let neg = buf.contains('缺') || buf.contains('无') || buf.contains("不含");
                if !neg {
                    out.push(op);
                    out.push_str(&buf);
                    out.push(c);
                }
                pair = None;
            }
            Some(_) => buf.push(c),
        }
    }
    /* 括号没闭合：把吞掉的内容原样补回，别把名字截断 */
    if let Some((op, _)) = pair {
        out.push(op);
        out.push_str(&buf);
    }
    out
}

/// 第一个 【…】 标签的内容；没有就是 None。
fn tag_of(name: &str) -> Option<String> {
    let s = name.find('【')? + '【'.len_utf8();
    let rest = &name[s..];
    let e = rest.find('】')?;
    Some(rest[..e].to_string())
}

/// 猜学科：文件名 → 末级目录名 → 【】标签里找学科词 → "其他"。
///
/// 【为什么文件名必须优先、目录只兜底】
/// 旧实现拿**整条父路径**做 contains，且目录和文件名在同一循环里按 SUBJ 顺序竞争
/// （"英语"排在"化学"前面）。于是 `…(缺英语)` 这种目录说明会盖掉文件名里的
/// "化学" —— 一整个目录的卷子全进了英语分区。目录信息只当**临时参考**：
/// 只有文件名认不出时才用，且只取最后一级（上层常是"英语"总目录，会污染全部子文件）。
fn subj_of(name: &str, base: &str) -> String {
    if let Some(s) = subj_in(&strip_neg(name)) {
        return (*s).to_string();
    }
    let last = base.rsplit(|c| c == '\\' || c == '/').next().unwrap_or("");
    if let Some(s) = subj_in(&strip_neg(last)) {
        return (*s).to_string();
    }
    if let Some(t) = tag_of(name) {
        if let Some(s) = subj_in(&t) {
            return (*s).to_string();
        }
    }
    "其他".into()
}

/// 撞名家族基底名：去掉 `_2` `_3` 这类副本后缀。
/// 同一份卷子被复制多次时，文件名往往只差这个后缀。
fn base_of(name: &str) -> String {
    let stem = match name.rfind('.') {
        Some(i) => &name[..i],
        None => name,
    };
    let ext = match name.rfind('.') {
        Some(i) => &name[i..],
        None => "",
    };
    let bytes = stem.as_bytes();
    let mut i = stem.len();
    if i >= 2 && bytes[i - 1].is_ascii_digit() && bytes[i - 2] == b'_' {
        i -= 1;
        while i > 0 && bytes[i - 1].is_ascii_digit() {
            i -= 1;
        }
        if i > 0 && bytes[i - 1] == b'_' {
            i -= 1;
        } else {
            i = stem.len();
        }
    }
    format!("{}{}", &stem[..i], ext)
}

/// 归一化：去掉所有空白。"2026 扬州四模" 与 "2026扬州四模" 应当算同一个家族。
fn norm(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 递归收集 PDF（docx 需要 LibreOffice 转 PDF，单独处理，见 docx_to_pdf）。
fn collect_files(root: &Path, out: &mut Vec<PathBuf>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(x) => x,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
}

/// 启动扫描。
///
/// 返回 `Ok(started)`：`true` 表示本调用真的起了新任务，`false` 表示
/// 已有任务在跑（前端据此显示"开始扫描"还是"已在扫描中"，
/// 而不是报错 —— 用户连点两次扫描按钮是正常操作，不该弹失败）。
pub fn start(app: &AppHandle, roots: Vec<String>) -> Result<bool, String> {
    let st = app.state::<DupState>();
    {
        let mut s = st.status.lock().unwrap();
        if s.running {
            return Ok(false);
        }
        *s = super::ScanStatus {
            running: true,
            phase: "收集文件".into(),
            ..Default::default()
        };
        *st.cancel.lock().unwrap() = false;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = run(&handle, roots) {
            let st = handle.state::<DupState>();
            let mut s = st.status.lock().unwrap();
            s.running = false;
            s.err = e;
        }
    });
    Ok(true)
}

/// 文件名 → 撞名家族名。改名命令要用它重算家族（改名后可能并进另一族）。
pub fn family_of(name: &str) -> String {
    norm(&base_of(name))
}

fn set_status(app: &AppHandle, phase: &str, done: u32, total: u32, msg: &str) {
    if let Ok(mut s) = app.state::<DupState>().status.lock() {
        s.phase = phase.into();
        s.done = done;
        s.total = total;
        s.msg = msg.into();
    }
}

fn cancelled(app: &AppHandle) -> bool {
    *app.state::<DupState>().cancel.lock().unwrap()
}

/// 扫描主流程。返回 Err 时由调用方写进 status.err。
fn run(app: &AppHandle, roots: Vec<String>) -> Result<(), String> {
    let dir = super::data_dir(app)?;
    let imgdir = dir.join("_imgs");

    /* ---- 1. 收集文件 ---- */
    let mut files: Vec<PathBuf> = Vec::new();
    for r in &roots {
        collect_files(Path::new(r), &mut files);
    }
    files.sort();
    let total = files.len() as u32;
    set_status(app, "收集文件", 0, total, &format!("共 {} 个 PDF", total));

    /* ---- 2. 逐文件登记 + 渲染首页缩略图 ----
       增量：本轮新出现的文件数要报给前端（它据此决定"自动扫描完成"
       要不要弹提示 —— 没新增就静默结束，避免每次开面板都弹一下）。 */
    let prev: Vec<Item> = super::read_json(&dir.join(MAP_FILE));
    let prev_paths: HashSet<String> = prev.iter().map(|x| x.path.clone()).collect();
    let done = Arc::new(AtomicU32::new(0));
    let mut items: Vec<Item> = Vec::new();

    for f in &files {
        if cancelled(app) {
            break;
        }
        let path = f.to_string_lossy().to_string();
        let name = f
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let idx = idx_of(&path);
        let base_dir = f
            .parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);

        /* 缩略图：已存在就跳过。渲染是整个扫描里最贵的一步，
           第二次扫描应当几乎是瞬时完成的。 */
        let thumb = imgdir.join(format!("{}.png", idx));
        let mut img: Option<String> = None;
        if thumb.exists() {
            img = Some(thumb.to_string_lossy().to_string());
        } else if let Ok(g) = super::pdf::first_page_gray(f) {
            if super::pdf::save_png(&g, &thumb).is_ok() {
                img = Some(thumb.to_string_lossy().to_string());
            }
        }

        items.push(Item {
            subj: subj_of(&name, &base_dir),
            fam: norm(&base_of(&name)),
            path,
            name,
            idx,
            size,
            md5: String::new(),
            md5same: false,
            ylw: false,
            csim: false,
            deleted: false,
            img,
        });

        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 10 == 0 || n == total {
            set_status(app, "渲染首页", n, total, &format!("{}/{}", n, total));
        }
    }

    /* ---- 3. 同尺寸 → 同 MD5 分组（字节级相同）---- */
    set_status(app, "MD5 分组", 0, total, "");
    md5_group_mark(&mut items);

    /* ---- 4. 内容一致分组（三级筛选）---- */
    set_status(app, "内容比对", 0, total, "");
    content_group_mark(&mut items, &imgdir);

    /* ---- 5. 落盘 ---- */
    super::write_json(&dir.join(MAP_FILE), &items)?;
    let added = items
        .iter()
        .filter(|it| !prev_paths.contains(&it.path))
        .count() as u32;
    if let Ok(mut s) = app.state::<DupState>().status.lock() {
        s.running = false;
        s.phase = "完成".into();
        s.added = added;
        s.msg = format!("{} 个文件（新增 {}）", items.len(), added);
    }
    Ok(())
}

/// 全局「同尺寸 → 同 MD5」分组：字节级完全相同的文件全部标 md5same。
///
/// 先按 size 分桶、桶内 ≥2 才算哈希 —— 429 个文件里绝大多数尺寸唯一，
/// 这一下就能把哈希计算量砍掉九成。
fn md5_group_mark(items: &mut [Item]) {
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if it.size > 0 {
            by_size.entry(it.size).or_default().push(i);
        }
    }
    for (_, group) in by_size {
        if group.len() < 2 {
            continue;
        }
        let mut by_hash: HashMap<String, Vec<usize>> = HashMap::new();
        for &i in &group {
            if let Some(h) = sim::md5_file(Path::new(&items[i].path)) {
                items[i].md5 = h.clone();
                by_hash.entry(h).or_default().push(i);
            }
        }
        for (_, g) in by_hash {
            if g.len() < 2 {
                continue;
            }
            for i in g {
                items[i].md5same = true;
                items[i].ylw = false;
            }
        }
    }
}

/// 内容一致检测：首页感知哈希取候选 → 32x32 缩略图预筛 → 逐页像素比对确认。
///
/// 三级里任何一级不过都直接丢弃这对，只有走到最后一级并且相似度达标的
/// 才标 csim（内容一致）。
fn content_group_mark(items: &mut [Item], imgdir: &Path) {
    /* 先算出每个文件的哈希与 32x32 缩略图，算一次复用多次。 */
    let mut hashes: Vec<Option<String>> = vec![None; items.len()];
    let mut thumbs: Vec<Option<Vec<u8>>> = vec![None; items.len()];
    for (i, it) in items.iter().enumerate() {
        let p = imgdir.join(format!("{}.png", it.idx));
        if let Ok(g) = load_thumb_gray(&p) {
            hashes[i] = sim::thumb_hash(&g);
            thumbs[i] = sim::thumb32(&g);
        }
    }

    /* 候选对：汉明距离 ≤16。只对有哈希的文件两两比对。 */
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for i in 0..items.len() {
        for j in (i + 1)..items.len() {
            if items[i].md5same && items[j].md5same && items[i].md5 == items[j].md5 {
                continue; // MD5 已判相同，不必再走内容比对
            }
            match (&hashes[i], &hashes[j]) {
                (Some(a), Some(b)) if sim::hamming(a, b) <= sim::CH_THR => {}
                _ => continue,
            }
            if let (Some(a), Some(b)) = (&thumbs[i], &thumbs[j]) {
                if let Some(m) = sim::mae(a, b) {
                    if m <= MAE_THR {
                        pairs.push((i, j));
                    }
                }
            }
        }
    }

    for (i, j) in pairs {
        let s = sim::pix_sim(Path::new(&items[i].path), Path::new(&items[j].path));
        if let Some(v) = s {
            if v >= CSIM_THR {
                items[i].csim = true;
                items[j].csim = true;
            } else {
                items[i].ylw = true;
                items[j].ylw = true;
            }
        }
    }
}

/// 读回已落盘的缩略图 PNG 并转灰度。扫描第 4 步要用它算哈希，
/// 而第 2 步渲染时只留下了 PNG（内存里的 Gray 早已释放）。
fn load_thumb_gray(p: &Path) -> Result<super::pdf::Gray, String> {
    let img = image::open(p).map_err(|e| format!("读缩略图失败：{e}"))?;
    let g = img.to_luma8();
    Ok(super::pdf::Gray {
        w: g.width(),
        h: g.height(),
        buf: g.into_raw(),
    })
}

/* ---------------------------------------------------------------------------
 * 列表组装
 * -------------------------------------------------------------------------*/

/// 按目录把 map 组装成前端要的树。
///
/// 与 python 版保持同样的形状（roots → kids → files），
/// 前端 index.html 里有大量按这个形状写的渲染代码，改形状等于重写前端。
pub fn build_list(app: &AppHandle) -> Result<ListOut, String> {
    let dir = super::data_dir(app)?;
    let map: Vec<Item> = super::read_json(&dir.join(MAP_FILE));
    let roots: Vec<Root> = super::read_json(&dir.join("_work/roots.json"));
    let done: Vec<String> = super::read_json(&dir.join("_work/done.json"));

    let mut done_map: HashMap<String, Vec<String>> = HashMap::new();
    for k in &done {
        if let Some((d, s)) = k.split_once('|') {
            done_map.entry(d.to_string()).or_default().push(s.to_string());
        }
    }

    /* 同名根目录加序号区分，否则两个根都叫"试卷"时树会混在一起。 */
    let mut used: HashMap<String, u32> = HashMap::new();
    let mut bases: Vec<(String, String)> = Vec::new();
    for r in &roots {
        let n = match used.get_mut(&r.name) {
            Some(c) => {
                *c += 1;
                format!("{} ({})", r.name, *c)
            }
            None => {
                used.insert(r.name.clone(), 1);
                r.name.clone()
            }
        };
        bases.push((r.path.clone(), n));
    }

    let mut subjects: Vec<String> = Vec::new();
    let mut root_nodes: Vec<TreeNode> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for (full, name) in &bases {
        root_nodes.push(TreeNode {
            name: name.clone(),
            path: name.clone(),
            dir: None,
            full: Some(full.clone()),
            done_subs: vec![],
            kids: vec![],
            files: None,
        });
        index.insert(name.clone(), root_nodes.len() - 1);
    }

    for it in &map {
        let d = match Path::new(&it.path).parent() {
            Some(p) => p.to_string_lossy().to_string(),
            None => continue,
        };
        let hit = bases.iter().find_map(|(pre, nm)| {
            if d == *pre || d.starts_with(&format!("{}\\", pre)) {
                Some((nm.clone(), d[pre.len()..].trim_start_matches('\\').to_string()))
            } else {
                None
            }
        });
        let (rn, rel) = match hit {
            Some(x) => x,
            None => continue,
        };
        if !subjects.contains(&it.subj) {
            subjects.push(it.subj.clone());
        }
        let rid = match index.get(&rn) {
            Some(i) => *i,
            None => continue,
        };
        let segs: Vec<&str> = rel.split('\\').filter(|s| !s.is_empty()).collect();
        place(&mut root_nodes[rid], &segs, &rel, &d, it);
    }

    /* 排序：目录按名字、文件按（家族, 名字）—— 与 python 版一致，
       否则每次扫描后列表顺序会变，用户刚看过的位置就找不到了。 */
    /* "其他"永远排最后；认不出的自定义学科（如"日语"）排在正式学科之后。 */
    subjects.sort_by_key(|s| {
        if s == "其他" {
            100
        } else {
            SUBJ.iter().position(|x| x == s).unwrap_or(99)
        }
    });
    for n in &mut root_nodes {
        sort_tree(n, &done_map);
    }

    Ok(ListOut {
        subjects,
        roots: root_nodes,
    })
}

/// 沿目录分段把文件挂到对应节点上，沿途缺的节点顺手建出来。
fn place(node: &mut TreeNode, segs: &[&str], rel: &str, full: &str, item: &Item) {
    if segs.is_empty() {
        node.dir = Some(rel.to_string());
        node.full = Some(full.to_string());
        node.files.get_or_insert_with(Vec::new).push(item.clone());
        return;
    }
    let seg = segs[0];
    if !node.kids.iter().any(|k| k.name == seg) {
        node.kids.push(TreeNode {
            name: seg.to_string(),
            path: format!("{}\\{}", node.path, seg),
            dir: None,
            full: None,
            done_subs: vec![],
            kids: vec![],
            files: None,
        });
    }
    let kid = node.kids.iter_mut().find(|k| k.name == seg).unwrap();
    place(kid, &segs[1..], rel, full, item);
}

fn sort_tree(node: &mut TreeNode, done: &HashMap<String, Vec<String>>) {
    if let Some(dir) = &node.dir {
        let mut v = done.get(dir).cloned().unwrap_or_default();
        v.sort();
        node.done_subs = v;
    }
    if let Some(files) = &mut node.files {
        files.sort_by(|a, b| (&a.fam, &a.name).cmp(&(&b.fam, &b.name)));
    }
    node.kids.sort_by(|a, b| a.name.cmp(&b.name));
    for k in &mut node.kids {
        sort_tree(k, done);
    }
}
