/**
 * types.ts 第 5 卷：update。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { NodeData } from './condition';
import type { GraphNode, NodeSize, NodeStatus } from './core';

/* ------------------------------------------------------------------ */
/* 更新检测节点（B站 UP 主 / 微信公众号）                               */
/*                                                                     */
/* 两种源共用一套数据结构：抓取 → 解析 → 与基线比对 → 输出 bool。      */
/* 差别只在"怎么抓"和"怎么解析"，由 source 字段区分。                  */
/* ------------------------------------------------------------------ */

/*
 * 监听目标的种类。
 *
 * 一个「更新检测」节点可以同时盯多个目标（B站 + 小红书 + 某个仓库），
 * 所以种类是**目标**的属性，不再是节点的属性 ——
 * 节点上那个 `source` 字段只为了让老存档继续能读（见 targetsOf）。
 */
export type UpdateSource =
  | 'bilibili'
  | 'wechat'
  | 'xiaohongshu'
  | 'weibo'
  | 'zhihu'
  | 'douyin'
  | 'kuaishou'
  | 'toutiao'
  | 'douban'
  | 'juejin'
  | 'csdn'
  | 'jianshu'
  | 'v2ex'
  | 'youtube'
  | 'twitter'
  | 'podcast'
  | 'github'
  /** 兜底：上面没有的平台，直接给一个订阅源地址 */
  | 'custom';

/** B站 的抓取方式 */
export type BiliMode =
  | 'api'   // 官方投稿列表接口，可能被风控，需要 Cookie
  | 'rss';  // RSS（如 RSSHub），稳定但要自备服务

export type UpdateNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'update';
  source: UpdateSource;
  label: string;

  /*
   * 监听目标（每个显示成一张卡）。
   *
   * 老存档没有这个字段，读时由 targetsOf() 合成一张 —— 见那里的说明。
   * 一旦任何一张卡被改动，这里就会有值，之后以它为准。
   */
  targets?: UpdateTarget[];

  /* ---- B站 ---- */
  /** UID，或 space.bilibili.com 主页链接 */
  biliUid: string;
  biliMode: BiliMode;
  /**
   * 完整 Cookie 串，用于绕过风控。
   * 只填 SESSDATA 往往不够 —— B站 还会看 buvid3 / _uuid。
   * 直接把浏览器里复制的整条 Cookie 粘进来最省事。
   */
  biliCookie: string;

  /* ---- 公众号 ---- */
  /**
   * 订阅源地址（RSS/Atom）。
   * 公众号没有官方开放接口，必须用第三方桥接：
   * wechat2rss / RSSHub / Feeddd 等，把生成的订阅地址填到这里。
   */
  feedUrl: string;

  /* ---- 共用 ---- */
  /** 自定义 User-Agent。部分源会拒绝默认的非浏览器 UA */
  userAgent: string;
  /**
   * 首次运行（还没有基线）时算不算更新。
   * 默认 false：刚配好就触发一次下游通常是误报。
   */
  firstRunAsUpdate: boolean;
  /**
   * 输出格式：
   *  - bool   → 只输出 true / false，配合条件节点直接用
   *  - detail → 附带标题、链接、时间
   */
  outputFormat: 'bool' | 'detail';
  /** 请求超时秒数 */
  timeoutSec: number;

  /* ---- 运行时状态（随画布持久化，重启后仍记得基线） ---- */
  /** 上次见到的最新条目 id —— 判定"有无更新"的基线 */
  lastSeenId: string;
  lastSeenTitle: string;
  lastCheckedAt: number | null;
  /** 最近一次检查是否发现有更新，界面上直接显示 */
  lastUpdated: boolean | null;

  status: NodeStatus;
  output: string;
  error: string;
};

export const UPDATE_SOURCE_META: Record<UpdateSource, {
  label: string;
  hint: string;
  icon: string;
  color: string;
  /**
   * 订阅源地址示例，直接进输入框的 placeholder。
   *
   * ================= 为什么必须给 =================
   *
   * 除了 YouTube 与播客，这些平台都不提供官方订阅源，
   * 地址要靠 RSSHub（或 wechat2rss 之类）拼出来。
   * 不给示例的话，用户面对一个空输入框无从下手 ——
   * 而"填了主页地址却一直解析失败"正是最常见的一类困惑。
   */
  route?: string;
}> = {
  bilibili: {
    label: 'B站 UP 主',
    hint: '检测 UP 主是否有新投稿（订阅源模式需第三方源；接口模式填 UID 即可）',
    icon: '📺',
    color: '#fb7299',
    route: 'https://rsshub.app/bilibili/user/video/<UID>',
  },
  wechat: {
    label: '微信公众号',
    hint: '检测公众号是否有新推文（无官方接口，需第三方订阅源）',
    icon: '💬',
    color: '#07c160',
    route: 'https://wechat2rss.xlab.app/feed/xxxx.xml',
  },
  xiaohongshu: {
    /*
     * 小红书没有官方开放接口，与公众号同一条路：第三方桥接出的订阅源。
     * 把这一点写在 hint 里而不是等用户填了才发现 ——
     * "填了主页地址却一直报解析失败"是最常见的一类困惑。
     */
    label: '小红书',
    hint: '检测博主是否有新笔记（无官方接口，需第三方订阅源）',
    icon: '📕',
    color: '#ff2442',
    route: 'https://rsshub.app/xiaohongshu/user/<id>/notes',
  },
  weibo: {
    label: '微博',
    hint: '检测博主是否有新微博（无官方接口，需第三方订阅源；公共实例常需自备 Cookie）',
    icon: '🌐',
    color: '#e6162d',
    route: 'https://rsshub.app/weibo/user/<uid>',
  },
  zhihu: {
    label: '知乎',
    hint: '检测答主新回答 / 新文章 / 专栏更新（无官方接口，需第三方订阅源）',
    icon: '💡',
    color: '#0084ff',
    route: 'https://rsshub.app/zhihu/people/activities/<id>',
  },
  douyin: {
    label: '抖音',
    hint: '检测达人是否有新视频（无官方接口，需第三方订阅源）',
    icon: '🎵',
    color: '#111827',
    route: 'https://rsshub.app/douyin/user/<sec_uid>',
  },
  kuaishou: {
    label: '快手',
    hint: '检测达人是否有新视频（无官方接口，需第三方订阅源）',
    icon: '⚡',
    color: '#ff6600',
    route: 'https://rsshub.app/kuaishou/user/<id>',
  },
  toutiao: {
    label: '今日头条',
    hint: '检测头条号是否有新内容（无官方接口，需第三方订阅源）',
    icon: '📰',
    color: '#f04142',
    route: 'https://rsshub.app/toutiao/user/<id>',
  },
  douban: {
    label: '豆瓣',
    hint: '检测小组新帖 / 用户动态（小组讨论有官方源，用户动态需第三方）',
    icon: '📗',
    color: '#00b51d',
    route: 'https://www.douban.com/feed/group/<group>/discussion',
  },
  juejin: {
    label: '掘金',
    hint: '检测专栏 / 作者新文章（需第三方订阅源）',
    icon: '⛏️',
    color: '#1e80ff',
    route: 'https://rsshub.app/juejin/category/frontend',
  },
  csdn: {
    label: 'CSDN',
    hint: '检测博主是否有新文章（需第三方订阅源）',
    icon: '🅲',
    color: '#fc5531',
    route: 'https://rsshub.app/csdn/blog/<user>',
  },
  jianshu: {
    label: '简书',
    hint: '检测作者是否有新文章（需第三方订阅源）',
    icon: '✍️',
    color: '#ea6f5a',
    route: 'https://rsshub.app/jianshu/user/<id>',
  },
  v2ex: {
    label: 'V2EX',
    hint: '检测节点 / 主题更新（有官方源，也可走第三方）',
    icon: '🅥',
    color: '#a3a3a3',
    route: 'https://rsshub.app/v2ex/topics/latest',
  },
  youtube: {
    /*
     * YouTube 是极少数**提供官方订阅源**的平台：
     * 不需要 RSSHub，把 channel_id 填进去就能用。
     * 这一点必须在 hint 里说清楚，否则用户会去找第三方桥接，
     * 多绕一圈还多一个故障点。
     */
    label: 'YouTube',
    hint: '检测频道是否有新视频（YouTube 提供官方订阅源，无需第三方桥接）',
    icon: '▶️',
    color: '#ff0000',
    route: 'https://www.youtube.com/feeds/videos.xml?channel_id=<id>',
  },
  twitter: {
    label: 'X（Twitter）',
    hint: '检测博主是否有新推文（无官方接口，需第三方订阅源）',
    icon: '𝕏',
    color: '#e5e7eb',
    route: 'https://rsshub.app/twitter/user/<id>',
  },
  podcast: {
    label: '播客',
    hint: '检测播客是否有新单集（播客普遍自带官方 RSS 源，直接填即可）',
    icon: '🎙️',
    color: '#8b5cf6',
    route: 'https://.../podcast.xml',
  },
  github: {
    label: 'GitHub 仓库',
    hint: '检测仓库有没有新提交 / 新 Release（走 GitHub 拉取，不走网络抓取）',
    icon: '🐙',
    color: '#a78bfa',
  },
  custom: {
    /*
     * 兜底种类。
     *
     * 无论内置多少平台，总有覆盖不到的：某个独立博客、某个小众论坛、
     * 某台自建的 RSSHub 上挂的自建路由。
     * 与其让用户等我们加，不如给一个"直接给地址"的口子 ——
     * 而且它跑的是与内置平台完全相同的解析与判定代码，不是二等公民。
     */
    label: '自定义订阅源',
    hint: '任何 RSS 2.0 / Atom 源：独立博客、自建 RSSHub 路由、小众论坛都可',
    icon: '🔗',
    color: '#38bdf8',
    route: 'https://.../feed.xml',
  },
};

/** 全部种类，顺序即面板里的排列顺序 */
export const UPDATE_SOURCE_KEYS = Object.keys(UPDATE_SOURCE_META) as UpdateSource[];

/**
 * 需要订阅源地址的种类 —— 界面上按这个决定填哪一栏。
 *
 * ================= 为什么是推导出来的 =================
 *
 * 早先这里是一份手写清单 `['wechat','xiaohongshu']`。
 * 手抄清单的代价在加平台时集中爆发：新种类忘了登记，
 * 卡片上就**没有订阅源输入框**，用户只能干瞪眼 ——
 * 不报错、界面看着也挺完整，是最难发现的那一类损伤。
 *
 * 改成"全部种类减去两个特例"，加平台就自动生效。
 * 特例只有两个：
 *  - bilibili：自带接口/订阅源两种模式，订阅源框由它自己那一段画
 *  - github：走 GitHub 拉取通道，根本不抓 HTTP
 *
 * 若将来出现第三个不走订阅源的种类，必须同时改这里与
 * tests/updateSources.test.ts 里那条"特例只有两个"的断言。
 */
export const FEED_SOURCES: UpdateSource[] =
  UPDATE_SOURCE_KEYS.filter((k) => k !== 'bilibili' && k !== 'github');

/** 这一张卡该不该显示"订阅源地址"输入框 */
export function needsFeedUrl(kind: UpdateSource, biliMode: BiliMode = 'rss'): boolean {
  if (kind === 'github') return false;
  if (kind === 'bilibili') return (biliMode ?? 'rss') === 'rss';
  return true;
}

/**
 * 侧栏直接列出的种类。
 *
 * 全部 17 种都塞进侧栏会把那一段撑得很长，而真正高频的就这几个。
 * 其余的在面板「＋ 加一个监听目标」里同样能选到 ——
 * 少露一面不等于少一种能力，但必须让用户知道还有更多（见面板那句提示）。
 */
export const UPDATE_SIDEBAR_SOURCES: UpdateSource[] = [
  'bilibili', 'wechat', 'xiaohongshu', 'weibo', 'zhihu', 'douyin', 'youtube', 'github',
  /*
   * 兜底排最后：它是"上面都没有"时用的，
   * 放在平台中间会让人以为它是某个具体站点。
   */
  'custom',
];

/**
 * 一个监听目标。
 *
 * 以前"更新检测"就是一个源进一个节点：盯三个 UP 主要放三个节点，
 * 而它们共用同一份"上次检查时间"与"输出"，于是三个节点互相覆盖状态 ——
 * 表现为"明明 A 有更新，节点却显示无更新"。
 *
 * 现在每个目标自带基线，节点只负责聚合。
 */
export type UpdateTarget = {
  /** 卡片自身的 id —— 同一种类可以配多张（盯两个 UP 主） */
  id: string;
  kind: UpdateSource;
  /** 这张卡单独停用（不影响节点上其它卡） */
  enabled?: boolean;
  /** 这一张的备注名；空则用种类名 */
  name?: string;

  /* ---- B站 ---- */
  biliUid?: string;
  biliMode?: BiliMode;
  biliCookie?: string;

  /* ---- 公众号 / 小红书 ---- */
  feedUrl?: string;

  /* ---- GitHub ---- */
  owner?: string;
  repo?: string;
  branch?: string;
  /** 比对本地 HEAD：只关心"本地是否落后"时用 */
  base?: string;
  credentialId?: string;

  /* ---- 每个目标各自的基线 ---- */
  lastSeenId?: string;
  lastSeenTitle?: string;
  lastCheckedAt?: number | null;
  lastUpdated?: boolean | null;
  /** 上一次检查这一张卡自己的结果；失败时给个说法，不然卡片上只是空 */
  error?: string;
};

/**
 * 取一个节点的监听目标列表。
 *
 * ================= 为什么读时才算 =================
 *
 * 老存档里没有 `targets`（那时一个节点就是一个源），字段是平铺的
 * `source` / `biliUid` / `feedUrl`。重写存档去补 targets 风险太大，
 * 而"读时合成一张卡"既能让老节点立刻长出新界面，
 * 又在这一张卡被改动时才落 `targets`（自然的写时迁移）。
 */
export function targetsOf(d: UpdateNodeData): UpdateTarget[] {
  if (Array.isArray(d.targets)) return d.targets;
  return [{
    id: `${String((d as { id?: string }).id ?? '') || 'u'}0`,
    kind: d.source ?? 'bilibili',
    enabled: true,
    biliUid: d.biliUid,
    biliMode: d.biliMode,
    biliCookie: d.biliCookie,
    feedUrl: d.feedUrl,
    lastSeenId: d.lastSeenId,
    lastSeenTitle: d.lastSeenTitle,
    lastCheckedAt: d.lastCheckedAt,
    lastUpdated: d.lastUpdated,
  }];
}

/** 启用的目标。一张都没启用时返回空 —— 校验层据此报"缺项" */
export function activeTargets(d: UpdateNodeData): UpdateTarget[] {
  return targetsOf(d).filter((t) => t.enabled !== false);
}

export function isUpdate(d: NodeData): d is UpdateNodeData {
  return (d as UpdateNodeData).kind === 'update';
}

/** GitHub 拉取策略。默认顺序即兜底顺序 */
export type GithubStrategy = 'api' | 'atom' | 'cli';

/** 拉取：要不要走本地 git（cli 方案需要机器上有 git） */
export type GithubUpdateNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'github-update';
  label: string;
  owner: string;
  repo: string;
  /** 留空则用仓库默认分支 */
  branch: string;
  /** 本地 HEAD / 上次记录的 sha；留空表示只取远端状态 */
  base: string;
  /** 策略顺序，前面失败了自动换后面 */
  order: GithubStrategy[];
  /** 凭据 id；留空则用节点内联的 token */
  credentialId: string;
  /** 内联令牌（兼容旧画布；新配置请走凭据） */
  token: string;
  status: NodeStatus;
  output: string;
  error: string;
  /** 上次结果摘要，仅用于界面展示 */
  lastSha?: string;
  lastBranch?: string;
  lastVia?: string;
};

export type GithubPushNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'github-push';
  label: string;
  owner: string;
  repo: string;
  branch: string;
  /** 新建分支时基于此分支 */
  fromBranch: string;
  /** 提交信息，支持 {{上游.output}} */
  message: string;
  /** 要提交的文件，每行一条 `路径=内容来源`；内容来源支持模板 */
  filesText: string;
  /** cli 方案需要的本地仓库路径 */
  workdir: string;
  order: GithubStrategy[];
  credentialId: string;
  token: string;
  status: NodeStatus;
  output: string;
  error: string;
  lastCommit?: string;
  lastVia?: string;
};

export function isGithubUpdate(d: NodeData): d is GithubUpdateNodeData {
  return (d as GithubUpdateNodeData).kind === 'github-update';
}

export function isGithubPush(d: NodeData): d is GithubPushNodeData {
  return (d as GithubPushNodeData).kind === 'github-push';
}

export function makeGithubUpdateNode(
  id: string,
  partial: Partial<GithubUpdateNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'github-update',
      label: partial.label ?? 'GitHub 更新',
      owner: partial.owner ?? '',
      repo: partial.repo ?? '',
      branch: partial.branch ?? '',
      base: partial.base ?? '',
      order: partial.order ?? ['api', 'atom', 'cli'],
      credentialId: partial.credentialId ?? '',
      token: partial.token ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeGithubPushNode(
  id: string,
  partial: Partial<GithubPushNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'github-push',
      label: partial.label ?? 'GitHub 推送',
      owner: partial.owner ?? '',
      repo: partial.repo ?? '',
      branch: partial.branch ?? 'main',
      fromBranch: partial.fromBranch ?? 'main',
      message: partial.message ?? 'chore: update via agent-flow',
      filesText: partial.filesText ?? '',
      workdir: partial.workdir ?? '',
      order: partial.order ?? ['api', 'cli'],
      credentialId: partial.credentialId ?? '',
      token: partial.token ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeUpdateNode(
  id: string,
  source: UpdateSource,
  partial: Partial<UpdateNodeData> = {},
): GraphNode {
  return {
    id,
    data: {
      kind: 'update',
      source,
      label: partial.label ?? UPDATE_SOURCE_META[source].label,
      /*
       * 直接落一份 targets。
       *
       * 不落的话新节点靠 targetsOf() 读时合成 —— 界面上看着有卡，
       * 但一改动才发现没有下标可写（老字段是平铺的）。
       * 这里落成数组，之后增删改卡都落在下标上，两条路径合一。
       */
      targets: partial.targets ?? [{
        id: `${id}0`,
        kind: source,
        enabled: true,
        biliUid: partial.biliUid ?? '',
        biliMode: partial.biliMode ?? 'rss',
        biliCookie: partial.biliCookie ?? '',
        feedUrl: partial.feedUrl ?? '',
        lastSeenId: partial.lastSeenId ?? '',
        lastSeenTitle: partial.lastSeenTitle ?? '',
        lastCheckedAt: partial.lastCheckedAt ?? null,
        lastUpdated: partial.lastUpdated ?? null,
      }],
      biliUid: partial.biliUid ?? '',
      biliMode: partial.biliMode ?? 'rss',
      biliCookie: partial.biliCookie ?? '',
      feedUrl: partial.feedUrl ?? '',
      userAgent: partial.userAgent ?? '',
      firstRunAsUpdate: partial.firstRunAsUpdate ?? false,
      outputFormat: partial.outputFormat ?? 'bool',
      timeoutSec: partial.timeoutSec ?? 15,
      lastSeenId: partial.lastSeenId ?? '',
      lastSeenTitle: partial.lastSeenTitle ?? '',
      lastCheckedAt: partial.lastCheckedAt ?? null,
      lastUpdated: partial.lastUpdated ?? null,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}
