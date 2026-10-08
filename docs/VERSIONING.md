# 版本约定（dsh-skill-manager）

> 一句话：**插件的大版本 = 它服务的 dsh 代际。** 看版本号就知道这个插件能装在哪个内核上。

---

## 1. 编号映射

| 插件版本线 | 服务的 dsh 世代 | 内核实际版本 | 状态 |
|---|---|---|---|
| `4.x.y` | 历史编号，未与代际对齐 | 主要是 `0.1.x` | **已弃用**（见 §4） |
| `1.x.y` | dsh **0.1** 世代 | `0.1.5-rc.2` 时代 | 收尾版 `1.3.5` = `4.3.5` 的重新编号（同内容） |
| `2.x.y` | dsh **0.2** 世代 | `0.2.0-rc.2` | **当前线**，从 `2.0.0` 起 |

同一个约定已经用在姊妹插件上：`@yanglaofish/dsh-proxy-pro` 的 `1.0.x` 服务 dsh 0.1，
`2.0.x` 服务 dsh 0.2。两个插件的编号从此可以横向对照。

### 为什么 2.0.0 比 4.3.5 "小"，依然是对的

npm 只要求"同一个版本号不能被发布两次"，**不要求新版本必须更大**，所以 2.0.0 可以正常发布，
并且 `npm publish` 会把 `dist-tags.latest` 指向它。代价是：

- `^4.3.5` 这种范围**不会**自动升到 2.x（semver 上 2.0.0 < 4.3.5）。改用 2.x 必须显式写范围
  （`^2.0.0`）或显式指定版本。我们自己的 web / desktop profile 会在发布流程里一起改（见
  `docs/RELEASE.md`）。
- 老编号线用 deprecate 提示，不动已发布的版本（`npm deprecate`，见 §4）。

---

## 2. 哪一位该 +1

| 变更 | 位数 | 例 |
|---|---|---|
| 支持的 dsh 代际变了，或插件对外契约破坏性变更（工具新增/删除参数、HTTP API 改语义、宿主服务门面改签名） | 大版本 | `1.3.5 → 2.0.0` |
| 新增能力、向后兼容 | 次版本 | `2.0.0 → 2.1.0` |
| 修 bug、改文案、仅内部重构 | 修订 | `2.1.0 → 2.1.1` |

新的 dsh 代际（例如将来 `0.3.x`）→ 直接开 `3.0.0`，**不要**在 2.x 上"顺手兼容"，
因为两代的内核 API 差异往往是静默失败（见 §3）。

---

## 3. peerDependencies 就是世代声明（务必理解，它决定插件会不会被整包跳过）

`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 会拿 `package.json` 里每一条
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围，跟**运行时版本**做
`semver.satisfies(..., { includePrerelease: true })`。**只要有一条不满足，整个 bundle 在启动时被跳过**
——没有构建错误、没有报错栈，只有一行 warning，插件就是不见了。

因此本仓库的规矩：

1. peer 范围**只声明真正验证过的世代**：2.x 写 `>=0.2.0-rc.2 <0.3.0`（与 dsh-proxy-pro 一致）。
2. 范围写错是"静默消失"级别的事故，所以有一道清单级护栏：
   `test/manifest-compat.test.mjs` 会断言每条 dsh peer 范围覆盖 `SUPPORTED_RUNTIMES`，
   并顺手记录那个真实陷阱（`^0.1.5-rc.2` 永远匹配不到 `0.2.0-rc.2`）。
3. **改 peer 范围 = 改版本号线**：范围一变，就说明支持的内核世代变了，大版本要跟着走。
4. `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 这类**不以 `dsh` 开头**的包不在检查范围内，
   但仍然是真实依赖，该声明就声明。

> 提醒：profile **从不安装** `@deepseek-ai/*`。它们由部署（app.asar / 全局 CLI）提供，
> profile 的模块解析会兜底到部署副本。peer 只是让 dsh 帮你做代际判定。

### 2.x 当前声明了哪些 peer

只声明本插件真正有契约关系的包，全部使用**同一个**验证过的范围串：

| 包 | 理由 |
|---|---|
| `@deepseek-ai/dsh-tools` | 工具注册表（`ctx.tools.register` 的 schema 契约） |
| `@deepseek-ai/dsh-session` | `ctx.sessions`（会话存储与 header.cwd） |
| `@deepseek-ai/dsh-skill` | `ctx.skills`（分层技能注册表：`list/snapshot/get`、`SkillViewOptions.scope`） |
| `@deepseek-ai/dsh-agent-preset-registry` | `ctx.agentPresets`（`list` / `acquireScope` / `serviceFor`） |
| `@deepseek-ai/dsh-host-webserver` | 面板 HTTP 路由（`webServer.register` 的 `(kind, path)` 唯一性契约） |
| `@deepseek-ai/cordis` | 不在 dsh 命名空间内，因此**不参与**世代判定；只声明真实依赖的 ctx API 世代 |

范围一律 `">=0.2.0-rc.2 <0.3.0"`。

**注意两件事**：

1. 声明这些 peer = 主动放弃 0.1 内核（0.1 profile 会按设计跳过整个 bundle）。这正是 2.x 想要的效果：
   与其"能加载但预设层静默为空"，不如让 dsh 在插件清单里明确标出不兼容。
2. `webServer` / `agentPresets` 是**可选使用**的服务（代码里用 `ctx.get()` 在调用时取，拿不到就降级），
   但它们仍然出现在 peer 里——peer 是**世代声明**，不是"必需服务"声明；"必需服务"由 `inject` 表达，
   而 `inject` 里只有 `tools` 与 `sessions`。

---

## 4. npm 侧的管理操作

### 弃用老编号线（不改已发布的版本、不破坏 lockfile）

走 `.github/workflows/npm-admin.yml`（`workflow_dispatch`），因为对 registry 的认证写操作在
公司网内会被 SWG 拦：

| 输入 | 值 |
|---|---|
| `operation` | `deprecate` |
| `target` | `@yanglaofish/dsh-skill-manager@^4.0.0` |
| `message` | 一句话说清"仅适配 dsh 0.1，请改用 1.x 或 2.x" |

`deprecate` 的效果：已固定该版本的 lockfile 仍能装，但任何人解析它都会看到警告。
**优先用 deprecate**；`unpublish` 只在"根本没人可能装过"的事故版本上考虑，而且 npm 只允许在
发布后 72 小时内、且无依赖者时删除，删除后该版本号不可复用。

### 用旧世代时显式取版本

```sh
# 明确要 0.1 世代（兼容老内核）
npm i @yanglaofish/dsh-skill-manager@1

# 当前世代
npm i @yanglaofish/dsh-skill-manager@2
```

---

## 5. 版本号出现在哪些地方（改版本时一起对齐）

| 位置 | 说明 |
|---|---|
| `package.json` → `version` | 唯一真源，CI 用它发布 |
| git tag `v<version>` | 必须与 `package.json` 完全一致，打错的 tag 会发布错版本 |
| `README.md` 的里程碑段落 | 面向用户的能力说明 |
| `lib/index.js` 的 `PKG_VERSION` | 无需手改：运行时从 `package.json` 读，设置面板角标即它 |

---

## 6. 相关文档

- [`docs/RELEASE.md`](RELEASE.md) —— 一次发布的完整步骤（开发 → test profile 实测 → tag → CI →
  淘宝强制同步 → 更新 web → 装到 desktop）。
- `test/manifest-compat.test.mjs` —— 世代护栏，改 peer / 客户端 inject / host inject 后必须先跑绿。
