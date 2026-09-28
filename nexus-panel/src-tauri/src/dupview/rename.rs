//! 改名规则引擎：给每个文件算出「计划目标名」。
//!
//! 【为什么要有它】
//! 列表卡片上那行计划目标名（fam）原本由离线管线写进 `_work/dup_families.json`，
//! 插件只负责读。但离线管线只在人工整理时跑一次：新加进来的目录、docx 之类
//! 就没有名字可显示（旧数据 2006 条里只有 760 条有 fam），而且它与插件各自维护
//! 一套目录/文件名的解析逻辑，迟早对不上。现在把规则搬进插件：扫描时按同一套
//! 规则给每个文件生成目标名，顺手把 `dup_families.json` 重写一遍，两边永远一致。
//!
//! 【移植基准】
//! 移植自离线引擎 `engine_fixed.py`（v2-fixed），含其中七类判错修正：
//!   1. 学科表补回 文综/理综（原先命中的文件被判「无学科」直接跳过）
//!   2. 试卷识别补回「真题」（原先只认 试卷/试题，"…高考物理真题及答案解析"被判成 _答案）
//!   3. 机构名（徐州教研室/盐城教研室/苏州大学指导卷）不当模次（原先把盐城的
//!      "指导卷"改写成"打靶卷"，属静默改写）
//!   4. 模次以**目录标注优先**（目录是人工整理过的权威标注，文件名里的模次常与它冲突）
//!   5. 认不出单科时记【全科】，而不是整条漏出改名清单
//!   6. 附加标记（手写版/原卷版/收集/学生版…）
//!   7. 区域联合卷（陕晋青宁、全国Ⅰ/Ⅱ卷）
//!
//! 【旧版的 notes / 待复核备注为什么不搬】
//! 那份脚本除了目标名还会产出 notes（"已按目录标注"、"按整套卷记为全科"等），
//! 但那些只喂给离线的复核报告，从不进 `dup_families.json` ——
//! 计划文件里只有 z/dir/old/new/base/tag/path 六项，卡片也只读 base。
//! 所以这里只搬"算名字"的那部分，备注一概不带，免得凭空多出一份无处落地的状态。
//!
//! 【格式】
//! 标准树： `{卷别}{模次}【{学科}】{届别}_{类型}_{附加}_{地区}({日期}).ext`
//! _真题：  `{卷别}高考真题【{学科}】{届别}_{类型}.ext`
//! _疑似错卷：跳过，不给目标名。
//!
//! 改这里的任何一条解析规则前，先拿 `engine_fixed.py` 跑一遍同样的目录，
//! 两边输出对上了再改 —— 这份文件的价值就在于与那份脚本逐字一致。

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/* ---------------------------------------------------------------------------
 * 常量表（与 engine_fixed.py 一一对应，顺序即优先级，别随手重排）
 * -------------------------------------------------------------------------*/

/// 学科表。文综/理综放最后 —— 单科优先命中，只有整卷标「文综/理综」时才落到它们。
pub const SUBJ: [&str; 12] = [
    "化学", "历史", "地理", "政治", "数学", "物理", "生物", "英语", "语文", "日语", "文综", "理综",
];

const BANDS: [&str; 21] = [
    "江苏", "湖南", "浙江", "陕西", "山西", "北京", "上海", "云南", "广东", "安徽", "河南", "天津",
    "山东", "河北", "湖北", "辽宁", "重庆", "四川", "福建", "黑吉辽蒙", "西北卷",
];

const MODES: [&str; 30] = [
    "第一次大联考", "第二次联考", "二次联考", "第一次联考", "基地校大联考", "百强校大联考",
    "大联考", "零模", "月考", "期中", "期初", "期末", "一模", "二模", "三模", "四模", "1.5模",
    "联考", "学情调研", "调研", "考前指导卷", "考前自测卷", "考前打靶卷", "最后一考",
    "苏州大学指导卷", "徐州教研室", "盐城教研室", "适应性考试", "春季高考", "高考真题",
];

const PREF_MODES: [&str; 20] = [
    "一模", "二模", "三模", "四模", "零模", "1.5模", "月考", "期中", "期初", "期末", "联考",
    "第一次联考", "第二次联考", "二次联考", "第一次大联考", "基地校大联考", "百强校大联考",
    "大联考", "学情调研", "调研",
];

const STRONG_MODES: [&str; 15] = [
    "一模", "二模", "三模", "四模", "1.5模", "零模", "期中", "期初", "期末", "最后一考",
    "考前打靶卷", "考前自测卷", "考前指导卷", "春季高考", "高考真题",
];

const WEAK_MODES: [&str; 11] = [
    "第一次联考", "第二次联考", "二次联考", "第一次大联考", "基地学校大联考", "基地大联考",
    "基地校大联考", "百强校大联考", "大联考", "联考", "月考",
];

/// 同一事物的不同写法归一（右侧为规范写法）。顺序即替换顺序，别重排。
const MODE_ALIAS: [(&str, &str); 4] = [
    ("基地大联考", "基地校大联考"),
    ("基地学校大联考", "基地校大联考"),
    ("基地联考", "基地校大联考"),
    ("第二次联考", "二次联考"),
];

/// 单科专项片段（整卷之外的单题/片段），命中即按专项命名，不并入整卷。
const SPECIALS: [(&str, &str); 10] = [
    ("作文", "语文"),
    ("文言文", "语文"),
    ("名篇名句", "语文"),
    ("文学常识", "语文"),
    ("语法填空", "英语"),
    ("完形填空", "英语"),
    ("阅读理解", "英语"),
    ("七选五", "英语"),
    ("读后续写", "英语"),
    ("书面表达", "英语"),
];

/// 附加标记：命中就追加到内容类型后面；已被内容类型吸收的不重复加。
const EXTRA_MARKS: [(&str, &str); 10] = [
    ("评分标准", "（评分标准）"),
    ("考点提纲", "（考点提纲）"),
    ("背诵提纲", "（背诵提纲）"),
    ("教师版", "（教师版）"),
    ("学生版", "（学生版）"),
    ("手写", "（手写版）"),
    ("精排", "（精排）"),
    ("原卷", "（原卷版）"),
    ("回忆", "（回忆版）"),
    ("收集", "（收集）"),
];

/// 目录里可能标的是**机构名**，那不是考试类型，不能当模次用；但也不该让模次段
/// 整个空掉 —— 退而用机构名占位（build_new 里的 dir_inst）。
const INSTITUTIONS: [&str; 4] = ["徐州教研室", "盐城教研室", "苏州大学指导卷", "苏州大学"];

const SKIP_FILES: [&str; 3] = ["Thumbs.db", "desktop.ini", ".DS_Store"];

const KNOWN_REGIONS: [&str; 24] = [
    "江苏", "湖南", "浙江", "陕西", "山西", "北京", "上海", "云南", "广东", "安徽", "河南", "天津",
    "山东", "河北", "湖北", "辽宁", "重庆", "四川", "福建", "黑吉辽蒙", "西北卷", "全国Ⅰ卷",
    "全国Ⅱ卷", "全国·陕晋青宁",
];

/* ---------------------------------------------------------------------------
 * 正则（惰性编译，只编一次）
 * -------------------------------------------------------------------------*/

fn date_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\((20\d\d[.\d]*-\d+\.?\d*|[.\d]+-\d+\.?\d*|[.\d]+左右|[.\d]+月底|[.\d]+月\d+日|[.\d]+)\)").unwrap()
    })
}

/// 去掉括号注释（全角/半角都认）。目录名与地区名都要过一遍。
fn paren_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[（(][^）)]*[）)]").unwrap())
}

fn paren_cap_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[（(]([^）)]*)[）)]").unwrap())
}

/// `(缺英语)` 这类否定说明：拿它做关键词匹配会把整目录的卷子判成英语。
fn note_paren_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\(缺[^)]*\)").unwrap())
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"【([^】]+)】").unwrap())
}

fn tag_strip_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"【[^】]*】").unwrap())
}

fn year_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"20\d\d届").unwrap())
}

fn year2_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^20(\d\d)$").unwrap())
}

fn month_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(\d{1,2})月").unwrap())
}

fn ord_strong_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"第([一二三四五12345])次\s*(模拟|调研|质量监测|质量调研)").unwrap())
}

fn ord_weak_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"第([一二三四五12345])次\s*(联考|大联考)").unwrap())
}

fn region_ii_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(全国|新课标|新高考)?\s*(二|2|Ⅱ|II|ii)\s*卷").unwrap())
}

fn region_i_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(全国|新课标|新高考)?\s*(一|1|Ⅰ|I)\s*卷").unwrap())
}

fn spring_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"春季高考|春考|春季招生|春季统一").unwrap())
}

/* ---------------------------------------------------------------------------
 * 小工具
 * -------------------------------------------------------------------------*/

/// `os.path.splitext` 的同义实现：按**最后一个**点切；点开头的名字（.gitignore）
/// 视作没有扩展名 —— Python 就是这么定的，照着来。
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// 撞名家族基底名：去掉末尾的 `_2` `_3`（旧版 `base_of` 的同义实现
/// `re.sub(r"_(\d+)(\.\w+)$", r"\2", name)`）。
pub fn base_of(name: &str) -> String {
    let (stem, ext) = split_ext(name);
    if ext.is_empty() {
        return name.to_string();
    }
    /* 旧版正则要求扩展名形如 `\.\w+`，`.pdf` 可以，`.a-b` 不行 —— 保持一致 */
    if !ext[1..].chars().all(|c| c.is_alphanumeric() || c == '_') {
        return name.to_string();
    }
    let b = stem.as_bytes();
    let mut i = stem.len();
    while i > 0 && b[i - 1].is_ascii_digit() {
        i -= 1;
    }
    if i == stem.len() || i == 0 || b[i - 1] != b'_' {
        return name.to_string();
    }
    format!("{}{}", &stem[..i - 1], ext)
}

/// 说明类文件（规格书：以 注意/以下/附注/说明 开头）不进改名。
/// 加冒号限定，免得把「说明文阅读」这类真试卷误伤。
fn is_note_file(name: &str) -> bool {
    for p in ["注意", "以下", "附注", "说明"] {
        if let Some(rest) = name.strip_prefix(p) {
            if rest.starts_with('：') || rest.starts_with(':') {
                return true;
            }
        }
    }
    false
}

/* ---------------------------------------------------------------------------
 * 目录解析
 * -------------------------------------------------------------------------*/

/// 目录里读出来的标注。`year` 默认 2026 届 —— 与旧版一致，目录没写年份时的兜底。
#[derive(Clone, Debug)]
pub struct DirInfo {
    pub bands: Vec<String>,
    pub modes: Vec<String>,
    pub year: String,
    pub regions: Vec<String>,
    pub date: Option<String>,
}

impl Default for DirInfo {
    fn default() -> Self {
        Self {
            bands: Vec::new(),
            modes: Vec::new(),
            year: "2026届".into(),
            regions: Vec::new(),
            date: None,
        }
    }
}

fn parse_dir(dirname: &str) -> DirInfo {
    let mut info = DirInfo::default();
    if let Some(m) = date_re().captures(dirname) {
        info.date = Some(m[1].to_string());
    }
    for m in tag_re().captures_iter(dirname) {
        let tok = &m[1];
        if BANDS.contains(&tok) && !info.bands.iter().any(|x| x == tok) {
            info.bands.push(tok.to_string());
        }
    }
    for md in MODES {
        if dirname.contains(&format!("【{}】", md)) {
            info.modes.push(md.to_string());
        }
    }
    if let Some(m) = year_re().find(dirname) {
        info.year = m.as_str().to_string();
    }
    let body = tag_strip_re().replace_all(dirname, "");
    let body = paren_re().replace_all(&body, "");
    let body = year_re().replace_all(&body, "");
    let body = note_paren_re().replace_all(&body, "");
    let body = body.trim_matches(|c| c == '·' || c == '-' || c == ' ' || c == '\t');
    if !body.is_empty() {
        info.regions.push(body.to_string());
    }
    info
}

fn dir_inst(info: &DirInfo) -> String {
    for md in &info.modes {
        if INSTITUTIONS.contains(&md.as_str()) {
            return md.clone();
        }
    }
    String::new()
}

fn dir_file_mode(info: &DirInfo) -> String {
    if info.modes.iter().any(|m| m == "春季高考") {
        return "春季高考".into();
    }
    for p in PREF_MODES {
        if info.modes.iter().any(|m| m == p) {
            return p.into();
        }
    }
    for md in &info.modes {
        if ["考前自测卷", "考前打靶卷", "考前指导卷"].contains(&md.as_str()) {
            return md.clone();
        }
    }
    String::new()
}

/* ---------------------------------------------------------------------------
 * 文件名解析
 * -------------------------------------------------------------------------*/

/// 在 text 里找 word 最早的合法出现位置（返回字符下标）。
///
/// 旧版用 `(?<!高)一模` / `月考(?!前)` 这两条断言防子串误命中（高三模拟≠三模、
/// 5月考前≠月考）。regex crate 不支持 lookaround，所以在循环里手写这两条判断。
fn find_mode(text: &str, word: &str) -> Option<usize> {
    let guard_prev = matches!(word, "一模" | "二模" | "三模" | "四模");
    let guard_next = word == "月考";
    let chars: Vec<char> = text.chars().collect();
    let w: Vec<char> = word.chars().collect();
    if w.len() > chars.len() {
        return None;
    }
    for i in 0..=(chars.len() - w.len()) {
        if chars[i..i + w.len()] != w[..] {
            continue;
        }
        if guard_prev && i > 0 && chars[i - 1] == '高' {
            continue;
        }
        if guard_next && i + w.len() < chars.len() && chars[i + w.len()] == '前' {
            continue;
        }
        return Some(i);
    }
    None
}

/// 在一组词里取**位置最靠前**的那个（不是列表顺序）。
fn scan_modes(text: &str, words: &[&str]) -> String {
    let mut best: Option<(usize, &str)> = None;
    for w in words {
        if let Some(i) = find_mode(text, w) {
            if best.is_none() || i < best.unwrap().0 {
                best = Some((i, w));
            }
        }
    }
    best.map(|x| x.1.to_string()).unwrap_or_default()
}

/// 阿拉伯数字 → 中文数字（`第3次模拟` 与 `第三次模拟` 归一）。
fn cn_ord(c: char) -> Option<char> {
    match c {
        '一' | '二' | '三' | '四' | '五' => Some(c),
        '1' => Some('一'),
        '2' => Some('二'),
        '3' => Some('三'),
        '4' => Some('四'),
        '5' => Some('五'),
        _ => None,
    }
}

fn scan_ord(text: &str, strong: bool) -> String {
    let re = if strong { ord_strong_re() } else { ord_weak_re() };
    for c in re.captures_iter(text) {
        let n = match cn_ord(c[1].chars().next().unwrap_or('?')) {
            Some(x) => x,
            None => continue,
        };
        let kind = c[2].to_string();
        if kind == "联考" || kind == "大联考" {
            return format!("第{}次{}", n, kind);
        }
        return format!("{}模", n);
    }
    String::new()
}

fn norm_aliases(text: &str) -> String {
    let mut s = text.to_string();
    for (k, v) in MODE_ALIAS {
        s = s.replace(k, v);
    }
    s
}

fn alias_of(w: &str) -> String {
    MODE_ALIAS
        .iter()
        .find(|(k, _)| *k == w)
        .map(|(_, v)| (*v).to_string())
        .unwrap_or_else(|| w.to_string())
}

/// 从文件名提取模次（文件本身优先，缺才回溯目录）。
/// 顺序：主部强词 > 括注强词 > 主部弱词；括号内多为别名，仅在前两者皆空时启用。
fn file_mode(fname: &str) -> String {
    let base = norm_aliases(split_ext(fname).0);
    let main = paren_re().replace_all(&base, " ").to_string();
    let par = paren_cap_re()
        .captures_iter(&base)
        .map(|c| c[1].to_string())
        .collect::<Vec<_>>()
        .join(" ");
    for txt in [main.as_str(), par.as_str()] {
        let w = {
            let m = scan_modes(txt, &STRONG_MODES);
            if m.is_empty() {
                scan_ord(txt, true)
            } else {
                m
            }
        };
        if !w.is_empty() {
            return alias_of(&w);
        }
    }
    let w = {
        let m = scan_modes(&main, &WEAK_MODES);
        if m.is_empty() {
            scan_ord(&main, false)
        } else {
            m
        }
    };
    if w.is_empty() {
        String::new()
    } else {
        alias_of(&w)
    }
}

/// 文件名解析结果：学科、内容类型、附加段、扩展名。
struct Parsed {
    subj: String,
    t: String,
    extra: String,
    ext: String,
}

fn parse_file(name: &str, hint_subj: &str) -> Parsed {
    let (base, ext) = split_ext(name);
    let ext = ext.to_string();
    let audio = matches!(ext.to_ascii_lowercase().as_str(), ".mp3" | ".m4a" | ".wav");

    let mut subj = SUBJ
        .iter()
        .find(|s| base.contains(**s))
        .map(|s| s.to_string());
    if subj.is_none() && !hint_subj.is_empty() {
        subj = Some(hint_subj.to_string());
    }
    if subj.is_none() {
        subj = Some(if base.contains("听力") || audio {
            "英语".into()
        } else {
            "?".into()
        });
    }
    let subj = subj.unwrap();

    let has_listen = base.contains("听力") || audio;
    let has_trans = base.contains("翻译");
    let has_ans = base.contains("答案");
    let has_ref = base.contains("参考");
    let has_ana = base.contains("解析") || base.contains("详解") || base.contains("解答");
    let has_card = base.contains("答题卡");
    let has_std = base.contains("评分标准");
    let has_outline = base.contains("考点提纲") || base.contains("背诵提纲");
    let has_pred = base.contains("考点预测");
    /* 「真题」也算试卷 —— 漏了它，"…高考物理真题及答案解析"会被判成 _答案。 */
    let has_sheet_real = base.contains("试卷") || base.contains("试题") || base.contains("真题");
    let has_yuanjuan = base.contains("原卷版") || base.contains("原卷");

    let spec = SPECIALS.iter().find(|(w, _)| base.contains(w));
    let spec_ok = spec.is_some()
        && !has_sheet_real
        && ![
            "真题",
            "答案",
            "解析",
            "详解",
            "解答",
            "答题卡",
            "翻译",
            "听力",
            "评分标准",
            "考点",
        ]
        .iter()
        .any(|k| base.contains(k));

    /* t / extra 在下面每个分支里都会赋值一次，这里只声明不初始化 ——
       否则初始值一写就被覆盖，白留一个"赋了从没读过"的死值。 */
    let mut t;
    let mut extra;
    let mut subj = subj;
    if has_listen {
        if base.contains("原文") {
            t = "听力原文".into();
            extra = String::new();
        } else {
            t = "试卷".into();
            extra = "（听力）".into();
        }
    } else if has_trans {
        t = "试卷".into();
        extra = "_翻译".into();
    } else if has_card {
        t = "答题卡".into();
        extra = String::new();
    } else if has_std {
        t = "答案".into();
        extra = String::new();
    } else if has_outline {
        t = "试卷".into();
        extra = String::new();
    } else if has_pred {
        t = "考点".into();
        extra = String::new();
    } else if spec_ok {
        let (w, s) = spec.unwrap();
        t = format!("专项·{}", w);
        extra = String::new();
        if subj == "?" {
            subj = (*s).to_string();
        }
    } else if has_ans {
        /* 【X卷+答案】→ 答案：「卷」是卷别来源，不是试卷。 */
        t = if has_sheet_real { "试卷+答案" } else { "答案" }.into();
        extra = String::new();
        if has_ref {
            t.push_str("（参考）");
        }
    } else if has_yuanjuan {
        t = "试卷".into();
        extra = String::new();
    } else if has_ana {
        t = "解析".into();
        extra = String::new();
    } else {
        /* 末尾两支在旧版里是 has_sheet / 兜底，两者同为「试卷」，合并成一支。 */
        t = "试卷".into();
        extra = String::new();
    }

    let mut marks = String::new();
    for (tok, mk) in EXTRA_MARKS {
        if base.contains(tok) && !marks.contains(mk) && !format!("{}{}", t, extra).contains(mk) {
            marks.push_str(mk);
        }
    }
    extra.push_str(&marks);

    Parsed { subj, t, extra, ext }
}

/* ---------------------------------------------------------------------------
 * 组装目标名
 * -------------------------------------------------------------------------*/

fn build_new(dinfo: &DirInfo, fname: &str, hint_subj: &str) -> String {
    let p = parse_file(fname, hint_subj);
    /* 认不出单科：按整套卷记【全科】并标注待复核，不再整条漏出改名清单。 */
    let subj = if p.subj == "?" { "全科".into() } else { p.subj };
    let band: String = dinfo.bands.iter().map(|b| format!("【{}】", b)).collect();
    let dmode = dir_file_mode(dinfo);
    let fmode = file_mode(fname);
    /* 模次以**目录标注优先** —— 目录是人工整理过的权威标注。 */
    let mut mode = if !dmode.is_empty() { dmode } else { fmode };
    if mode.is_empty() {
        /* 目录只标了机构名、文件名也没写考试名 —— 用机构名占位，别让模次段空掉。 */
        mode = dir_inst(dinfo);
    }
    let region = dinfo.regions.join("·");
    let date = dinfo.date.clone();
    let tail = p.extra.clone();
    let mut month = String::new();
    if date.is_none() && tail.is_empty() {
        if let Some(c) = month_re().captures(fname) {
            month = format!("_{}月", &c[1]);
        }
    }
    let mut seg = format!("_{}{}_{}", p.t, tail, month);
    seg = seg.replace("__", "_");
    seg = seg.trim_end_matches('_').to_string();
    let mut full = if region.is_empty() {
        format!("{}{}【{}】{}{}", band, mode, subj, dinfo.year, seg)
    } else {
        format!("{}{}【{}】{}{}_{}", band, mode, subj, dinfo.year, seg, region)
    };
    if let Some(d) = date {
        full.push_str(&format!("({})", d));
    }
    full + &p.ext
}

/// 地区/卷别规范化：全国一卷→全国Ⅰ卷、二卷→全国Ⅱ卷，其余原样（去括号注释）。
fn norm_region(name: &str) -> String {
    let s = paren_re().replace_all(name, "").trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    if s.contains("陕晋青宁") {
        return "全国·陕晋青宁".into();
    }
    if region_ii_re().is_match(&s) {
        return "全国Ⅱ卷".into();
    }
    if region_i_re().is_match(&s) {
        return "全国Ⅰ卷".into();
    }
    s
}

/// 真题地区取值（沿用既往优先级）：全国Ⅰ/Ⅱ卷 > 其余已知地区。
/// 命中全国卷即取全国卷，不再叠加省份（江苏\全国一卷 → 只写【全国Ⅰ卷】）。
fn pick_zhenti_region(parts: &[String]) -> String {
    let mut fallback = String::new();
    for p in parts {
        let n = norm_region(p);
        if n == "全国Ⅰ卷" || n == "全国Ⅱ卷" {
            return n;
        }
        if fallback.is_empty() && KNOWN_REGIONS.contains(&n.as_str()) {
            fallback = n;
        }
    }
    fallback
}

/// `_真题` 树：parts 为 `_真题` 之后的路径段，形如 [年份, 地区, (学科|说明目录), ...]。
/// 模次默认「高考真题」，春季高考等独立考试按实际考试名标注。
fn build_zhenti(parts: &[&str], fname: &str) -> String {
    let mut year = String::new();
    let mut segs: Vec<String> = Vec::new();
    let mut subj_hint = String::new();
    for p in parts {
        if year.is_empty() {
            if let Some(c) = year2_re().captures(p) {
                year = format!("20{}届", &c[1]);
                continue;
            }
        }
        segs.push((*p).to_string());
        if subj_hint.is_empty() {
            let clean = note_paren_re().replace_all(p, "");
            subj_hint = SUBJ
                .iter()
                .find(|s| clean.contains(**s))
                .map(|s| s.to_string())
                .unwrap_or_default();
        }
    }
    let p = parse_file(fname, &subj_hint);
    let subj = if p.subj == "?" { "全科".into() } else { p.subj };
    let band = pick_zhenti_region(&segs);
    let head = if band.is_empty() {
        String::new()
    } else {
        format!("【{}】", band)
    };
    let seg = format!("_{}{}", p.t, p.extra);
    let mode = if spring_re().is_match(fname) {
        "春季高考"
    } else {
        "高考真题"
    };
    format!("{}{}【{}】{}{}{}", head, mode, subj, year, seg, p.ext)
}

/* ---------------------------------------------------------------------------
 * 计划表：把一棵目录树全量算成 rows + families
 * -------------------------------------------------------------------------*/

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanRow {
    /// 所属根目录的显示名（试卷 / 试卷_待改名）
    pub z: String,
    /// 相对根目录的路径（根目录下直接放的文件为 "."）
    pub dir: String,
    /// 当前文件名
    pub old: String,
    /// 计划目标名（同目录重名时带 _2 _3 后缀）
    pub new: String,
    /// 家族基底名 = new 去掉 _N 后缀；列表卡片上显示的 fam 就是它
    pub base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// 手工改名钉住的行：名字是人为定的终稿，规则重算时必须原样保留。
    /// 旧版靠"计划文件只追加不重算"达到同一效果，这里计划是全量重算的，
    /// 所以要把"别动这一行"显式记下来。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pin: bool,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanMember {
    pub z: String,
    pub dir: String,
    pub old: String,
    pub new: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlanFile {
    #[serde(default)]
    pub rows: Vec<PlanRow>,
    #[serde(default)]
    pub families: BTreeMap<String, Vec<PlanMember>>,
}

impl PlanFile {
    /// path → fam 的查表。逐条 `find` 是 O(n²)，1955 个文件 × 2000 行会明显卡，
    /// 所以统一先摊平成 HashMap 再查。
    pub fn base_map(&self) -> HashMap<String, String> {
        self.rows
            .iter()
            .map(|r| (r.path.clone(), r.base.clone()))
            .collect()
    }

    /// 按 rows 重算 families。改过 rows 之后必须调它 ——
    /// 卡片上的 fam 取自 rows，而"哪些文件算一族"取自 families，两张表必须同源。
    pub fn rebuild_families(&mut self) {
        let mut fams: BTreeMap<String, Vec<PlanMember>> = BTreeMap::new();
        for r in &self.rows {
            fams.entry(r.base.clone()).or_default().push(PlanMember {
                z: r.z.clone(),
                dir: r.dir.clone(),
                old: r.old.clone(),
                new: r.new.clone(),
                path: r.path.clone(),
                tag: r.tag.clone(),
            });
        }
        self.families = fams;
    }
}

/// 中间态：new 可能为 None（`_疑似错卷` 跳过）。
struct Raw {
    z: String,
    dir: String,
    name: String,
    path: String,
    new: Option<String>,
}

/// 归组键 = 最近一个名字里带【】的祖先目录（考试目录本身）。
///
/// 有的文件躺在考试目录的**子目录**里（如 `…\【徐州教研室】徐州市(5.21)\语文试卷(含答案)`），
/// 按叶子目录分组会把它们单独算一组、统一不到 —— 所以按考试目录分组。
fn exam_key(dir: &str) -> String {
    let parts: Vec<&str> = dir.split('\\').collect();
    for i in (0..parts.len()).rev() {
        if parts[i].contains('【') {
            return parts[..=i].join("\\");
        }
    }
    dir.to_string()
}

/// 取目标名里的模次段：跳过开头连续的【…】，取到下一个【 之前。
fn mode_of(new: &str) -> String {
    let s2 = split_ext(new).0;
    let mut rest = s2;
    loop {
        let Some(t) = rest.strip_prefix('【') else { break };
        match t.find('】') {
            /* 【】里至少要有内容才算一个标签（与旧版 `【[^】]+】` 一致） */
            Some(0) => break,
            Some(i) => rest = &t[i + '】'.len_utf8()..],
            None => break,
        }
    }
    match rest.find('【') {
        Some(i) => rest[..i].to_string(),
        None => String::new(),
    }
}

/// 单个文件的计划目标名。None = 这个文件不进改名计划。
pub fn plan_for(rel_dir: &str, fname: &str) -> Option<String> {
    let parts: Vec<&str> = if rel_dir.is_empty() || rel_dir == "." {
        Vec::new()
    } else {
        rel_dir.split('\\').collect()
    };
    if let Some(i) = parts.iter().position(|p| *p == "_真题") {
        return Some(build_zhenti(&parts[i + 1..], fname));
    }
    if parts.iter().any(|p| *p == "_疑似错卷") {
        return None;
    }

    /* 标准树：从叶子往上找第一个"有信息"的目录当标注源，再往上把模次/卷别/日期补齐。 */
    let mut dinfo = DirInfo::default();
    let mut hint_subj = String::new();
    for i in (0..parts.len()).rev() {
        let cand = parse_dir(parts[i]);
        if hint_subj.is_empty() {
            let clean = note_paren_re().replace_all(parts[i], "");
            hint_subj = SUBJ
                .iter()
                .find(|s| clean.contains(**s))
                .map(|s| s.to_string())
                .unwrap_or_default();
        }
        if !cand.bands.is_empty() || !cand.modes.is_empty() || cand.date.is_some() {
            let mut d = cand;
            for j in (0..i).rev() {
                let up = parse_dir(parts[j]);
                for mdu in up.modes {
                    if !d.modes.contains(&mdu) {
                        d.modes.push(mdu);
                    }
                }
                for b in up.bands {
                    if !d.bands.contains(&b) {
                        d.bands.push(b);
                    }
                }
                if d.date.is_none() && up.date.is_some() {
                    d.date = up.date;
                }
                if d.regions.is_empty() && !up.regions.is_empty() {
                    d.regions = up.regions;
                }
            }
            dinfo = d;
            break;
        }
    }
    Some(build_new(&dinfo, fname, &hint_subj))
}

/// 递归收集根目录下所有"参与改名"的文件。
///
/// 与扫描的收集不同：这里**不过滤扩展名** —— 改名计划要覆盖 mp3 / jpg / doc
/// 这些同样躺在试卷目录里的附属文件（旧版计划里就有 13 个 mp3、2 个 jpg），
/// 只按旧版的规则跳过隐藏项、系统垃圾与说明类文件。
fn walk_all(root: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(root)];
    while let Some(d) = stack.pop() {
        let rd = match std::fs::read_dir(&d) {
            Ok(x) => x,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            let nm = e.file_name().to_string_lossy().to_string();
            if nm.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if SKIP_FILES.contains(&nm.as_str()) || is_note_file(&nm) {
                continue;
            }
            let rel = p
                .parent()
                .and_then(|x| x.strip_prefix(root).ok())
                .map(|x| x.to_string_lossy().trim_start_matches(['\\', '/']).to_string())
                .filter(|x| !x.is_empty())
                .unwrap_or_else(|| ".".to_string());
            out.push((rel, nm, p.to_string_lossy().to_string()));
        }
    }
    out.sort();
    out
}

/// 统一机构名目录的模次：徐州教研室/盐城教研室这类目录，只有部分文件名写了卷名，
/// 没写的那些会被机构名占位 —— 同一个目录出现两种模次段。按目录内多数文件的卷名统一。
fn unify_institution_modes(rows: &mut [Raw]) {
    let mut groups: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    for (i, r) in rows.iter().enumerate() {
        if r.new.is_some() {
            groups
                .entry((r.z.clone(), exam_key(&r.dir)))
                .or_default()
                .push(i);
        }
    }
    for (_, idxs) in groups {
        let mut cnt: HashMap<String, usize> = HashMap::new();
        for &i in &idxs {
            let md = mode_of(rows[i].new.as_deref().unwrap_or(""));
            if !md.is_empty() && !INSTITUTIONS.contains(&md.as_str()) {
                *cnt.entry(md).or_insert(0) += 1;
            }
        }
        let Some((top, n)) = cnt.into_iter().max_by_key(|x| x.1) else {
            continue;
        };
        if n < 2 {
            continue;
        }
        for &i in &idxs {
            let nm = match rows[i].new.clone() {
                Some(x) => x,
                None => continue,
            };
            if INSTITUTIONS.contains(&mode_of(&nm).as_str()) {
                let from = format!("{}【", mode_of(&nm));
                let to = format!("{}【", top);
                rows[i].new = Some(nm.replacen(&from, &to, 1));
            }
        }
    }
}

/// 去重：同目录下同名（含扩展名）依次 `_2` `_3`。
fn dedup(rows: &mut [Raw]) {
    let mut seen: HashMap<(String, String, String), u32> = HashMap::new();
    for r in rows.iter_mut() {
        let nm = match r.new.clone() {
            Some(x) => x,
            None => continue,
        };
        let c = seen
            .entry((r.z.clone(), r.dir.clone(), nm.clone()))
            .or_insert(0);
        *c += 1;
        if *c > 1 {
            let (b, e) = split_ext(&nm);
            r.new = Some(format!("{}_{}{}", b, c, e));
        }
    }
}

/// 把根目录表跑一遍，生成完整改名计划。
///
/// `roots` 是 (显示名, 绝对路径) 列表；某个根目录当前不可访问（盘没挂上）时
/// 它下面的文件不会进计划 —— 调用方据此决定要不要覆盖落盘的计划文件，
/// 免得把一份残缺的计划写回去。
pub fn build_plan(roots: &[(String, String)]) -> PlanFile {
    let mut raw: Vec<Raw> = Vec::new();
    for (z, root) in roots {
        for (rel, name, path) in walk_all(root) {
            let new = plan_for(&rel, &name);
            raw.push(Raw {
                z: z.clone(),
                dir: rel,
                name,
                path,
                new,
            });
        }
    }
    unify_institution_modes(&mut raw);
    dedup(&mut raw);

    let mut plan = PlanFile::default();
    for r in &raw {
        let Some(new) = r.new.clone() else { continue };
        let base = base_of(&new);
        let tag = if base != new {
            Some("dup".to_string())
        } else {
            None
        };
        plan.rows.push(PlanRow {
            z: r.z.clone(),
            dir: r.dir.clone(),
            old: r.name.clone(),
            new: new.clone(),
            base: base.clone(),
            tag: tag.clone(),
            pin: false,
            path: r.path.clone(),
        });
        plan.families
            .entry(base)
            .or_default()
            .push(PlanMember {
                z: r.z.clone(),
                dir: r.dir.clone(),
                old: r.name.clone(),
                new,
                path: r.path.clone(),
                tag,
            });
    }
    plan
}

/// 把上一份计划里被手工改名钉住的行（pin）搬到新计划上，再重算 families。
///
/// 计划是"规则在磁盘上的投影"，每次扫描都全量重算；但手工改过名的文件，
/// 它的名字是人为定的终稿，再让规则改一遍就等于把用户的决定抹掉 —— 所以这些行原样保留。
/// 找不到对应行（文件被移走、改名后又删了）就自然丢弃，不留悬空条目。
pub fn carry_pins(plan: &mut PlanFile, prev: &PlanFile) {
    let pins: HashMap<&str, &PlanRow> = prev
        .rows
        .iter()
        .filter(|r| r.pin)
        .map(|r| (r.path.as_str(), r))
        .collect();
    if pins.is_empty() {
        return;
    }
    for row in plan.rows.iter_mut() {
        if let Some(p) = pins.get(row.path.as_str()) {
            row.new = p.new.clone();
            row.base = p.base.clone();
            row.tag = p.tag.clone();
            row.pin = true;
        }
    }
    plan.rebuild_families();
}

/// 手工改名后同步计划文件：该条目的 old/new/base/path 跟随新名，
/// 并从旧家族移入新基底家族 —— 与旧版 `rename_in_plan` 同一套语义，
/// 保证「计划」与磁盘上的实际文件名一致。
///
/// 额外把该行标成 pin：下次扫描全量重算计划时，这一行不会被规则改写。
pub fn rename_in_plan(plan: &mut PlanFile, old_path: &str, new_path: &str, new_name: &str) {
    let new_base = base_of(new_name);
    let Some(row) = plan.rows.iter_mut().find(|r| r.path == old_path) else {
        return;
    };
    row.old = new_name.to_string();
    row.new = new_name.to_string();
    row.base = new_base;
    row.pin = true;
    row.path = new_path.to_string();
    /* 家族表按 rows 重算，而不是手工把这一条从旧族搬进新族：
       手工搬要同时处理"旧族空了要删、新族没有要建"这些边角，
       而 rows 是唯一事实源，重算一遍天然一致。 */
    plan.rebuild_families();
}

/// 计划文件路径：`<数据目录>/_work/dup_families.json`（沿用旧版位置与文件名，
/// 覆盖写 —— 用户要的就是"插件自己生成的计划落在原版那个文件上"）。
pub fn plan_path(data_dir: &Path) -> PathBuf {
    data_dir.join("_work/dup_families.json")
}
