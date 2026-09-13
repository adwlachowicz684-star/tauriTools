//! 极简 base64（标准字母表 + '=' 填充）。
//! ------------------------------------------------------------------
//! 只为本插件的图标传输服务：把数据目录里的图标文件转成 data URI 给沙箱里的前端显示，
//! 以及把前端 fetch 到的图标内容存回磁盘。
//! 为此拉一个 base64 crate 不值得，且本模块逻辑短、可单测，手写更可控。

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 反查表：字节值 → 6 位值；非法字符为 0xFF。
fn decode_table() -> [u8; 256] {
    let mut t = [0xFFu8; 256];
    for (i, &c) in ALPHABET.iter().enumerate() {
        t[c as usize] = i as u8;
    }
    t
}

pub fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        // 不足 3 字节时补 '='，保证是合法的标准 base64
        out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// 宽松解码：忽略换行与空白；遇非法字符报错。
pub fn decode(input: &str) -> Result<Vec<u8>, String> {
    let table = decode_table();
    let mut out: Vec<u8> = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0;

    for c in input.chars() {
        if c.is_ascii_whitespace() || c == '=' { continue; }
        if !c.is_ascii() { return Err("base64 含非 ASCII 字符".into()); }
        let v = table[c as usize];
        if v == 0xFF { return Err(format!("base64 非法字符: {c}")); }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

/// 二进制 → data URI（按扩展名猜 MIME；认不出就用 octet-stream）。
pub fn data_uri(bytes: &[u8], ext: &str) -> String {
    let mime = match ext.to_lowercase().as_str() {
        "ico" => "image/x-icon",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    format!("data:{mime};base64,{}", encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for len in 0..64usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let enc = encode(&data);
            assert_eq!(decode(&enc).unwrap(), data, "len={len}");
        }
    }

    #[test]
    fn known_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn rejects_bad_input() {
        assert!(decode("Zm9v!").is_err());
    }
}
