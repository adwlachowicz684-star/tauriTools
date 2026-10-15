//! 卷内回收目录的选择逻辑（`root_of` / `trash_path_for` / `trash_file_of`）的自测。
//!
//! 【为什么单独放一个文件，不写在 mod.rs 里】
//! 用例里全是 Windows 路径字面量，`"Z:\试卷"` 里的反斜杠在普通
//! Rust 字符串里是转义起点；写在同一个文件里就是满屏 `\\`，
//! 再被任何一层 shell/脚本改写就变成 `Z:\试卷` 这种非法转义。
//! 这里统一用 `r"..."` 原始字面量，反斜杠就是反斜杠。

#![cfg(test)]

use super::*;

fn root_list(paths: &[&str]) -> Vec<Root> {
    paths
        .iter()
        .map(|p| Root {
            path: (*p).into(),
            name: String::new(),
        })
        .collect()
}

fn item_at(path: &str, idx: &str, trash: Option<&str>) -> Item {
    Item {
        path: path.into(),
        name: path.rsplit('\\').next().unwrap_or_default().into(),
        idx: idx.into(),
        subj: "?".into(),
        fam: String::new(),
        size: 0,
        pages: 0,
        md5: String::new(),
        md5same: false,
        ylw: false,
        txtsame: false,
        dim: trash.is_some(),
        img: None,
        trash: trash.map(|s| s.to_string()),
    }
}

/// 试卷根成对出现（`试卷` 与 `试卷_待改名`）是这台机器的常态。
/// 字符串前缀比较会把 `试卷_待改名` 下的文件错配给 `试卷`，
/// 于是删除反而搬到跨盘位置、又回去报 os error 17 —— 必须按路径段判边界。
#[test]
fn root_of_requires_path_segment_boundary() {
    let rs = root_list(&[r"Z:\试卷", r"Z:\试卷_待改名"]);
    assert_eq!(
        root_of(&rs, r"Z:\试卷_待改名\江苏\2026届\a.pdf").map(|r| r.path.as_str()),
        Some(r"Z:\试卷_待改名")
    );
    assert_eq!(
        root_of(&rs, r"Z:\试卷\江苏\2026届\b.pdf").map(|r| r.path.as_str()),
        Some(r"Z:\试卷")
    );
}

/// 取最长匹配：即使两个根真成前缀关系，也要选更具体的那一个。
#[test]
fn root_of_prefers_longest_match() {
    let rs = root_list(&[r"Z:\试卷", r"Z:\试卷\江苏"]);
    assert_eq!(
        root_of(&rs, r"Z:\试卷\江苏\a.pdf").map(|r| r.path.as_str()),
        Some(r"Z:\试卷\江苏")
    );
}

/// 根目录末尾带分隔符、路径用正斜杠、盘符大小写不同，都不该影响判定。
#[test]
fn root_of_tolerates_separators_and_case() {
    let rs = root_list(&[r"Z:\试卷\"]);
    assert_eq!(
        root_of(&rs, r"z:\试卷\p.pdf").map(|r| r.path.as_str()),
        Some(r"Z:\试卷\")
    );
    assert_eq!(
        root_of(&rs, "Z:/试卷/q.pdf").map(|r| r.path.as_str()),
        Some(r"Z:\试卷\")
    );
}

#[test]
fn root_of_returns_none_outside_all_roots() {
    let rs = root_list(&[r"Z:\试卷"]);
    assert!(root_of(&rs, r"Z:\其他\p.pdf").is_none());
}

/// 卷内回收：删除后文件必须落在**试卷所在盘**的根目录下。
/// 落到 C: 的 AppData 就是用户看到的 `os error 17`。
#[test]
fn trash_path_stays_on_the_paper_volume() {
    let rs = root_list(&[r"Z:\试卷"]);
    let got = trash_path_for(
        Path::new(r"C:\data\dupview"),
        &rs,
        "deadbeef",
        "卷子.pdf",
        r"Z:\试卷\江苏\卷子.pdf",
    );
    assert_eq!(
        got,
        Path::new(r"Z:\试卷")
            .join(scan::TRASH_DIRNAME)
            .join("deadbeef_卷子.pdf")
    );
}

/// 根目录没登记过时不得直接失败（那又变成"删不掉"），
/// 回落到数据目录，至少把操作做完。
#[test]
fn trash_path_falls_back_when_root_unknown() {
    let got = trash_path_for(
        Path::new(r"C:\data\dupview"),
        &[],
        "deadbeef",
        "卷子.pdf",
        r"Z:\没登记过的\卷子.pdf",
    );
    assert_eq!(
        got,
        Path::new(r"C:\data\dupview")
            .join("_trash")
            .join("deadbeef_卷子.pdf")
    );
}

/// 记在条目上的 `trash` 优先于现算 —— roots.json 被改过之后仍要能找回回收件。
#[test]
fn trash_file_prefers_recorded_path() {
    let it = item_at(
        r"Z:\试卷\a.pdf",
        "deadbeef",
        Some(r"Z:\试卷\.dupview_trash\deadbeef_a.pdf"),
    );
    assert_eq!(
        trash_file_of(Path::new(r"C:\data\dupview"), &[], &it),
        Path::new(r"Z:\试卷\.dupview_trash\deadbeef_a.pdf")
    );
}

/// 旧数据没有 `trash` 字段：按 roots 现算；
/// **磁盘上哪个都不存在时，报的要指向卷内那个**（它才是应该存在的位置），
/// 而不是把责任推给 C: 的 AppData —— 报错指错地方比报错本身更费时间。
#[test]
fn trash_file_infers_when_field_missing() {
    let rs = root_list(&[r"Z:\试卷"]);
    let it = item_at(r"Z:\试卷\a.pdf", "deadbeef", None);
    assert_eq!(
        trash_file_of(Path::new(r"C:\data\dupview"), &rs, &it),
        Path::new(r"Z:\试卷")
            .join(scan::TRASH_DIRNAME)
            .join("deadbeef_a.pdf")
    );
    assert_eq!(
        trash_file_of(Path::new(r"C:\data\dupview"), &[], &it),
        Path::new(r"C:\data\dupview")
            .join("_trash")
            .join("deadbeef_a.pdf")
    );
}

/// 回收目录名必须带点：它直接躺在用户天天翻的试卷根下，
/// 不带点极易被当成杂物手动删掉（那就等于永久丢卷子）。
#[test]
fn trash_dirname_is_dotted() {
    assert!(scan::TRASH_DIRNAME.starts_with('.'));
}
