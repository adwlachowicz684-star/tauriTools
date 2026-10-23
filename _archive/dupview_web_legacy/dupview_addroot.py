# -*- coding: utf-8 -*-
"""为新添加的文件夹做增量扫描 + 完整比对（重名家族 + 相似度 + 文本一致/包含判定），
   结果合并进 dupview/dup_map.json，并把新家族/新对/新标注同步写回中间文件，
   保证后续离线管线(make_all_map.py)不会丢掉新增内容。

独立运行：
    python dupview_addroot.py "<文件夹绝对路径>" ["显示名"]
由 dupview_server.py 以后台线程调用：
    scan_async(path, name)
"""
import os, re, sys, json, time, hashlib, difflib, zipfile, shutil
import subprocess, tempfile, threading
from collections import defaultdict
from io import BytesIO

import fitz
from PIL import Image
import pytesseract

try:
    import numpy as _np
except Exception:
    _np = None

# ---- 数据根 ----------------------------------------------------------------
# 本模块是路径的**唯一来源**：dupview_server.py 直接复用下面的 OUT / WORK，
# 两边各写一份常量必然漂移。
# 默认落在面板的 appData 下 —— <appDataDir>/dupview。由面板拉起后端时，Rust
# 侧会显式传 DUPVIEW_DATA（面板自己算的绝对路径），所以正常路径走的是环境变量。
DATA = os.environ.get("DUPVIEW_DATA") or os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "com.nexus.panel", "dupview")
OUT = os.path.abspath(DATA)        # 主索引 / 缩略图 / 删除与「已解决」记录
WORK = os.path.join(OUT, "_work")  # 中间管线缓存（家族 / 相似度 / OCR / 全文）
IMGDIR = os.path.join(OUT, "_imgs")
DOCXPDF = os.path.join(OUT, "_docx_pdf")
MAPF = os.path.join(OUT, "dup_map.json")
ROOTSF = os.path.join(OUT, "roots.json")
MARKF = os.path.join(OUT, "mark.json")
MD5CF = os.path.join(OUT, "md5cache.json")
FAMF = os.path.join(WORK, "dup_families.json")
SIMF = os.path.join(WORK, "dup_sim.json")
MD5IDXF = os.path.join(WORK, "md5.json")
OCRC = os.path.join(WORK, "dup_ocr_cache.json")
FULLC = os.path.join(WORK, "dup_fulltext_cache.json")
CHASHC = os.path.join(WORK, "dup_chash.json")
CPAIRF = os.path.join(WORK, "dup_content_pairs.json")
# 外部工具（LibreOffice 转 docx、tesseract OCR）不在插件内分发，
# 仍指向本机工具箱；换机器时用 DUPVIEW_BIN 覆盖，不用改代码。
BIN = os.environ.get("DUPVIEW_BIN") or r"C:\Users\Administrator\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\bin"
SOFFICE = os.path.join(BIN, "soffice.exe")
TESSERACT = os.path.join(BIN, "tesseract.cmd")

# 数据目录按需建出来：首次运行（数据还没迁过来）时不能因为目录不存在就整个挂掉
for _d in (OUT, WORK, IMGDIR, DOCXPDF):
    os.makedirs(_d, exist_ok=True)
SUBJ = ["语文", "数学", "英语", "物理", "化学", "生物", "历史", "地理", "政治"]
DEFAULT_ROOTS = [{"path": r"Z:\学习资源\教案\高中\试卷", "name": "试卷"},
                 {"path": r"Z:\学习资源\教案\高中\试卷_待改名", "name": "试卷_待改名"}]
YTHR = 0.3
CHTHR = 16        # 首页感知哈希海明距离上限（128bit，取候选对）
MAETH = 6.0       # 二级预筛：32x32 缩略图灰度平均绝对差上限
CSIMTHR = 0.98    # 逐页像素相似度确认阈值
BLANKINK = 0.002  # 墨迹占比低于此值视为近空白页，不参与内容判定
LOCK = threading.RLock()
STATUS = {"running": False, "path": "", "name": "", "phase": "", "done": 0, "total": 0,
          "msg": "", "err": "", "t0": 0.0, "t1": 0.0, "added": 0, "pairs": 0}

pytesseract.pytesseract.tesseract_cmd = TESSERACT


def lpath(p):
    p = os.path.abspath(p)
    return ("\\\\?\\UNC\\" + p[2:]) if p.startswith("\\\\") else ("\\\\?\\" + p)


def strip_lp(p):
    return re.sub(r"^\\\\\?\\", "", p)


def set_status(**kw):
    with LOCK:
        STATUS.update(kw)


def log(m):
    with LOCK:
        t0 = STATUS.get("t0") or time.time()
    print("[%ds] %s" % (int(time.time() - t0), m), flush=True)


# ---------------- 根目录配置 ----------------

def load_roots():
    if os.path.exists(ROOTSF):
        try:
            rs = json.load(open(ROOTSF, encoding="utf-8"))
            if isinstance(rs, list) and rs:
                return [{"path": r["path"], "name": r.get("name") or os.path.basename(r["path"].rstrip("\\/"))} for r in rs]
        except Exception:
            pass
    save_roots(DEFAULT_ROOTS)
    return [dict(r) for r in DEFAULT_ROOTS]


def save_roots(rs):
    os.makedirs(OUT, exist_ok=True)
    tmp = ROOTSF + ".tmp"
    json.dump(rs, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, ROOTSF)


# ---------------- 基础工具 ----------------

def subj_of(name, base=""):
    for k in SUBJ:
        if k in base or k in name:
            return k
    m = re.search(r"【([^】]+)】", name)
    return m.group(1) if m else "?"


def base_of(name):
    """去掉 _2/_3... 后缀得到撞名家族基底名。"""
    return re.sub(r"_(\d+)(\.\w+)$", r"\2", name)


def norm(s):
    return re.sub(r"\s+", "", s or "")


def md5_file(p):
    try:
        h = hashlib.md5()
        with open(lpath(p), "rb") as f:
            for c in iter(lambda: f.read(1 << 20), b""):
                h.update(c)
        return h.hexdigest()
    except Exception:
        return ""


def md5_of(p, cache):
    if p not in cache:
        cache[p] = md5_file(p)
    return cache[p]


def md5_group_mark(mp):
    """全局「同尺寸 → 同 MD5」分组：字节级完全相同的文件全部标 md5same（绿框）。
    不依赖重名家族，因此文件名不同、仅内容一致的副本也能配对。
    先按 size 分桶，桶内成员 ≥2 才计算哈希，避免全量重算。
    返回 True 表示标注有变化。"""
    bysize = defaultdict(list)
    for it in mp:
        sz = it.get("size")
        if not isinstance(sz, int) or sz <= 0:
            try:
                sz = os.path.getsize(lpath(it["path"]))
            except Exception:
                continue
            it["size"] = sz
        bysize[sz].append(it)
    changed = False
    for arr in bysize.values():
        if len(arr) < 2:
            continue
        byhash = defaultdict(list)
        for it in arr:
            h = md5_file(it["path"])
            if h:
                it["md5"] = h
                byhash[h].append(it)
        for g in byhash.values():
            if len(g) < 2:
                continue
            for it in g:
                if not it.get("md5same") or it.get("ylw"):
                    it["md5same"] = True
                    it["ylw"] = False
                    changed = True
    return changed


def docx_to_pdf(p, dest):
    td = tempfile.mkdtemp(prefix="dup_lo_")
    try:
        r = subprocess.run([SOFFICE, "--headless", "--convert-to", "pdf", "--outdir", td, p],
                           capture_output=True, timeout=180)
        if r.returncode != 0:
            return None
        for f in os.listdir(td):
            if f.lower().endswith(".pdf"):
                src = os.path.join(td, f)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copyfile(src, dest)
                return dest
        return None
    except Exception:
        return None
    finally:
        shutil.rmtree(td, ignore_errors=True)


def render_thumb(path, idx, ext):
    """渲染首页缩略图，返回页数。"""
    imgf = os.path.join(IMGDIR, idx + ".png")
    pages = 0
    try:
        if ext == ".docx":
            pdf = docx_to_pdf(lpath(path), os.path.join(DOCXPDF, idx + ".pdf"))
            if not pdf:
                return 0
            src = pdf
        else:
            src = lpath(path)
        d = fitz.open(src)
        pages = len(d)
        if pages:
            z = 1100 / d[0].rect.width
            pix = d[0].get_pixmap(matrix=fitz.Matrix(z, z), alpha=False)
            pix.save(lpath(imgf))
        d.close()
    except Exception:
        pass
    return pages


# ---------------- 文本提取（相似度用，3 页取样） ----------------

def docx_text(p):
    try:
        z = zipfile.ZipFile(lpath(p))
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
        xml = re.sub(r"<w:tab[^>]*/>", " ", xml)
        return norm(re.sub(r"<[^>]+>", "", xml))
    except Exception:
        return ""


def ocr_pdf_text(p):
    try:
        d = fitz.open(lpath(p))
        n = len(d)
        if n == 0:
            d.close()
            return ""
        best = ""
        for idx in sorted(set([n // 2, min(1, n - 1), 0])):
            pg = d[idx]
            z = 220 / pg.rect.width
            pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False)
            im = Image.open(BytesIO(pix.tobytes("png"))).convert("L")
            t = norm(pytesseract.image_to_string(im, lang="chi_sim+eng", config="--psm 6"))
            if len(t) > len(best):
                best = t
        d.close()
        return best
    except Exception:
        return ""


def sim_text_of(p, cache):
    """相似度取样文本：PDF 优先文本层（数字版 PDF 准确），文本层过薄或扫描件才用 OCR。"""
    if p in cache:
        return cache[p]
    if not os.path.exists(lpath(p)):
        return ""
    ext = os.path.splitext(p)[1].lower()
    if ext == ".docx":
        t = docx_text(p)
    elif ext == ".pdf":
        t = pdf_layer_text(p)
        if len(t) < 400:
            t2 = ocr_pdf_text(p)
            if len(t2) > len(t):
                t = t2
    else:
        t = ""
    cache[p] = t
    return t


# ---------------- 全文提取 + 像素比对（eq/sup/sub 判定用） ----------------

def pdf_layer_text(p):
    try:
        d = fitz.open(lpath(p))
        t = norm("".join(pg.get_text() for pg in d))
        d.close()
        return t
    except Exception:
        return ""


def ocr_pages(p, maxpg=6):
    try:
        d = fitz.open(lpath(p))
        n = len(d)
        if n == 0:
            d.close()
            return ""
        picks = sorted(set([0, n - 1, n // 2, n // 3, 2 * n // 3, n // 4]))[:maxpg]
        parts = []
        for i in picks:
            pg = d[i]
            z = 220 / pg.rect.width
            pix = pg.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False)
            im = Image.open(BytesIO(pix.tobytes("png"))).convert("L")
            parts.append(norm(pytesseract.image_to_string(im, lang="chi_sim+eng", config="--psm 6")))
        d.close()
        return "".join(parts)
    except Exception:
        return ""


def full_text(p, cache):
    if p in cache:
        return cache[p]
    if not os.path.exists(lpath(p)):
        return ""
    ext = os.path.splitext(p)[1].lower()
    if ext == ".docx":
        t = docx_text(p)
    elif ext == ".pdf":
        t = pdf_layer_text(p)
        if len(t) < 400:
            t = ocr_pages(p)
    else:
        t = ""
    cache[p] = t
    return t


def pix_sim(p1, p2):
    try:
        d1 = fitz.open(lpath(p1))
        d2 = fitz.open(lpath(p2))
        if len(d1) != len(d2):
            d1.close()
            d2.close()
            return None
        diffs = tot = 0
        for i in range(len(d1)):
            a, b = d1[i], d2[i]
            z = 900 / max(a.rect.width, b.rect.width)
            s1 = a.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False).samples
            s2 = b.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False).samples
            n = min(len(s1), len(s2))
            if _np is not None:
                v1 = _np.frombuffer(s1, dtype=_np.uint8)[:n][::7].astype(_np.int16)
                v2 = _np.frombuffer(s2, dtype=_np.uint8)[:n][::7].astype(_np.int16)
                tot += int(v1.size)
                diffs += int((_np.abs(v1 - v2) > 12).sum())
            else:
                for j in range(0, n, 7):
                    tot += 1
                    if abs(s1[j] - s2[j]) > 12:
                        diffs += 1
        d1.close()
        d2.close()
        return (1 - diffs / tot) if tot else 0.0
    except Exception:
        return None


# ---------------- 全局内容一致检测（跨文件名/家族/尺寸） ----------------

def _load_json(path, default):
    try:
        if os.path.exists(path):
            return json.load(open(path, encoding="utf-8"))
    except Exception:
        pass
    return default


def thumb_hash(idx):
    """缓存首页缩略图 → 128bit 感知哈希（dHash64 + aHash64），返回 hex 或 ''。"""
    f = os.path.join(IMGDIR, idx + ".png")
    if not os.path.exists(lpath(f)):
        return ""
    try:
        im = Image.open(lpath(f)).convert("L").resize((32, 32), Image.Resampling.LANCZOS)
        dp = list(im.resize((9, 8), Image.Resampling.LANCZOS).getdata())
        dh = 0
        for r in range(8):
            for c in range(8):
                dh = (dh << 1) | (1 if dp[r * 9 + c] > dp[r * 9 + c + 1] else 0)
        ap = list(im.resize((8, 8), Image.Resampling.LANCZOS).getdata())
        avg = sum(ap) / len(ap)
        ah = 0
        for v in ap:
            ah = (ah << 1) | (1 if v > avg else 0)
        return "%016x%016x" % (dh, ah)
    except Exception:
        return ""


def _ham(h1, h2):
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count("1")
    except Exception:
        return 999


def _pkey(p1, p2):
    """配对缓存键：与文件先后顺序无关，保证缓存稳定命中。"""
    return "|".join(sorted((p1, p2)))


def thumb32(idx):
    """缓存首页缩略图 → 32x32 灰度像素列表（二级预筛用）。"""
    f = os.path.join(IMGDIR, idx + ".png")
    if not os.path.exists(lpath(f)):
        return None
    try:
        im = Image.open(lpath(f)).convert("L").resize((32, 32), Image.Resampling.LANCZOS)
        return list(im.getdata())
    except Exception:
        return None


def content_pix_sim(p1, p2):
    """内容一致检测用：页数与各页尺寸校验 + 逐页像素比对。
    近空白页（损坏件渲染失败 / 纯白页）不参与判定，避免「两页都空白」被判成完全一致；
    全部页都无有效内容时返回 None（无法确认）。"""
    try:
        d1 = fitz.open(lpath(p1))
        d2 = fitz.open(lpath(p2))
        if len(d1) != len(d2):
            d1.close()
            d2.close()
            return None
        diffs = tot = 0
        for a, b in zip(d1, d2):
            w1, h1, w2, h2 = a.rect.width, a.rect.height, b.rect.width, b.rect.height
            if not (w1 and h1 and w2 and h2):
                d1.close()
                d2.close()
                return None
            if abs(w1 - w2) / max(w1, w2) > 0.02 or abs(h1 - h2) / max(h1, h2) > 0.02:
                d1.close()
                d2.close()
                return None
            z = 900 / max(w1, w2)
            s1 = a.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False).samples
            s2 = b.get_pixmap(matrix=fitz.Matrix(z, z), colorspace=fitz.csGRAY, alpha=False).samples
            n = min(len(s1), len(s2))
            if _np is not None:
                v1 = _np.frombuffer(s1, dtype=_np.uint8)[:n].astype(_np.int16)
                v2 = _np.frombuffer(s2, dtype=_np.uint8)[:n].astype(_np.int16)
                if max(int((v1 < 200).sum()), int((v2 < 200).sum())) / max(n, 1) < BLANKINK:
                    continue
                v1, v2 = v1[::7], v2[::7]
                tot += int(v1.size)
                diffs += int((_np.abs(v1 - v2) > 12).sum())
            else:
                step = max(n // 4000, 1)
                dark = sum(1 for i in range(0, n, step) if s1[i] < 200 or s2[i] < 200)
                if dark / max(n // step, 1) < BLANKINK:
                    continue
                for j in range(0, n, 7):
                    tot += 1
                    if abs(s1[j] - s2[j]) > 12:
                        diffs += 1
        d1.close()
        d2.close()
        if not tot:
            return None
        return 1 - diffs / tot
    except Exception:
        return None


def content_group_mark(mp, mark):
    """全局内容一致检测：首页感知哈希取候选 → 32x32 缩略图预筛 → 逐页像素比对确认
    → mark 记 eq（蓝框「文本一致」）。
    不依赖文件名、撞名家族与字节 MD5，因此改名、改尺寸、含水印的同一份试卷也能配对。
    哈希与配对结果分别缓存到 dup_chash.json / dup_content_pairs.json，重复扫描只需增量计算。
    返回 True 表示 mark 有变化。"""
    hashc = _load_json(CHASHC, {})
    pairc = _load_json(CPAIRF, {})
    byidx, cand, miss = {}, [], 0
    for it in mp:
        if not it.get("pages"):
            continue
        p = it["path"]
        h = hashc.get(p) or ""
        if not h:
            h = thumb_hash(it.get("idx") or "")
            if not h:
                miss += 1
                continue
            hashc[p] = h
        byidx[p] = it.get("idx") or ""
        cand.append((h, it.get("pages"), p))
    log("内容一致检测：参与 %d 个文件（缩略图缺失 %d 个）" % (len(cand), miss))

    # 1) 首页哈希 + 页数 → 候选对（带出已缓存判定，保证重跑也能回填标注）
    bypage = defaultdict(list)
    for h, pg, p in cand:
        bypage[pg].append((h, p))
    pairs = []
    for arr in bypage.values():
        if len(arr) < 2:
            continue
        for i in range(len(arr)):
            hi, pi = arr[i]
            for j in range(i + 1, len(arr)):
                hj, pj = arr[j]
                if _ham(hi, hj) <= CHTHR:
                    pairs.append((pi, pj, pairc.get(_pkey(pi, pj))))
    log("内容一致检测：哈希候选对 %d（已缓存 %d）"
        % (len(pairs), sum(1 for x in pairs if x[2] is not None)))

    # 2) 二级预筛：32x32 缩略图灰度平均绝对差（廉价，滤掉模板相似但内容不同的对）
    arrc = {}
    keep = []
    for pa, pb, sim in pairs:
        if sim is not None:
            keep.append((pa, pb, sim))
            continue
        for p in (pa, pb):
            if p not in arrc:
                arrc[p] = thumb32(byidx.get(p, ""))
        a1, a2 = arrc[pa], arrc[pb]
        if a1 is None or a2 is None:
            keep.append((pa, pb, None))
            continue
        mae = sum(abs(x - y) for x, y in zip(a1, a2)) / len(a1)
        if mae <= MAETH:
            keep.append((pa, pb, None))
    log("内容一致检测：待确认 %d 对" % sum(1 for x in keep if x[2] is None))

    # 3) 逐页像素比对确认
    todo = sum(1 for x in keep if x[2] is None)
    set_status(phase="内容一致检测", done=0, total=todo,
               msg="待确认 %d 对，逐页像素比对" % todo)
    changed = False
    ok = 0
    byp = {it["path"]: it for it in mp}
    for n, (pa, pb, sim) in enumerate(keep):
        if sim is None:
            r = content_pix_sim(pa, pb)
            sim = -1.0 if r is None else round(float(r), 4)
            pairc[_pkey(pa, pb)] = sim
        if sim >= CSIMTHR:
            ok += 1
            for p in (pa, pb):
                if not mark.get(p):
                    mark[p] = "eq"
                    changed = True
                it = byp.get(p)
                if it is not None:
                    try:
                        cur = float(it.get("sim") or 0)
                    except Exception:
                        cur = 0.0
                    if sim > cur:
                        it["sim"] = "%.2f" % sim
                        changed = True
        if todo and ((n + 1) % 10 == 0 or n + 1 == len(keep)):
            set_status(done=min(n + 1, todo),
                       msg="内容一致检测 %d/%d，已确认 %d 对" % (min(n + 1, todo), todo, ok))
    log("内容一致检测：确认 %d 对像素一致" % ok)
    with LOCK:
        _atomic_dump(hashc, CHASHC)
        _atomic_dump(pairc, CPAIRF)
    return changed


def apply_marks(mp, mark):
    """把 mark（eq/sup/sub）落到 txtsame/sup/sub/ylw 字段。返回 True 表示字段有变化。"""
    changed = False
    for it in mp:
        k = mark.get(it["path"])
        t, s1, s2 = (k == "eq"), (k == "sup"), (k == "sub")
        if (it.get("txtsame") != t) or (it.get("sup") != s1) or (it.get("sub") != s2):
            changed = True
        it["txtsame"], it["sup"], it["sub"] = t, s1, s2
        try:
            s = float(it.get("sim") or 0)
        except Exception:
            s = 0.0
        y = bool(it.get("fam")) and (not it.get("md5same")) and (not k) and s > YTHR
        if it.get("ylw") != y:
            changed = True
        it["ylw"] = y
    return changed


def refresh_global_marks(mp):
    """全局标注刷新：MD5 相同（绿框）+ 内容一致（蓝框）。返回 (map 有变化, mark 有变化)。"""
    m_ch = md5_group_mark(mp)
    mark = _load_json(MARKF, {})
    k_ch = content_group_mark(mp, mark)
    a_ch = apply_marks(mp, mark)
    if k_ch:
        with LOCK:
            _atomic_dump(mark, MARKF)
    return (m_ch or a_ch or k_ch), k_ch


def judge_pair(pa, pb, full_cache):
    """判定文本一致/包含关系，返回 (kind_a, kind_b) 或 (None, None)。"""
    ta = full_text(pa, full_cache)
    tb = full_text(pb, full_cache)
    if (not ta or len(ta) < 60) or (not tb or len(tb) < 60):
        ps = pix_sim(pa, pb)
        if ps is not None and ps >= 0.98:
            return "eq", "eq"
        return None, None
    sa, sb = sorted([ta, tb], key=len)
    sm = difflib.SequenceMatcher(None, sa, sb)
    cover = sum(b.size for b in sm.get_matching_blocks()) / len(sa)
    ratio = difflib.SequenceMatcher(None, ta, tb).ratio()
    lr = len(ta) / len(tb) if len(tb) else 0
    lr = max(lr, 1 / lr) if lr else 0
    if cover >= 0.95 and lr >= 1.5:
        if len(ta) >= len(tb):
            return "sup", "sub"
        return "sub", "sup"
    if ratio >= 0.999 and lr < 1.5:
        return "eq", "eq"
    return None, None


# ---------------- 主流程 ----------------

def _atomic_dump(obj, path, indent=1):
    tmp = path + ".tmp"
    json.dump(obj, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=indent)
    os.replace(tmp, path)


def _scan_root(root_path, name=""):
    root_path = os.path.abspath(root_path)
    if not os.path.isdir(lpath(root_path)):
        raise RuntimeError("目录不存在或不可访问: %s" % root_path)
    name = (name or os.path.basename(root_path.rstrip("\\/")) or root_path).strip()

    set_status(phase="收集文件", msg="正在遍历 " + root_path, done=0, total=0)
    found = []
    for dp, dn, fn in os.walk(lpath(root_path)):
        for f in fn:
            if f.startswith("~$"):
                continue
            if os.path.splitext(f)[1].lower() not in (".pdf", ".docx"):
                continue
            found.append(strip_lp(os.path.abspath(os.path.join(dp, f))))
    found = sorted(set(found))
    log("根目录 %s 下发现文档 %d 个" % (name, len(found)))

    with LOCK:
        mp = json.load(open(MAPF, encoding="utf-8")) if os.path.exists(MAPF) else []
    bypath = {it["path"]: it for it in mp}
    new_paths = [p for p in found if p not in bypath]
    set_status(phase="新增文件", msg="待新增 %d 个（已在库 %d 个）" % (len(new_paths), len(found) - len(new_paths)),
               done=0, total=len(new_paths))
    log("新增 %d 个，已在库 %d 个" % (len(new_paths), len(found) - len(new_paths)))

    # 1) 分配 idx 并渲染缩略图
    used = set(it["idx"] for it in mp)
    nxt = 0
    for it in mp:
        if str(it.get("idx", "")).isdigit():
            nxt = max(nxt, int(it["idx"]) + 1)
    os.makedirs(lpath(IMGDIR), exist_ok=True)
    os.makedirs(lpath(DOCXPDF), exist_ok=True)
    set_status(phase="渲染缩略图", done=0, total=len(new_paths))
    for i, p in enumerate(new_paths):
        while ("%03d" % nxt) in used:
            nxt += 1
        idx = "%03d" % nxt
        used.add(idx)
        nxt += 1
        nm = os.path.basename(p)
        ext = os.path.splitext(nm)[1].lower()
        try:
            sz = os.path.getsize(lpath(p))
        except Exception:
            sz = 0
        rel = os.path.dirname(p)[len(root_path):].strip("\\")
        pages = render_thumb(p, idx, ext)
        mp.append({"idx": idx, "name": nm, "path": p, "pages": pages,
                   "subj": subj_of(nm, name + "\\" + rel), "fam": "",
                   "sim": "0.00", "img": "_imgs/%s.png" % idx, "doc": ext != ".pdf",
                   "md5same": False, "txtsame": False, "sup": False, "sub": False,
                   "ylw": False, "size": sz, "exists": True})
        if (i + 1) % 5 == 0 or i + 1 == len(new_paths):
            set_status(done=i + 1, msg="%s（%d 页）" % (nm[:48], pages))
            log("  缩略图 %d/%d %s" % (i + 1, len(new_paths), nm[:50]))

    newset = set(new_paths)
    if not new_paths:
        set_status(phase="全局内容一致检测", msg="比对全库内容一致的重复件")
        ch, _ = refresh_global_marks(mp)
        if ch:
            with LOCK:
                _atomic_dump(mp, MAPF)
            log("已刷新全局标注（MD5 相同 / 内容一致）")
        set_status(phase="完成", msg="没有新文件需要处理", added=0, pairs=0)
        log("没有新文件，结束")
        return {"added": 0, "pairs": 0, "families": 0}

    # 2) 重名家族：按“去掉 _N 后缀的基底名”分组，仅处理含新文件且成员≥2 的组
    groups = defaultdict(list)
    for it in mp:
        groups[base_of(it["name"])].append(it)
    fam_groups = {b: ms for b, ms in groups.items()
                  if len(ms) >= 2 and any(m["path"] in newset for m in ms)}
    fam_new = {b: ms for b, ms in fam_groups.items() if len(ms) == sum(1 for m in ms if m["path"] in newset)}
    log("含新文件的重名家族: %d（其中全新家族 %d）" % (len(fam_groups), len(fam_new)))

    # 3) 家族内两两比对（只要有一侧是新文件）
    pairs = []
    for b, ms in fam_groups.items():
        for i in range(len(ms)):
            for j in range(i + 1, len(ms)):
                if ms[i]["path"] in newset or ms[j]["path"] in newset:
                    pairs.append((b, ms[i], ms[j]))
    set_status(phase="相似度比对", done=0, total=len(pairs), pairs=len(pairs))
    log("待比对 %d 对" % len(pairs))

    md5c = {}
    if os.path.exists(MD5CF):
        try:
            md5c = json.load(open(MD5CF, encoding="utf-8"))
        except Exception:
            md5c = {}
    if os.path.exists(MD5IDXF):  # 复用既有 md5->文件 索引，避免重复哈希
        try:
            for h, arr in json.load(open(MD5IDXF, encoding="utf-8")).items():
                for r in arr:
                    md5c.setdefault(strip_lp(r["path"]), h)
        except Exception:
            pass
    simc = {}
    if os.path.exists(OCRC):
        try:
            simc = json.load(open(OCRC, encoding="utf-8"))
        except Exception:
            simc = {}
    fullc = {}
    if os.path.exists(FULLC):
        try:
            fullc = json.load(open(FULLC, encoding="utf-8"))
        except Exception:
            fullc = {}
    mark = {}
    if os.path.exists(MARKF):
        try:
            mark = json.load(open(MARKF, encoding="utf-8"))
        except Exception:
            mark = {}

    simmax, md5set, results = {}, set(), []
    for n, (b, a, bb) in enumerate(pairs):
        ma, mb = md5_of(a["path"], md5c), md5_of(bb["path"], md5c)
        rec = {"base": b, "a": a["name"], "b": bb["name"], "pa": a["path"], "pb": bb["path"],
               "ea": os.path.splitext(a["name"])[1].lower(), "eb": os.path.splitext(bb["name"])[1].lower(),
               "md5same": bool(ma) and ma == mb}
        if rec["md5same"]:
            rec["sim"], rec["how"] = 1.0, "md5"
        else:
            ta = sim_text_of(a["path"], simc)
            tb = sim_text_of(bb["path"], simc)
            if not ta and not tb:
                rec["sim"], rec["how"] = 0.0, "notext"
            else:
                rec["sim"] = round(difflib.SequenceMatcher(None, ta, tb).ratio(), 4)
                rec["how"] = "ocr"
        results.append(rec)
        if (n + 1) % 5 == 0 or n + 1 == len(pairs):
            set_status(done=n + 1, msg="%s vs %s · %.3f" % (a["name"][:24], bb["name"][:24], rec["sim"]))
            log("  比对 %d/%d %.3f %s" % (n + 1, len(pairs), rec["sim"], b[:44]))
        for side, pth in (("a", a["path"]), ("b", bb["path"])):
            simmax[pth] = max(simmax.get(pth, 0), rec["sim"])
        if rec["md5same"]:
            md5set.add(a["path"])
            md5set.add(bb["path"])
        if rec["sim"] >= 0.9 and not rec["md5same"]:
            ka, kb = judge_pair(a["path"], bb["path"], fullc)
            if ka and a["path"] not in mark:
                mark[a["path"]] = ka
            if kb and bb["path"] not in mark:
                mark[bb["path"]] = kb
            if ka:
                log("    判定 %s=%s / %s=%s" % (a["name"][:22], ka, bb["name"][:22], kb))

    # 4) 回填到 map（非破坏：已有 fam/mark 不覆盖，sim/md5same 取更强结论）
    md5_group_mark(mp)  # 全局 MD5 相同（跨家族，文件名不同也算）
    for b, ms in fam_groups.items():
        for m in ms:
            if not m.get("fam"):
                m["fam"] = b
    for it in mp:
        p = it["path"]
        if p in simmax:
            cur = 0.0
            try:
                cur = float(it.get("sim") or 0)
            except Exception:
                cur = 0.0
            it["sim"] = "%.2f" % max(cur, simmax[p])
        if p in md5set:
            it["md5same"] = True
    content_group_mark(mp, mark)  # 全局内容一致（跨家族、改名、改尺寸）
    apply_marks(mp, mark)

    # 5) 落盘
    set_status(phase="写入结果", msg="保存 dup_map.json")
    with LOCK:
        _atomic_dump(mp, MAPF)
        _atomic_dump(md5c, MD5CF)
        _atomic_dump(simc, OCRC)
        _atomic_dump(fullc, FULLC)
        _atomic_dump(mark, MARKF)
        _sync_intermediate(root_path, name, mp, fam_new, results)

    set_status(phase="完成", msg="新增 %d 个文件，比对 %d 对" % (len(new_paths), len(pairs)),
               added=len(new_paths), pairs=len(pairs))
    log("完成：新增 %d，比对 %d 对" % (len(new_paths), len(pairs)))
    return {"added": len(new_paths), "pairs": len(pairs), "families": len(fam_new)}


def _sync_intermediate(root_path, root_name, mp, fam_new, results):
    """把新家族/新对写回 dup_families.json 与 dup_sim.json，保持离线管线一致。"""
    bypath = {it["path"]: it for it in mp}
    # dup_families.json
    try:
        famd = json.load(open(FAMF, encoding="utf-8")) if os.path.exists(FAMF) else {"rows": [], "families": {}}
        famd.setdefault("rows", [])
        famd.setdefault("families", {})
        have = set(r.get("path") for r in famd["rows"])
        for base, ms in fam_new.items():
            for m in ms:
                rel = os.path.dirname(m["path"])
                if rel.startswith(root_path):
                    rel = rel[len(root_path):].strip("\\")
                row = {"z": root_name, "dir": rel, "old": m["name"], "new": m["name"],
                       "base": base, "tag": None, "path": m["path"]}
                if m["path"] not in have:
                    famd["rows"].append(row)
                    have.add(m["path"])
            famd["families"][base] = [{"z": root_name,
                                       "dir": (os.path.dirname(m["path"])[len(root_path):].strip("\\")
                                               if m["path"].startswith(root_path) else os.path.dirname(m["path"])),
                                       "old": m["name"], "path": m["path"], "new": m["name"], "tag": None}
                                      for m in ms]
        _atomic_dump(famd, FAMF)
    except Exception as e:
        log("警告: dup_families.json 同步失败: %s" % e)
    # dup_sim.json
    try:
        simd = json.load(open(SIMF, encoding="utf-8")) if os.path.exists(SIMF) else {"results": []}
        simd.setdefault("results", [])
        seen = set((r["pa"], r["pb"]) for r in simd["results"])
        for r in results:
            if (r["pa"], r["pb"]) not in seen:
                simd["results"].append(r)
                seen.add((r["pa"], r["pb"]))
        _atomic_dump(simd, SIMF)
    except Exception as e:
        log("警告: dup_sim.json 同步失败: %s" % e)


def rename_in_plan(old_path, new_path, new_name):
    """手工改名后同步 dup_families.json：该条目 old/new/base/path 跟随新名，
    并从旧家族移入新基底家族，保证离线改名计划与磁盘实际文件名一致。"""
    if not os.path.exists(FAMF):
        return False
    famd = json.load(open(FAMF, encoding="utf-8"))
    rows = famd.get("rows") or []
    fams = famd.get("families") or {}
    row = next((r for r in rows if r.get("path") == old_path), None)
    if row is None:
        return False
    old_base = row.get("base") or ""
    new_base = base_of(new_name)
    row["old"] = new_name
    row["new"] = new_name
    row["base"] = new_base
    row["path"] = new_path
    moved = None
    lst = fams.get(old_base)
    if lst is not None:
        for i, m in enumerate(lst):
            if m.get("path") == old_path:
                moved = lst.pop(i)
                break
        if not lst:
            del fams[old_base]
    if moved is None:
        moved = {"z": row.get("z"), "dir": row.get("dir"), "tag": row.get("tag")}
    moved["old"] = new_name
    moved["new"] = new_name
    moved["path"] = new_path
    fams.setdefault(new_base, []).append(moved)
    famd["rows"] = rows
    famd["families"] = fams
    _atomic_dump(famd, FAMF)
    return True


def scan_root(root_path, name=""):
    """同步执行一次扫描（带状态记录）。"""
    with LOCK:
        STATUS.update(running=True, path=root_path, name=name, phase="准备", done=0, total=0,
                      msg="", err="", t0=time.time(), t1=0.0, added=0, pairs=0)
    try:
        r = _scan_root(root_path, name)
        with LOCK:
            STATUS.update(running=False, t1=time.time())
        return r
    except Exception as e:
        with LOCK:
            STATUS.update(running=False, phase="失败", err=str(e)[:300], t1=time.time())
        log("扫描失败: %s" % e)
        return {"ok": False, "err": str(e)[:300]}


def scan_async(root_path, name=""):
    """后台线程扫描（供服务端调用）。已在扫描中则直接返回 False。"""
    with LOCK:
        if STATUS.get("running"):
            return False
    t = threading.Thread(target=scan_root, args=(root_path, name), daemon=True)
    t.start()
    return True


def _scan_all():
    """后台线程体：依次增量扫描全部已登记根目录。"""
    t0 = time.time()
    with LOCK:
        STATUS.update(running=True, path="", name="全部根目录", phase="准备", done=0, total=0,
                      msg="", err="", t0=t0, t1=0.0, added=0, pairs=0)
    ta = tp = 0
    try:
        rs = load_roots()
        log("开始增量扫描 %d 个根目录" % len(rs))
        for i, r in enumerate(rs):
            set_status(name="全部根目录 (%d/%d) %s" % (i + 1, len(rs), r["name"]),
                       phase="收集文件", done=0, total=0, msg=r["path"])
            try:
                res = _scan_root(r["path"], r["name"])
            except Exception as e:
                log("跳过根目录 %s: %s" % (r["name"], e))
                continue
            ta += res.get("added", 0)
            tp += res.get("pairs", 0)
        set_status(running=False, name="全部根目录", phase="完成", done=0, total=0,
                   msg="共新增 %d 个文件，比对 %d 对" % (ta, tp), added=ta, pairs=tp, t1=time.time())
        log("全部根目录扫描完成：新增 %d，比对 %d 对" % (ta, tp))
    except Exception as e:
        set_status(running=False, phase="失败", err=str(e)[:300], t1=time.time())
        log("全部根目录扫描失败: %s" % e)
    return {"added": ta, "pairs": tp}


def scan_roots_async():
    """后台依次扫描全部已登记根目录（读取各目录里新放进去的文件）。已在扫描中则返回 False。"""
    with LOCK:
        if STATUS.get("running"):
            return False
    threading.Thread(target=_scan_all, daemon=True).start()
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    p = sys.argv[1]
    nm = sys.argv[2] if len(sys.argv) > 2 else ""
    rs = load_roots()
    if not any(os.path.normcase(r["path"]) == os.path.normcase(os.path.abspath(p)) for r in rs):
        rs.append({"path": os.path.abspath(p), "name": nm or os.path.basename(os.path.abspath(p).rstrip("\\/"))})
        save_roots(rs)
        print("已登记根目录:", p)
    out = scan_root(p, nm)
    print("结果:", out)