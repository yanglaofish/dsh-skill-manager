// 仅在隔离目录使用真实桌面依赖，不启动或改写用户的 profile。
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
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skm-panel-runtime-'));
  process.env.DSH_HOME = path.join(root, 'dsh');
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
  const { Context } = runtimeRequire('@deepseek-ai/cordis');
  const { HostConnectionService } = runtimeRequire('@deepseek-ai/dsh-client-connection');
  const manager = require('../lib/index.js');
  const ctx = new Context(), routes = [];
  ctx.provide('tools', { register() { return () => {}; } });
  ctx.provide('sessions', { list: () => [] });
  ctx.provide('webServer', {
    host: '192.168.51.116', protocol: 'http:',
    register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); },
  });
  let authenticated = true;
  // 仅凭据签名验证以固定值代替；Host、Origin、端口和准入逻辑均来自真实宿主。
  new HostConnectionService(ctx, ['dsh.example.com:3003', 'dsh.internal'], {
    isAuthenticated: () => authenticated, authenticateApi: () => undefined,
  });
  const plugin = ctx.plugin({ name: 'panel-runtime-test', apply: manager.apply });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(routes.length, 1);
    async function request(headers, expected) {
      let status;
      await routes[0].handler({ method: 'GET', url: '/skill-manager/api/unknown', headers }, {
        writeHead(code) { status = code; }, end() {},
      });
      assert.equal(status, expected, JSON.stringify(headers));
    }
    const remote = { host: 'dsh.example.com:3003', origin: 'https://dsh.example.com:3003' };
    await request(remote, 404);
    await request({ host: 'dsh.internal:1234', origin: 'https://dsh.internal:1234' }, 404);
    await request({ host: 'dsh.example.com:3004' }, 403);
    await request({ host: 'evil.example.com' }, 403);
    await request({ ...remote, 'sec-fetch-site': 'cross-site' }, 403);
    await request({ ...remote, origin: 'https://evil.example.com:3003' }, 403);
    await request({ ...remote, origin: 'https://dsh.example.com:3004' }, 403);
    await request({ host: 'localhost:3080', origin: 'http://localhost:3080' }, 404);
    await request({ host: '[::1]:3080', origin: 'http://[::1]:3080' }, 404);
    authenticated = false;
    await request(remote, 401);
    await request({ host: 'localhost:3080' }, 401);
    await request({ host: 'evil.example.com' }, 403);
    console.log('PASS：真实 connection；可信域名；无端口授权；精确端口；IPv6；跨域拦截；401/403 区分。');
  } finally {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
