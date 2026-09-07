# AGENTS.md — Mochi Write

人类入口见 [README.md](README.md)。共享行为遵循 `/home/ling/workspace/AGENTS.md`。

## 项目定位与当前状态

个人小说创作 Web app；资产库支持 Web 编辑，故事首期仅阅读，写作通过后续单 Agent 接入。
MWT-002 已实现资产编辑、故事阅读、导入导出和个人认证接入；本地门禁使用隔离存储及签名测试身份。
真实云端联调留到 MWT-004。用户确认长期服务登记由 ProjectOps PRO-053 起的后续任务承接，
MWT-002 使用临时 loopback 端口完成本地验收；不得假定固定端口已分配。
实现前区分用户确认范围、建议行为与待决策项。

## ProjectOps 路由

项目 ID `mochi-write`，Backlog 前缀 `MWT`。用户于 2026-09-06 授权本项目使用 ProjectOps。
数据 workspace 为 `/home/ling/workspace`，authority 为 `.pops/workspace.json`。
先执行 `pops project list --json` 和 `pops project doctor --json`，读取 workspace 安装的
`projectops-workflow` skill，使用 manifest 解析出的 typed roots。
Backlog、Plan、execution、Report、ADR、Research 均由 ProjectOps 管理，不创建 Workspace Control 副本。
项目回顾使用 ProjectOps retrospective 路由；共享 tooling 回顾遵循 Workspace 路由。

## 开发边界

- 只服务本人；不引入多人协作、多 Agent 编排或 planner/narrator。
- 本项目持有正文、角色、设定等业务数据；Mochi 持有 Agent 执行会话与 provider 认证。
- 浏览器经应用后端调用 Mochi；不向客户端传递 provider 凭据。
- CCP 独占管理云资源与部署字段，本项目提供镜像和运行需求。
- 不把私人小说素材、凭据、会话或本地运行数据提交到 Git；导入不修改原始素材。
- 业务主存储已选择 Azure Cosmos DB；React/TypeScript/Vite、Node.js 24/TypeScript/Fastify、npm 与个人 Entra/MSAL 已确定，按首期实现契约开发。
- 侧栏通过宿主适配接口连接业务，首期应用内独立实现；共享包发布和 ProjectOps 接入留待后续。
- 故事使用独立完整快照，不因母版更新而变化；详细契约见产品和架构文档。
- 接入外部 API 前查阅最新官方文档。
- 文件操作先声明边界：默认受信任本地 Linux/容器目录，校验静态 containment 与正常并发冲突；
  不承诺抵抗同用户恶意 ancestor 替换，无 native helper。跨平台支持须另行确定。
- 尚未登记本地长期服务；需要固定端口时先按 Workspace 规则明确登记方案。

## 文档路由

| 文档 | 何时读 | 何时更新 |
|---|---|---|
| [README.md](README.md) | 了解状态和运行入口 | 实现状态、安装与运行命令变化 |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | 设计功能、交互和数据 | 用户流程、范围与数据契约变化 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 设计组件、存储和接入 | 技术选择、所有权与外部契约变化 |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 实现数据、认证、侧栏、导入导出或部署前 | schema、接口、质量入口和接入边界变化 |
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

纯文档变更检查 ProjectOps、文档链接与 diff。代码已有测试、类型检查和构建入口，
后续执行覆盖实际变更的项目质量门禁。中高风险行为按共享规则先验证失败用例。
导入、版本冲突、身份权限与任务恢复需行为测试，不能以文档检查代替。
完工同步受影响的产品和架构文档；已有 CodeGraph 索引且修改覆盖源码时运行 `codegraph sync`。
