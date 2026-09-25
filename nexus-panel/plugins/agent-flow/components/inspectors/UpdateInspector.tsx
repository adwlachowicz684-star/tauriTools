import { useState } from 'react';
import type { FlowNode } from '../../flowTypes';
import {
  UPDATE_SOURCE_META, UPDATE_SOURCE_KEYS, FEED_SOURCES, targetsOf,
  type UpdateNodeData, type UpdateSource, type UpdateTarget, type BiliMode,
} from '../../types';
import { UpdateTargetTest } from './UpdateTargetTest';

/**
 * 合并后的「更新检测」面板：每个监听目标一张卡。
 *
 * ================= 为什么整份 targets 一起写 =================
 *
 * 用点号路径（targets.0.feedUrl）写的话，老节点上没有 targets 字段，
 * setInPath 会**凭空建出一个对象** —— 里面没有 id 也没有 kind。
 * 卡片渲染时 UPDATE_SOURCE_META[t.kind] 直接抛错，整棵 React 树崩掉。
 *
 * 所以这里任何改动都写整份数组（先由 targetsOf 合成出带 id/kind 的卡），
 * 老节点第一次被改动时也就自然完成了迁移。
 */

/**
 * 「＋ 加一个监听目标」里可选的分组。
 *
 * 十七种平铺成一排会糊成一片，找不着想要的那个。
 * 分组不是装饰：漏掉一种，那个平台就在面板上**选不到**，
 * 而界面不会有任何提示 —— 所以测试里钉着"每种都恰好出现一次"。
 */
export const UPDATE_SOURCE_GROUPS: Array<{ title: string; kinds: UpdateSource[] }> = [
  { title: '国内平台', kinds: ['bilibili', 'wechat', 'xiaohongshu', 'weibo', 'zhihu', 'douyin', 'kuaishou', 'toutiao'] },
  { title: '技术与代码', kinds: ['github', 'juejin', 'csdn', 'jianshu', 'v2ex'] },
  { title: '兴趣与海外', kinds: ['douban', 'youtube', 'twitter', 'podcast'] },
  { title: '其他', kinds: ['custom'] },
];

function newId(): string {
  return `ut${Math.random().toString(36).slice(2, 8)}`;
}

export function UpdateInspector({ node, onChange }: {
  node: FlowNode;
  onChange: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = node.data as UpdateNodeData;
  const list = targetsOf(d);
  const [adding, setAdding] = useState(false);

  /** 写整份数组 —— 见文件头说明 */
  const writeAll = (next: UpdateTarget[]) => onChange(node.id, { targets: next });

  const patchAt = (i: number, part: Partial<UpdateTarget>) =>
    writeAll(list.map((t, j) => (j === i ? { ...t, ...part } : t)));

  const addTarget = (kind: UpdateSource) => {
    setAdding(false);
    writeAll([...list, {
      id: newId(), kind, enabled: true,
      biliMode: 'rss',
      lastSeenId: '', lastSeenTitle: '', lastCheckedAt: null, lastUpdated: null,
    }]);
  };

  const removeAt = (i: number) => writeAll(list.filter((_, j) => j !== i));

  return (
    <>
      <div className="trig-cards">
        {list.map((t, i) => {
          const meta = UPDATE_SOURCE_META[t.kind];
          const off = t.enabled === false;
          return (
            <div className={`trig-card upd-card${off ? ' is-off' : ''}`} key={t.id}>
              <div className="upd-card-head">
                <span className="upd-icon">{meta.icon}</span>
                <input
                  className="p-input upd-name-input"
                  value={t.name ?? ''}
                  placeholder={meta.label}
                  title="给这张卡起个备注名；留空显示种类名"
                  onChange={(e) => patchAt(i, { name: e.target.value })}
                />
                <span className="task-grow" />
                <button
                  type="button"
                  className={`insp-size-btn${off ? '' : ' on'}`}
                  title={off ? '这一张已停用，点一下启用' : '停用这一张（节点上其它卡照常）'}
                  onClick={() => patchAt(i, { enabled: off })}
                >
                  {off ? '停用' : '启用'}
                </button>
                {list.length > 1 ? (
                  <button
                    type="button"
                    className="insp-size-btn"
                    title="删掉这一张（其余不受影响）"
                    onClick={() => removeAt(i)}
                  >
                    删除
                  </button>
                ) : null}
              </div>

              <div className="p-muted upd-hint">{meta.hint}</div>

              {t.kind === 'bilibili' ? (
                <>
                  <label className="p-row">
                    <span className="p-muted" style={{ width: 64, flex: 'none' }}>抓取方式</span>
                    <select
                      className="p-input"
                      value={t.biliMode ?? 'rss'}
                      onChange={(e) => patchAt(i, { biliMode: e.target.value as BiliMode })}
                    >
                      <option value="rss">订阅源（免 Cookie）</option>
                      <option value="api">B站接口（更及时，建议填 Cookie）</option>
                    </select>
                  </label>
                  {(t.biliMode ?? 'rss') === 'api' ? (
                    <>
                      <label className="p-row">
                        <span className="p-muted" style={{ width: 64, flex: 'none' }}>UP 主</span>
                        <input
                          className="p-input"
                          value={t.biliUid ?? ''}
                          placeholder="UID 或 space.bilibili.com 主页链接"
                          onChange={(e) => patchAt(i, { biliUid: e.target.value })}
                        />
                      </label>
                      <label className="p-row">
                        <span className="p-muted" style={{ width: 64, flex: 'none' }}>Cookie</span>
                        <input
                          className="p-input"
                          value={t.biliCookie ?? ''}
                          placeholder="浏览器里复制的整条 Cookie（可选）"
                          title="只填 SESSDATA 往往不够 —— B站 还会看 buvid3 / _uuid"
                          onChange={(e) => patchAt(i, { biliCookie: e.target.value })}
                        />
                      </label>
                    </>
                  ) : (
                    <label className="p-row">
                      <span className="p-muted" style={{ width: 64, flex: 'none' }}>订阅源</span>
                      <input
                        className="p-input"
                        value={t.feedUrl ?? ''}
                        placeholder="https://.../feed.xml"
                        onChange={(e) => patchAt(i, { feedUrl: e.target.value })}
                      />
                    </label>
                  )}
                </>
              ) : null}

              {/*
               * 订阅源输入框。
               *
               * 判据必须是 FEED_SOURCES 而不是列举种类名：
               * 早先写的是 `kind === 'wechat' || kind === 'xiaohongshu'`，
               * 于是每加一个平台都要记得回来加一个 ||
               * —— 漏一个的表现是那张卡上**没有输入框**，
               * 配置无从下手，而界面看着完全正常。
               *
               * placeholder 给具体路由（meta.route）：
               * 除了 YouTube 和播客，这些平台都得靠 RSSHub 拼地址，
               * 空输入框等于让人猜。
               */}
              {FEED_SOURCES.includes(t.kind) ? (
                <label className="p-row">
                  <span className="p-muted" style={{ width: 64, flex: 'none' }}>订阅源</span>
                  <input
                    className="p-input"
                    value={t.feedUrl ?? ''}
                    placeholder={meta.route ?? 'https://.../feed.xml'}
                    title={meta.route ? `示例：${meta.route}` : undefined}
                    onChange={(e) => patchAt(i, { feedUrl: e.target.value })}
                  />
                </label>
              ) : null}

              {t.kind === 'github' ? (
                <>
                  <label className="p-row">
                    <span className="p-muted" style={{ width: 64, flex: 'none' }}>仓库</span>
                    <input
                      className="p-input"
                      value={t.owner ?? ''}
                      placeholder="owner"
                      onChange={(e) => patchAt(i, { owner: e.target.value })}
                    />
                    <span className="p-muted">/</span>
                    <input
                      className="p-input"
                      value={t.repo ?? ''}
                      placeholder="repo"
                      onChange={(e) => patchAt(i, { repo: e.target.value })}
                    />
                  </label>
                  <label className="p-row">
                    <span className="p-muted" style={{ width: 64, flex: 'none' }}>分支</span>
                    <input
                      className="p-input"
                      value={t.branch ?? ''}
                      placeholder="留空用默认分支"
                      onChange={(e) => patchAt(i, { branch: e.target.value })}
                    />
                  </label>
                  <label className="p-row">
                    <span className="p-muted" style={{ width: 64, flex: 'none' }}>基准</span>
                    <input
                      className="p-input"
                      value={t.base ?? ''}
                      placeholder="本地 HEAD，留空只取远端状态"
                      title="填了会与本地 HEAD 比对：只关心本地是否落后时用"
                      onChange={(e) => patchAt(i, { base: e.target.value })}
                    />
                  </label>
                </>
              ) : null}

              {/*
               * 试跑：每张卡各一个 —— 合并之后一个节点盯多个目标，
               * 只留一个节点级按钮就分不清测的是哪一张。
               *
               * ================= 这里曾出过一个真问题 =================
               *
               * UpdateTargetTest 早先只是 import 了，**从未渲染**。
               * 于是"每张卡都有试跑"这句话是空的：组件写好了、按钮没接，
               * 界面上安静地少一块，谁也不会报错。
               * 现在渲染它，并加了守卫盯住"必须真的用上"。
               *
               * GitHub 不给按钮：它走的是另一种通道（需要注入的拉取能力），
               * 试跑面板拿不到。做个"点下去其实没查"的按钮比不给更糟，
               * 所以这里明说，让用户知道正式运行时才会检查。
               */}
              {t.kind === 'github' ? (
                <div className="p-muted upd-hint">
                  GitHub 目标在正式运行时才检查（试跑面板没有 GitHub 拉取能力）。
                </div>
              ) : (
                <UpdateTargetTest target={t} d={d} />
              )}

              {/*
               * 重置基线：清空"上次见到的最新条目"，下一次运行重新记基线。
               * 换了个 UP 主或订阅源之后必须做 ——
               * 否则拿旧基线去比新源，永远比不出结果。
               */}
              {t.lastSeenId ? (
                <div className="upd-reset">
                  <button
                    type="button"
                    className="insp-size-btn"
                    title="清空这一张的基线，下次运行重新记录"
                    onClick={() => patchAt(i, {
                      lastSeenId: '', lastSeenTitle: '', lastUpdated: null, error: '',
                    })}
                  >
                    重置基线
                  </button>
                  {t.lastSeenTitle ? (
                    <span className="p-muted" title={t.lastSeenTitle}>
                      当前：{t.lastSeenTitle}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/*
       * 侧栏为了不撑太长只列了常用的几种 ——
       * 必须在这里说一句"还有全部可选"，否则用户会以为
       * 想盯的平台不支持（功能其实有，只是没露面）。
       */}
      {adding ? (
        <div className="upd-add">
          {UPDATE_SOURCE_GROUPS.map((g) => (
            <div className="upd-add-row" key={g.title}>
              <span className="p-muted upd-add-title">{g.title}</span>
              {g.kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="insp-size-btn"
                  title={UPDATE_SOURCE_META[k].hint}
                  onClick={() => addTarget(k)}
                >
                  {UPDATE_SOURCE_META[k].icon} {UPDATE_SOURCE_META[k].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="mini"
          title={`共 ${UPDATE_SOURCE_KEYS.length} 种平台可选 —— 侧栏只列了常用的几种`}
          onClick={() => setAdding(true)}
        >
          ＋ 加一个监听目标（全部 {UPDATE_SOURCE_KEYS.length} 种）
        </button>
      )}

      {/* ---- 节点级共用项 ---- */}
      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>输出格式</span>
        <select
          className="p-input"
          value={d.outputFormat ?? 'bool'}
          onChange={(e) => onChange(node.id, { outputFormat: e.target.value })}
        >
          <option value="bool">只输出 true / false</option>
          <option value="detail">附带标题、链接、时间</option>
        </select>
      </label>
      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>超时（秒）</span>
        <input
          className="p-input"
          type="number"
          min={1}
          max={120}
          value={d.timeoutSec ?? 15}
          onChange={(e) => onChange(node.id, { timeoutSec: Number(e.target.value) || 15 })}
        />
      </label>
      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>UA（可选）</span>
        <input
          className="p-input"
          value={d.userAgent ?? ''}
          placeholder="留空用默认值"
          title="部分源会拒绝默认的非浏览器 UA"
          onChange={(e) => onChange(node.id, { userAgent: e.target.value })}
        />
      </label>
      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }} />
        <label className="p-row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={d.firstRunAsUpdate === true}
            onChange={(e) => onChange(node.id, { firstRunAsUpdate: e.target.checked })}
          />
          <span className="p-muted">首次运行（还没有基线）时算作更新</span>
        </label>
      </label>
      <div className="p-muted upd-hint">
        任一目标有更新就输出 true。输出字段：title / url / date / updated。
      </div>
    </>
  );
}
