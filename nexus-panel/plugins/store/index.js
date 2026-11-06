import { definePlugin, h } from '../../js/plugin-sdk.js';
import {
  getCustomPlugins, saveCustomPlugins,
  takeCustomPluginWriteError, customPluginWriteFailMsg,
} from '../../js/host.js';
import { prompt as askPrompt } from '../../js/dialog.js';
/* 联网商店装配层：把编排层第一次接进产品（清单第 50 轮）。
   只在 mount 里实例化，模块顶层不触发任何 invoke —— 否则面板还没挂载
   就去读 appDataDir，浏览器调试态会直接打不开。 */
import { createWebviewMarket } from '../../js/market-binding.js';

/**
 * 插件面板（插件商店）
 * ------------------------------------------------------------
 * 一个独立面板，集中做三件事：
 *   1. 列出**已安装**的应用插件与服务插件（服务单独一区，标注用途）
 *   2. 添加 / 移除自定义插件
 *   3. 未来接联网安装与卸载（面板结构已按商店形态预留）
 *
 * 为什么单独做一个面板，而不是继续塞在设置里：
 * 插件数量会增长，还要区分「应用 / 服务」两类、展示版本与来源，
 * 设置页已经很长了；而商店形态（列表 + 卡片 + 操作）跟设置的
 * 表单形态本来就不是一回事。
 */

/** 取外壳全局单例（同页 / 沙箱两种模式下位置不同，隔离态读不到要吞异常） */
function shellGlobal() {
  try {
    return window.__NEXUS__
      || (window.parent !== window ? window.parent?.__NEXUS__ : null)
      || null;
  } catch {
    return null;
  }
}

function readPlugins() {
  const list = shellGlobal()?.getPlugins?.();
  return Array.isArray(list) ? list : null;
}

/**
 * 重新加载注册表并刷新外壳侧边栏（添加/移除之后必须调，否则列表不更新）
 *
 * ⚠️ **必须 await**：它是 async（动态 import + loadRegistry 都要等）。
 * 不 await 就紧接着 render()，画出来的还是 shell 里的旧列表 ——
 * 界面上表现为"点了移除，卡片还在"，而 toast 已经报过成功了。
 * 更要紧的是失败会被吞：shell 取不到时 shell.state 直接 TypeError，
 * 而那时"已移除"已经弹出去了 —— 错在 A、报在 B。
 */
async function refreshShell(shell) {
  if (!shell) throw new Error('取不到外壳（不在主窗口里？）');
  const { loadRegistry, filterByRuntime } = await import('../../js/host.js');
  const list = filterByRuntime(await loadRegistry());
  shell.state.plugins = list;
  shell.refresh?.();
  return list;
}

export default definePlugin({
  name: '插件',
  async mount(ctx) {
    const shell = shellGlobal();
    const root = ctx.container;

    /* ============ 联网商店装配（第 50 轮接线） ============
     * PAT 只活在这个闭包里：不落盘、不进 localStorage、不进日志、不回显。
     * 拿不到 Tauri / appDataDir 时装配层返回结构化失败，这里只显示提示，
     * 不能让整个面板打不开（浏览器调试态没有 Tauri）。 */
    let sessionPat = '';
    let market = null;
    let marketCtl = null;
    let marketMsg = '';
    try {
      const wired = await createWebviewMarket({
        getToken: () => sessionPat,
        /* 内置插件 id 由外壳真实列表派生，不另写一份硬编码表：
           少写一个就可能被同名市场插件顶替，且不报错。 */
        reservedIds: (readPlugins() || []).map((x) => x.id),
      });
      if (wired.ok) {
        marketCtl = wired;
        market = wired.market;
      } else {
        marketMsg = wired.message || '联网安装不可用';
      }
    } catch (e) {
      marketMsg = `联网安装初始化失败：${e?.message || e}`;
    }

    /* ---- 分区容器 ---- */
    const appList = h('div', {});
    const svcList = h('div', {});

    const render = () => {
      const all = readPlugins() || [];
      const apps = all.filter((p) => p.kind !== 'service');
      const svcs = all.filter((p) => p.kind === 'service');

      /* ---- 应用插件 ---- */
      appList.innerHTML = '';
      if (!apps.length) {
        appList.appendChild(h('div.p-muted', { style: { padding: '12px 0' } },
          '还没有安装任何应用插件。'));
      }
      for (const p of apps) {
        appList.appendChild(card({
          icon: p.icon || '◈',
          name: p.name,
          desc: p.description || '',
          meta: [
            p.version ? 'v' + p.version : null,
            p.builtin ? '内置' : null,
            p.custom ? '自定义' : null,
            p.type === 'iframe' ? '沙箱' : '同页',
          ].filter(Boolean).join(' · '),
          actions: p.builtin ? [] : [
            {
              label: '移除', danger: true,
              onclick: async () => {
                const next = getCustomPlugins().filter((x) => x.id !== p.id);
                /* 没存下就不能往下走：刷新出来的还是旧列表，
                   而下面那句「已移除」会先弹出来 —— 说了移除其实没移除。 */
                if (!saveCustomPlugins(next)) {
                  ctx.toast?.(customPluginWriteFailMsg('移除', p.name, takeCustomPluginWriteError()), 'err');
                  return;
                }
                /*
                 * 先刷新、再报成功。
                 *
                 * 原来是「toast 已移除 → refreshShell()（没 await）→ render()」：
                 * 刷新是异步的，render 画的是 shell 里那份**还没换**的旧列表，
                 * 于是卡片原地不动；而刷新真失败时（shell 取不到）rejection
                 * 没人接，界面上只剩下那句"已移除"。
                 */
                try {
                  await refreshShell(shell);
                } catch (e) {
                  ctx.toast?.(`已移除「${p.name}」，但刷新列表失败：${e?.message || e}`, 'err');
                  return;
                }
                ctx.toast?.(`已移除「${p.name}」`, 'ok');
                render();
              },
            },
          ],
        }));
      }

      /* ---- 服务插件 ---- */
      svcList.innerHTML = '';
      if (!svcs.length) {
        svcList.appendChild(h('div.p-muted', { style: { padding: '12px 0' } },
          '还没有安装服务插件。服务插件不显示在侧边栏，由其它插件通过 ctx.services.call 调用。'));
      }
      for (const p of svcs) {
        svcList.appendChild(card({
          icon: p.icon || '⚙',
          name: p.name,
          desc: p.description || '',
          meta: ['服务插件', p.version ? 'v' + p.version : null].filter(Boolean).join(' · '),
          actions: [],
        }));
      }
    };

    /** 一张卡片：图标 + 名称 + 说明 + 元信息 + 操作按钮 */
    function card({ icon, name, desc, meta, actions }) {
      const row = h('div', {
        style: {
          display: 'flex', gap: '10px', alignItems: 'flex-start',
          padding: '10px 12px', marginTop: '8px',
          borderRadius: 'var(--r-sm)', background: 'var(--surface-sunk)',
          boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
        },
      });
      row.appendChild(h('div', {
        style: { fontSize: '18px', lineHeight: '1.4', flex: '0 0 auto', width: '24px', textAlign: 'center' },
      }, icon));
      const mid = h('div', { style: { flex: '1', minWidth: '0' } });
      mid.appendChild(h('div', { style: { fontSize: '13px', fontWeight: '600' } }, name));
      if (meta) {
        mid.appendChild(h('div.p-muted', { style: { fontSize: '11px', marginTop: '2px' } }, meta));
      }
      if (desc) {
        mid.appendChild(h('div.p-muted', {
          style: { fontSize: '11px', marginTop: '4px', lineHeight: '1.6' },
        }, desc));
      }
      row.appendChild(mid);

      if (actions?.length) {
        const bar = h('div', { style: { display: 'flex', gap: '6px', flex: '0 0 auto' } });
        for (const a of actions) {
          bar.appendChild(h('button.p-btn', {
            style: {
              height: '26px', padding: '0 9px', fontSize: '11px',
              ...(a.danger ? { color: 'var(--danger)' } : {}),
            },
            onclick: a.onclick,
          }, a.label));
        }
        row.appendChild(bar);
      }
      return row;
    }

    /* ============ 组装 ============ */
    root.appendChild(h('div.p-card', {},
      h('h2', {}, '已安装'),
      h('div.p-muted', {
        style: { fontSize: '11px', lineHeight: '1.6', marginTop: '4px' },
      }, '应用插件显示在侧边栏；服务插件不显示，供其它插件调用。'),
      appList,
      h('h3', { style: { marginTop: '16px', fontSize: '13px' } }, '服务插件'),
      svcList,
    ));

    /* 添加自定义插件：复用与外壳一致的字段，保存后刷新列表 */
    root.appendChild(h('div.p-card', { style: { marginTop: '12px' } },
      h('h2', {}, '添加插件'),
      h('div.p-muted', {
        style: { fontSize: '11px', lineHeight: '1.6', marginTop: '4px' },
      }, '填写插件入口信息即可安装。未来这里会接联网商店，直接从目录安装与卸载。'),
      h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button.p-btn', {
          onclick: async () => {
            /*
             * validate 让弹窗当场拦住空值并把原因写在框下面。
             * 不用它的话，空值点「确定」只是静默回到面板 ——
             * 用户按了按钮却毫无反应，只会以为这按钮坏了。
             */
            const name = await askPrompt({
              title: '插件名称', placeholder: '例如：我的工具',
              validate: (v) => (v.trim() ? null : '请填写插件名称'),
            });
            if (!name) return;
            const entry = await askPrompt({
              title: '入口文件', placeholder: './plugins/xxx/index.html',
              validate: (v) => (v.trim() ? null : '请填写入口文件路径'),
            });
            if (!entry) return;
            /*
             * 需要的后端命令 —— 外壳「＋」面板里有同一项，这里不能缺。
             *
             * 不给这一项，插件只能调 js/invoke-policy.js 的 SAFE_COMMANDS
             * （就 app_version / rust_ping 两个只读命令），一调别的就被
             * 白名单挡下，而用户只会看到"插件没反应"，
             * 完全想不到是权限问题 —— 从这儿装进来的插件等于废的。
             */
            const cmds = await askPrompt({
              title: '需要的后端命令',
              message: '可选，逗号分隔。不填则只能用 app_version / rust_ping 两个只读命令。',
              placeholder: 'app_version, fs_op',
              cancelText: '跳过',
            });
            const item = {
              name: name.trim(), entry: entry.trim(),
              icon: '◆',
              type: 'iframe',
              kind: 'app',
              version: '1.0.0',
              description: '自定义插件',
              commands: cmds ? cmds.split(',').map((x) => x.trim()).filter(Boolean) : [],
            };
            /* 写在 try 之前：存不下时这个插件根本不在清单里，
               后面刷新/渲染都是白做，而「已添加」又会照弹。 */
            if (!saveCustomPlugins([...getCustomPlugins(), item])) {
              ctx.toast?.(customPluginWriteFailMsg('添加', item.name, takeCustomPluginWriteError()), 'err');
              return;
            }
            try {
              await refreshShell(shell);
            } catch (e) {
              ctx.toast?.(`已添加「${item.name}」，但刷新列表失败：${e?.message || e}`, 'err');
              return;
            }
            ctx.toast?.(`已添加「${item.name}」`, 'ok');
            render();
          },
        }, '＋ 添加自定义插件'),
      ),
    ));

    /* ============ 联网商店（从私有仓库安装 / 卸载 / 查更新） ============ */
    const netState = h('div.p-muted', {
      style: { fontSize: '11px', lineHeight: '1.6', marginTop: '4px' },
    }, market ? '' : marketMsg);

    /* 至少调用一个能力方法：list() 把「已联网安装」的数量写进状态行。
       只实例化、不调用，等于没接线（台账 unblock 第一条）。 */
    if (market) {
      try {
        const listed = await market.list();
        const n = (listed?.plugins || []).filter((x) => !x.builtin).length;
        netState.textContent = `联网安装已就绪 · 已安装 ${n} 个市场插件`;
      } catch (e) {
        netState.textContent = `联网安装已就绪，但列表读取失败：${e?.message || e}`;
      }
    }

    const patInput = h('input', {
      type: 'password',
      placeholder: 'GitHub PAT（私有仓必需，仅本次会话，不保存）',
      autocomplete: 'off',
      spellcheck: 'false',
      style: {
        flex: '1', minWidth: '220px', height: '28px', padding: '0 8px',
        fontSize: '11px', borderRadius: 'var(--r-sm)',
        border: '1px solid var(--border, #8884)', background: 'var(--surface-sunk)',
      },
      oninput: (e) => {
        sessionPat = e?.target?.value || '';
        /* 只写内存：装配层把 token 转成 Authorization 放进 headerBox，
           任何一步都不落盘、不进日志、不回显。 */
        marketCtl?.setToken?.(sessionPat);
      },
    });

    const netBtn = (label, fn, danger = false) => h('button.p-btn', {
      style: {
        height: '28px', padding: '0 10px', fontSize: '11px',
        ...(danger ? { color: 'var(--danger)' } : {}),
      },
      onclick: fn,
    }, label);

    const needMarket = () => {
      if (market) return true;
      ctx.toast?.(marketMsg || '联网安装不可用', 'err');
      return false;
    };

    root.appendChild(h('div.p-card', { style: { marginTop: '12px' } },
      h('h2', {}, '联网安装'),
      netState,
      h('div', {
        style: {
          marginTop: '8px', display: 'flex', gap: '6px',
          flexWrap: 'wrap', alignItems: 'center',
        },
      },
        patInput,
        netBtn('检查更新', async () => {
          if (!needMarket()) return;
          const r = await market.checkUpdates();
          const hits = (r?.results || []).filter((x) => x.hasUpdate);
          ctx.toast?.(hits.length
            ? `${hits.length} 个插件有更新：${hits.map((x) => x.id).join('、')}`
            : '所有已安装插件均为最新', 'ok');
        }),
        netBtn('从仓库安装', async () => {
          if (!needMarket()) return;
          const repo = await askPrompt({
            title: '插件仓库',
            placeholder: 'owner/repo，例如 xxx/nexusPanel_plugin_demoIframe',
            validate: (v) => (v.trim() && v.trim().includes('/') ? null : '请填写 owner/repo'),
          });
          if (!repo) return;
          const r = await market.install(repo.trim());
          ctx.toast?.(r.ok
            ? `已安装「${r.id}」 v${r.version}`
            : `安装失败：${r.error || r.stage}`, r.ok ? 'ok' : 'err');
          if (r.ok) render();
        }),
        netBtn('卸载', async () => {
          if (!needMarket()) return;
          const id = await askPrompt({
            title: '卸载插件 id', placeholder: '例如 demoIframe',
            validate: (v) => (v.trim() ? null : '请填写插件 id'),
          });
          if (!id) return;
          const r = await market.uninstall(id.trim());
          ctx.toast?.(r.ok
            ? `已卸载「${id.trim()}」（用户数据已保留）`
            : `卸载失败：${r.error || ''}`, r.ok ? 'ok' : 'err');
          if (r.ok) render();
        }, true),
      ),
      h('div.p-muted', {
        style: { fontSize: '11px', lineHeight: '1.6', marginTop: '6px' },
      }, '产物需为各插件仓 Release 里的规范命名 tarball。资产下载会重定向到 GitHub 对象存储，真机需确认 CSP 放行；装完后的加载与侧边栏呈现属阶段 0，待本机实测。'),
    ));

    render();
  },
});
