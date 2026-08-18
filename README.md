# dsh-skill-manager

DeepSeek Harness（DSH）的技能生命周期管理插件：在「全局 / 工作区 / 会话」三层模型上完成技能的查看、编辑、导入、启用/停用，并提供完整的设置页与会话页 UI。

---

## 作用

技能（带 YAML frontmatter 的 `.md` 文件）是 DSH 代理的可复用能力包。本插件为它们提供管理平面：

- **一个技能，三层生效** — 可在全局、工作区、单个会话分别启用，最终生效集是分层合并结果。
- **免手填路径** — 工作区选择器自动解析当前会话的工作区。
- **完整 UI** — 设置页 + 会话页 tab，三处界面行布局完全一致。

---

## 三层技能模型

```
┌─ 会话层  (Session)     ~/.dsh/skill-manager/sessions/<sessionId>.json
│    工作区启用集的子集；默认「跟随工作区」
├─ 工作区层 (Workspace)  <cwd>/.dsh/skills/
│    symlink → 全局文件（Windows 无开发者模式时降级为复制）
│    此处存在 == 在该工作区启用，同名覆盖全局
└─ 全局层   (Global)     ~/.dsh/skills/          （启用）
                         ~/.dsh/skills-disabled/ （停用）
```

| 层 | 位置 | 生效范围 | 同名优先级 |
|---|---|---|---|
| 全局 | `~/.dsh/skills` | 所有工作区与会话 | 低 |
| 工作区 | `<cwd>/.dsh/skills` | 该工作区（及跟随它的会话） | 高（覆盖全局） |
| 会话 | 会话配置 | 仅该会话 | 最高（可见集内的子集） |

关键语义：

- **全局启用**的技能处处可见；工作区启用**不是白名单**，而是同名覆盖（dsh 引擎将 `project-dsh` 根排在 `user-dsh` 之上，最近层胜出）。
- **工作区启用**创建指向全局文件的 symlink（单副本、编辑即时同步）。Windows 未开启开发者模式时 symlink 需要管理员权限，插件**自动降级为复制**——仍支持跨盘，仍按名字识别为已启用。
- **会话勾选**：默认「跟随工作区」（工作区增删自动同步）；勾选任一技能即固定为自选子集；重新勾选全部则恢复跟随。

---

## 功能

### Host（lib/index.js）
- `list / get / edit / delete / enable / disable` — 全局层磁盘 CRUD
- `import` — 技能 `.zip`（根目录 `SKILL.md`，frontmatter 声明 kebab-case `name`）或**批量文件夹导入**
- `search` — 跨层全文搜索（名称 / 描述 / whenToUse / 正文），带命中字段标签与片段
- `workspace` — 工作区登记 / 改名重绑 / 忘记，工作区内技能启用/停用
- `session` — 查看 / 设置会话技能子集（对工作区允许集做交集校验）
- preset 目录 — 经 `agent-presets` 服务读取 preset 内物理捆绑的技能（如 `cordis` 预设自带 `cordis-plugin-development`、`editing-cordis-compositions`）

### Client（lib/client.js）— 设置页 + 会话页 tab
- 统计条：总数 / 全局启用 / 全局禁用 / preset 数 / 登记工作区数
- 双 tab：**全局技能**（整行切换、详情模态、删除）与**工作区技能**（搜索框上方的独立工作区下拉）
- 搜索框：防抖跨层结果
- **技能详情模态**：用 dsh 官方 `MarkdownText` 做 GFM 预览（KaTeX 数学、代码高亮）+ 原始编辑 tab，frontmatter/正文校验
- 统一的 **SkillRow**：整行点击切换，启用=高亮+实心圆点，停用=置灰+空心圆点；preset 技能只读并带所属 preset 标签
- **分页**（每页 10 条）：全局列表、搜索结果、工作区与会话列表；启用在前、preset 殿后
- 工作区选择器自动解析当前会话工作区（经 `ctx.sessions` + `agent-presets` 服务）

---

## 安装

插件以 git 仓库方式就地开发，通过 `link:` 依赖（Windows 下为 junction）装入 profile，重启即加载最新代码：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-skill-manager": "link:D:\\path\\to\\dsh-skill-manager"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* ... */ "dsh-skill-manager" ]
    }
  }
}
```

然后重启 `dsh web`。bundle patch（`cordis.patch.yml`）挂载 host 端；client 端注册设置分区与会话页 tab。

---

## 开发

```bash
node --check lib/index.js lib/client.js   # 语法检查
node test/unit.mjs                        # 83 条断言，隔离 DSH_HOME
```

- 所有文件操作在模块级、无需真实 `ctx` 即可测试；`apply()` 包装工具注册做 schema 规范化（等价 `defineTool`），因此 15 个工具都能通过模型投影校验。
- 插件注入 `tools`、`webServer`、`sessions`、`agentPresets` —— `sessions` 用于解析当前工作区，`agentPresets` 提供权威 preset 根（bundle 是 junction 安装，基于模块位置的 preset 发现会失效）。

---

## 实现要点

- **Windows 跨盘**：`~/.dsh` 在 C 盘、工作区在 D 盘 → 硬链接失败（`EXDEV`），symlink 需开发者模式。插件优先 symlink、失败静默降级为复制。
- **UTF-8 BOM**：Windows 编辑器常加 BOM，会破坏严格的 `^---` frontmatter 分隔符——`parseSkillDoc` 会剥离。
- **工具 schema**：裸 `parameters` 映射必须规范化为 `{type:'object', properties, required}`（模型投影会拒绝 `type: null`）。
- **复用 dsh 渲染器**：client 端 `require` 种子模块 `@deepseek-ai/dsh-client-ui-primitives` 取用 `MarkdownText`，而非内置 markdown 库。

---

## License

MIT（或按你的偏好调整）。
