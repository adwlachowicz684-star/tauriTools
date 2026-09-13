import { definePlugin, h } from '../../js/plugin-sdk.js';

/**
 * 同页挂载（module）示例
 * 特点：与主页面共享 JS 环境 → 可直接 ctx.invoke 调 Rust、性能最好。
 * ctx.addStyle 会自动加作用域前缀，CSS 不会污染其他插件。
 */
export default definePlugin({
  name: '示例·同页插件',
  async mount(ctx) {
    const removeStyle = ctx.addStyle(`
      .hero { padding: 18px; border-radius: var(--r);
              box-shadow: inset 4px 4px 8px var(--sh-dark), inset -4px -4px 8px var(--sh-light); }
      .hero .num { font-size: 40px; font-weight: 700; color: var(--accent); line-height: 1.1; }
      .log { max-height: 160px; overflow: auto; font-family: Menlo, Consolas, monospace; font-size: 11.5px; }
    `);

    // 持久化状态
    let count = await ctx.store.get('count', 0);
    const numEl = h('div.num', {}, String(count));
    const logEl = h('div.log.p-mono.p-muted', {});

    const log = (msg) => {
      const t = new Date().toLocaleTimeString();
      logEl.prepend(h('div', {}, `[${t}] ${msg}`));
    };

    // 定时器演示清理；间隔来自插件自己的设置面板（0 = 关闭心跳）
    let heartbeat = await ctx.store.get('heartbeat', 5000);
    let timer = null;
    const restartTimer = () => {
      clearInterval(timer);
      if (heartbeat > 0) timer = setInterval(() => log('心跳 tick'), heartbeat);
    };
    restartTimer();
    ctx.onDestroy(() => clearInterval(timer));
    ctx.onDestroy(removeStyle);

    // 设置面板改了配置会广播过来，主视图即时响应
    const offCfg = ctx.on('demo-module:config', (cfg) => {
      heartbeat = cfg?.heartbeat ?? heartbeat;
      restartTimer();
      log(`配置已更新：心跳 ${heartbeat > 0 ? heartbeat + 'ms' : '关闭'}`);
    });
    ctx.onDestroy(offCfg);

    // 监听其他插件事件
    const off = ctx.on('demo:ping', (payload) => {
      log('收到事件 demo:ping → ' + JSON.stringify(payload));
      ctx.toast('收到跨插件事件');
    });
    ctx.onDestroy(off);

    const bump = async () => {
      count++;
      numEl.textContent = String(count);
      await ctx.store.set('count', count);
      ctx.emit('demo:counter', count);   // 广播给其他插件（概览会把角标更新）
      ctx.setBadge(count);
      log(`count = ${count}（已持久化）`);
    };

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '计数器（持久化 + 事件广播）'),
        h('div.hero', { style: { textAlign: 'center' } },
          numEl,
          h('div.p-muted', { style: { marginTop: '4px' } }, 'ctx.store 自动隔离，只属于本插件'),
        ),
        h('div.p-row', { style: { marginTop: '16px', justifyContent: 'center' } },
          h('button.p-btn.primary', { onclick: bump }, '＋ 1'),
          h('button.p-btn', { onclick: async () => { count = 0; numEl.textContent = '0'; await ctx.store.set('count', 0); ctx.setBadge(0); } }, '重置'),
          h('button.p-btn', { onclick: () => ctx.emit('demo:ping', { from: ctx.id, at: Date.now() }) }, '广播 demo:ping'),
        ),
      ),
    );

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '调用 Rust 后端'),
        h('div.p-row', {},
          h('button.p-btn', {
            onclick: async () => {
              try {
                const r = await ctx.invoke('rust_ping', { payload: '来自同页插件' });
                log('rust_ping → ' + r);
                ctx.toast('调用成功', 'ok');
              } catch (e) { log('错误：' + e); ctx.toast(String(e), 'err'); }
            },
          }, 'invoke("rust_ping")'),
          h('button.p-btn', {
            onclick: async () => {
              const r = await ctx.invoke('app_version').catch((e) => 'ERR ' + e);
              log('app_version → ' + r);
            },
          }, 'invoke("app_version")'),
        ),
      ),
    );

    // 快捷键：只在自己被激活时生效，切走自动失效，卸载自动注销
    ctx.shortcut('mod+k', () => { log('快捷键 mod+k'); ctx.toast('mod+k'); });
    ctx.shortcut('mod+shift+k', () => { log('快捷键 mod+shift+k'); });
    ctx.shortcut('alt+n', () => bump());

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '快捷键'),
        h('div.p-muted', { style: { lineHeight: '1.9' } },
          '本插件注册了 mod+k、mod+shift+k、alt+n —— 切到别的插件后这些键就不再响应，',
          h('br'), '插件卸载时自动注销，不会残留。下同页插件的快捷键互不影响。'),
        h('div.p-row', { style: { marginTop: '12px' } },
          h('span.p-tag', {}, 'mod+k'),
          h('span.p-tag', {}, 'mod+shift+k'),
          h('span.p-tag', {}, 'alt+n'),
        ),
      ),
    );

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '运行日志'),
        logEl,
      ),
    );

    log(`插件已挂载，mode = ${ctx.mode}`);

    // 返回卸载函数（可选）
    return () => console.log('[demo-module] 已卸载');
  },

  /**
   * 插件自己的设置面板
   * 声明后外壳标题栏会出现「⚙ 设置」按钮，点击后从右侧滑出，
   * 这里拿到的 ctx 与主视图完全一致（同一个 store、同一条事件总线）。
   */
  async settings(ctx) {
    let heartbeat = await ctx.store.get('heartbeat', 5000);

    const field = (label, hint, control) =>
      h('div.p-row', {
        style: {
          padding: '12px 14px', marginTop: '10px', borderRadius: 'var(--r)',
          background: 'var(--surface-sunk)',
          boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
        },
      },
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontSize: '13px' } }, label),
          h('div.p-muted', { style: { fontSize: '11px', marginTop: '2px' } }, hint),
        ),
        control,
      );

    // 开关：心跳是否开启
    const toggle = h('button.p-btn', {
      style: { height: '30px', padding: '0 12px', fontSize: '12px' },
      onclick: () => {
        heartbeat = heartbeat > 0 ? 0 : 5000;
        toggle.textContent = heartbeat > 0 ? '已开启' : '已关闭';
        toggle.classList.toggle('primary', heartbeat > 0);
        apply();
      },
    }, heartbeat > 0 ? '已开启' : '已关闭');
    heartbeat > 0 && toggle.classList.add('primary');

    // 间隔选择
    const sel = h('select.p-input', {
      style: { height: '30px', width: '110px', fontSize: '12px', padding: '0 8px' },
      onchange: (e) => {
        heartbeat = Number(e.target.value);
        apply();
      },
    },
      [1000, 3000, 5000, 10000].map((ms) =>
        h('option', { value: ms, selected: heartbeat === ms }, `${ms / 1000}s`)),
    );

    // 保存并广播给主视图
    const apply = async () => {
      await ctx.store.set('heartbeat', heartbeat);
      ctx.emit('demo-module:config', { heartbeat });
    };

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '同页插件设置'),
        h('div.p-muted', { style: { marginBottom: '4px', lineHeight: '1.9' } },
          '改动会立刻广播给主视图 —— 设置面板与主视图共享同一条事件总线。'),
        field('心跳日志', '定时输出一条日志，关掉更安静', toggle),
        field('心跳间隔', '仅在上一项开启时生效', sel),
        h('div.p-row', { style: { marginTop: '16px' } },
          h('button.p-btn.primary', {
            onclick: async () => {
              await apply();
              ctx.toast('设置已保存', 'ok');
            },
          }, '保存'),
          h('button.p-btn', { onclick: () => ctx.reload() }, '重载插件'),
        ),
      ),
    );

    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '调试'),
        h('div.p-row', {},
          h('button.p-btn', {
            onclick: async () => {
              const all = await ctx.store.all();
              ctx.toast('已输出到控制台', 'ok');
              console.log('[demo-module] store:', all);
            },
          }, '打印 store'),
          h('button.p-btn.danger', {
            onclick: async () => {
              await ctx.store.del('heartbeat');
              await ctx.store.del('count');
              ctx.toast('已清空本插件数据', 'ok');
            },
          }, '清空数据'),
        ),
      ),
    );
  },
});
