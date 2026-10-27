// 会话选择通过原生技能 provider 接入目录与加载工具，所有注册均归属 agent scope。
const listeners = new Set();
export function notifySkillSelectionChanged() {
  for (const invalidate of listeners) invalidate();
}

export function installSessionSkills(ctx, { readSessionConfig, skillsRoot }) {
  const attached = new Map();
  const warned = new WeakSet();
  let closed = false;
  function warn(message, error) {
    try { ctx.logger?.warn?.(`${message}：${error instanceof Error ? error.message : String(error)}`); }
    catch { /* 日志服务不可用也不能干扰宿主会话。 */ }
  }
  function assemblyFailure(error, agent) {
    if (agent && (typeof agent === 'object' || typeof agent === 'function')) {
      if (warned.has(agent)) return;
      warned.add(agent);
    }
    warn('会话技能装配失败（本会话的选择层不可用，原生技能继续运行）', error);
  }
  // 使用宿主的包解析，避免另装一份 scope 后产生不共享的身份与父链。
  // 启动即检查并缓存结果；缺包只提示一次，不在每一步重复 import/抛错。
  const runtimeReady = Promise.all([
    import('@deepseek-ai/dsh-scope'), import('@deepseek-ai/dsh-skill-filesystem'),
  ]).catch((error) => {
    warn('会话技能选择层不可用（缺少或无法加载宿主依赖；原生技能继续运行）', error);
    return undefined;
  });
  async function attach(agent) {
    if (closed || !agent?.ctx || !agent.session?.header?.cwd) return;
    if (attached.has(agent)) return attached.get(agent);
    const pending = (async () => {
      const runtime = await runtimeReady;
      if (closed || !runtime) return;
      const [{ createScope, scopeParentOf }, { FileSystemSkillProvider }] = runtime;
      const scope = createScope(agent.ctx, agent);
      const registry = scope.ctx.get('skills');
      if (!registry?.registerProvider) { await scope.dispose(); return; }
      let library, invalidate;
      try {
        registry.registerProvider((control) => {
          invalidate = control.invalidate;
          listeners.add(invalidate);
          // 构造可能抛错；必须先登记清理，接住宿主随后的 abort。
          control.signal.addEventListener('abort', () => {
            listeners.delete(invalidate);
            attached.delete(agent);
          }, { once: true });
          library = new FileSystemSkillProvider(scope.ctx, control, {
            includeDefaultRoots: false, customSkillDirs: [skillsRoot()], watch: false,
          });
          const providerName = 'skill-manager-session';
          function parentLookup(options) {
            let parent = scopeParentOf(agent);
            // 子代理不能意外继承父会话的选择；只读取预设及宿主层。
            while (parent?.session) parent = scopeParentOf(parent);
            return { ...options, scope: parent };
          }
          return {
            name: providerName,
            async list(options) {
              if (options.scope !== agent) return [];
              const cfg = await readSessionConfig(agent.session.id ?? agent.id);
              if (!cfg.explicit) return [];
              const parent = await registry.snapshot(parentLookup(options));
              const found = await library.list(options);
              const libraryCandidates = Array.isArray(found) ? found : found.candidates;
              const byName = new Map(libraryCandidates.map((candidate) => [candidate.name, { candidate, local: true }]));
              const readonly = new Set();
              for (const summary of parent.skills) {
                if (['project-dsh', 'project-agents', 'user-dsh', 'user-agents'].includes(summary.source)) {
                  byName.set(summary.name, { candidate: summary, local: false });
                } else {
                  // 原生预设/runtime/custom 来源保持只读，不能被同名库技能顶掉。
                  readonly.add(summary.name);
                }
              }
              const selected = new Set(cfg.enabled);
              return {
                complete: parent.complete && (Array.isArray(found) || found.complete !== false),
                candidates: [...byName].filter(([name]) => !readonly.has(name)).map(([name, { candidate, local }]) => ({
                  ...candidate, provider: providerName, rank: 1000,
                  invocation: selected.has(name) ? candidate.invocation : { modelInvocable: false, userInvocable: false },
                  locator: { candidate, local },
                })),
              };
            },
            async get(candidate, options) {
              const cfg = await readSessionConfig(agent.session.id ?? agent.id);
              if (cfg.explicit && !cfg.enabled.includes(candidate.name)) return undefined;
              const definition = candidate.locator.local
                ? await library.get(candidate.locator.candidate, options)
                : await registry.get(candidate.name, parentLookup(options));
              return definition ? { ...definition, provider: providerName } : undefined;
            },
          };
        });
      } catch (error) {
        listeners.delete(invalidate);
        try { await scope.dispose(); }
        finally { await library?.dispose(); }
        throw error;
      }
      return { invalidate, dispose: async () => {
        try { await scope.dispose(); }
        finally { await library?.dispose(); }
      } };
    })();
    attached.set(agent, pending);
    try { return await pending; }
    catch (error) { attached.delete(agent); throw error; }
  }
  ctx.on('agent/created', async ({ agent }) => {
    try { await attach(agent); }
    catch (error) { assemblyFailure(error, agent); }
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // 每步重新读取持久状态，也覆盖另一个 profile/进程写入后的缓存刷新。
    try {
      const entry = await attach(agent);
      entry?.invalidate();
    } catch (error) { assemblyFailure(error, agent); }
    return next();
  });
  ctx.on('agent/disposed', async ({ agent }) => {
    try { await (await attached.get(agent))?.dispose(); }
    catch (error) { assemblyFailure(error, agent); }
    finally { attached.delete(agent); }
  });
  // 热加载也要为已有会话装配；下一步钩子仍作为兜底。
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
    attach(agent).catch((error) => assemblyFailure(error, agent));
  }
  ctx.effect(() => async () => {
    closed = true;
    for (const [agent, pending] of [...attached]) {
      try { await (await pending)?.dispose(); }
      catch (error) { assemblyFailure(error, agent); }
    }
    attached.clear();
  }, 'skill-manager: session providers');
}
