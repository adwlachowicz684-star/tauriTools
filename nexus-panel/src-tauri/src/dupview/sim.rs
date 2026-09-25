//! 查重判定用的相似度算法：文件级 MD5、首页感知哈希、逐页像素比对。
//!
//! 【三级筛选为什么必须分级】
//! 429 份卷子两两配对是 9 万对，每对都做逐页像素比对（5000 次渲染级）
//! 是跑不完的。所以按代价从低到高排三级，前一级先砍掉绝大多数无关对：
//!
//!   1. MD5          —— 字节级相同（文件可能被复制过，文件名不同）
//!   2. 感知哈希     —— 首页 dHash+aHash 128bit，汉明距离 ≤16 才留
//!   3. 32x32 缩略图 —— 灰度平均绝对差 ≤6.0（比汉明距离更能挡住"同版式不同卷"）
//!   4. 逐页像素比对 —— 相似度 ≥0.98 才最终判"内容一致"
//!
//! 阈值沿用 python 版实测值，不要凭感觉调：放宽会让不同年份的同科试卷
//! 被并成一组（版式相近），收紧则漏掉扫描参数不同的同一份卷子。

use image::imageops::{resize, FilterType};
use image::GrayImage;
use std::path::Path;

use super::pdf::Gray;

/// 首页感知哈希汉明距离上限（128bit 中允许 16 位不同）
pub const CH_THR: u32 = 16;
/// 32x32 灰度缩略图的平均绝对差上限
pub const MAE_THR: f32 = 6.0;
/// 逐页像素相似度下限
pub const CSIM_THR: f32 = 0.98;
/// 墨迹占比低于此值视为近空白页，不参与判定
pub const BLANK_INK: f32 = 0.002;

/// 文件 MD5。
///
/// 整读进内存而不是流式：单份卷子一般几 MB，而流式读要额外持有一个
/// 1MB 缓冲与文件句柄，在 429 个文件的循环里这点开销反而不划算。
pub fn md5_file(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    Some(format!("{:x}", md5::compute(&data)))
}

fn to_gray_image(g: &Gray) -> Option<GrayImage> {
    image::ImageBuffer::from_raw(g.w, g.h, g.buf.clone())
}

fn resize_gray(g: &GrayImage, w: u32, h: u32) -> GrayImage {
    resize(g, w, h, FilterType::Lanczos3)
}

/// 首页缩略图的 128bit 感知哈希：dHash64（相邻像素梯度）+ aHash64（与均值比）。
///
/// 两个哈希互补：dHash 对整体明暗变化不敏感但抓结构，aHash 反过来。
/// 只用其中一个时，"加了水印/扫描亮度不同"的同一份卷子会漏判。
pub fn thumb_hash(gray: &Gray) -> Option<String> {
    let g32 = resize_gray(&to_gray_image(gray)?, 32, 32);

    let d = resize_gray(&g32, 9, 8);
    let mut dh: u128 = 0;
    for r in 0..8u32 {
        for c in 0..8u32 {
            let a = *d.get_pixel(c, r).0.first().unwrap_or(&0) as i32;
            let b = *d.get_pixel(c + 1, r).0.first().unwrap_or(&0) as i32;
            dh = (dh << 1) | if a > b { 1 } else { 0 };
        }
    }

    let a8 = resize_gray(&g32, 8, 8);
    let px: Vec<u8> = a8.pixels().map(|p| p.0[0]).collect();
    let avg = px.iter().map(|v| *v as u32).sum::<u32>() as f32 / px.len() as f32;
    let mut ah: u128 = 0;
    for v in px {
        ah = (ah << 1) | if v as f32 > avg { 1 } else { 0 };
    }

    Some(format!("{:016x}{:016x}", dh, ah))
}

/// 32x32 缩略图像素（二级预筛用）
pub fn thumb32(gray: &Gray) -> Option<Vec<u8>> {
    let g = resize_gray(&to_gray_image(gray)?, 32, 32);
    Some(g.pixels().map(|p| p.0[0]).collect())
}

/// 两个 128bit 哈希的汉明距离。解析不出来返回 u32::MAX（视为完全不同）。
pub fn hamming(h1: &str, h2: &str) -> u32 {
    let parse = |s: &str| u128::from_str_radix(s, 16).ok();
    match (parse(h1), parse(h2)) {
        (Some(a), Some(b)) => (a ^ b).count_ones(),
        _ => u32::MAX,
    }
}

/// 两个 32x32 缩略图的平均绝对差
pub fn mae(a: &[u8], b: &[u8]) -> Option<f32> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let s: u32 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs())
        .sum();
    Some(s as f32 / a.len() as f32)
}

/// 近空白页判定：墨迹（灰度 <200 的像素）占比。
///
/// 为什么要跳过空白页：损坏件渲染出来是纯白，"两页都白"会被算成
/// 100% 一致，于是两个不相干的损坏文件被并成一组 —— 这是漏判之外
/// 更糟的一类错误（误判会直接诱导用户删错文件）。
fn ink_ratio(s: &[u8]) -> f32 {
    if s.is_empty() {
        return 0.0;
    }
    let step = (s.len() / 4000).max(1);
    let mut dark = 0u32;
    let mut tot = 0u32;
    let mut i = 0;
    while i < s.len() {
        if s[i] < 200 {
            dark += 1;
        }
        tot += 1;
        i += step;
    }
    if tot == 0 {
        0.0
    } else {
        dark as f32 / tot as f32
    }
}

/// 逐页像素比对：页数与页尺寸校验 + 每页灰度采样。
///
/// 返回 None 表示"无法确认"（页数不同 / 尺寸差异过大 / 全是空白页），
/// 调调用方按"不是同一份"处理 —— 与 python 版语义一致。
pub fn pix_sim(p1: &Path, p2: &Path) -> Option<f32> {
    use super::pdf;

    let n1 = pdf::page_count(p1).ok()?;
    let n2 = pdf::page_count(p2).ok()?;
    if n1 != n2 || n1 == 0 {
        return None;
    }

    let mut diffs: u32 = 0;
    let mut tot: u32 = 0;
    for i in 0..n1 {
        let g1 = pdf::render_page(p1, i, 900).ok()?;
        let g2 = pdf::render_page(p2, i, 900).ok()?;
        /* 页尺寸差异 >2% 直接判不同：同一份卷子不会被导出成两种版心。 */
        let w1 = g1.w as f32;
        let w2 = g2.w as f32;
        let h1 = g1.h as f32;
        let h2 = g2.h as f32;
        if (w1 - w2).abs() / w1.max(w2) > 0.02 || (h1 - h2).abs() / h1.max(h2) > 0.02 {
            return None;
        }
        let n = g1.buf.len().min(g2.buf.len());
        if ink_ratio(&g1.buf[..n]) < BLANK_INK && ink_ratio(&g2.buf[..n]) < BLANK_INK {
            continue;
        }
        let mut j = 0;
        while j < n {
            if (g1.buf[j] as i32 - g2.buf[j] as i32).unsigned_abs() > 12 {
                diffs += 1;
            }
            tot += 1;
            j += 7;
        }
    }
    if tot == 0 {
        return None;
    }
    Some(1.0 - diffs as f32 / tot as f32)
}
