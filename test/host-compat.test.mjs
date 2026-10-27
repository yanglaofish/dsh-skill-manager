import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'skm-host-compat-'));
  process.env.DSH_HOME = join(root, 'home');
  process.env.DSH_AGENTS_HOME = join(root, 'agents');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function host(connection) {
  const routes = [], effects = [], services = { connection };
  const ctx = {
    tools: { register() {} }, sessions: { list: () => [] },
    on() {}, provide() {}, logger: { info() {}, warn() {} },
    get: (name) => services[name],
    effect(setup) { effects.push(setup()); },
    inject(_names, callback) { callback({ webServer: services.webServer }); },
  };
  services.webServer = { register(route) { routes.push(route); return () => {}; } };
  apply(ctx);
  return { services, effects, async request(headers, method = 'GET') {
    const out = {};
    await routes[0].handler({ headers, method, url: '/skill-manager/api/unknown' }, {
      writeHead(status) { out.status = status; }, end(body) { out.body = body; },
    });
    return out;
  } };
}

test('面板委托宿主校验可信域名、凭据与跨域请求，并读取后挂载的 connection', async (t) => {
  await fixture(t);
  const h = host();
  assert.equal((await h.request({ host: 'dsh.example.com:3003' })).status, 403);
  let calls = 0;
  h.services.connection = { requestRejection(req) {
    calls++;
    assert.equal(req.headers.host, 'dsh.example.com:3003');
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
    if (req.headers.origin && req.headers.origin !== 'https://dsh.example.com:3003') return 403;
    if (req.headers.cookie !== 'authenticated') return 401;
  } };
  const headers = { host: 'dsh.example.com:3003', origin: 'https://dsh.example.com:3003', cookie: 'authenticated' };
  // 未知端点返回 404，证明请求通过了访问围栏；此处不写用户数据。
  assert.equal((await h.request(headers)).status, 404);
  assert.equal((await h.request({ ...headers, cookie: '' }, 'POST')).status, 401);
  assert.equal((await h.request({ ...headers, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await h.request({ ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal(calls, 4);
  for (const cleanup of h.effects.reverse()) await cleanup?.();
});

test('没有 connection 时仍仅允许 loopback 同源请求', async (t) => {
  await fixture(t);
  const h = host();
  assert.equal((await h.request({ host: '127.0.0.1:3080' })).status, 404);
  assert.equal((await h.request({ host: '192.168.1.2:3080' })).status, 403);
  assert.equal((await h.request({ host: 'localhost:3080', origin: 'http://localhost:3081' })).status, 403);
  h.services.connection = {};
  assert.equal((await h.request({ host: 'localhost:3080' })).status, 403, '已有服务缺少准入接口时不能降级放行');
  h.services.connection = { requestRejection() { throw Error('宿主校验失败'); } };
  assert.equal((await h.request({ host: 'localhost:3080' })).status, 403);
  for (const cleanup of h.effects.reverse()) await cleanup?.();
});

async function sessionFixture(t, { runtime = false, warnThrows = false } = {}) {
  const root = await fixture(t);
  // 在独立目录加载真实插件模块；不受开发机已安装的 peer 包影响。
  await copyFile(new URL('../lib/session-skills.js', import.meta.url), join(root, 'session.mjs'));
  if (runtime) {
    const packages = {
      'dsh-scope': `export const scopeParentOf = () => undefined;
        export function createScope(ctx) { return { ctx, dispose: async () => {
          ctx.state.disposed++; if (ctx.state.disposeError) throw Error('清理失败');
        } }; }`,
      'dsh-skill-filesystem': `export class FileSystemSkillProvider {
        constructor(ctx) { if (ctx.state.constructorError) throw Error('构造失败'); }
        async dispose() {}
      }`,
    };
    for (const [name, source] of Object.entries(packages)) {
      const dir = join(root, 'node_modules', '@deepseek-ai', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      await writeFile(join(dir, 'index.js'), source);
    }
  }
  const events = new Map(), effects = [], warnings = [];
  const ctx = {
    on(event, fn) { events.set(event, fn); },
    effect(setup) { effects.push(setup()); }, get() {},
    logger: { warn(message) { warnings.push(message); if (warnThrows) throw Error('日志失败'); } },
  };
  const { installSessionSkills, notifySkillSelectionChanged } = await import(pathToFileURL(join(root, 'session.mjs')));
  installSessionSkills(ctx, { skillsRoot: () => root, readSessionConfig: async () => ({ explicit: false }) });
  function agent(state = {}) {
    state.disposed = 0;
    return { session: { header: { cwd: root } }, ctx: { state, get() {
      return { registerProvider(factory) {
        if (state.attachError) throw Error('挂载失败');
        const lifecycle = new AbortController();
        try {
          factory({ invalidate() {
            state.invalidations = (state.invalidations ?? 0) + 1;
            if (state.invalidateError) throw Error('刷新失败');
          }, signal: lifecycle.signal });
        } catch (error) { lifecycle.abort(error); throw error; }
      } };
    } } };
  }
  return { events, effects, warnings, agent, notify: notifySkillSelectionChanged };
}

test('缺少宿主 peer 时会话创建和每步推理继续，启动提示只记录一次', async (t) => {
  const h = await sessionFixture(t);
  const agent = h.agent();
  await assert.doesNotReject(() => h.events.get('agent/created')({ agent }));
  let steps = 0;
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.events.get('agent/pre-step')({ agent }, () => ++steps), i + 1);
  }
  await h.events.get('agent/created')({ agent: h.agent() });
  await h.events.get('agent/disposed')({ agent });
  for (const cleanup of h.effects) await cleanup();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /会话.*不可用|会话.*失败/);
});

test('日志服务抛错也不打断缺 peer 的会话', async (t) => {
  const h = await sessionFixture(t, { warnThrows: true });
  const agent = h.agent();
  await assert.doesNotReject(() => h.events.get('agent/created')({ agent }));
  assert.equal(await h.events.get('agent/pre-step')({ agent }, () => '继续'), '继续');
  for (const cleanup of h.effects) await cleanup();
});

test('挂载和刷新异常按 agent 去重告警，后续正常的 agent 仍能运行', async (t) => {
  const h = await sessionFixture(t, { runtime: true });
  const failed = h.agent({ attachError: true });
  await assert.doesNotReject(() => h.events.get('agent/created')({ agent: failed }));
  assert.equal(await h.events.get('agent/pre-step')({ agent: failed }, () => '继续'), '继续');
  assert.equal(h.warnings.length, 1);
  const refresh = h.agent({ invalidateError: true });
  await h.events.get('agent/created')({ agent: refresh });
  assert.equal(await h.events.get('agent/pre-step')({ agent: refresh }, () => '继续'), '继续');
  assert.equal(await h.events.get('agent/pre-step')({ agent: refresh }, () => '继续'), '继续');
  assert.equal(h.warnings.length, 2);
  const healthy = h.agent();
  await h.events.get('agent/created')({ agent: healthy });
  await assert.rejects(() => h.events.get('agent/pre-step')({ agent: healthy }, async () => { throw Error('模型异常'); }), /模型异常/);
  for (const cleanup of h.effects) await cleanup();
  assert.equal(healthy.ctx.state.disposed, 1);
});

test('单个会话清理失败不打断销毁与其他会话卸载', async (t) => {
  const h = await sessionFixture(t, { runtime: true });
  const failed = h.agent({ disposeError: true }), healthy = h.agent();
  for (const agent of [failed, healthy]) await h.events.get('agent/created')({ agent });
  await assert.doesNotReject(() => h.events.get('agent/disposed')({ agent: failed }));
  for (const cleanup of h.effects) await assert.doesNotReject(cleanup);
  assert.equal(healthy.ctx.state.disposed, 1);
});

test('provider 构造失败并重试时，不残留全局刷新监听器', async (t) => {
  const h = await sessionFixture(t, { runtime: true });
  const agent = h.agent({ constructorError: true });
  await h.events.get('agent/created')({ agent });
  await h.events.get('agent/pre-step')({ agent }, () => {});
  h.notify();
  assert.equal(agent.ctx.state.invalidations ?? 0, 0);
  assert.equal(h.warnings.length, 1);
  for (const cleanup of h.effects) await cleanup();
  h.notify();
  assert.equal(agent.ctx.state.invalidations ?? 0, 0, '卸载后也不能残留失效回调');
});
