# Mochi Write

供个人使用的小说创作 Web app，将本地 Markdown 创作资料迁移为可浏览、可管理的作品与资产库。
Agent 执行由 Mochi 提供，云基础设施与部署由 CCP 管理。

## 当前状态

已实现个人登录接入、角色/世界观编辑、故事阅读及 Markdown 导入导出。
本地验收使用隔离存储与签名测试身份；真实 Cosmos/Entra 联调留到 MWT-004。
长期开发服务登记待 ProjectOps 服务管理能力交付后落实；按用户确认，MWT-002 使用临时端口完成本地验收。
当前不启动固定端口服务，也没有云部署。
项目 ID 为 `mochi-write`，Backlog 前缀为 `MWT`。

## 首期范围

- 角色与世界观资产的浏览、检索和 Web 编辑。
- 作品设定与分章正文阅读；暂不提供故事正文手工编辑器。
- 后续通过页面感知右侧栏接入单 Agent 写作，按故事持续会话，生成草稿、反馈重写和采纳章节。
- 故事拥有独立的角色与世界观快照；业务主存储已选择 Azure Cosmos DB。
- 导入既有 Markdown 资料并保留关联，提供 Markdown 导出。
- 仅个人使用；不实现 planner/narrator、多 Agent 编排或角色扮演。

## 文档与任务

- [Agent 指引](AGENTS.md)
- [产品规格](docs/PRODUCT_SPEC.md)
- [架构与待决策项](docs/ARCHITECTURE.md)

在 ProjectOps 数据 workspace 中执行：

```bash
pops backlog list mochi-write --json
pops docs check mochi-write --json
pops project doctor --json
```

技术栈已确定为 React/TypeScript/Vite + Node.js 24/TypeScript/Fastify，npm，同仓库同容器；个人 Entra ID + MSAL。
数据、认证、侧栏及后续接入条件见 [首期实现契约](docs/CONTRACTS.md)。

## 开发与验证

使用 Node.js 24，在 Repo 根目录执行：

```bash
npm ci
npm run check
npm run test:e2e
```

`check` 包含 ESLint、Prettier、TypeScript、Vitest 和前后端构建；`test:e2e` 要求先构建并安装
Playwright Chromium，使用临时 loopback 端口。覆盖登录壳、编辑保存/刷新、保存失败、版本冲突与草稿保留、
故事阅读、快照隔离、Markdown 渲染、目录导入、ZIP 导出与移动端布局。测试身份入口及内存存储仅位于 tests，
独立构建到 Git 忽略的 .data/browser，不进入生产构建；测试不代表真实 Microsoft 登录或 Cosmos 云端验收。
sandbox 禁止本地监听时需在允许 loopback 的环境执行。

运行入口为 `npm run dev`（TypeScript 后端）或构建后的 `npm start`；均提供 `dist/web` 静态页面，
修改前端后需要重新构建。后端要求通过环境传入以下配置，不自动读取 `.env`：

| 变量 | 含义 |
|---|---|
| `ENTRA_TENANT_ID` / `ENTRA_OWNER_OID` | 允许的租户与本人对象 UUID |
| `ENTRA_SPA_CLIENT_ID` / `ENTRA_API_CLIENT_ID` | 独立 SPA/API registration UUID |
| `APP_ORIGIN` | 精确同源地址，无路径或尾部斜杠；公开地址要求 HTTPS |
| `COSMOS_ENDPOINT` | 既有 Cosmos HTTPS endpoint |
| `COSMOS_DATABASE` | 默认 `mochi-write` |
| `AZURE_CLIENT_ID` | 可选的 user-assigned Managed Identity client ID |
| `HOST` / `PORT` | 默认 loopback / 8080；容器显式传 `HOST=0.0.0.0` |

后端目前使用 Managed Identity，不自动创建数据库、container 或 registration。API registration 需签发 v2 access token，
scope 为 `api://<API client ID>/Write.Access`；SPA redirect 为 `APP_ORIGIN/redirect.html`。
MSAL v5 使用独立 redirect bridge 页面，反向代理不得为该页面设置 COOP header。
首次启动长期服务前仍须完成工作区开发 endpoint 登记，默认 8080 不是已分配的本地开发端口。

## 使用与资料迁移

- 角色库、世界观：按名称、题材筛选，角色还可按年龄层筛选；打开资产阅读或编辑。
- 保存成功才显示确认。保存失败保留草稿；版本冲突时可读取并对照服务器最新内容，再决定如何保存。
  已有资产的草稿在当前页面会话内保留，侧栏可返回；关闭/刷新前提示未保存内容，不在本机持久化私人草稿。
- 故事书架：阅读设定、人物关系、大纲、独立资产快照和按序章节；正文没有手工编辑入口。
- 导入：选择旧 novel 根目录或已解压导出包，预检后确认写入。同一次重试保留批次标识；
  输入变化使用新批次，无 manifest 的不同批次会创建新的资产/故事 ID。已有导出包按清单 ID 判定冲突。
- 导出：下载含 Markdown 与 manifest.json 的 ZIP，保留当前内容及导入溯源；不导出全部历史版本。

命令行也提供只读预检、导入和不覆盖已有目标的目录导出：

```bash
npm run transfer -- preflight tests/fixtures/novel example-batch
npm run transfer -- import <源目录> <批次标识>
npm run transfer -- export <尚不存在的目标目录>
```

`preflight` 不需要云配置，不写入数据库；`import` / `export` 使用与服务相同的环境配置和 Managed Identity。
CLI 不提供认证绕过，也不自动创建云资源。源目录只读；仅消费 library、projects，忽略旧库派生 index.md。
导出在目标目录原子占位后逐个 create-only 写入，manifest 最后写入。失败保留已产生的部分目录供检查；
重试使用新的目标，不覆盖或自动清理已有内容。文件系统支持边界及具体格式见 [实现契约](docs/CONTRACTS.md)。
