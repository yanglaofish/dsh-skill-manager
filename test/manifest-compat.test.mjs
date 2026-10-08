/**
 * 运行时世代兼容性护栏（dsh 0.2 / 插件 2.x）。
 *
 * 为什么必须有这个文件：它拦的每一类问题在单测里都是**静默**的。
 *
 *  - `@deepseek-ai/dsh*` 的 peerDependencies 只要有一条不满足运行版本，
 *    `dsh-app-boot` 的 `evaluatePluginCompatibility` 会**整包跳过**该 bundle，
 *    只留一行 warning：没有构建错误、没有加载错误、单测全绿，插件就是不见了
 *    （dsh-proxy-pro 的 LESSONS §33 踩过：`^0.1.5-rc.2` 撞上 0.2.0-rc.2）。
 *  - 顶层 inject 写 `webServer`：dsh 0.2 里它是**晚挂载**，无 web 服务的
 *    composition（headless/TUI）会永远 pending —— 连同 14 个工具一起消失。
 *  - apply 期直接读一次 `ctx.webServer` 就注册路由：拿不到服务，**静默**不注册。
 *  - `ctx.on('dispose', …)`：dsh 0.2 **没有** `dispose` 事件（全库 0 命中），
 *    所以路由 disposer 永不执行；而 `webServer.register` 对同一 `(kind, path)`
 *    重复注册会**抛错** —— 插件第一次重载/重启用就会在 apply 里炸掉。
 *  - 客户端 inject 一个已被删除的服务，会让浏览器半边**永久 pending**。
 *  - 客户端读 `sessions.list` 快照的 `current` 字段：0.2 里该字段不存在
 *    （快照是 `{ids, byId, phase, projectionsBySession}`），当前会话恒为空。
 *  - `agentPresets.resolvedRoots`：0.2 全库 0 命中，预设目录也已不存在，
 *    旧写法不报错，只是预设层永远为空。
 *
 * semver 子集实现刻意写得很小（^、>=、<），只覆盖本清单与 dsh 评测器实际用到的
 * 形式，做法与 dsh-proxy-pro/test/manifest-compat.test.mjs 一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const hostSource = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** 去掉注释行后的源码。注释里会**解释**这些被禁的写法（"0.2 里没有 dispose 事件，
 *  所以旧的 ctx.on('dispose') 永不执行"），拿整份源码做否定断言会误报自己。 */
function codeLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}
const hostCode = codeLines(hostSource)
const clientCode = codeLines(clientSource)

/** 本插件声明支持的运行时世代。版本约定（用户定案）：插件大版本 = dsh 代际，
 *  1.x 服务 dsh 0.1.x，2.x 服务 dsh 0.2.x，peer 范围只声明真正验证过的世代。 */
const SUPPORTED_RUNTIMES = ['0.2.0-rc.2', '0.2.9']

// ---------------------------------------------------------------- semver 子集

function parse(version) {
  const [core, pre = ''] = String(version).trim().split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  return { major, minor, patch, pre: pre === '' ? [] : pre.split('.') }
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compare(left, right) {
  const a = parse(left)
  const b = parse(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const diff = compareIdentifier(x, y)
    if (diff !== 0) return diff
  }
  return 0
}

function satisfies(version, range) {
  for (const raw of String(range).trim().split(/\s+/)) {
    if (raw.startsWith('^')) {
      const base = parse(raw.slice(1))
      const current = parse(version)
      if (compare(version, raw.slice(1)) < 0) return false
      // caret 在 0.x 上只允许同一 minor（npm 规则）
      if (base.major === 0
        ? current.minor !== base.minor || current.major !== base.major
        : current.major !== base.major) return false
    } else if (raw.startsWith('>=')) {
      if (compare(version, raw.slice(2)) < 0) return false
    } else if (raw.startsWith('<')) {
      if (compare(version, raw.slice(1)) >= 0) return false
    } else if (raw !== '') {
      throw new Error(`测试助手里不支持的 range 片段：${raw}`)
    }
  }
  return true
}

// ---------------------------------------------------------------- 假 ctx

/** 造一个足够 apply() 跑起来的宿主 ctx，并记录它实际注册了什么。
 *  `effect` 刻意按 cordis 的 `effect(execute, label)` 契约实现：execute 的返回值
 *  就是 disposer（`fiber.ts` 里 `if (typeof effect === 'function') collect(effect)`）。 */
function makeCtx({ webServer, agentPresets, skills } = {}) {
  const state = {
    tools: [],
    routes: [],
    events: [],
    effects: [],
    injections: [],
    provided: {},
    log: [],
  }
  const services = { webServer, agentPresets, skills }
  const ctx = {
    tools: { register: (definition) => { state.tools.push(definition); return () => {} } },
    sessions: { list: () => [], get: () => undefined },
    provide: (name, value) => { state.provided[name] = value; return () => {} },
    on: (event, cb) => { state.events.push(event); return () => {} },
    effect: (execute, label) => {
      state.effects.push({ label, disposer: execute() })
      return () => {}
    },
    logger: { info: (...a) => state.log.push(a.join(' ')), warn: (...a) => state.log.push(a.join(' ')) },
    inject: (names, cb) => { state.injections.push({ names, cb }) },
    get: (name) => services[name],
  }
  return { ctx, state, services }
}

function fakeWebServer(state) {
  return {
    register: (route) => {
      // 真实 webServer 对重复的 (kind, path) 会抛错 —— 假实现也照做，
      // 这样"disposer 没被执行"会在测试里直接暴露。
      if (state.routes.some((r) => r.kind === route.kind && r.path === route.path)) {
        throw new Error(`duplicate route ${route.kind} ${route.path}`)
      }
      state.routes.push(route)
      return () => { const i = state.routes.indexOf(route); if (i >= 0) state.routes.splice(i, 1) }
    },
  }
}

/** 跑掉所有 ctx.effect 的 disposer，等价于 fiber 卸载。 */
async function runEffects(state) {
  for (const { disposer } of state.effects) {
    if (typeof disposer === 'function') await disposer()
  }
}

/** 用假 ctx 真正调用一次面板 HTTP 处理器（GET/POST 都要能走通）。 */
async function callHandler(state, method, url, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const out = { status: 0, body: '' }
  const res = {
    writeHead: (status) => { out.status = status },
    end: (body) => { out.body = String(body ?? '') },
  }
  await state.routes[0].handler(req, res)
  return out
}

/** 在隔离 DSH_HOME 的技能库里造一个目录形式技能。 */
function seedLibrarySkill(name) {
  const dir = path.join(HOME, 'skill-manager', 'library', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试技能\n---\n正文\n`)
}

const HOME = mkdtempSync(path.join(tmpdir(), 'skm-compat-'))
process.env.DSH_HOME = HOME
mkdirSync(path.join(HOME, 'skill-manager', 'library'), { recursive: true })

const { apply, setSessionSkills } = await import('../lib/index.js')

test.after(() => { rmSync(HOME, { recursive: true, force: true }) })

// ---------------------------------------------------------------- 清单

test('每一条 @deepseek-ai/dsh* peer 范围都覆盖声明支持的运行世代', () => {
  const peers = manifest.peerDependencies ?? {}
  const dshPeers = Object.entries(peers)
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshPeers.length > 0, '清单必须声明它依赖的 dsh peer 范围（否则世代守卫形同虚设）')
  for (const [name, range] of dshPeers) {
    for (const runtime of SUPPORTED_RUNTIMES) {
      assert.ok(
        satisfies(runtime, range),
        `${name} 的范围 "${range}" 不满足运行时 ${runtime} —— dsh-app-boot 会整包跳过（LESSONS §33）`,
      )
    }
  }
})

test('2.x 不再假装支持 0.1：旧 caret 范围确实排除 0.2', () => {
  // 记录这条真实故障：^0.1.5-rc.2 永远匹配不到 0.2.0-rc.2。
  assert.equal(satisfies('0.2.0-rc.2', '^0.1.5-rc.2'), false)
  assert.equal(satisfies('0.1.5-rc.2', '^0.1.5-rc.2'), true)
  assert.equal(satisfies('0.2.0-rc.2', '>=0.2.0-rc.2 <0.3.0'), true)
  assert.equal(satisfies('0.1.5-rc.2', '>=0.2.0-rc.2 <0.3.0'), false)
})

test('清单与 bundle 补丁的接线仍然完整', () => {
  assert.equal(manifest.name, '@yanglaofish/dsh-skill-manager')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(manifest.exports?.['./client'], 'exports 必须暴露 ./client，否则客户端半边不会被扫描')
  assert.ok(manifest.exports?.['./cordis.patch.yml'], 'exports 必须暴露 cordis.patch.yml')
})

test('dsh.client.inject 不列不存在的包（0.2 已无 dsh-client-runtime）', () => {
  const list = manifest.dsh?.client?.inject ?? []
  assert.ok(!list.includes('@deepseek-ai/dsh-client-runtime'),
    'dsh-client-runtime 在 0.2 已不存在；列一个不存在的图行只会静默跳过，属误导')
})

// ---------------------------------------------------------------- host 侧静态护栏

test('host 侧 inject 只留真正的硬依赖（0.2 里 webServer 晚挂载、agentPresets 可选）', () => {
  const inject = /const inject = \[([^\]]*)\]/.exec(hostSource)
  assert.ok(inject !== null, 'lib/index.js 必须声明 inject 列表')
  assert.ok(!/'webServer'/.test(inject[1]),
    'webServer 不能进顶层 inject：晚挂载 + 无 web 的 composition 会永久 pending（LESSONS §35）')
  assert.ok(!/'agentPresets'/.test(inject[1]),
    'agentPresets 只在 preset-registry bundle 存在时才有；代码已按可选处理，硬依赖自相矛盾')
  assert.ok(/'tools'/.test(inject[1]) && /'sessions'/.test(inject[1]), 'tools / sessions 仍是硬依赖')
})

test('面板 API 走 ctx.inject 懒注册，且失败时会留日志', () => {
  assert.ok(/ctx\.inject\(\['webServer'\]/.test(hostSource), "必须用 ctx.inject(['webServer'], cb) 在服务出现时再注册")
  assert.ok(/panel API registered on/.test(hostSource), '注册成功要打一行 info —— 静默跳过是最贵的失败模式')
  assert.ok(!/ctx\.webServer\.register/.test(hostSource), '不得在 apply 期直接读 ctx.webServer.register')
})

test('析构走 ctx.effect，不用 0.2 里不存在的 dispose 事件', () => {
  // 0.2 全库 0 处 on('dispose')/emit("dispose")：cordis 的卸载通知是 internal/plugin。
  // 旧写法让路由 disposer 永不执行，而 webServer.register 对重复 (kind,path) 抛错
  // → 插件第一次重载就会在 apply 里炸掉。
  assert.ok(!/ctx\.on\(\s*['"]dispose['"]/.test(hostCode), "不得监听 0.2 里不存在的 'dispose' 事件")
  assert.ok(/ctx\.effect\(\(\) => unregisterRoute/.test(hostCode), '路由 disposer 必须注册为 ctx.effect')
})

test('不再引用 0.2 里已消失的 agentPresets.resolvedRoots', () => {
  assert.ok(!/\.resolvedRoots/.test(hostSource), 'resolvedRoots 在 0.2 全库 0 命中，访问它只会静默退化成空预设层')
  assert.ok(/acquireScope/.test(hostSource), '预设层必须改成 acquireScope(id) + skills.list({ scope })')
  assert.ok(/Symbol\.asyncDispose/.test(hostSource), 'acquireScope 是引用租约，必须在 finally 里释放')
  assert.ok(!/settingsNamespace|installSettingsSection/.test(hostSource), '不得 import 会被移除的 dsh-settings 导出')
})

test('引擎可见性查询不再是无 scope 的 list（0.2 里看不到任何项目技能）', () => {
  assert.ok(/resolveSessionSkillsView/.test(hostSource), '必须经 Agent 的 preset 作用域解析 skills 服务')
  assert.ok(!/collectEngineLoaded\(ctx\.get\('skills'\)/.test(hostSource),
    'scope-less ctx.skills.list({cwd}) 在 0.2 web 组合里只看得到 runtime/bundled')
})

// ---------------------------------------------------------------- client 侧静态护栏

test('浏览器半边不 inject 已被删除的服务，注册 id 就是完整包名', () => {
  // 两种写法都接受：字面量 `exports.inject = [...]`，或先声明 `const inject = [...]` 再导出。
  const inject = /const inject = \[([^\]]*)\]/.exec(clientSource)
    ?? /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(clientSource)
  assert.ok(inject !== null, 'client.js 必须声明它的 cordis inject 列表')
  assert.ok(/slots/.test(inject[1]), '客户端仍然需要 slots 服务')
  assert.ok(!/settingsScope/.test(inject[1]), 'dsh 0.2 删除了 settingsScope；inject 它会让半边永久 pending')
  assert.ok(!/ctx\.settingsScope/.test(clientSource), 'client.js 不得再 bind 设置 scope')
  assert.ok(
    new RegExp(`id:\\s*"${manifest.name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}"`).test(clientSource),
    '__ModuleLoader__.load 的 id 必须是完整包名（它是 client-modules 的匹配键）',
  )
})

test('客户端“当前会话”读法符合 0.2 会话快照的形状', () => {
  // 0.2 的 sessions.list 快照是 { ids, byId, phase, projectionsBySession }，没有 current；
  // 官方推导是 byId + retainedBy.mainView（dsh-client-ui-workspace）。
  assert.ok(!/getSnapshot\(\)\s*\.current/.test(clientCode),
    '快照没有 current 字段，读它会让当前会话恒为空')
  assert.ok(/retainedBy/.test(clientCode), '当前会话必须按官方口径从 byId + retainedBy.mainView 推导')
})

// ---------------------------------------------------------------- host 侧行为护栏

test('webServer 晚到也能注册；插件重载时 disposer 会真正执行', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx)

  assert.equal(state.routes.length, 0, 'apply 时没有 webServer，就不该有路由')
  assert.equal(state.injections.length, 1, "必须挂一次 ctx.inject(['webServer'])")
  assert.ok(!state.events.includes('dispose'), "不得依赖 0.2 不存在的 'dispose' 事件")

  const late = fakeWebServer(state)
  state.injections[0].cb({ webServer: late })
  assert.equal(state.routes.length, 1, 'webServer 出现后必须补注册成功')
  assert.equal(state.routes[0].kind, 'prefix')
  assert.equal(state.routes[0].path, '/skill-manager/api')
  assert.ok(state.log.some((line) => line.includes('panel API registered')), '注册成功必须留一行日志')

  // 幂等：inject 回调重放 + apply 期 ctx.get 两条路径不得重复注册
  state.injections[0].cb({ webServer: late })
  assert.equal(state.routes.length, 1, '重复注入不得重复注册（真实 webServer 会抛 duplicate route）')

  await runEffects(state)
  assert.equal(state.routes.length, 0, 'fiber 卸载必须解绑路由 —— 否则下次 apply 会撞 duplicate route 而炸')
  assert.equal(state.provided.skillManager?.list instanceof Function, true, '宿主服务门面必须已 provide')
})

test('webServer 已挂载的运行时同样只在 apply 期注册一次', () => {
  const { ctx, state } = makeCtx()
  const ws = fakeWebServer(state)
  ctx.get = (name) => (name === 'webServer' ? ws : undefined)
  apply(ctx)
  assert.equal(state.routes.length, 1)
})

test('预设层只保留“该 preset 真正新增”的技能，并释放每一个 scope 租约', async () => {
  const presetSkill = path.join(HOME, 'cordis-plugin-development', 'SKILL.md')
  mkdirSync(path.dirname(presetSkill), { recursive: true })
  writeFileSync(presetSkill, '---\nname: cordis-plugin-development\ndescription: 写插件\n---\n正文\n')

  const released = []
  const agentPresets = {
    list: async () => [
      { id: 'standard', name: '标准模式', order: 1 },
      { id: 'cordis', name: '创造模式', order: 4 },
      { id: 'broken-preset', broken: '挂载失败' },
    ],
    acquireScope: async (id) => {
      if (id === 'broken-preset') throw new Error('损坏的 preset 不该被 acquireScope')
      return {
        key: `scope:${id}`,
        [Symbol.asyncDispose]: async () => { released.push(id) },
      }
    },
  }
  const skills = {
    list: async (options = {}) => {
      // 宿主层：只有引擎内建（runtime/bundled）注册 —— 0.2 里 host 的
      // skill-filesystem 行是 disabled 的，所以这里看不到任何项目技能。
      if (options.scope === undefined) return [{ name: 'genui' }, { name: 'office-docx' }]
      // 每个 preset 的 scope 都能看到同一份环境目录（项目/用户盘 + 内建）
      const ambient = [{ name: 'genui' }, { name: 'my-project-skill' }, { name: 'shared-skill' }]
      if (options.scope === 'scope:standard') return ambient
      if (options.scope === 'scope:cordis') {
        return [...ambient, { name: 'cordis-plugin-development', source: 'custom', provider: 'filesystem', path: presetSkill }]
      }
      return []
    },
  }

  const { ctx, state } = makeCtx({ agentPresets, skills })
  apply(ctx)

  const listed = await state.provided.skillManager.list()
  const presetNames = listed.skills.filter((s) => s.origin === 'preset').map((s) => s.name)

  assert.deepEqual(presetNames, ['cordis-plugin-development'],
    '宿主层与“每个 preset 都看得到”的技能必须被扣减，只留 preset 独有贡献')
  const entry = listed.skills.find((s) => s.name === 'cordis-plugin-development')
  assert.equal(entry.preset.id, 'cordis')
  assert.equal(entry.preset.label, '创造模式', '预设标签应取服务返回的 name')
  assert.ok(entry.bodyLength > 0, '预设技能正文应从指令文件读回，供详情面板预览')

  assert.deepEqual(released.sort(), ['cordis', 'standard'], '每个 acquireScope 租约都必须在 finally 里释放')

  await runEffects(state)
})

test('只有一个 preset 时不清空它自己的贡献（环境判定需要 ≥2 个预设）', async () => {
  const agentPresets = {
    list: async () => [{ id: 'cordis', name: '创造模式', order: 4 }],
    acquireScope: async () => ({ key: 'scope:cordis', [Symbol.asyncDispose]: async () => {} }),
  }
  const skills = {
    // 单 preset 时无 scope 的宿主层读法与 preset 层读法只能靠 hostNames 区分；
    // 项目技能无从判定归属，宁可不删（文档已记录这条局限）。
    list: async (options = {}) => (options.scope === undefined
      ? [{ name: 'genui' }]
      : [{ name: 'genui' }, { name: 'my-project-skill' }]),
  }
  const { ctx, state } = makeCtx({ agentPresets, skills })
  apply(ctx)
  const listed = await state.provided.skillManager.list()
  const names = listed.skills.filter((s) => s.origin === 'preset').map((s) => s.name)
  assert.deepEqual(names, ['my-project-skill'], '单 preset 时不得用“全共有”规则把贡献全删掉')
  await runEffects(state)
})

test('agentPresets 或 skills 服务缺席时，预设层安静回退而不是抛错', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx)
  const listed = await state.provided.skillManager.list()
  assert.equal(listed.stats.preset, 0, '没有 services 时必须返回空预设层，不得抛错')
  await runEffects(state)
})

test('会话视角解析：有活体 Agent 时用它的 preset scope 服务，否则退回全局注册表', async () => {
  const workspace = path.join(HOME, 'ws-scope-test')
  mkdirSync(workspace, { recursive: true })

  const calls = []
  const globalRegistry = {
    // 0.2 web 组合里 host 层只有 runtime/bundled —— 看不到任何项目技能
    list: async () => { calls.push('global'); return [{ name: 'genui', source: 'bundled', provider: 'runtime' }] },
  }
  const scopedRegistry = {
    list: async () => { calls.push('scoped'); return [{ name: 'project-skill', source: 'project-dsh', provider: 'filesystem' }] },
  }

  const { ctx, state } = makeCtx()
  const ws = fakeWebServer(state)
  ctx.get = (name) => {
    if (name === 'skills') return globalRegistry
    if (name === 'agents') return { get: (id) => (id === 'live-session' ? { id } : undefined) }
    if (name === 'agentPresets') return { serviceFor: (_agent, service) => (service === 'skills' ? scopedRegistry : undefined) }
    if (name === 'webServer') return ws
    return undefined
  }
  apply(ctx)
  assert.equal(state.routes.length, 1)

  const callView = async (sessionId) => {
    const out = { status: 0, body: '' }
    const req = {
      method: 'GET',
      url: `/skill-manager/api/view?sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(workspace)}`,
      headers: { host: '127.0.0.1:3080' },
    }
    const res = { writeHead: (status) => { out.status = status }, end: (body) => { out.body = String(body) } }
    await state.routes[0].handler(req, res)
    return out
  }

  calls.length = 0
  const live = await callView('live-session')
  assert.equal(live.status, 200)
  assert.ok(calls.includes('scoped'), '有活体 Agent 时必须用它的 preset scope 服务读引擎目录')
  assert.ok(!calls.includes('global'), '有活体 Agent 时不得退回无 scope 的全局注册表')

  calls.length = 0
  const cold = await callView('cold-session')
  assert.equal(cold.status, 200)
  assert.ok(calls.includes('global'), '没有活体 Agent 时退回全局注册表')

  await runEffects(state)
})

// ---------------------------------------------------------------- 会话层回归（实测报告）

test('会话从未保存过插件状态时，/view 也必须回传生效的工作区', async () => {
  // 回归：`session.cwd` 原先回传的是"已保存的 cwd"，而没写过插件状态的会话
  // 恒为空串。面板拿它给自身的 cwd 播种，于是每一次勾选/「回到跟随」都提交
  // cwd:""，服务端只能回 400「cwd 必须为工作区绝对路径」—— 用户看到的就是
  // "点了完全没反应"。
  const workspace = path.join(HOME, 'ws-cold-session')
  mkdirSync(workspace, { recursive: true })
  const session = { id: 'session-cold-0001', header: { cwd: workspace, createdAt: 1 } }

  const { ctx, state } = makeCtx()
  const ws = fakeWebServer(state)
  ctx.get = (name) => (name === 'webServer' ? ws : undefined)
  ctx.sessions = { list: () => [session], get: (id) => (id === session.id ? session : undefined) }
  apply(ctx)

  const out = await callHandler(state, 'GET', `/skill-manager/api/view?sessionId=${session.id}`)
  assert.equal(out.status, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.session.cwd, workspace, '必须回传生效的工作区，而不是空的已保存 cwd')

  await runEffects(state)
})

test('客户端不带 cwd 时，会话技能写入也必须成功（勾选与回到跟随）', async () => {
  const workspace = path.join(HOME, 'ws-cold-write')
  mkdirSync(workspace, { recursive: true })
  seedLibrarySkill('compat-lib-skill')
  const session = { id: 'session-cold-0002', header: { cwd: workspace, createdAt: 2 } }

  const { ctx, state } = makeCtx()
  const ws = fakeWebServer(state)
  ctx.get = (name) => (name === 'webServer' ? ws : undefined)
  ctx.sessions = { list: () => [session], get: (id) => (id === session.id ? session : undefined) }
  apply(ctx)

  const out = await callHandler(state, 'POST', '/skill-manager/api/session/set', {
    sessionId: session.id,
    enabled: ['compat-lib-skill'],
    explicit: true,
  })
  assert.equal(out.status, 200, `会话写入不应要求客户端提供 cwd（实际返回 ${out.body}）`)
  const savedPath = path.join(HOME, 'skill-manager', 'sessions', `${session.id}.json`)
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
  assert.equal(saved.cwd, workspace, '服务端应自行解析出会话的工作区')
  assert.deepEqual(saved.enabled, ['compat-lib-skill'])
  assert.equal(saved.explicit, true)

  const back = await callHandler(state, 'POST', '/skill-manager/api/session/set', {
    sessionId: session.id,
    enabled: [],
    explicit: false,
  })
  assert.equal(back.status, 200, '「回到跟随工作区」同样不能依赖客户端提供 cwd')
  const after = JSON.parse(readFileSync(savedPath, 'utf8'))
  assert.equal(after.explicit, false, '「回到跟随工作区」必须真的落盘')

  await runEffects(state)
})

test('会话勾选里含技能库之外的名字时明确报告，不再静默丢弃', async () => {
  seedLibrarySkill('compat-lib-skill-2')
  const workspace = path.join(HOME, 'ws-dropped')
  mkdirSync(workspace, { recursive: true })

  const r = await setSessionSkills('session-cold-0003', workspace, ['compat-lib-skill-2', 'not-in-library'], true)
  assert.equal(r.ok, true)
  assert.deepEqual(r.cfg.enabled, ['compat-lib-skill-2'])
  assert.deepEqual(r.dropped, ['not-in-library'], '库外名字必须回传给 UI，用户才知道为什么勾不上')

  const clean = await setSessionSkills('session-cold-0004', workspace, ['compat-lib-skill-2'], true)
  assert.equal(clean.dropped, undefined, '全部合法时不应多出字段')
})

test('会话不在内存时（刚打开、还没跑过 turn），/view 必须从持久化 header 解析工作区', async () => {
  // 这是用户实际踩到的场景：在面板里打开一个会话（ctx.sessions 是内存存储，
  // 打开会话并不会把它放进去），于是 workspace 层解析成空 —— 界面表现为"我明明
  // 在工作区启用了技能，会话页却全是未勾选"，并且任何勾选都写不进去。
  const workspace = path.join(HOME, 'ws-persisted')
  const linkDir = path.join(workspace, '.dsh', 'skills', 'compat-persist-skill')
  mkdirSync(linkDir, { recursive: true })
  writeFileSync(path.join(linkDir, 'SKILL.md'), '---\nname: compat-persist-skill\ndescription: 已启用\n---\n正文\n')

  const sessionId = 'session-persisted-0001'
  const asked = []
  const { ctx, state } = makeCtx()
  const ws = fakeWebServer(state)
  ctx.get = (name) => {
    if (name === 'webServer') return ws
    if (name === 'sessionPersistence') {
      return {
        stat: async (id) => {
          asked.push(id)
          return id === sessionId ? { header: { cwd: workspace, createdAt: 1 } } : undefined
        },
      }
    }
    return undefined
  }
  // 内存里没有这个会话（刚打开、未跑 turn）
  ctx.sessions = { list: () => [], get: () => undefined }
  apply(ctx)

  const out = await callHandler(state, 'GET', `/skill-manager/api/view?sessionId=${sessionId}`)
  assert.equal(out.status, 200)
  const body = JSON.parse(out.body)
  assert.equal(body.session.cwd, workspace, '必须从持久化 header 取到工作区')
  assert.deepEqual(
    body.skills.filter((s) => s.sessionEnabled).map((s) => s.name),
    ['compat-persist-skill'],
    '工作区启用集必须真的回显为已启用',
  )
  assert.ok(asked.includes(sessionId), '解析工作区时必须询问持久化存储')

  await runEffects(state)
})
