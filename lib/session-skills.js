// 会话选择通过原生技能 provider 接入目录与加载工具，所有注册均归属 agent scope。
const listeners = new Set();
export function notifySkillSelectionChanged() {
  for (const invalidate of listeners) invalidate();
}

export function installSessionSkills(ctx, { readSessionConfig, skillsRoot }) {
  const attached = new Map();
  let closed = false;
  async function attach(agent) {
    if (closed || !agent?.ctx || !agent.session?.header?.cwd) return;
    if (attached.has(agent)) return attached.get(agent);
    const pending = (async () => {
      const [{ createScope, scopeParentOf }, { FileSystemSkillProvider }] = await Promise.all([
        import('@deepseek-ai/dsh-scope'), import('@deepseek-ai/dsh-skill-filesystem'),
      ]);
      if (closed) return;
      const scope = createScope(agent.ctx, agent);
      const registry = scope.ctx.get('skills');
      if (!registry?.registerProvider) { await scope.dispose(); return; }
      let library, invalidate;
      try {
        registry.registerProvider((control) => {
          invalidate = control.invalidate;
          listeners.add(invalidate);
          library = new FileSystemSkillProvider(scope.ctx, control, {
            includeDefaultRoots: false, customSkillDirs: [skillsRoot()], watch: false,
          });
          control.signal.addEventListener('abort', () => {
            listeners.delete(invalidate);
            attached.delete(agent);
          }, { once: true });
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
      } catch (error) { await scope.dispose(); throw error; }
      return { invalidate, dispose: async () => { await scope.dispose(); await library?.dispose(); } };
    })();
    attached.set(agent, pending);
    try { return await pending; }
    catch (error) { attached.delete(agent); throw error; }
  }
  ctx.on('agent/created', async ({ agent }) => { await attach(agent); });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // 每步重新读取持久状态，也覆盖另一个 profile/进程写入后的缓存刷新。
    const entry = await attach(agent);
    entry?.invalidate();
    return next();
  });
  ctx.on('agent/disposed', async ({ agent }) => {
    const entry = await attached.get(agent);
    await entry?.dispose();
    attached.delete(agent);
  });
  // 热加载也要为已有会话装配；下一步钩子仍作为兜底。
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
    attach(agent).catch((error) => ctx.logger?.warn?.(`会话技能装配失败：${error.message}`));
  }
  ctx.effect(() => async () => {
    closed = true;
    for (const pending of [...attached.values()]) await (await pending)?.dispose();
    attached.clear();
  }, 'skill-manager: session providers');
}
