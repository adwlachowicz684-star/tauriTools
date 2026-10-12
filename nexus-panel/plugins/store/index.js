import { definePlugin, h } from '../../js/plugin-sdk.js';
import { getCustomPlugins, saveCustomPlugins } from '../../js/host.js';
import { prompt as askPrompt } from '../../js/dialog.js';

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
                saveCustomPlugins(next);
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
            saveCustomPlugins([...getCustomPlugins(), item]);
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

    render();
  },
});
