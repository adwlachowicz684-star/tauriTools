//! 查重缓存的治理：占用统计、孤儿清理、分级清理。
//!
//! 【这个模块为什么存在】
//! 缓存（缩略图 / 逐页图 / docx→PDF）此前**只写不回收**：rename 时会顺手把
//! 旧 idx 名下的缓存搬到新 idx（见 `migrate_idx_cache`），但索引条目整体消失时
//! （文件被删、被改名改到索引追不上、根目录被移除）没有任何人认领那些缓存文件 ——
//! 它们永远不可能再被命中，却永远躺在磁盘上。本机实测攒到 2.3GB，
//! 占全部缓存的 72%，而活缓存只有 858MB。
//!
//! 【三条安全底线，全部在代码里强制】
//!   ① 索引读不到（map.json 不存在 / 空 / 损坏）→ **整体不删**。
//!      空索引在调用方眼里等于"全部缓存都是孤儿"，一次读失败就会清光整个缓存。
//!      返回 None 让调用方跳过：宁可这次没清成，也不能误杀。
//!   ② 只认 `<8位十六进制>` 形状的缓存名（缩略图 `<idx>.png`、
//!      逐页图目录 `<idx>_pages`、docx 转换 `<idx>.pdf`）。认不出来的文件
//!      **一律不碰** —— 它们不是"能证明是垃圾"，只是"没见过"。
//!   ③ 只走 `_imgs` 与 `_docx_pdf` 两个目录；`_work`（索引）、`_trash`
//!      （回收件）从头到尾不出现在这个模块里。

use super::Item;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/* ---------------------------------------------------------------------------
 * 档位与返回形状
 * -------------------------------------------------------------------------*/

/// 清理档位。三档的代价差着量级，所以前端必须显式传、且传错必须报错
/// （静默落成某一档 = "想清页图结果把 docx 缓存也清了"）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SweepMode {
    /// 只清孤儿：索引里已无对应的缓存。零代价 —— 删的都是不可达文件。
    Orphan,
    /// 孤儿 + 全部逐页图。逐页图是可再生资产（重新打开卷子即按页渲染，
    /// 见 `dupview_page`），但 docx→PDF **不碰**（重转一份要几分钟）。
    Pages,
    /// 清空全部可识别缓存。缩略图与逐页图重渲即可，docx→PDF 要重新过转换。
    All,
}

impl SweepMode {
    /// 前端传上来的档位名 → 档位。认不出来返回 None，由调用方报错。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "orphan" => Some(Self::Orphan),
            "pages" => Some(Self::Pages),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

/// 一次清理的报告。数字必须与磁盘实际对得上 —— UI 会拿它向用户报
/// "释放了多少"，报了没释放比不报更糟。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub removed_files: u32,
    pub removed_bytes: u64,
    /// 被清掉的逐页图目录数（里面的文件已计入 removed_files）
    pub removed_dirs: u32,
    pub thumbs: u32,
    pub pages: u32,
    pub docx_pdf: u32,
}

/// 缓存占用统计。`index_ok = false` 时所有数字都不可信 ——
/// UI 必须明说"索引不可读"，不能拿一堆 0 当"没有缓存"。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub index_ok: bool,
    /// 活缓存：索引里的文件正在用的（删了要重生）
    pub live_files: u32,
    pub live_bytes: u64,
    /// 孤儿缓存：源文件已删/改名/根目录移除，永不可达
    pub orphan_files: u32,
    pub orphan_bytes: u64,
    /// 活逐页图（可再生那一档里"活着"的部分）
    pub live_pages_files: u32,
    pub live_pages_bytes: u64,
    /// 孤儿逐页图（同时计入 orphan_*）
    pub orphan_pages_files: u32,
    pub orphan_pages_bytes: u64,
    pub total_files: u32,
    pub total_bytes: u64,
}

/* ---------------------------------------------------------------------------
 * 编号形状
 * -------------------------------------------------------------------------*/

/// 缓存编号的形状：8 位十六进制（路径 MD5 前 8 位，见 `scan::idx_of`）。
///
/// 大小写都放行：MD5 十六进制由格式化工序决定，而索引与缓存文件是同一套
/// 工序的产物，放行大小写不会把两个不同 idx 混为一谈（同串忽略大小写相等）。
fn is_idx(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 索引里的全部 idx。
///
/// 【为什么读不到就返回 None，而不是返回空集】
/// 空集在调用方眼里等于"全部缓存都是孤儿"—— map.json 被占、磁盘抽风、
/// 升级中途，任何一次读失败都会把整个缓存清光。None 让调用方整体跳过：
/// 清理是顺带做的好事，做不成不该有任何代价。
///
/// 顺带滤掉形状不合法的 idx：那是索引损坏的痕迹，拿它去比对只会
/// 把一堆正常缓存误判成孤儿。
pub fn live_idx(dir: &Path) -> Option<HashSet<String>> {
    let p = dir.join("_work/map.json");
    if !p.is_file() {
        return None;
    }
    let items: Vec<Item> = super::read_json(&p);
    if items.is_empty() {
        return None;
    }
    let set: HashSet<String> = items
        .into_iter()
        .map(|it| it.idx)
        .filter(|idx| is_idx(idx))
        .collect();
    (!set.is_empty()).then_some(set)
}

/* ---------------------------------------------------------------------------
 * 遍历辅助
 * -------------------------------------------------------------------------*/

/// 目录下的直接子文件。读不动（不存在/没权限）当空处理 ——
/// 调用方按"没有可清的"走，不把一次列举失败升级成弹窗。
fn files_in(d: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(d) else {
        return Vec::new();
    };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect()
}

/// 目录下的直接子目录。
fn dirs_in(d: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(d) else {
        return Vec::new();
    };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// 递归数一个目录里的文件数与总字节。
///
/// 【为什么必须先数后删】
/// 报告里的"释放了多少"要在删之前数出来；删完再数就只能是 0，
/// 而 UI 会拿着这个 0 告诉用户"什么都没清理"——明明清了。
fn dir_files_bytes(d: &Path) -> (u32, u64) {
    let mut files = 0u32;
    let mut bytes = 0u64;
    let mut stack = vec![d.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&cur) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                files += 1;
                bytes += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (files, bytes)
}

/// 记一个被删文件的大小，再删。删失败就不计数 —— 报告必须与磁盘一致。
fn take_file(p: &Path, bucket: Bucket, rep: &mut SweepReport) {
    let bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    if std::fs::remove_file(p).is_ok() {
        rep.removed_files += 1;
        rep.removed_bytes += bytes;
        match bucket {
            Bucket::Thumb => rep.thumbs += 1,
            Bucket::Page => rep.pages += 1,
            Bucket::DocxPdf => rep.docx_pdf += 1,
        }
    }
}

/// 整目录删（逐页图）。先数后删，删失败不计数。
fn take_dir(d: &Path, rep: &mut SweepReport) {
    let (files, bytes) = dir_files_bytes(d);
    if std::fs::remove_dir_all(d).is_ok() {
        rep.removed_files += files;
        rep.removed_bytes += bytes;
        rep.removed_dirs += 1;
        rep.pages += files;
    }
}

#[derive(Clone, Copy)]
enum Bucket {
    Thumb,
    Page,
    DocxPdf,
}

/* ---------------------------------------------------------------------------
 * 对外：统计 / 清理
 * -------------------------------------------------------------------------*/

/// 缓存占用统计。只读，不删任何文件。
pub fn stats(dir: &Path) -> CacheStats {
    let mut st = CacheStats::default();
    let Some(live) = live_idx(dir) else {
        /* 索引读不到：一个数字都不给。UI 看到 index_ok=false 会明说，
           而不是显示"缓存 0 MB"让人以为已经清过了。 */
        return st;
    };
    st.index_ok = true;
    let imgs = dir.join("_imgs");
    let dxpf = dir.join("_docx_pdf");

    /* 缩略图：_imgs/<idx>.png */
    for p in files_in(&imgs) {
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_idx(stem) {
            continue;
        }
        let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        st.total_files += 1;
        st.total_bytes += bytes;
        if live.contains(stem) {
            st.live_files += 1;
            st.live_bytes += bytes;
        } else {
            st.orphan_files += 1;
            st.orphan_bytes += bytes;
        }
    }

    /* 逐页图：_imgs/<idx>_pages/（可再生那一档，活/孤儿分开数，
       前端算 pages 档能回收多少时要用） */
    for d in dirs_in(&imgs) {
        let Some(name) = d.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(idx) = name.strip_suffix("_pages") else {
            continue;
        };
        if !is_idx(idx) {
            continue;
        }
        let (files, bytes) = dir_files_bytes(&d);
        st.total_files += files;
        st.total_bytes += bytes;
        if live.contains(idx) {
            st.live_files += files;
            st.live_bytes += bytes;
            st.live_pages_files += files;
            st.live_pages_bytes += bytes;
        } else {
            st.orphan_files += files;
            st.orphan_bytes += bytes;
            st.orphan_pages_files += files;
            st.orphan_pages_bytes += bytes;
        }
    }

    /* docx→PDF：_docx_pdf/<idx>.pdf（全场最贵，重转一份几分钟） */
    for p in files_in(&dxpf) {
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_idx(stem) {
            continue;
        }
        let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        st.total_files += 1;
        st.total_bytes += bytes;
        if live.contains(stem) {
            st.live_files += 1;
            st.live_bytes += bytes;
        } else {
            st.orphan_files += 1;
            st.orphan_bytes += bytes;
        }
    }

    st
}

/// 分级清理。索引读不到时返回空报告、一个文件都不动（见 `live_idx`）。
pub fn sweep(dir: &Path, mode: SweepMode) -> SweepReport {
    let Some(live) = live_idx(dir) else {
        return SweepReport::default();
    };
    let mut rep = SweepReport::default();
    let imgs = dir.join("_imgs");
    let dxpf = dir.join("_docx_pdf");

    /* ---- 缩略图 _imgs/<idx>.png：孤儿删；all 档连活的一起删 ---- */
    for p in files_in(&imgs) {
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_idx(stem) {
            continue; /* 形状不认的不碰 */
        }
        if !live.contains(stem) || mode == SweepMode::All {
            take_file(&p, Bucket::Thumb, &mut rep);
        }
    }

    /* ---- 逐页图 _imgs/<idx>_pages/：orphan 档只删孤儿子目录；
            pages / all 档连活的一起清（可再生，见 SweepMode::Pages） ---- */
    for d in dirs_in(&imgs) {
        let Some(name) = d.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(idx) = name.strip_suffix("_pages") else {
            continue;
        };
        if !is_idx(idx) {
            continue;
        }
        if !live.contains(idx) || matches!(mode, SweepMode::Pages | SweepMode::All) {
            take_dir(&d, &mut rep);
        }
    }

    /* ---- docx→PDF _docx_pdf/<idx>.pdf：只有孤儿档与 all 档动它。
            pages 档刻意不碰 —— 那是全场最贵的缓存。 ---- */
    for p in files_in(&dxpf) {
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_idx(stem) {
            continue;
        }
        if !live.contains(stem) || mode == SweepMode::All {
            take_file(&p, Bucket::DocxPdf, &mut rep);
        }
    }

    rep
}

/* ---------------------------------------------------------------------------
 * 单测：临时目录里造活/孤儿混合场景
 * -------------------------------------------------------------------------*/

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例一套独立目录（并行跑测试，靠名字区分）。
    fn fixture(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dv-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("_imgs")).unwrap();
        std::fs::create_dir_all(d.join("_docx_pdf")).unwrap();
        std::fs::create_dir_all(d.join("_work")).unwrap();
        d
    }

    fn touch(p: &Path, bytes: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    /// 写一份最小可解析的索引（Item 的必填字段就那几个）。
    fn write_map(dir: &Path, idxs: &[&str]) {
        let items: Vec<String> = idxs
            .iter()
            .map(|i| {
                format!(
                    r#"{{"path":"p:{i}","name":"n","idx":"{i}","subj":"?","fam":"","size":0}}"#
                )
            })
            .collect();
        std::fs::write(dir.join("_work/map.json"), format!("[{}]", items.join(","))).unwrap();
    }

    /// 本轮要钉的头号 bug：只删不可达的，活缓存与形状不认的文件一概不动。
    #[test]
    fn orphan_sweep_removes_only_unreachable() {
        let d = fixture("orphan");
        write_map(&d, &["aaaaaaaa", "bbbbbbbb"]);
        touch(&d.join("_imgs/aaaaaaaa.png"), 100);
        touch(&d.join("_imgs/bbbbbbbb.png"), 100);
        touch(&d.join("_imgs/cccccccc.png"), 100); // 孤儿
        touch(&d.join("_imgs/notidx.png"), 100); // 形状不认 —— 谁都不能动
        touch(&d.join("_imgs/aaaaaaaa_pages/0.png"), 50);
        touch(&d.join("_imgs/cccccccc_pages/0.png"), 50); // 孤儿子目录
        touch(&d.join("_docx_pdf/aaaaaaaa.pdf"), 1000);
        touch(&d.join("_docx_pdf/cccccccc.pdf"), 1000); // 孤儿

        let rep = sweep(&d, SweepMode::Orphan);

        assert_eq!(rep.removed_files, 3, "c.png + c_pages/0.png + c.pdf");
        assert_eq!(rep.removed_bytes, 1150);
        assert_eq!(rep.removed_dirs, 1);
        assert_eq!(rep.thumbs, 1);
        assert_eq!(rep.pages, 1);
        assert_eq!(rep.docx_pdf, 1);
        // 活缓存原样
        assert!(d.join("_imgs/aaaaaaaa.png").is_file());
        assert!(d.join("_imgs/bbbbbbbb.png").is_file());
        assert!(d.join("_imgs/aaaaaaaa_pages/0.png").is_file());
        assert!(d.join("_docx_pdf/aaaaaaaa.pdf").is_file());
        // 形状不认的原样（包括 all 档也不该动，见下）
        assert!(d.join("_imgs/notidx.png").is_file());
        // 孤儿子目录连目录一起消失
        assert!(!d.join("_imgs/cccccccc_pages").exists());
    }

    /// 头号安全底线：索引读不到（不存在 / 空数组 / 损坏）时，
    /// **连 all 档都不准删一个文件**。空索引 ≠ 全部孤儿。
    #[test]
    fn unreadable_index_blocks_every_mode() {
        for case in ["missing", "empty", "corrupt"] {
            let d = fixture(&format!("unreadable-{case}"));
            match case {
                "empty" => {
                    std::fs::write(d.join("_work/map.json"), "[]").unwrap();
                }
                "corrupt" => {
                    std::fs::write(d.join("_work/map.json"), "{这不是 json").unwrap();
                }
                _ => {} // missing：不写
            }
            touch(&d.join("_imgs/aaaaaaaa.png"), 100);
            touch(&d.join("_imgs/aaaaaaaa_pages/0.png"), 50);
            touch(&d.join("_docx_pdf/aaaaaaaa.pdf"), 1000);

            for mode in [SweepMode::Orphan, SweepMode::Pages, SweepMode::All] {
                let rep = sweep(&d, mode);
                assert_eq!(rep.removed_files, 0, "{case}/{mode:?}: 索引读不到时一律不准删");
                assert_eq!(rep.removed_bytes, 0);
            }
            assert!(d.join("_imgs/aaaaaaaa.png").is_file());
            assert!(d.join("_imgs/aaaaaaaa_pages/0.png").is_file());
            assert!(d.join("_docx_pdf/aaaaaaaa.pdf").is_file());
        }
    }

    /// pages 档的语义：活逐页图跟着清（可再生），活 docx→PDF 不碰（最贵）。
    #[test]
    fn pages_mode_clears_regenerable_pages_only() {
        let d = fixture("pages");
        write_map(&d, &["aaaaaaaa"]);
        touch(&d.join("_imgs/aaaaaaaa.png"), 100); // 活缩略图：留
        touch(&d.join("_imgs/aaaaaaaa_pages/0.png"), 50); // 活逐页图：删
        touch(&d.join("_imgs/cccccccc_pages/0.png"), 50); // 孤儿逐页图：删
        touch(&d.join("_docx_pdf/aaaaaaaa.pdf"), 1000); // 活 docx→PDF：pages 档不碰
        touch(&d.join("_docx_pdf/cccccccc.pdf"), 1000); // 孤儿 docx→PDF：删

        let rep = sweep(&d, SweepMode::Pages);

        assert_eq!(rep.removed_files, 3);
        assert_eq!(rep.removed_bytes, 1100); // 50 + 50 + 1000
        assert!(d.join("_imgs/aaaaaaaa.png").is_file());
        assert!(d.join("_docx_pdf/aaaaaaaa.pdf").is_file());
        assert!(!d.join("_imgs/aaaaaaaa_pages").exists());
        assert!(!d.join("_imgs/cccccccc_pages").exists());
        assert!(!d.join("_docx_pdf/cccccccc.pdf").exists());
    }

    /// all 档：可识别缓存全清，但形状不认的与索引本身仍然不碰。
    #[test]
    fn all_mode_spares_unknown_shapes_and_index() {
        let d = fixture("all");
        write_map(&d, &["aaaaaaaa"]);
        touch(&d.join("_imgs/aaaaaaaa.png"), 100);
        touch(&d.join("_imgs/readme.txt"), 7); // 形状不认：all 档也不动
        touch(&d.join("_imgs/aaaaaaaa_pages/0.png"), 50);
        touch(&d.join("_docx_pdf/aaaaaaaa.pdf"), 1000);

        let rep = sweep(&d, SweepMode::All);

        assert_eq!(rep.removed_files, 3);
        assert_eq!(rep.removed_bytes, 1150);
        assert!(!d.join("_imgs/aaaaaaaa.png").exists());
        assert!(!d.join("_imgs/aaaaaaaa_pages").exists());
        assert!(!d.join("_docx_pdf/aaaaaaaa.pdf").exists());
        assert!(d.join("_imgs/readme.txt").is_file());
        assert!(d.join("_work/map.json").is_file());
    }

    /// 统计要把活/孤儿/逐页图三档分开，且 pages 档的可回收量能算出来。
    #[test]
    fn stats_split_live_orphan_and_pages() {
        let d = fixture("stats");
        write_map(&d, &["aaaaaaaa"]);
        touch(&d.join("_imgs/aaaaaaaa.png"), 100);
        touch(&d.join("_imgs/cccccccc.png"), 200);
        touch(&d.join("_imgs/aaaaaaaa_pages/0.png"), 50);
        touch(&d.join("_imgs/cccccccc_pages/0.png"), 60);
        touch(&d.join("_docx_pdf/aaaaaaaa.pdf"), 1000);
        touch(&d.join("_docx_pdf/cccccccc.pdf"), 2000);

        let st = stats(&d);

        assert!(st.index_ok);
        assert_eq!(st.live_files, 3); // a.png + a_pages/0 + a.pdf
        assert_eq!(st.live_bytes, 1150);
        assert_eq!(st.orphan_files, 3);
        assert_eq!(st.orphan_bytes, 2260);
        assert_eq!(st.live_pages_files, 1);
        assert_eq!(st.orphan_pages_files, 1);
        assert_eq!(st.total_files, 6);
        assert_eq!(st.total_bytes, 3410);
    }

    /// 索引读不到时统计必须自己说"不可信"，不能拿 0 充数。
    #[test]
    fn stats_flags_unreadable_index() {
        let d = fixture("stats-bad");
        touch(&d.join("_imgs/aaaaaaaa.png"), 100);

        let st = stats(&d);

        assert!(!st.index_ok);
        assert_eq!(st.total_files, 0);
        assert_eq!(st.orphan_files, 0);
    }

    /// 档位名认不出来必须报错，不能静默落成某一档。
    #[test]
    fn mode_parse_rejects_unknown() {
        assert_eq!(SweepMode::parse("orphan"), Some(SweepMode::Orphan));
        assert_eq!(SweepMode::parse("pages"), Some(SweepMode::Pages));
        assert_eq!(SweepMode::parse("all"), Some(SweepMode::All));
        assert_eq!(SweepMode::parse("everything"), None);
        assert_eq!(SweepMode::parse(""), None);
        assert_eq!(SweepMode::parse("Orphan"), None);
    }
}
