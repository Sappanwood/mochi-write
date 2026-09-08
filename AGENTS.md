# AGENTS.md — Mochi Write

人类入口见 [README.md](README.md)。共享行为遵循 `/home/ling/workspace/AGENTS.md`。

## 项目定位与当前状态

个人小说创作 Web app；资产库支持 Web 编辑，故事支持阅读和单 Agent 草稿采纳，暂无正文手工编辑器。
MWT-010/011 已在本地接入故事资产工具、独立草稿与有限授权写章后端；创作主界面与全链路验收由后续切片推进，未发布云端工具配置。
MWT-002 已实现资产编辑、故事阅读、导入导出和个人认证接入；MWT-003 已接通写作侧栏与 Mochi 会话/任务 API。
本地门禁使用隔离存储及签名测试身份；跨 Repo 集成使用真实 HTTP/Pi AgentSession 与假 provider 输出。
MWT-004 已发布到 Azure Container Apps，本人 Entra 登录与故事列表 HTTP 200 已验证；
首批 18 故事、374 对象已导入，同批次重试及全局分页已验证；导出修复已上线，云端导出的正文 hash 与 manifest 元数据语义核验通过。
独立人工测试故事已验证真实模型生成、章节采纳后刷新一致及页面断开后原任务恢复。
真实跨应用隔离、服务进程中断恢复、收费数据库恢复及 ZIP 落盘完整性尚未验收，主入口尚未切换。MWT-005 已通过 ProjectOps 登记 `127.0.0.1:12600` 单端口 Web/API；
该本地服务仅完成登记、尚未启动，启动仍需独立准备 Entra/Cosmos 配置与可用 Managed Identity。
实现前区分用户确认范围、建议行为与待决策项。

## ProjectOps 路由

项目 ID `mochi-write`，Backlog 前缀 `MWT`。用户于 2026-09-06 授权本项目使用 ProjectOps。
数据 workspace 为 `/home/ling/workspace`，authority 为 `.pops/workspace.json`。
先执行 `pops project list --json` 和 `pops project doctor --json`，读取 workspace 安装的
`projectops-workflow` skill，使用 manifest 解析出的 typed roots。
Backlog、Plan、execution、Report、ADR、Research 均由 ProjectOps 管理，不创建 Workspace Control 副本。
项目回顾使用 ProjectOps retrospective 路由；共享 tooling 回顾遵循 Workspace 路由。

## 开发边界

- 当前阶段以快速迭代为主，验收覆盖主要 happy path；真实使用中出现的 bug 再针对性处理，不为追求工程完备性主动扩展实现与验收范围。
- 只服务本人；不引入多人协作、多 Agent 编排或 planner/narrator。
- 本项目持有正文、角色、设定等业务数据；Mochi 持有 Agent 执行会话与 provider 认证。
- 浏览器经应用后端调用 Mochi；不向客户端传递 provider 凭据。
- CCP 管理云资源与非镜像部署字段；本项目 GitHub Actions 管理 image digest 和发布，Terraform 仅忽略 image 字段。
- 不把私人小说素材、凭据、会话或本地运行数据提交到 Git；导入不修改原始素材。
- 业务主存储已选择 Azure Cosmos DB；React/TypeScript/Vite、Node.js 24/TypeScript/Fastify、npm 与个人 Entra/MSAL 已确定，按首期实现契约开发。
- 侧栏通过宿主适配接口连接业务，首期应用内独立实现；共享包发布和 ProjectOps 接入留待后续。
- 故事使用独立完整快照，不因母版更新而变化；详细契约见产品和架构文档。
- 接入外部 API 前查阅最新官方文档。
- 文件操作先声明边界：默认受信任本地 Linux/容器目录，校验静态 containment 与正常并发冲突；
  不承诺抵抗同用户恶意 ancestor 替换，无 native helper。跨平台支持须另行确定。
- 本地长期服务 authority 为 workspace `.pops/workspace.json` 的 `projects.mochi-write.dev`；
  在 Repo cwd 执行 `npm run dev`，由 ProjectOps 注入 `HOST`、`PORT`、`APP_ORIGIN`。先构建前端，
  准备 README 要求的真实运行环境，再用 `pops dev check/start/status/stop/restart mochi-write` 管理；不创建 Workspace Control descriptor。

## 文档路由

| 文档 | 何时读 | 何时更新 |
|---|---|---|
| [README.md](README.md) | 了解状态和运行入口 | 实现状态、安装与运行命令变化 |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | 设计功能、交互和数据 | 用户流程、范围与数据契约变化 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 设计组件、存储和接入 | 技术选择、所有权与外部契约变化 |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 实现数据、认证、侧栏、导入导出或部署前 | schema、接口、质量入口和接入边界变化 |
| [docs/CREATIVE_WORKSPACE.md](docs/CREATIVE_WORKSPACE.md) | 实现故事工具会话、授权与恢复 | 草稿、授权、收据、创作 API 或恢复变化 |
| ProjectOps typed roots | 查看任务、计划、决策背景与验收 | 通过对应 ProjectOps 契约维护 |

## 常用命令与完工验收

```bash
pops project doctor --json
pops docs check mochi-write --json
pops backlog list mochi-write --json
git diff --check
npm run check
npm run test:e2e
```

跨 Repo 联调显式执行 `MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration`，要求两个 Repo 依赖就绪及临时 loopback 权限；不自动发现 Repo，不调用真实模型。

纯文档变更检查 ProjectOps、文档链接与 diff。代码已有测试、类型检查和构建入口，
后续执行覆盖实际变更的项目质量门禁。中高风险行为按共享规则先验证失败用例。
导入、版本冲突、身份权限与任务恢复需行为测试，不能以文档检查代替。
完工同步受影响的产品和架构文档；已有 CodeGraph 索引且修改覆盖源码时运行 `codegraph sync`。

应用发布 workflow 与 `scripts/deploy.py` 的修改需运行 Python 发布行为测试，随后执行项目既有质量门禁。日常发布入口与维护边界见 README；不得恢复 CCP 与应用双重管理 image。
