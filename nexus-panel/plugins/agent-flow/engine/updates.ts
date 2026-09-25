/**
 * 订阅源更新检测 —— B站 UP 主 / 微信公众号 / 小红书。
 *
 * 这个模块是纯函数，不碰网络：抓取由 Rust 侧完成，这里只负责
 * 解析响应、挑出最新一条、与上次记录的基线比对。
 * 这样核心逻辑可以脱离 Tauri 直接单测。
 */

import { UPDATE_SOURCE_META, type UpdateTarget } from '../types';

export type FeedItem = {
  /** 稳定唯一标识。B站用 bvid，RSS 用 guid 或 link */
  id: string;
  title: string;
  url: string;
  /** 发布时间，原始字符串，无法解析时为空 */
  date: string;
};

export type ParseResult = {
  items: FeedItem[];
  /** 非致命问题（如部分条目缺 id 已用链接兜底） */
  warnings: string[];
  /** 致命错误：响应格式不对、接口返回错误码 */
  error: string | null;
};

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/** 去掉 CDATA 包裹与外层空白 */
function unwrap(raw: string): string {
  const t = raw.trim();
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  return (m ? m[1] : t).trim();
}

/** 最小可用的文本反转义：够覆盖 feed 里常见的五种实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // 放最后，避免把 &lt; 里的 & 又拆开
}

/** 取出第一个 <tag>...</tag> 的内容 */
function tagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decodeEntities(unwrap(m[1])) : '';
}

/** 取出所有 <tag ...>...</tag> 的完整片段 */
function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

/** 取某个标签上的属性值 */
function attrOf(block: string, attr: string): string {
  const m = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i').exec(block);
  return m ? decodeEntities(m[1]) : '';
}

/* ------------------------------------------------------------------ */
/* RSS 2.0 / Atom 解析（公众号节点用，B站的 RSS 模式也复用）            */
/* ------------------------------------------------------------------ */

/** 从 Atom 的 <link> 里取地址：优先 rel="alternate"，其次任何 href */
function atomLink(entry: string): string {
  const links = entry.match(/<link\b[^>]*>/gi) ?? [];
  for (const l of links) {
    if (/rel\s*=\s*["']alternate["']/i.test(l)) {
      const href = attrOf(l, 'href');
      if (href) return href;
    }
  }
  for (const l of links) {
    const href = attrOf(l, 'href');
    if (href) return href;
  }
  return '';
}

/**
 * 解析 RSS 2.0 或 Atom。
 *
 * 用正则而不是 DOMParser：这段逻辑要能在 node --test 里跑，
 * 而沙盒和 CI 都未必有 DOM。feed 格式本身很规整，正则够用。
 */
export function parseFeed(xml: string): ParseResult {
  const warnings: string[] = [];
  if (!xml || !xml.trim()) {
    return { items: [], warnings, error: '响应为空' };
  }
  if (!/[<>]/.test(xml)) {
    return { items: [], warnings, error: '响应不是 XML（可能是错误页或需要登录）' };
  }

  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = isAtom ? tagBlocks(xml, 'entry') : tagBlocks(xml, 'item');

  if (blocks.length === 0) {
    return {
      items: [],
      warnings,
      error: isAtom ? 'Atom 里没有 entry' : 'RSS 里没有 item（公众号源常因失效返回空列表）',
    };
  }

  const items: FeedItem[] = [];
  for (const b of blocks) {
    const title = tagText(b, 'title');
    const url = isAtom ? atomLink(b) : tagText(b, 'link');
    const date = isAtom
      ? (tagText(b, 'updated') || tagText(b, 'published'))
      : tagText(b, 'pubDate');
    // 标识优先级：guid/id > link > title
    // 有些源的 guid 每次抓取都变（带随机参数），这时 link 反而更稳
    const id = (isAtom ? tagText(b, 'id') : tagText(b, 'guid')) || url || title;
    if (!id) continue;
    if (!url) warnings.push(`条目「${title.slice(0, 20)}」没有链接`);
    items.push({ id, title, url, date });
  }

  if (items.length === 0) {
    return { items, warnings, error: '所有条目都缺少可用标识' };
  }
  return { items, warnings, error: null };
}

/* ------------------------------------------------------------------ */
/* B站                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从各种 B站 链接里提取 UID。
 * 支持：space.bilibili.com/123 / 带 ?spm_id_from= 参数 / 纯数字 / /uid/123
 */
export function extractBiliUid(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const patterns = [
    /space\.bilibili\.com\/(\d+)/i,
    /[?&]mid=(\d+)/i,
    /^\s*(\d{1,15})\s*$/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[1];
  }
  return null;
}

export type BiliApiResult = ParseResult & {
  /** 接口返回的风控提示，界面上要显式告诉用户 */
  riskMessage?: string;
};

/**
 * 解析 B站 投稿列表接口。
 *
 * 响应形如：
 * { code: 0, data: { list: { vlist: [ { bvid, title, created, author } ] } } }
 *
 * 几个已知错误码单独提示，否则用户只看到 "code:-352" 根本不知道要填 Cookie。
 */
export function parseBiliApi(json: string): BiliApiResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { items: [], warnings, error: '接口返回的不是 JSON（可能被风控页拦截）' };
  }

  const root = data as { code?: number; message?: string; data?: { list?: { vlist?: BiliVideo[] } } };
  const code = root.code;

  if (code !== 0) {
    const msg = root.message ?? '';
    const hint: Record<number, string> = {
      '-352': '触发 B站 风控（code -352）。需要填完整 Cookie，或改用 RSS 方式',
      '-401': '需要登录。请填完整 Cookie',
      '-403': '被拒绝（403）。多半是缺 Referer 或 Cookie 不完整，建议改用 RSS 方式',
      '-404': 'UID 不存在，检查一下主页链接',
      '-412': '请求过于频繁，稍后再试',
    };
    // code 可能是 undefined（接口没返回 code），不能直接当索引
    const extra = (code !== undefined ? hint[code] : undefined) ?? `错误码 ${code}`;
    return {
      items: [], warnings,
      error: `B站接口报错：${extra}${msg ? `（${msg}）` : ''}`,
      riskMessage: code === -352 || code === -401 || code === -403 ? extra : undefined,
    };
  }

  const vlist = root.data?.list?.vlist;
  if (!Array.isArray(vlist)) {
    return { items: [], warnings, error: '接口没返回 vlist，可能 UID 有误或接口已变更' };
  }
  if (vlist.length === 0) {
    return { items: [], warnings, error: '这个 UP 主还没有投稿' };
  }

  const items: FeedItem[] = vlist
    // 用类型谓词而非普通 filter：否则 TS 不知道 bvid 已经非空，
    // 会把 id 推断成 string | undefined，与 FeedItem 不匹配
    .filter((v): v is BiliVideo & { bvid: string } => !!v?.bvid)
    .map((v) => ({
      id: v.bvid,
      title: v.title ?? '(无标题)',
      url: `https://www.bilibili.com/video/${v.bvid}`,
      date: v.created ? new Date(v.created * 1000).toISOString() : '',
    }));

  if (items.length === 0) {
    return { items, warnings, error: '投稿列表里没有可识别的视频' };
  }
  return { items, warnings, error: null };
}

type BiliVideo = { bvid?: string; title?: string; created?: number; author?: string };

/**
 * 拼出 B站 投稿列表接口地址。
 *
 * 注意用的是 wbi 版（/x/space/wbi/arc/search）：
 * 老的 /x/space/arc/search 与 /x/space/arc/list 已下线，
 * 不带 wbi 签名会被直接拒绝。
 */
export function biliApiUrl(uid: string): string {
  return `https://api.bilibili.com/x/space/wbi/arc/search?mid=${encodeURIComponent(uid)}&pn=1&ps=5&order=pubdate`;
}

/** B站接口必须带的 Referer，缺了会直接 403 */
export const BILI_REFERER = 'https://www.bilibili.com/';

/* ------------------------------------------------------------------ */
/* 更新判定                                                            */
/* ------------------------------------------------------------------ */

export type DetectInput = {
  items: FeedItem[];
  /** 上次记录的最新条目 id；空字符串表示还没有基线 */
  lastSeenId: string;
  /**
   * 首次运行（没有基线）时算不算更新。
   * 默认 false —— 刚配好就触发一次下游，通常是误报。
   */
  firstRunAsUpdate?: boolean;
};

export type DetectResult = {
  updated: boolean;
  /** 本次认定的最新条目 */
  latest: FeedItem | null;
  /** 展示用说明 */
  reason: string;
  /** 是否处于"首次运行只记基线"状态 */
  baseline: boolean;
};

/**
 * 判定是否有更新。
 *
 * 只看最新一条的 id 是否变化 —— 不比较时间：
 * 各源的时间格式与精度不一致（RSS 常缺 pubDate），
 * 而 id（bvid / guid）是稳定的。
 */
export function detectUpdate({ items, lastSeenId, firstRunAsUpdate = false }: DetectInput): DetectResult {
  if (items.length === 0) {
    return { updated: false, latest: null, reason: '没有可判定的条目', baseline: false };
  }

  const latest = items[0];

  // 没有基线：记下当前最新，不算更新（除非用户明确要求）
  if (!lastSeenId) {
    return {
      updated: firstRunAsUpdate,
      latest,
      reason: firstRunAsUpdate
        ? `首次检查，视为更新：${latest.title}`
        : `首次检查，已记录基线：${latest.title}（下次有新的才会触发）`,
      baseline: true,
    };
  }

  if (latest.id === lastSeenId) {
    return { updated: false, latest, reason: '没有更新', baseline: false };
  }

  // 最新一条变了：算更新
  // 顺便判断基线是否还在列表里 —— 不在说明可能被删除或列表被翻页截断
  const stillThere = items.some((i) => i.id === lastSeenId);
  return {
    updated: true,
    latest,
    reason: stillThere
      ? `发现更新：${latest.title}`
      : `发现更新：${latest.title}（原基线已不在列表中，可能已删除）`,
    baseline: false,
  };
}

/** 挑出"最新"的一条：优先按时间倒序，时间缺失时保持原顺序 */
export function pickLatest(items: FeedItem[]): FeedItem | null {
  if (items.length === 0) return null;
  const withTime = items
    .map((it, idx) => ({ it, idx, t: it.date ? Date.parse(it.date) : NaN }))
    .filter((x) => Number.isFinite(x.t));
  if (withTime.length === 0) return items[0];
  withTime.sort((a, b) => b.t - a.t || a.idx - b.idx);
  return withTime[0].it;
}

/** 规范化条目顺序：让 items[0] 一定是最新那条 */
export function sortByNewest(items: FeedItem[]): FeedItem[] {
  const top = pickLatest(items);
  if (!top) return items;
  return [top, ...items.filter((i) => i !== top)];
}

/* ------------------------------------------------------------------ */
/* 抓一个监听目标（试跑与正式运行共用）                                */
/* ------------------------------------------------------------------ */

/**
 * 这个目标该去哪个地址抓。
 *
 * ================= 为什么抽出来 =================
 *
 * 「测试」按钮和正式运行做的是同一件事，早先各写一份：
 * 测试面板自己拼 URL、自己 parse、自己 detectUpdate。
 * 两份逻辑迟早会漂 —— 表现是"试跑说有更新，正式跑却没更新"，
 * 而**两边都不报错**，用户只能靠猜。
 */
export function targetFeedUrl(t: UpdateTarget): { url: string; error?: string } {
  if (t.kind === 'bilibili' && (t.biliMode ?? 'rss') === 'api') {
    const uid = extractBiliUid(t.biliUid ?? '');
    if (!uid) return { url: '', error: '填一个 UP 主 UID 或 space.bilibili.com 主页链接' };
    return { url: biliApiUrl(uid) };
  }
  const url = (t.feedUrl ?? '').trim();
  if (!url) {
    /*
     * 除了 YouTube 和播客，这些平台都没有官方接口，
     * 地址要靠 RSSHub / wechat2rss 之类拼出来 —— 这句话必须说出来，
     * 否则用户填主页地址会一直解析失败且不知为何。
     *
     * 带上 meta.route 示例：光说"要填订阅源"等于让人猜格式，
     * 而 RSSHub 的路由（如 /weibo/user/<uid>）不看文档根本拼不出来。
     */
    const meta = UPDATE_SOURCE_META[t.kind];
    return {
      url: '',
      error: meta.route
        ? `${meta.label}：需要填订阅源地址（示例：${meta.route}；可用 RSSHub / wechat2rss 等生成）`
        : `${meta.label}：需要填订阅源地址`,
    };
  }
  return { url };
}

export type ProbeInput = {
  headers?: Record<string, string>;
  timeoutSec?: number;
  firstRunAsUpdate?: boolean;
  /** 基线；不传就按这个目标自己记录的算 */
  lastSeenId?: string;
  /** 拿到最终地址时回调（正式运行用它打日志） */
  onUrl?: (url: string) => void;
};

export type ProbeDeps = {
  /** 抓取，返回响应正文；失败请抛错 */
  get: (url: string, opts: { headers?: Record<string, string>; timeoutSec?: number }) => Promise<string>;
  /** 模板渲染；试跑面板没有上下文，可以不传 */
  tpl?: (s: string) => string;
};

export type ProbeResult = {
  updated: boolean;
  latest: FeedItem | null;
  reason: string;
  baseline: boolean;
  url: string;
};

/**
 * 抓一个目标并判定有无更新。
 *
 * 只覆盖订阅源类（B站 / 公众号 / 小红书）。GitHub 走的是另一条路
 * （需要 GitHub 拉取能力），由执行器自己处理 ——
 * 这里不假装能抓，否则点下去会得到一个假结果。
 */
export async function probeFeedTarget(
  t: UpdateTarget,
  input: ProbeInput,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const { url, error } = targetFeedUrl(t);
  if (error) throw new Error(error);

  const rendered = deps.tpl ? deps.tpl(url) : url;
  input.onUrl?.(rendered);

  const text = await deps.get(rendered, {
    headers: input.headers ?? {},
    timeoutSec: input.timeoutSec,
  });

  const parsed = t.kind === 'bilibili' && (t.biliMode ?? 'rss') === 'api'
    ? parseBiliApi(text)
    : parseFeed(text);
  if (parsed.error) throw new Error(parsed.error);

  const items = sortByNewest(parsed.items);
  const res = detectUpdate({
    items,
    lastSeenId: input.lastSeenId ?? t.lastSeenId ?? '',
    firstRunAsUpdate: input.firstRunAsUpdate === true,
  });

  return {
    updated: res.updated,
    latest: res.latest,
    reason: parsed.warnings.length ? `${res.reason}；${parsed.warnings.join('；')}` : res.reason,
    baseline: res.baseline,
    url: rendered,
  };
}
