import { useEffect, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';
import { imageToIcoBase64 } from '../utils/ico';
import type { BackupAutoStatus, BackupTargets, ChainClient, FpxConfig, McpToolRow } from '../types';
import { ChainActionsPanel } from './ChainActionsPanel';
import { summarizeDetection } from '../utils/clientDetect';
import { ChainClientsDialog } from './ChainClientsDialog';
import { DirDialog } from './DirDialog';
import { HotkeySettings } from './HotkeySettings';
import {
  LOG_MAX_LINES_DEFAULT, LOG_MAX_LINES_MAX, LOG_MAX_LINES_MIN, clampLogMax,
} from '../utils/log';

/**
 * 自动备份档位（分钟）；0 = 关闭。
 *
 * #93 补齐 1/2/5/10 分钟：改配置时想"改完就备份一次看看对不对"，
 * 最短却要等 15 分钟 —— 那就只能手动备份，等于这个功能在**最需要它的
 * 时候用不上**（刚改完设置、刚调整备份目录，恰恰最想立刻验证一次）。
 *
 * 短档位不是为了长期开着，是为了"调设置时能马上看到效果"。
 */
const BACKUP_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: '关闭' },
  { value: 1, label: '1 分钟' },
  { value: 2, label: '2 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 120, label: '2 小时' },
  { value: 360, label: '6 小时' },
  { value: 720, label: '12 小时' },
  { value: 1440, label: '每天' },
];

/**
 * 基础设置主体（不带 Modal 外壳）。
 *
 * 这一组开关原先只有配置字段、没有界面，改起来得手改 JSON，现在集中在这里。
 * 改动即时保存（与 WPF 版一致）；其中「自动备份间隔」保存后还要通知后端
 * 重新拉起/停止定时器——后端是常驻线程，不跟着配置自己变。
 *
 * 抽成"主体"（不带 Modal 外壳）是为了直接嵌进外壳的「⚙ 设置」面板——
 * 那一页本身就是个独立页面，再套 Modal 会多一层无意义的遮罩。
 */
export function SettingsBody({
  api, config, dataDir, onLog, onSaved, onChainActionsChanged, onResetLayout, onDevModeChange, onShowShortcutsChange,
}: {
  api: Api;
  config: FpxConfig;
  /** 插件数据目录：拼 icons/ 下图标的绝对路径（换软件图标要用） */
  dataDir: string;
  onLog: (m: string, isError?: boolean) => void;
  /**
   * 连锁动作在管理页里改过之后通知外层重新拉清单。
   *
   * 非走不可：saveChainActions 返回的是动作数组而不是 Snapshot，
   * 外层 boot 不会变，于是右键菜单和侧边栏会一直挂着旧清单，
   * 用户刚加的自定义动作要等到下一次别的写操作才冒出来。
   */
  onChainActionsChanged?: () => void;
  /** 恢复默认布局（三栏比例 / 日志高度）；拖乱了给个回头路 */
  onResetLayout?: () => void;
  /** 开发者模式开关（#46） */
  onDevModeChange?: (on: boolean) => void;
  /**
   * 「显示快捷键」开关（#22）。
   *
   * Settings.tsx 已经在传这个回调了，但类型里一直没写 —— 解构出来是
   * `any`，调用点又用了 `?.()`，于是开关点了不报错也没反应。
   */
  onShowShortcutsChange?: (on: boolean) => void;
  /**
   * 写入配置；传的对象会与当前草稿合并。
   * 返回 Promise 是因为后面要紧接着通知后端重算定时器——
   * 后端是读磁盘上的配置，必须等这次写入落盘，否则读到的是旧间隔。
   */
  onSaved: (patch: Partial<FpxConfig>) => Promise<unknown>;
}) {
  // 软件图标（外壳能力）：候选来自数据目录 icons/
  const [iconFiles, setIconFiles] = useState<string[]>([]);
  const [iconThumbs, setIconThumbs] = useState<Record<string, string>>({});
  const [iconMsg, setIconMsg] = useState('');
  /*
   * #110 两步确认：点图标只是**暂存**，要再点「应用」才真的换。
   *
   * 为什么不能点了就换：换软件图标是**窗口级**操作，
   * 每点一次窗口图标就变一次。用户想试几个图标时窗口一直在闪，
   * 而且没有"取消"的余地 —— 只能再点回原来那个（还得记得是哪个）。
   */
  const [pendingIcon, setPendingIcon] = useState<{ path: string; thumb?: string } | null>(null);
  /* #111 拖放区：拖到上面才高亮，平时不抢注意力 */
  const [winDropOver, setWinDropOver] = useState(false);
  const [winBusy, setWinBusy] = useState('');

  const [autoSelect, setAutoSelect] = useState(config.autoSelect);
  const [quickLink, setQuickLink] = useState(config.quickLink);
  const [hierarchy, setHierarchy] = useState(config.createPathCarriesHierarchy);
  const [iconSync, setIconSync] = useState(config.iconAffectExplorer);
  const [appendOnly, setAppendOnly] = useState(config.backupAppendOnly);
  const [autoMinutes, setAutoMinutes] = useState(config.backupAutoMinutes);

  /* 日志保留条数（#32）。草稿存的是**字符串**：输入框允许自由编辑，
     若存数字，用户清空输入框的瞬间会被夹成 10，反而改不动。
     提交时才 clamp —— 见 save() 里的 logMaxLines。 */
  const [logMaxDraft, setLogMaxDraft] = useState(String(
    clampLogMax(config.logMaxLines),
  ));

  /* 目录设置（#49 #578）：config 里早有这些字段、后端也一直在读，
     但界面上从来没有入口，想改只能手改 JSON。 */
  const [createProjectDir, setCreateProjectDir] = useState(config.createProjectDir ?? '');
  const [createGroupDir, setCreateGroupDir] = useState(config.createGroupDir ?? '');
  const [groupTemplateDir, setGroupTemplateDir] = useState(config.createGroupTemplateDir ?? '');
  /* 备份目录（#595）：与「新建」那三项同理 —— 字段与后端早都有了，
     此前只有「一键备份」弹窗里能改，设置页一直缺入口。 */
  const [backupDir, setBackupDir] = useState(config.backupDir ?? '');
  const [backupProjectDir, setBackupProjectDir] = useState(config.backupProjectDir ?? '');
  const [backupGroupDir, setBackupGroupDir] = useState(config.backupGroupDir ?? '');
  const [dirPicker, setDirPicker] = useState<'cp' | 'cg' | 'gt' | 'bu' | 'bp' | 'bg' | null>(null);

  const [moveFolder, setMoveFolder] = useState(config.moveFolderOnCrossMove);
  const [moveScope, setMoveScope] = useState(config.moveFolderScope || 'defaultRootsFlatten');
  const [mcpEnabled, setMcpEnabled] = useState(config.mcpEnabled);
  /* #53 退出时一并关闭 MCP 进程。
     此前这个字段**连界面入口都没有** —— 只有 model.rs 里的字段与 Default，
     全库无读取点也无写入点。用户根本看不到它，更谈不上生效。 */
  const [closeMcpOnExit, setCloseMcpOnExit] = useState(config.closeMcpOnExit ?? false);
  const [mcpTools, setMcpTools] = useState<Record<string, boolean>>({ ...config.mcpTools });
  const [toolRows, setToolRows] = useState<McpToolRow[]>([]);
  const [status, setStatus] = useState<BackupAutoStatus | null>(null);

  // 工具清单与自动备份状态都取自后端；清单以工具名为准，开关状态用本地草稿覆盖
  useEffect(() => {
    // 三项都做了空值兜底：后端理论上不返回 null，但一旦返回（旧版本 / 异常路径），
    // 下面 toolRows.length / iconFiles.length 会直接让整个设置页白屏。
    api.mcpTools().then((r) => setToolRows(r ?? [])).catch((e) => onLog(errText(e), true));
    api.backupAutoStatus().then(setStatus).catch(() => { /* 状态拿不到不影响设置 */ });
    api.listIcons().then((r) => setIconFiles(r ?? [])).catch(() => { /* 拿不到就不显示图标列表 */ });
  }, [api, onLog]);

  // 图标是本地文件，沙箱里要后端转 data URI 才显示得出来
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const n of iconFiles) {
        const base = dataDir.replace(/[\\/]+$/, '');
        const sep = base.includes('\\') ? '\\' : '/';
        try {
          out[n] = await api.iconData(`${base}${sep}icons${sep}${n}`);
        } catch { /* 单个失败不影响其余 */ }
        if (!alive) return;
      }
      if (alive) setIconThumbs(out);
    })();
    return () => { alive = false; };
  }, [api, iconFiles, dataDir]);

  /** 目录行：输入框 + 浏览 + 清空。与备份弹窗里那套一致，避免两处写法漂移。 */
  const dirRow = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    which: 'cp' | 'cg' | 'gt' | 'bu' | 'bp' | 'bg',
    hint: string,
  ) => (
    <div className="fpx-field">
      <label>{label}</label>
      <div className="p-row">
        <input className="p-input" value={value} placeholder={hint}
          onChange={(e) => onChange(e.target.value)} />
        <button className="p-btn" onClick={() => setDirPicker(which)}>浏览…</button>
        <button className="p-btn" title="清空" onClick={() => onChange('')}>清空</button>
      </div>
    </div>
  );

  const [hotkeys, setHotkeys] = useState<Record<string, string> | null>(config.hotkeys ?? null);

  const [version, setVersion] = useState('');

  /* #29 实际生效的备份落点。
     **必须问后端**：留空时会退到数据目录下的 backup/ 并再按类型加一层子目录，
     这一层用户猜不到；前端若自己按规则推，改了后端规则就会漂移。 */
  const [targets, setTargets] = useState<BackupTargets | null>(null);
  useEffect(() => {
    // 外壳命令可能不存在（旧版本 Rust 未编译进来），静默失败即可
    api.backupTargets().then(setTargets).catch(() => setTargets(null));
  }, [api]);

  useEffect(() => {
    // 外壳命令可能不存在（旧版本 Rust 未编译进来），静默失败即可
    api.appVersion().then(setVersion).catch(() => setVersion(''));
  }, [api]);

  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // 必须先等配置真正落盘：backupAutoSync 是让后端重读磁盘上的配置，
      // 若这里不等，后端读到的是旧间隔，新设置要等到下次保存才生效。
      await onSaved({
        autoSelect,
        quickLink,
        createProjectDir: createProjectDir.trim() || null,
        createGroupDir: createGroupDir.trim() || null,
        createGroupTemplateDir: groupTemplateDir.trim() || null,
        hotkeys,
        createPathCarriesHierarchy: hierarchy,
        iconAffectExplorer: iconSync,
        backupAppendOnly: appendOnly,
        backupAutoMinutes: autoMinutes,
        // 空串一律写 null：后端按"未设置"处理，与「一键备份」弹窗的写法一致
        backupDir: backupDir.trim() || null,
        backupProjectDir: backupProjectDir.trim() || null,
        backupGroupDir: backupGroupDir.trim() || null,
        moveFolderOnCrossMove: moveFolder,
        moveFolderScope: moveScope,
        mcpEnabled,
        closeMcpOnExit,
        mcpTools,
        logMaxLines: clampLogMax(logMaxDraft),
      });
      const running = await api.backupAutoSync();
      onLog(autoMinutes === 0 ? '已停止自动备份' : `自动备份已启用（每 ${autoMinutes} 分钟）`);
      setStatus((s) => (s ? { ...s, running, minutes: autoMinutes } : s));
      onLog('设置已保存');
    } catch (e) {
      onLog(errText(e), true);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 把数据目录 icons/ 里的某个图标设为软件窗口图标。
   * 后端要的是绝对路径，而 icons/ 就在数据目录下，用 bootstrap 给的 dataDir 拼出来。
   */
  const iconsAbs = (name: string) => {
    const base = dataDir.replace(/[\\/]+$/, '');
    const sep = base.includes('\\') ? '\\' : '/';
    return `${base}${sep}icons${sep}${name}`;
  };

  /** #110 第一步：只暂存，不动窗口 */
  const stageWindowIcon = (path: string, thumb?: string) => {
    setIconMsg('');
    setPendingIcon({ path, thumb });
  };

  /** #110 第二步：真正应用 */
  const applyWindowIcon = async () => {
    if (!pendingIcon) return;
    const name = pendingIcon.path.split(/[\\/]/).pop() ?? pendingIcon.path;
    try {
      await api.setWindowIcon(pendingIcon.path);
      setIconMsg(`已把「${name}」设为软件图标（重启后恢复默认）`);
      onLog(`已更换软件图标：${pendingIcon.path}`);
      setPendingIcon(null);
    } catch (e) {
      const msg = errText(e);
      setIconMsg(msg);
      onLog(`设置软件图标失败：${msg}`, true);
    }
  };

  /**
   * #111 拖放 / #112 粘贴进来的图片：先存进数据目录 icons/，再暂存待应用。
   *
   * **为什么不直接拿拖进来的路径去 setWindowIcon**：
   * 拖放拿到的是文件内容（前端在沙箱里，拿不到本地绝对路径），
   * 所以只能先落盘到 icons/ —— 顺带也让它成为"我的图标"的一员，
   * 之后在卡片图标里也能直接选用。
   */
  const ingestImage = async (file: File, srcLabel: string) => {
    const lower = file.name.toLowerCase();
    /* 后端只认图片；把别的东西当图标传过去会得到一条看不懂的报错 */
    if (!/\.(ico|png|jpe?g|bmp)$/.test(lower)) {
      onLog(`「${file.name}」不是图片（只支持 .ico / .png / .jpg / .bmp）`, true);
      return;
    }
    setWinBusy(srcLabel);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const v = String(fr.result ?? '');
          v ? resolve(v) : reject(new Error('读取内容为空'));
        };
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
      /*
       * #7 非 ICO 图片必须**真的转成 ICO**再入库。
       *
       * 后端存的文件名固定是 `{name}.ico`（sanitize 不去扩展名）。
       * 把 PNG 原样写盘会得到一个"叫 .ico 实为 PNG"的文件 ——
       * 资源管理器按 ICO 结构解析，显示不出来，且没有任何报错。
       */
      const isIco = lower.endsWith('.ico');
      const b64 = isIco
        ? dataUrl.split(',')[1] ?? ''
        /* 交给 canvas 缩放 + PNG 内嵌拼装，见 utils/ico.ts */
        : await imageToIcoBase64(file);
      if (!b64) throw new Error('读取内容为空');
      /*
       * 名字要**去掉原扩展名**：后端会再补 `.ico`，
       * 不去掉就得到 `logo.png.ico` 这种双后缀 —— 看着像坏了。
       */
      const saved = await api.saveIconData(file.name.replace(/\.[^.]+$/, ''), b64);
      setIconFiles((prev) => (prev.includes(saved) ? prev : [...prev, saved]));
      /* 预览仍用原图：它最清晰，且浏览器对 PNG/JPEG 的支持比 ICO 稳 */
      stageWindowIcon(saved, dataUrl);
      onLog(`已收入「${file.name}」${isIco ? '' : '（已转为多尺寸 .ico）'}，点「应用」生效`);
    } catch (e) {
      onLog(`${srcLabel}失败：${errText(e)}`, true);
    } finally {
      setWinBusy('');
    }
  };

  /** 工具开关：只记录与"默认开启"不同的项，保持配置清爽 */
  const toggleTool = (name: string, on: boolean) => {
    setMcpTools((m) => {
      const next = { ...m };
      if (on) delete next[name];
      else next[name] = false;
      return next;
    });
  };

  const isToolOn = (name: string) => mcpTools[name] ?? true;

  // true = 切到连锁动作管理页。整页替换而不是嵌在本弹窗里：
  // 管理页自己带 Modal，嵌进来会叠成两层遮罩。
  const [managing, setManaging] = useState(false);
  const [clientsOpen, setClientsOpen] = useState(false);
  /** 刷新检测（#48）：结果 + 加载态。默认 null = 还没点过，不显示 */
  const [detected, setDetected] = useState<ChainClient[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  if (managing) {
    return (
      <ChainActionsPanel
        api={api}
        onClose={() => setManaging(false)}
        onLog={onLog}
        onChanged={onChainActionsChanged}
        devMode={config.devMode}
      />
    );
  }

  /**
   * 重新检测已安装的客户端（#48）。
   *
   * 为什么需要这个按钮：检测发生在后端 `detect()`，而界面上的下拉
   * 是打开面板时拉一次就缓存了。用户装完新客户端回来，看到的还是旧列表，
   * 会以为"软件没认出来"。
   */
  const refreshDetect = async () => {
    setDetecting(true);
    try {
      setDetected(await api.chainClients());
    } catch (e) {
      onLog(`检测失败：${errText(e)}`, true);
      setDetected(null);
    } finally {
      setDetecting(false);
    }
  };

  if (clientsOpen) {
    return (
      <ChainClientsDialog
        api={api}
        initial={config.customChainClients}
        onClose={() => setClientsOpen(false)}
        onLog={onLog}
      />
    );
  }

  return (
    <>
      <div className="fpx-settings-sec">
        <h3>交互</h3>
        <Check
          checked={autoSelect} onChange={setAutoSelect}
          title="拖入的文件夹默认选中"
          sub="拖放添加卡片后自动选中它，省一次点击"
        />
        <Check
          checked={quickLink} onChange={setQuickLink}
          title="快速链接（拖项目组⇄项目时直接创建链接）"
          sub="关闭则跨栏拖放后还要再确认一次才建链"
        />
      </div>

      <div className="fpx-settings-sec">
        <h3>快捷键</h3>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-4, 8px)' }}>
          卡片与页签的键位。只记录改过的项，其余跟随内置默认。
        </div>
        <HotkeySettings value={hotkeys} onChange={setHotkeys} />
      </div>

      <div className="fpx-settings-sec">
        <h3>目录</h3>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-4, 8px)' }}>
          下面几个目录决定**新建设在哪、跨栏搬家往哪搬**。留空则每次新建时自己选。
        </div>
        {dirRow('新建项目的预设父目录', createProjectDir, setCreateProjectDir, 'cp',
          '留空 = 每次新建时手动选')}
        {dirRow('新建项目组的预设父目录', createGroupDir, setCreateGroupDir, 'cg',
          '留空 = 每次新建时手动选')}
        {dirRow('项目组模板文件夹', groupTemplateDir, setGroupTemplateDir, 'gt',
          '新建项目组时把这里的内容复制过去（留空 = 不套模板）')}
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-3, 6px)' }}>
          「跨类别移动」里的<b>默认根目录</b>指的就是前两项：卡片换栏时若开启同步移动，
          文件夹会被搬到另一类别的预设父目录。两项都没设时，换栏只改归属、不搬文件夹。
        </div>
      </div>

      <div className="fpx-settings-sec">
        <h3>新建</h3>
        <Check
          checked={hierarchy} onChange={setHierarchy}
          title="新建项目 / 项目组时路径携带页签层级"
          sub="开启后路径为「父目录\页签名\名称」，关闭则直接建在父目录下"
        />
      </div>

      <div className="fpx-settings-sec">
        <h3>Agent 连锁</h3>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-3, 6px)' }}>
          内置四项（自由任务 / 一键审查 / 快速归并 / 快速部署）+ 自定义动作，
          每个动作分别可设项目与项目组两份指令模板。
        </div>
        <div className="p-row">
          <button className="p-btn" onClick={() => setManaging(true)}>管理连锁动作…</button>
          <button className="p-btn" onClick={() => setClientsOpen(true)}>自定义客户端…</button>
          <button className="p-btn" disabled={detecting} onClick={() => void refreshDetect()}>
            {detecting ? '检测中…' : '刷新检测'}
          </button>
        </div>
        {detected && (() => {
          const r = summarizeDetection(detected);
          return (
            <div className="p-muted fpx-detect" style={{ fontSize: 'var(--fs-11, 11px)' }}>
              检测到 {r.count} 个{r.count > 0 && <>：{r.names}</>}
              {r.hint && <div style={{ color: r.count === 0 ? 'var(--danger)' : 'var(--warn, #c98a00)', marginTop: 4 }}>{r.hint}</div>}
            </div>
          );
        })()}
      </div>

      <div className="fpx-settings-sec">
        <h3>跨类别移动（卡片换栏）</h3>
        <Check
          checked={moveFolder} onChange={setMoveFolder}
          title="跨项目 / 项目组移动时同步移动文件夹"
          sub="把卡片从「项目」栏移到「项目组」栏时，物理文件夹一并搬到项目组的预设父目录"
        />
        {moveFolder && (
          <div className="fpx-field">
            <label>搬家范围</label>
            <select className="p-input fpx-select" value={moveScope}
              onChange={(e) => setMoveScope(e.target.value)}>
              <option value="defaultRootsFlatten">仅默认根目录下的卡片（嵌套层级扁平化到目标根）</option>
              <option value="defaultRoots">仅默认根目录下的卡片（已在目标根内则保持原位）</option>
              <option value="anywhere">任意位置的卡片都搬</option>
            </select>
            <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)' }}>
              「默认根目录」指「新建」里设置的预设父目录（项目/项目组各一个）。
              搬迁目标是另一类别的预设父目录；未设置时自动跳过物理搬家，只换卡片归属。
            </div>
          </div>
        )}
      </div>

      <div className="fpx-settings-sec">
        <h3>软件图标（外壳）</h3>
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginBottom: 'var(--sp-3, 6px)' }}>
          更换本软件窗口在任务栏 / 标题栏上的图标。这是窗口级设置，不属于插件数据；
          重启软件后会回到打包时的默认图标。
        </div>
        {/*
          #111 拖放区 + #112 粘贴。
          两者共用 ingestImage：拖放与粘贴在前端拿到的都是**文件内容**，
          落盘后的处理完全一致，没必要分开写。
        */}
        <div
          className={`fpx-windrop${winDropOver ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setWinDropOver(true); }}
          onDragLeave={() => setWinDropOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setWinDropOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) void ingestImage(f, '拖入');
          }}
          /* 粘贴要挂在这块上：window 级监听会与本页其它输入框的粘贴打架
             （在别处复制路径时也会往这里塞图）。限定在软件图标这一区，
             用户点了这里再粘贴，意图就明确了。 */
          onPaste={(e) => {
            const item = Array.from(e.clipboardData?.items ?? [])
              .find((it) => it.type.startsWith('image/'));
            if (!item) return;
            const f = item.getAsFile();
            if (f) { e.preventDefault(); void ingestImage(f, '粘贴'); }
          }}
          tabIndex={0}
          role="button"
          title="把 .ico / .png 拖到这里，或在此处粘贴剪贴板里的图片"
        >
          {winBusy
            ? `${winBusy}处理中…`
            : '把图标文件拖到这里，或点此处后粘贴剪贴板图片'}
        </div>

        {iconFiles.length === 0 ? (
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            数据目录 icons/ 下还没有图标。可先拖入 / 粘贴一个，或在卡片的「图标与标签」里导入。
          </div>
        ) : (
          <div className="fpx-settings-icons">
            {iconFiles.map((n) => {
              const abs = iconsAbs(n);
              const on = pendingIcon?.path === abs;
              return (
                <button
                  key={n}
                  /* #110 选中的是**待应用**，不是"已应用" */
                  className={`fpx-settings-iconbtn${on ? ' pending' : ''}`}
                  title={on ? `待应用：${n}` : `暂存为软件图标：${n}`}
                  onClick={() => stageWindowIcon(abs, iconThumbs[n])}
                >
                  {iconThumbs[n] ? <img src={iconThumbs[n]} alt="" /> : '◆'}
                  <span>{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* #110 第二步：确认才真的换窗口图标 */}
        {pendingIcon && (
          <div className="fpx-winapply">
            <img
              className="fpx-winapply-img"
              src={pendingIcon.thumb ?? iconThumbs[pendingIcon.path] ?? ''}
              alt=""
            />
            <span className="fpx-winapply-name">
              待应用：{pendingIcon.path.split(/[\\/]/).pop()}
            </span>
            <button className="p-btn mini primary" onClick={() => void applyWindowIcon()}>
              应用
            </button>
            <button className="p-btn mini" onClick={() => setPendingIcon(null)}>取消</button>
          </div>
        )}
        {iconMsg && (
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-3, 6px)' }}>{iconMsg}</div>
        )}
      </div>

      <div className="fpx-settings-sec">
        <h3>图标</h3>
        <Check
          checked={iconSync} onChange={setIconSync}
          title="修改图标同步生效到资源管理器"
          sub="写入文件夹 desktop.ini（仅 Windows）；关闭则只在本界面显示"
        />
      </div>

      <div className="fpx-settings-sec">
        <h3>布局</h3>
        <div className="fpx-field">
          <div className="p-row">
            {/*
              `?.()` 而不是直接调用：这个回调是可选的（外层可以不传）。
              直接调用在没传时是 TypeError —— 点了按钮没反应、控制台报错，
              而用户只会觉得"这个按钮坏了"。
            */}
            <button className="p-btn" onClick={() => void onResetLayout?.()}>
              恢复默认布局
            </button>
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            三栏宽度与日志区高度可拖动栏间的分隔条调整，松手即记忆。
            拖乱了就点这里回到默认比例。
          </div>
        </div>
      </div>

      <div className="fpx-settings-sec">
        <h3>界面</h3>
        <label className="fpx-check">
          <input type="checkbox" checked={config.showShortcuts}
            onChange={(e) => onShowShortcutsChange?.(e.target.checked)} />
          <span className="fpx-check-box">{config.showShortcuts ? '✓' : ''}</span>
          <span>
            <span className="fpx-check-title">在按钮上显示快捷键</span>
            <span className="fpx-check-sub">
              关闭后工具栏按钮只显示文字（鼠标悬停的提示里仍会带键位）。
              显示的键位取自「快捷键」设置的当前值，改了键位这里会跟着变。
            </span>
          </span>
        </label>
      </div>

      {/* 开发者模式（#46）：默认关。它解锁的是"删除内置连锁动作"这类
          不可逆操作，摆在显眼处反而容易被顺手打开 —— 所以放在靠后的位置。 */}
      <div className="fpx-settings-sec">
        <h3>高级</h3>
        <label className="fpx-check">
          <input type="checkbox" checked={config.devMode}
            onChange={(e) => onDevModeChange?.(e.target.checked)} />
          <span className="fpx-check-box">{config.devMode ? '✓' : ''}</span>
          <span>
            <span className="fpx-check-title">开发者模式</span>
            <span className="fpx-check-sub">
              开启后允许删除内置连锁动作（自由任务 / 一键审查 / 快速归并 / 快速部署）。
              删掉后只有把动作清单清空才会重新生成，请谨慎。
            </span>
          </span>
        </label>
      </div>

      <div className="fpx-settings-sec">
        <h3>日志</h3>
        <div className="fpx-field">
          <label>最多保留条数</label>
          <div className="p-row">
            <input
              className="p-input fpx-num"
              type="number"
              min={LOG_MAX_LINES_MIN}
              max={LOG_MAX_LINES_MAX}
              value={logMaxDraft}
              onChange={(e) => setLogMaxDraft(e.target.value)}
              onBlur={() => setLogMaxDraft(String(clampLogMax(logMaxDraft)))}
            />
            <button
              className="p-btn"
              title={`恢复默认（${LOG_MAX_LINES_DEFAULT} 条）`}
              onClick={() => setLogMaxDraft(String(LOG_MAX_LINES_DEFAULT))}
            >
              恢复默认
            </button>
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            范围 {LOG_MAX_LINES_MIN}–{LOG_MAX_LINES_MAX}，超出会自动夹回。
            同时决定界面显示多少条与「复制全部」能拿到多少条 —— 所见即所复制。
            日志只是本次会话的操作流水，重启即清空，调大不占磁盘。
          </div>
        </div>
      </div>

      <div className="fpx-settings-sec">
        <h3>备份</h3>
        <Check
          checked={appendOnly} onChange={setAppendOnly}
          title="只增模式（源中删除的文件在备份中保留）"
          sub="关闭则做镜像同步，备份里多余的文件会被清除"
        />
        <div className="fpx-field">
          <label>自动备份间隔</label>
          <div className="p-row">
            <select
              className="p-input fpx-select"
              value={autoMinutes}
              onChange={(e) => setAutoMinutes(Number(e.target.value))}
            >
              {/* #93 当前值不在档位里时（手改 config.json 存了别的值）
                  动态插一项显示它 —— 受控 select 遇到没有的 option 会**显示空白**，
                  用户看不出当前是什么，还以为没设置。
                  这与 #63 同源：显示必须与实际一致。 */}
              {!BACKUP_PRESETS.some((p) => p.value === autoMinutes) && (
                <option value={autoMinutes}>{autoMinutes} 分钟（自定义）</option>
              )}
              {BACKUP_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            {status?.lastRun
              ? `上次自动备份：${status.lastRun}${status.running ? '，运行中' : ''}`
              : '设置后由后台定时执行，改动在保存时生效'}
          </div>
        </div>
        {dirRow('备份根目录（两类共用）', backupDir, setBackupDir, 'bu',
          '留空 = 用数据目录下的 backup/')}
        {dirRow('项目备份目录（优先）', backupProjectDir, setBackupProjectDir, 'bp',
          '指定后项目备份不再进根目录的子层')}
        {dirRow('项目组备份目录（优先）', backupGroupDir, setBackupGroupDir, 'bg',
          '指定后项目组备份不再进根目录的子层')}
        <div className="fpx-field">
          <label>备份位置</label>
          <div className="p-row">
            <button className="p-btn" onClick={() => { void api.openBackupDir('project').catch((e) => onLog(`打开失败：${errText(e)}`, true)); }}>
              打开项目备份目录
            </button>
            <button className="p-btn" onClick={() => { void api.openBackupDir('group').catch((e) => onLog(`打开失败：${errText(e)}`, true)); }}>
              打开项目组备份目录
            </button>
          </div>
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            打开的就是备份实际写入的目录。还没备份过时目录可能不存在 —— 这里不自动创建，
            免得看到空目录反而困惑。
          </div>
          {/* #29 把**实际生效**的两条路径显示出来。
              上面填的是规则，这里显示规则算出来的结果 ——
              留空时它会退到数据目录下的 backup/ 并再加一层类型子目录，
              那一层光看规则根本看不出来。 */}
          <div className="fpx-targets">
            <div className="fpx-target-row">
              <span className="fpx-target-label">项目</span>
              <span className="fpx-target-path" title={targets?.project}>{targets?.project ?? '（未取到）'}</span>
            </div>
            <div className="fpx-target-row">
              <span className="fpx-target-label">项目组</span>
              <span className="fpx-target-path" title={targets?.group}>{targets?.group ?? '（未取到）'}</span>
            </div>
          </div>
          {/* 取不到时明确说"未取到" —— 留空会被当成加载失败 */}
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            以上为当前规则下的实际落点，保存后才会变。数据目录：{targets?.dataDir ?? '（未取到）'}
          </div>
        </div>
      </div>

      <div className="fpx-settings-sec">
        <h3>MCP 服务</h3>
        <Check
          checked={mcpEnabled} onChange={setMcpEnabled}
          title="启用 MCP 服务"
          sub="关闭后外部 AI 工具的全部调用都会被拒绝（进程仍在跑，可随时改回）"
        />
        <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', margin: '4px 0 8px' }}>
          进程的启动 / 停止在「服务」面板；这里只管是否对外提供能力。
        </div>
        <Check
          checked={closeMcpOnExit} onChange={setCloseMcpOnExit}
          title="退出面板时一并关闭 MCP 进程"
          sub="勾选后退出即释放端口；不勾则进程常驻，关掉面板也能继续被客户端连"
        />
        {toolRows.length > 0 && (
          <div className="fpx-toollist">
            {toolRows.map((t) => (
              <Check
                key={t.name}
                checked={isToolOn(t.name)}
                onChange={(v) => toggleTool(t.name, v)}
                title={t.name}
                sub={t.desc}
              />
            ))}
          </div>
        )}
      </div>

      {dirPicker && (
        <DirDialog
          api={api}
          title="选择文件夹"
          allowCreate
          onClose={() => setDirPicker(null)}
          onPick={(p) => {
            if (dirPicker === 'cp') setCreateProjectDir(p);
            else if (dirPicker === 'cg') setCreateGroupDir(p);
            else if (dirPicker === 'bu') setBackupDir(p);
            else if (dirPicker === 'bp') setBackupProjectDir(p);
            else if (dirPicker === 'bg') setBackupGroupDir(p);
            else setGroupTemplateDir(p);
            setDirPicker(null);
          }}
        />
      )}

      {/* 保存按钮放在主体里而不是外层 Modal 的 footer：
          设置面板（外壳「⚙」）没有 Modal，只有主体，按钮必须自带。 */}
      <div className="p-row" style={{ marginTop: 'var(--sp-8, 16px)' }}>
        <button className="p-btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>

      {/*
        数据目录（只读展示）。

        **必须显示实际路径本身，不能只有"打开"按钮**：
        出问题时（要发日志、要手改 config、要告诉别人配置在哪），
        用户需要的是**这个路径字符串** —— 光有按钮他还是不知道在哪。
        主界面左栏那行能显示，但设置页才是"找配置"的第一去处。

        它是 Tauri 的 app_data_dir 决定的，**不可改**，所以只读、不做成输入框。
      */}
      <div className="fpx-settings-datadir">
        <span className="fpx-settings-datadir-label">数据目录</span>
        {dataDir ? (
          <code className="fpx-settings-datadir-path" title={dataDir}>{dataDir}</code>
        ) : (
          /* 外壳命令没编译进来时给个明确占位，不要留空 —— 留空会被当成加载失败 */
          <span className="fpx-settings-datadir-path p-muted">（未取到）</span>
        )}
      </div>

      {/* 版本与数据目录：出问题（要发日志、要手改 config）时第一件事就是找这两个。
          外壳命令不存在时（旧版 Rust 未编译进来）显示占位，不阻塞设置页。 */}
      <div className="fpx-settings-foot">
        <span>版本 {version || '—'}</span>
        <span className="fpx-foot-sep">·</span>
        {dataDir ? (
          <button className="p-btn fpx-foot-btn" title="打开数据目录"
            onClick={() => api.openPath(dataDir, 'dir').catch((e) => onLog(errText(e), true))}>
            数据目录
          </button>
        ) : (
          <span>数据目录 —</span>
        )}
        {dataDir && (
          <>
            <span className="fpx-foot-sep">·</span>
            <button className="p-btn fpx-foot-btn" title="复制数据目录路径"
              onClick={() => api.copyText(dataDir).then(
                (ok) => onLog(ok ? '已复制数据目录路径' : '复制失败', !ok),
                (e) => onLog(errText(e), true),
              )}>
              复制路径
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** 带副标题的勾选项（与 CheckLine 同款视觉，这里单独实现便于内联使用） */
export function Check({
  checked, onChange, title, sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  sub?: string;
}) {
  return (
    <label className="fpx-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="fpx-check-box">{checked ? '✓' : ''}</span>
      <span>
        <span className="fpx-check-title">{title}</span>
        {sub && <span className="fpx-check-sub">{sub}</span>}
      </span>
    </label>
  );
}
