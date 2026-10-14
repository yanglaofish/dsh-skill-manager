const { createRequire, registerHooks } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const runtimeRequire = createRequire(path.join(process.argv[2], 'package.json'));
let resolving = false;
registerHooks({ resolve(specifier, context, next) {
  if (!resolving && specifier.startsWith('@deepseek-ai/')) {
    let resolved;
    try { resolving = true; resolved = runtimeRequire.resolve(specifier); }
    finally { resolving = false; }
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  return next(specifier, context);
} });

(async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skm-session-runtime-'));
  process.env.DSH_HOME = path.join(root, 'dsh');
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_BUNDLED_SKILL_DIR;
  const { Context } = runtimeRequire('@deepseek-ai/cordis');
  const { SkillRegistry } = runtimeRequire('@deepseek-ai/dsh-skill');
  const { createScope, scopeTarget } = runtimeRequire('@deepseek-ai/dsh-scope');
  const { agentEvents } = runtimeRequire('@deepseek-ai/dsh-agent');
  const compiler = runtimeRequire('@deepseek-ai/dsh-tools');
  const { FileSystemSkillProvider } = runtimeRequire('@deepseek-ai/dsh-skill-filesystem');
  const toolSkill = runtimeRequire('@deepseek-ai/dsh-tool-skill');
  const manager = require('../lib/index.js');
  const ctx = new Context();
  const skillRegistry = new SkillRegistry(ctx);
  const scopes = [];
  const providers = [];
  const tools = new Map();
  const agents = new Map();
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }, get(name) { return tools.get(name); } });
  ctx.provide('sessions', { list() { return []; } });
  ctx.provide('agents', { get(id) { return agents.get(id); }, list() { return [...agents.values()]; } });
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  try {
    const presetKey = {};
    const preset = createScope(ctx, presetKey);
    scopes.push(preset);
    preset.ctx.get('skills').registerProvider((control) => {
      const provider = new FileSystemSkillProvider(preset.ctx, control, { watch: false });
      providers.push(provider);
      return provider;
    });
    preset.ctx.get('skills').register({ name: 'preset-only', description: '预设', content: '预设正文', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } });
    toolSkill.apply(preset.ctx);
    const definition = { name: 'test-manager', apply: manager.apply };
    let plugin = ctx.plugin(definition);
    await new Promise((resolve) => setImmediate(resolve));
    await manager.registerWorkspace(cwd);
    await manager.importSkillDocs([{ content: '---\nname: picked\ndescription: 会话技能\n---\n会话专用正文' }]);
    async function agent(id) {
      const value = { id, session: { id, header: { cwd }, seq: 0, surface: { nodes: [] } } };
      const scope = createScope(ctx, value, { parent: presetKey });
      scopes.push(scope);
      value.ctx = scope.ctx;
      agents.set(id, value);
      await ctx.serial(scopeTarget(value, value), 'agent/created', { agent: value });
      return value;
    }
    const a = await agent('a'), b = await agent('b');
    for (const tool of tools.values()) compiler.assertSupportedJsonSchema(tool.parameters);
    const catalog = async (agent) => (await skillRegistry.list({ cwd, scope: agent })).filter((s) => s.invocation.modelInvocable).map((s) => s.name);
    assert.equal((await manager.setSessionSkills('a', cwd, ['picked'], true)).ok, true);
    assert.ok((await catalog(a)).includes('picked'), '会话勾选必须进入真实技能目录');
    assert.ok(!(await catalog(b)).includes('picked'), '同项目其他会话不能继承 A 的选择');
    const skillTool = tools.get('skill');
    const exec = (agent) => ({ agent, signal: new AbortController().signal });
    const step = (agent, messages = []) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages, signal: new AbortController().signal,
    }, async () => ({ kind: 'continue', messages, startsRequestSeries: true }));
    const loaded = await skillTool.execute({ name: 'picked' }, exec(a));
    assert.match(loaded.content, /会话专用正文/);
    assert.equal(loaded.resourceBase.path, path.join(manager.skillsRoot(), 'picked'));
    const firstStep = await step(a);
    assert.ok(JSON.stringify(firstStep.messages).includes('picked'), '模型实际收到的原生目录包含会话选择');
    assert.equal(firstStep.startsRequestSeries, true, '不能丢失原生决策字段');
    await assert.rejects(() => skillTool.execute({ name: 'picked' }, exec(b)), /unknown|not available/);
    assert.ok((await catalog(a)).includes('preset-only'));
    await manager.linkGlobalSkillToWorkspace(cwd, 'picked');
    // 本测试关闭文件监视器，显式清掉原生 provider 缓存模拟文件变更通知。
    skillRegistry.invalidateCache();
    await manager.setSessionSkills('a', cwd, [], true);
    assert.ok(!(await catalog(a)).includes('picked'), '空选集必须屏蔽工作区技能');
    assert.ok((await catalog(b)).includes('picked'), '跟随中的 B 保留工作区技能');
    await assert.rejects(() => skillTool.execute({ name: 'picked' }, exec(a)), /unknown|not available/);
    const disabledStep = await step(a, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '/picked' }] }]);
    assert.ok(!disabledStep.messages.some((m) => m.source?.kind === 'skill-invocation'), '取消勾选也禁止用户直接加载路径');
    await manager.setSessionSkills('a', cwd, [], false);
    assert.ok((await catalog(a)).includes('picked'), '回到跟随后恢复工作区集合');
    // 原生调用策略、预设同名、编辑后内容及重新装配均必须保持正确。
    await manager.importSkillDocs([
      { content: '---\nname: preset-only\ndescription: 同名库版本\n---\n不能覆盖预设' },
      { content: '---\nname: user-only\ndescription: 仅用户调用\ndisable-model-invocation: true\n---\n用户技能正文' },
    ]);
    await manager.setSessionSkills('a', cwd, ['picked', 'user-only'], true);
    assert.match((await skillTool.execute({ name: 'preset-only' }, exec(a))).content, /预设正文/);
    assert.ok(!(await catalog(a)).includes('user-only'), '会话选择不能放宽技能的原生调用策略');
    const userStep = await step(a, [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '/user-only' }] }]);
    assert.ok(userStep.messages.some((m) => m.source?.kind === 'skill-invocation'), '允许的人类显式调用仍能加载');
    // Windows 副本模式下，编辑工作区当前实际加载的文件；不覆盖独立库版本。
    await manager.writeSkillFile('picked', 'SKILL.md', '---\nname: picked\ndescription: 新描述\n---\n更新后正文', cwd);
    assert.match((await skillTool.execute({ name: 'picked' }, exec(a))).content, /更新后正文/);
    await plugin.dispose();
    plugin = ctx.plugin(definition);
    await new Promise((resolve) => setImmediate(resolve));
    await step(a);
    assert.ok((await catalog(a)).includes('picked'), '重新装配后从持久选择恢复');
    assert.ok(!(await catalog(a)).includes('user-only'));
    // 另一个进程直接写入的选择，必须在下一步进入模型前使缓存失效。
    await fs.writeFile(path.join(process.env.DSH_HOME, 'skill-manager', 'sessions', 'a.json'), JSON.stringify({ cwd, explicit: true, enabled: [] }));
    const externalStep = await step(a);
    assert.ok(!(await catalog(a)).includes('picked'));
    assert.ok(!externalStep.messages.some((m) => m.source?.entries?.some((s) => s.name === 'picked')));
    await plugin.dispose();
    assert.ok((await catalog(a)).includes('picked'), '卸载后恢复原生行为');
    console.log('PASS：真实模型目录与 skill 工具；双会话隔离；取消及跟随；预设同名；调用策略；资源目录；热更新；重载恢复；跨进程状态刷新；卸载清理。');
  } finally {
    for (const provider of providers) await provider.dispose();
    for (const scope of scopes.reverse()) await scope.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
