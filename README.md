# dsh-skill-manager

一个 DeepSeek Harness（DSH）插件：为 DSH 代理的**技能**提供完整的管理平面——统一查看、编辑、导入、启用/停用，并按照「全局 / 工作区 / 会话」三层模型精细控制每个技能在何时何地生效。

DSH 的「技能」是带 YAML frontmatter 的 Markdown 文件，是代理可复用的能力包。技能一多就会散落在全局目录、各项目目录、甚至 preset 里，难以统一管理。dsh-skill-manager 把这一切收拢成一个管理平面：

- **全局技能** — 列出/查看/编辑/导入/删除/启用停用全部技能，一眼看清启用状态。
- **工作区技能** — 每个项目独立维护自己的技能集合（跟随项目目录走），切工作区即切视角。
- **会话技能** — 针对当前会话临时勾选，默认跟随工作区、可固定自选子集。
- **跨层搜索** — 名称 / 描述 / 使用场景 / 正文全文匹配，带命中标注。
- **统一界面** — 设置页双标签页 + 会话页技能面板，三处共用同一套行组件（整行点击切换、启用高亮、停用置灰、预设只读、自动分页）。

它不改变 DSH 的技能加载机制——它管理技能在磁盘上的组织方式，让 DSH 原生引擎读到的正是你想要的集合。

## 安装

```sh
dsh plugin --profile web add github:yanglaofish/dsh-skill-manager
```

安装完成后直接启动：

```sh
dsh web
```

## 使用

**推荐：页面管理** —— 启动 `dsh web` 后，进入设置 → 技能管理：

- **全局技能**标签页：整行点击切换启用/停用；「查看/编辑」打开详情模态（Markdown 渲染预览 + 原始编辑）；右上角「导入 skill」支持技能压缩包或整个文件夹批量导入。
- **工作区技能**标签页：顶部下拉选择工作区（自动定位当前会话的工作区），下方列出该工作区启用的技能；preset 技能只读并标注所属预设。
- **搜索框**：输入关键词即跨全部层级全文检索（名称/描述/whenToUse/正文），结果标注命中字段与上下文片段。
- **会话页「技能」tab**：查看并临时调整当前会话启用的技能子集。

**备选：对话管理** —— 直接对 agent 说：

- 「列出我有哪些技能」
- 「把 markdown-formatter 在工作区启用」
- 「导入这个技能压缩包」
- 「搜索包含 SQL 优化的技能」

agent 会调用 `skill_manager_*` 工具（共 15 个）完成操作。

## 卸载

```sh
dsh plugin --profile web remove dsh-skill-manager
```

## 技术方案

### 整体架构

插件由「宿主侧」（Node，随 DSH 主进程运行）与「客户端侧」（浏览器 bundle，随 Web UI 运行）两部分组成，通过 `/skill-manager/api/*` 自注册 HTTP 接口衔接。宿主侧为原生 ESM（无编译步骤），客户端侧为手写 `react.createElement` 的原生 JS bundle。

```
dsh-skill-manager
├── lib/
│   ├── index.js               宿主侧（原生 ESM，无需编译）
│   │   ├── 模块级函数         扫描/解析/CRUD/导入/搜索/工作区/会话/预设
│   │   └── apply()            装配 15 个 skill_manager_* 工具 + HTTP 路由
│   │                          + sessions/agentPresets 注入解析
│   └── client.js              客户端 bundle（__ModuleLoader__ 包装）
│       ├── SkillManagerPanel    设置页：统计条 + 双 tab + 搜索 + 分页 + 详情模态
│       ├── WorkspaceSkillsPanel 工作区/会话技能面板
│       └── SkillRow             三处共用的统一技能行组件
├── cordis.patch.yml          bundle patch：挂载宿主侧插件行
├── test/
│   ├── unit.mjs              83 条隔离单测（临时 DSH_HOME）
│   └── seed-sample.mjs       示例技能写入工具（开发验证用）
├── README.md / README-en.md
└── package.json              bundle 清单：exports + dsh.client 声明
```

**核心设计原则**：技能的状态只有单一事实源 —— 磁盘上的目录结构。全局启用在 `~/.dsh/skills`，工作区启用在 `<cwd>/.dsh/skills`，会话勾选在独立 JSON；所有界面与工具都读取同一份磁盘事实，不存在内存态与磁盘态的分叉。

### 三层模型

```
┌─ 会话层  (Session)     ~/.dsh/skill-manager/sessions/<sessionId>.json
│    工作区启用集的子集；默认「跟随工作区」
├─ 工作区层 (Workspace)  <cwd>/.dsh/skills/
│    symlink → 全局文件（Windows 无开发者模式时降级为复制）
└─ 全局层   (Global)     ~/.dsh/skills/          （启用）
                         ~/.dsh/skills-disabled/ （停用）
```

三层按「全局 → 工作区 → 会话」的 scope 链合并，**最近层同名覆盖**：全局启用的技能处处可见；工作区启用是「同名优先版本」（dsh 引擎将 `project-dsh` 根排在 `user-dsh` 之上）；会话勾选是可见集内的子集。

### 关键模块

| 模块 | 职责 |
| --- | --- |
| `parseSkillDoc / serializeSkillDoc` | 技能文档解析/序列化：YAML frontmatter + 正文，剥离 UTF-8 BOM |
| `scanDir / findSkill / searchSkills` | 目录扫描、按名定位、跨层全文搜索（命中字段 + 片段） |
| `importSkillDocs / importSkillZipFromBuffer` | 文件夹批量导入 / zip 包导入，逐项校验、部分失败不中断 |
| `linkGlobalSkillToWorkspace / unlink…` | 工作区启用/停用：symlink 优先，失败降级 copyFile |
| `readSessionConfig / setSessionSkills` | 会话勾选读写：显式子集与跟随工作区、对工作区允许集交集校验 |
| `scanPresetSkills` | 经 `agent-presets` 服务读取 preset 内物理捆绑的技能 |
| `normalizeParameters / registerTool` | 工具参数规范化为标准 JSON Schema（等价 defineTool） |
| `SkillManagerPanel / WorkspaceSkillsPanel / SkillRow` | 设置页与会话页 UI、统一行组件、分页与排序 |

### 数据流

**查看列表（/list）**

`scanDir(skillsRoot()) + scanDir(disabledRoot()) + scanPresetSkills() + listWorkspaces()` 并行收集，合并为「启用 → 禁用 → preset」的技能数组，连同统计条（总数/全局启用/全局禁用/preset 数/登记工作区数）一次返回。

**工作区解析（/view）**

Client 从会话 store 取当前 sessionId → `/view?sessionId=` → 宿主经 `ctx.sessions.get(id).header.cwd` 解析工作区（免手填路径），并自动登记该工作区；同一响应带回工作区列表供下拉选择，消除「暂无工作区」竞态。

**工作区启用（/workspace/toggle）**

优先 `symlink(source, target)` 创建指向全局文件的符号链接（单副本、编辑即时同步）；Windows 未开启开发者模式时 symlink 抛权限错误，静默降级 `copyFile`（跨盘可用，按名字识别为已启用）。重启用先 unlink 旧的再重建，幂等。

**会话设置（/session/set）**

Client 计算目标子集与「是否等于工作区全集」：等于全集 → 恢复跟随（`explicit=false`）；否则固定显式子集（`explicit=true`），宿主对工作区允许集做交集过滤后落盘。

**搜索（/search?q=）**

跨全局（启用+禁用）/ preset / 所有已登记工作区收集，大小写不敏感子串匹配名称/描述/whenToUse/正文；同名去重按「工作区 > 全局 > preset」优先级，返回命中字段 `why` 与正文片段 `snippet`。

### 关键设计细节

- **Windows 跨盘**：`~/.dsh` 在 C 盘、工作区在 D 盘时硬链接必然失败（`EXDEV`）。symlink 需要开发者模式/管理员权限，故设计为**优先 symlink、自动降级复制**，两种传输方式对外行为一致。
- **UTF-8 BOM**：Windows 编辑器常给文件加 BOM，破坏严格的 `^---` frontmatter 分隔符导致整段解析失败——`parseSkillDoc` 开头剥离。
- **工具 schema**：裸 `parameters` 映射（`{key: spec}`）在模型投影时被当作 JSON Schema 读取，`type` 为 null 直接报错。`registerTool` 统一规范化为 `{type:'object', properties, required}`（与 `defineTool` 输出等价），15 个工具全部通过校验。
- **复用 dsh 渲染器**：Markdown 预览 `require` 种子模块 `@deepseek-ai/dsh-client-ui-primitives` 取用官方 `MarkdownText`（KaTeX 数学 + 代码高亮 + 表格），不内置任何 markdown 库。
- **preset 根解析**：bundle 以 junction 方式安装时，`import.meta.dirname` 指向工作区，基于模块相对路径的 preset 发现会失效——改从 `agent-presets` 服务的 `resolvedRoots` 读取权威根。
- **无构建步骤**：宿主侧与客户端侧都是纯 JS，客户端 bundle 手写 `react.createElement`，不依赖 JSX/TS/打包器，安装即用。

## 开发

```sh
# 语法检查
node --check lib/index.js lib/client.js

# 运行 83 条隔离单测（临时 DSH_HOME，不污染真实环境）
node test/unit.mjs
```

- 所有文件操作均为模块级函数，无需真实运行环境即可单测；`apply()` 只在装配阶段工作。
- **GitHub 安装模式下**：改代码需 `git push` 后执行 `pnpm update dsh-skill-manager` 再重启 `dsh web` 生效。
- **本地开发模式**（改代码重启即生效）：`dsh plugin --profile web add .` 或手动 link 依赖。

## 许可

MIT
