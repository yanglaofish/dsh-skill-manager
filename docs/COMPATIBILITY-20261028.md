# 2026-10-28 兼容性修复记录

## 现状与范围

本地候选版本为 **2.1.1，尚未发布 npm**。修复分支为
`codex/skill-manager-issue3-compat`，起点为 `5578f9f`（`dsh2.x`）。
本轮查询官方 npm 注册表，公开 `latest` 仍为 `2.1.0`；桌面 profile 使用本地源码链接。
当前桌面内核为 `0.2.1-rc.3`，另以本地 `0.2.0-rc.2` 安装包验证向后兼容。

| 反馈 | 核查与处理 |
|---|---|
| [issue #3](https://github.com/yanglaofish/dsh-skill-manager/issues/3)：域名访问 403 | 复现并修复：自建 HTTP 路由改用宿主 `connection.requestRejection(req)` |
| 同一 issue：缺 peer 时会话钩子抛错 | 复现并修复：启动预检缓存依赖结果，创建、每步刷新、销毁和卸载隔离插件异常 |
| [issue #1](https://github.com/yanglaofish/dsh-skill-manager/issues/1)：无法勾选 | 保留 2.1.0 的既有客户端回归；真实会话测试验证勾选、取消与回到跟随。本轮未手动重现旧版界面 |
| [issue #2](https://github.com/yanglaofish/dsh-skill-manager/issues/2) | 内容仅为泛泛反馈，没有可执行的缺陷信息 |

本轮没有评论或关闭线上 issue，也没有推送分支、打发布标签或重启用户的桌面实例。

## 行为约定

- 复用宿主的可信 Host、Origin、端口和凭据校验，支持 `--trusted-host` / `--public-url`
  产生的宿主配置；不另行解析 CLI 参数或设置一份独立信任名单。
- 宿主返回 401/403 时原样拒绝，校验抛错或已存在的服务缺少准入接口则拒绝。没有 connection 的组合仍仅接受
  loopback 同源请求；connection 每次请求读取，支持晚挂载与替换。
- 缺少 `dsh-scope` / `dsh-skill-filesystem` 时，启动日志明确提示会话选择层不可用。
  此时插件的会话勾选覆盖不能生效，继续使用宿主的原生技能行为；补齐宿主依赖后需重新加载插件。
- 依赖从宿主的包解析机制取得，不安装第二份 scope，保留原生身份、父链和每会话隔离。
- 挂载或刷新异常按 agent 去重提示；`next()` 仍继续调用，且模型自身的错误继续向上传播。
- 原生技能目录中的 `<name>/SKILL.md` 不会自动迁入库，请用“导入未托管技能”。

## 验证

全部文件系统测试在临时 DSH_HOME / agents 目录内执行。

```powershell
npm test
node scripts/run-desktop-test.mjs "$env:LOCALAPPDATA/Programs/DeepSeek Harness" scripts/session-runtime.test.cjs
node scripts/run-desktop-test.mjs "$env:LOCALAPPDATA/Programs/DeepSeek Harness" scripts/panel-runtime.test.cjs
node scripts/run-desktop-test.mjs 'E:/Agenttools/deepseek/app' scripts/session-runtime.test.cjs
node scripts/run-desktop-test.mjs 'E:/Agenttools/deepseek/app' scripts/panel-runtime.test.cjs
```

- 核心脚本 220 条断言通过；Node 测试 51 项通过，0 失败、0 跳过。
- 新增 7 项回归：域名与凭据委托、无 connection、缺包、日志失败、挂载/刷新失败、清理失败、
  provider 构造失败后的监听器释放。前六项在初次修复前有五项失败；独立审查发现的构造失败
  回归也先验证失败，再修复，全数通过。
- 两个桌面内核的真实模型目录、skill 工具、调用策略、双会话隔离、跨进程刷新和卸载验证通过。
- 两个内核的真实 HostConnectionService 验证可信域名、端口、IPv6、跨域和 401/403。
  测试以固定值代替凭据签名验证，不代表完成了真实浏览器的登录和 UI 手动验收。
- rc.3 的原生 skill 工具新增 workingDirectory 服务依赖，运行时测试夹具已补上固定测试目录解析。

独立审查发现的 provider 构造异常监听器泄漏已修复并复核关闭；未发现 P0/P1。
另对已有 connection 缺失准入方法的情况补充拒绝逻辑，并先用回归确认原实现会错误放行。

## 备份与恢复

修改前备份位于 `E:/Agenttools/deepseek/backups/skill-manager-issue3-20261028/`：
`source.bundle` 保存源码历史，`skill-manager-data/` 保存用户技能管理数据，
`desktop-package.json` 保存桌面插件依赖清单。验证未对这些用户数据执行迁移或修改。

仅回退代码时，确保没有未保存改动，然后在本仓库切回 `dsh2.x`（本轮起点 `5578f9f`），
再在合适时机重新加载插件。保留修复分支以便继续审查。
如需恢复用户数据，先退出相关 DSH 实例，将备份复制到新的 DSH_HOME 验证后再替换原目录，
并保留原目录副本。不要在运行中的 profile 上覆盖数据或依赖清单。
