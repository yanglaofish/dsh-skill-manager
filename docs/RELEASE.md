# 发布手册（dsh-skill-manager）

> 版本号怎么定看 [`docs/VERSIONING.md`](VERSIONING.md)。本文只讲**怎么走一次发布**。

---

## 0. 这条流水线长什么样

```
工作区源码  ──(junction 安装)──►  test profile     ← 你在这里实测功能/回归
     │
     │ 实测通过
     ▼
 git commit ──push──► GitHub ──tag vX.Y.Z──► Actions: 单测 → npm publish → 淘宝强制同步
                                                                              │
                                                          npmmirror latest 到位
                                                                              ▼
                                                     web profile（非 junction，registry 安装）
                                                                              │
                                                                              ▼
                                                            desktop profile（Electron 独占管理）
```

三种 profile 的安装形态（这是"非 junction 才要更新"的由来）：

| profile | 路径 | skill-manager 的形态 | 更新方式 |
|---|---|---|---|
| `test` | `~/.dsh/profiles/test` | `link:D:/个人材料/Agent/dsh-workspace/dsh-skill-manager`（**junction 指向工作区**，改源码即时生效） | 不用更新，跟着工作区走 |
| `web` | `~/.dsh/profiles/web` | registry 安装（`^2.0.0`） | 发布后 `dsh plugin --profile web add` |
| `desktop` | `~/.dsh/profiles/desktop` | registry 安装（`^2.0.0`） | **只能由 Electron 侧管理**，见 §5 |

---

## 1. 开发与本地护栏

```powershell
cd D:\个人材料\Agent\dsh-workspace\dsh-skill-manager
npm test          # unit.mjs（核心逻辑）+ manifest-compat.test.mjs（世代护栏）都必须绿
```

`npm test` 里的 `test/manifest-compat.test.mjs` 专门拦"静默失败"：

- peer 范围不覆盖运行世代 → dsh 会**整包跳过**插件，单测照样全绿；
- 客户端半边 inject 了 0.2 已删除的服务 → 浏览器半边永久 pending；
- host 半边把 `webServer` 写进顶层 inject，或 apply 期直接读 `ctx.webServer` → 路由静默不注册；
- 又去访问 `agentPresets.resolvedRoots` → 预设层静默变空。

Windows 编码红线（踩过两次）：**源码/文档只用编辑器或本工具的 write/edit 改**，
不要用 PowerShell `Get-Content -Raw | Set-Content` 做文本往返——中文会被读成系统代码页再以
UTF-8 写回，整文件变乱码。

---

## 2. test profile 实测（人来做）

`test` profile 已经是 junction 指向工作区，**不需要重新安装**，只要重启这个 profile 的实例：

```powershell
# 现有实例：node .../@deepseek-ai/dsh/lib/bin.js --profile test --port 1200
# 重启后打开 http://127.0.0.1:1200
```

验收清单（同时也能回归"0.2 迁移"是否真的修好）：

| # | 检查项 | 期望 |
|---|---|---|
| 1 | 设置 → 技能管理 | 页面在，插件版本角标 = `package.json` 的版本 |
| 2 | 技能库 / 工作区 / 搜索 三个标签 | 都能列出、能打开详情、能编辑保存 |
| 3 | 会话页「技能」tab | 会话勾选能改、能"回到跟随" |
| 4 | **预设层**（本次迁移的改动点） | 创造模式（cordis）下的捆绑技能（`cordis-plugin-development` 等）以只读形式出现，且不会被"每个预设都重复一遍用户技能"淹没 |
| 5 | 面板 API | `GET http://127.0.0.1:1200/skill-manager/api/view` 返回 200 且 `ok:true` |
| 6 | 日志 | 启动日志里有 `skill-manager: panel API registered on /skill-manager/api` 一行 |
| 7 | 插件清单 | 插件在列表里**正常（非"等待服务"、非被跳过）**；无 `Unreadable bundles… skipped` 之类 warning |
| 8 | 插件**禁用 → 启用**一次（或热重载） | 不出现 `duplicate route /skill-manager/api` —— 这是 `ctx.on('dispose')` 时代的直接崩点：disposer 没执行，`webServer.register` 对同一 `(kind, path)` 抛错，插件在该次加载里整个失效 |

第 7、8 条最容易被忽略但最重要：0.2 里 peer 不满足导致的跳过**不会报错**（只少一行 warning），
而析构没走 `ctx.effect` 时只在**第一次重载**才炸——单次启动完全看不出问题。

---

## 3. 提交与打 tag

先 commit 再 push，避免"发布树与 HEAD 不一致"（历史上真发生过：某个修复混进了 commit 却从没发布）。

> **实测过的漂移（2026-10-08）**：npm 上的 `4.3.5` 是**本地发布**的，它的 tarball 与仓库 HEAD 相比，
> `lib/` 代码完全一致，但 `README.md` 明显不同（tarball 里 140 行，仓库 200 行）——文档漂移。
> 改走 CI 之后这类问题不会再发生：workflow 从 **tag 指向的 commit** 检出并打包，
> 发布内容恒等于该 commit 的树。这也是"先 commit 再打 tag"必须严格照做的原因。

```powershell
cd D:\个人材料\Agent\dsh-workspace\dsh-skill-manager
git status                      # 确认没有意外文件；package-lock.json 在 .gitignore 里，属正常
npm version <X.Y.Z> --no-git-tag-version
git commit -am "release: X.Y.Z"
git tag vX.Y.Z
git push origin master --tags
```

### git 推送的代理坑（实测）

git 全局 config 里可能写死了过期的 `http.proxy`，离开公司网或代理变更时会
`407 CONNECT tunnel failed`。正确姿势是让 git 走**当前系统代理**：

```powershell
# 先暖一下当前系统代理（.NET 会自动带 NTLM 协商）
Invoke-WebRequest https://github.com -UseBasicParsing -TimeoutSec 20 | Out-Null
# 用 -c 临时覆盖写死的 config（不要改全局，避免下次又踩）
git -c http.proxy=$env:HTTP_PROXY push origin master --tags
```

---

## 4. CI 自动做的事（`.github/workflows/publish.yml`）

tag 推上去后，GitHub runner（不在公司网内，绕开 SWG 上传拦截）会：

1. `npm install --legacy-peer-deps`（只装 `adm-zip` + `yaml`；peer 是世代声明，不需要安装）；
2. `node --check` + 单测；
3. **幂等**发布：该版本已在 npmjs 上就跳过，所以"先本地发、后补 tag"或重跑同一个 tag 都不会打红；
4. **淘宝源强制同步**（用户铁律"不许干等"）：每轮先
   `PUT https://registry.npmmirror.com/-/sync?name=%40yanglaofish%2Fdsh-skill-manager`
   再轮询 `dist-tags.latest`，最多 60 轮、每轮间隔 8 秒，直到等于本次版本才成功退出。

> ⚠️ 两个已踩过的坑，改这个 workflow 时别改回去：
> - 端点是**查询参数**式 `/-/sync?name=…`（201）；路径式 `/-/sync/@scope%2Fname` 返回 **404**。
>   旧写法被 `|| true` 吞掉，看起来"同步过了"，实际一直靠懒同步兜底。
> - `PUT` 返回 201 只是**入队确认**，不等于同步完成。实测要 11~33 轮（2~4 分钟），所以必须
>   每轮**重发**再轮询，只发一次会 stuck。
>
> 若 npmjs 侧走的是 staged publishing（返回 202），需要真人在 npmjs 网页做 2FA 批准或用
> `npm stage approve`，批准后**重跑这个 job**（幂等，不会重复发布）。

### 本地兜底：手动触发淘宝同步

```powershell
curl.exe -sS -X PUT "https://registry.npmmirror.com/-/sync?name=%40yanglaofish%2Fdsh-skill-manager" -H "content-type: application/json" -d "{\"version\":\"2.0.0\"}"
curl.exe -sS "https://registry.npmmirror.com/%40yanglaofish%2Fdsh-skill-manager" | Select-String "latest"
```

---

## 5. 更新 web（非 junction），最后装到 desktop

### 5.1 web profile

规范做法是走 dsh CLI（它会同时维护 `dependencies` 与 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile web add '@yanglaofish/dsh-skill-manager@^2.0.0'
```

profile 的 pnpm 默认 registry 是**华为内网镜像**，对新版本有滞后（会报 "The latest release of … is <旧版本>"
甚至 `--force` 也绕不过，因为元数据来自镜像）。镜像没到位时，挂公司代理 + 显式淘宝 registry：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
$env:HTTP_PROXY = 'http://proxyhk.huawei.com:8080'
$env:HTTPS_PROXY = $env:HTTP_PROXY
pnpm add '@yanglaofish/dsh-skill-manager@^2.0.0' --registry=https://registry.npmmirror.com
```

核对（**必须做**，否则可能装到旧版本）：

```powershell
(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@yanglaofish\dsh-skill-manager").LinkType   # 期望为空（registry 安装，不是 Junction）
(Get-Content "$env:USERPROFILE\.dsh\profiles\web\node_modules\@yanglaofish\dsh-skill-manager\package.json" -Raw | Select-String '"version"')
```

`LinkType` 为空 = 真的从 registry 装的（这就是"更新非 junction 到 web"的含义）；
若是 `Junction`，说明它被指向了源码目录，那不是发布版。

### 5.2 desktop profile

desktop profile 由 Electron 应用**独占管理**，CLI 直接改会被拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以 desktop 的更新只能在 Electron 侧做，二选一：

1. **桌面 UI**：设置 → 插件（Plugins）→ 找到 `@yanglaofish/dsh-skill-manager` → 更新到 `^2.0.0`
   （或先卸载再安装）；
2. **在桌面会话里用内核的 `plugin_manager` 工具**（`install_bundle`），等价于 UI 操作。

更新后核对：

```powershell
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@yanglaofish\dsh-skill-manager\package.json" -Raw | Select-String '"version"')
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw | Select-String 'dsh-skill-manager')
```

> 桌面端重启后如果"啥也没看到"：先读 `~/.dsh/profiles/desktop/package.json`，确认
> `dependencies` 与 `dsh.profile.bundles` 里都还有这个包。桌面版在插件树加载失败时会执行
> recovery 卸载并**重写 package.json**，把手工加的条目一起清掉（dsh-proxy-pro 的 LESSONS §14）。

---

## 6. 发布后验证

| # | 检查 | 命令 / 位置 |
|---|---|---|
| 1 | npmjs 版本到位 | `npm view @yanglaofish/dsh-skill-manager dist-tags versions --registry=https://registry.npmjs.org` |
| 2 | 淘宝源到位 | `npm view @yanglaofish/dsh-skill-manager version --registry=https://registry.npmmirror.com` |
| 3 | tarball 可下载 | `npm pack @yanglaofish/dsh-skill-manager@<ver> --registry=https://registry.npmmirror.com` |
| 4 | web profile 版本正确 | §5.1 的核对命令 |
| 5 | desktop profile 版本正确 | §5.2 的核对命令 |
| 6 | 三个 profile 的面板都正常 | 各自的设置 → 技能管理 |

---

## 7. 回滚

| 场景 | 处置 |
|---|---|
| 插件能加载但功能坏了 | 把 web/desktop 的依赖范围指回上一个版本并重装；test profile 用 `git checkout <上一个 commit>` 回退工作区 |
| 发布出去的版本无法加载（跳过/报错） | 走 `.github/workflows/npm-admin.yml` 做 `deprecate`（**优先**，保留可安装性）；确实没人装过再考虑 `unpublish`（72 小时窗口） |
| tag 打错（版本与 package.json 不一致） | 删掉远端 tag 重打：`git tag -d vX.Y.Z; git push origin --delete vX.Y.Z; git tag vX.Y.Z; git push origin vX.Y.Z`。注意 tag 触发时 workflow 取的是**该 commit 的版本**，所以改了 workflow 必须重打 tag |
| 本地发布撞 staging | 在 npmjs 网页批准 2FA，然后重跑 job（幂等） |

---

## 8. 世代重编号是怎么落地的（本次 `4.3.5 → 1.3.5 / 2.0.0` 的实际步骤）

供以后做同类迁移时照抄。要点是**两个独立 commit + 两个 tag**，顺序不能反：

1. **commit A（0.1 世代收尾）**：`lib/` 一字不改（= 当时稳定的 `4.3.5` 代码），只改
   - `package.json` → `version: 1.3.5`（把 `4.3.5` 按"大版本归 1"重编号，minor/patch 保持不变）
   - CI 修复（`publish.yml` 的淘宝同步端点 + 主动循环、新增 `npm-admin.yml`）——放这里是为了
     `v1.3.5` 那次发布就用上正确的同步逻辑。
   然后 `git tag v1.3.5` → push → CI 发布 `1.3.5`。
   `1.3.5` 与 `4.3.5` 的 tarball 除版本号外完全一致，这是刻意的：它的作用是给老编号线一个
   代际正确的版本号，而不是引入行为变化。
2. **用 npm-admin.yml deprecate `@yanglaofish/dsh-skill-manager@^4.0.0`**，消息指向 `1.x`（0.1 世代）
   与 `2.x`（0.2 世代）。
3. **commit B（0.2 迁移）**：`version: 2.0.0` + 全部 0.2 适配（见 `lib/index.js` 顶部与
   `test/manifest-compat.test.mjs` 注释里逐条记录的破坏性变更）。
   然后 `git tag v2.0.0` → push → CI 发布 `2.0.0` + 淘宝同步。
4. 按 §5 更新 web 与 desktop 到 `^2.0.0`。
