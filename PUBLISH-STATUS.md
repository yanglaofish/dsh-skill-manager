# 2.1.1 已发布（2026-10-28）

本轮已完成修复后的双轴 code-review、完整回归、正式 npm 发布和淘宝镜像核验。
规范轴最终 0 项问题，需求轴无剩余阻断项；审查过程见
[发布审查记录](docs/RELEASE-REVIEW-20261028.md)。

## 正式版本与校验

- [npm 2.1.1](https://www.npmjs.com/package/@yanglaofish/dsh-skill-manager/v/2.1.1) 已公开可下载。
  本轮独立查询确认 npm 官方与 npmmirror 的 `latest` 均为 `2.1.1`。
- 发布标签 `v2.1.1` 保持指向 `2fb38bc6eaa0cfaf32ccc45dda9b7c773a4b6bfb`，未移动历史标签。
- 正式归档 **97,520 字节**，SHA-512 与注册表 `dist.integrity` 一致；归档内 lib/docs 共 10 个文件
  与发布标签中的 Git 原始内容逐字节一致，清单核心字段一致。
- 淘宝镜像归档与官方归档逐字节一致。SHA-256：
  `6aa1fea7c59a00db04b6735a772c6169d932f964e7592c2dc18ac062a528f73b`。
- 本地核验数据位于 `E:/Agenttools/deepseek/logs/formal-releases-20261028/skill-manager-2.1.1/`；
  downloads 中同名安装包已替换为经过核验的正式归档，旧候选包保留在 backups/release-candidates-20261028/。

## 流水线与验证

- [标签发布任务](https://github.com/yanglaofish/dsh-skill-manager/actions/runs/40541265079)成功。
- 发布期间修正旧镜像同步端点及当前世代 latest 判据，后续
  [最终核验任务](https://github.com/yanglaofish/dsh-skill-manager/actions/runs/40543811539)全部成功。
  日志确认已有 `2.1.1`，跳过重复上传，并输出 `SYNCED: 2.1.1`。
- 核心脚本 220 条断言、Node 测试 51 项均通过；两代真实桌面依赖冒烟通过。
  后续镜像脚本的 7 种边界回归、YAML/Bash 语法检查通过，补充审查无遗留。
- 后续 CI 修复提交为 `777783e`，仅修正发布流程，不改变已发版本的业务代码或归档。

本轮没有更改本机 profile 安装、重启桌面或评论/关闭线上 issue。
凭据签名使用固定值夹具，未执行完整真实浏览器登录与 UI 手动验收。
