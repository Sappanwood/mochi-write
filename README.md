# Mochi Write

供个人使用的小说创作 Web app，将本地 Markdown 创作资料迁移为可浏览、可管理的作品与资产库。
Agent 执行由 Mochi 提供，云基础设施与部署由 CCP 管理。

## 当前状态

已实现个人登录接入、角色/世界观编辑、故事阅读、Markdown 导入导出及 Mochi 单 Agent 写作侧栏。
侧栏支持上下文预览、持续会话、生成/反馈重写、取消/恢复与原子章节采纳。
已发布至 [Mochi Write](https://mochi-write.whitemeadow-6e32159b.eastus.azurecontainerapps.io)，
本人 Entra 登录和 `/api/stories` HTTP 200 已验证，CCP 发布后资源检查无 drift。
首批 18 故事、374 对象已导入云端；同批次重试返回 created 0、skipped 374，全局故事分页共 18 条且无重复。
云端导出曾因故事分区查询问题返回 HTTP 400；修复已上线，374 份 Markdown hash、全部 manifest attributes/fields、唯一路径及 ID 均与期望一致。
独立人工测试故事已完成真实模型生成、采纳及页面断开恢复验证，未使用 18 个旧故事作为模型上下文。
真实跨应用隔离、服务进程中断恢复、收费数据库恢复及 ZIP 落盘完整性尚未验收，主入口尚未切换。
本地测试继续使用隔离存储与签名测试身份。
已通过 ProjectOps 登记长期开发服务 `http://127.0.0.1:12600`，Web/API 共用端口；本次只完成登记，尚未启动服务。
本地启动仍需独立准备 Entra/Cosmos 配置与可用 Managed Identity；云发布不代表本地开发服务已经运行。
项目 ID 为 `mochi-write`，Backlog 前缀为 `MWT`。

## 首期范围

- 角色与世界观资产的浏览、检索和 Web 编辑。
- 作品设定与分章正文阅读；暂不提供故事正文手工编辑器。
- 页面感知右侧栏接入单 Agent 写作，按故事持续会话，生成草稿、反馈重写和采纳章节。
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
sandbox 禁止本地监听时需在允许 loopback 的环境执行。写作浏览器测试还覆盖导航固定目标、反馈重写、刷新恢复、取消和资产库无章节采纳。

显式跨 Repo 联调入口（两个 Repo 先安装依赖，使用真实 HTTP 服务、Pi AgentSession 与本地签名身份，provider 为脱敏测试输出）：

```bash
MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration
```

该命令使用临时 loopback 端口和隔离持久存储，验证幂等、游标、采纳、调用方隔离及服务重启恢复；
不调用真实模型，不替代 Cosmos/Entra 云端联调。它不属于独立 Repo 的默认 `check`。

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
| `MOCHI_ORIGIN` / `MOCHI_ENTRA_AUDIENCE` | 可选但必须成对；Mochi 精确 origin 与 Entra API audience UUID |
| `HOST` / `PORT` | 默认 loopback / 8080；容器显式传 `HOST=0.0.0.0` |

后端目前使用 Managed Identity，不自动创建数据库、container 或 registration。API registration 需签发 v2 access token，
scope 为 `api://<API client ID>/Write.Access`；SPA redirect 为 `APP_ORIGIN/redirect.html`。
MSAL v5 使用独立 redirect bridge 页面，反向代理不得为该页面设置 COOP header。
开发 endpoint 已登记于 workspace `.pops/workspace.json` 的 `projects.mochi-write.dev`：单 `web` endpoint，
`127.0.0.1:12600`，Repo 相对 cwd `.`，命令 `npm run dev`。ProjectOps 注入 `HOST=127.0.0.1`，
并通过受限变量将 `WEB_PORT` 映射到 `PORT`、`WEB_ORIGIN` 映射到 `APP_ORIGIN`；默认 8080 不是本工作区分配。

先在 Repo 执行 `npm run build` 生成前端，再为首次启动独立 manager 的环境提供上表真实配置及可用 Managed Identity。
manager 继承启动时的环境，后续 CLI 不会重新注入调用 shell 的环境；本应用不自动加载 `.env`，
不要把凭据写进 manifest。配置未就绪时仅运行以下只读检查：

```bash
pops dev ports --json
pops dev check mochi-write --json
pops dev status mochi-write --json
```

配置就绪后可用 `pops dev start mochi-write` 启动，`pops dev restart mochi-write` 重启，
`pops dev stop mochi-write` 关闭；Workbench 项目 Overview 的开发服务区提供同一服务的控制与打开入口。
CLI 可独立工作，关闭 Workbench 不影响该服务。端口检查通过只证明登记与占用检查通过，不证明云端连接可用。

## 使用与资料迁移

- 角色库、世界观：按名称、题材筛选，角色还可按年龄层筛选；打开资产阅读或编辑。
- 保存成功才显示确认。保存失败保留草稿；版本冲突时可读取并对照服务器最新内容，再决定如何保存。
  已有资产的草稿在当前页面会话内保留，侧栏可返回；关闭/刷新前提示未保存内容，不在本机持久化私人草稿。
- 故事书架：阅读设定、人物关系、大纲、独立资产快照和按序章节；正文没有手工编辑入口。
- 导入：选择旧 novel 根目录或已解压导出包，预检后确认写入。同一次重试保留批次标识；
  输入变化使用新批次，无 manifest 的不同批次会创建新的资产/故事 ID。已有导出包按清单 ID 判定冲突。
- 导出：下载含 Markdown 与 manifest.json 的 ZIP，保留当前内容及导入溯源；不导出全部历史版本。
- 大小限制：普通 Markdown 单篇 1 MiB，根 manifest.json 最多 16 MiB，整个包累计仍最多 16 MiB、1000 个文件；较大清单保留完整原始溯源。

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


## 写作与恢复

打开右侧“写作助手”，按故事或资产库恢复最近创建的会话，也可新建会话。
选择模型、勾选所需资料，预览原文；选区可粘贴并调整。当前对象版本由页面提供，取消勾选会移除该对象正文，
其位置与版本仍会校验。默认只选一份资料，不发送整部作品。
故事中选择新章节名称/顺序或当前章节新版本，输入要求，先预览固定内容再确认发送。
发送后导航不改变目标；反馈重写保持原草稿的目标及预分配章节 ID。

成功完整输出才提供采纳动作，采纳事务同时保存章节版本、当前章节及草稿 accepted；重复点击返回既有结果。
版本竞争显示冲突并保留草稿，需重新读取当前章节并发起新的生成请求，不能强制覆盖。
失败/取消/中断的片段仅供查看。页面关闭不取消任务；刷新后打开侧栏可恢复查询。
提交结果未知时先查询，只有显式“用原请求重试提交”才会使用同一输入及请求键再次提交；不自动重放。
资产库会话仅提供建议，没有章节采纳动作。聊天历史由 Mochi 保存，应用仅持有输入快照、关联和草稿。
缓存统计只显示实际返回值，没有统计时显示未知。上下文超出保守预算会阻止发送，需减少资料或新建会话。

真实云端验收使用独立人工测试故事及 `deepseek-v4-flash`，共 2 个 conversation、2 个 run，每个 run 的 `maxOutputTokens` 为 4096。
任务 A 完成生成并采纳为章节 v1，刷新后正文一致；任务 B 在 queued 时导航到 `about:blank` 断开页面，重开后查询原 run 成功，没有重新提交。
API 返回 usage 合计 2015 tokens：input 202、output 1685、cache_read 128；按 API 口径记录，不推算价格。
该验证覆盖页面断开后的查询恢复，未验证服务进程中断或真实跨应用身份隔离。

未设置 Mochi 配置时写作入口报告不可用，资产阅读与管理仍可使用。后端以 Managed Identity 获取
`api://<MOCHI_ENTRA_AUDIENCE>/.default` token，不转发浏览器 token，不传递 provider 凭据。

## 容器

```bash
docker build --platform linux/amd64 -t mochi-write:local .
docker run --rm --env-file /absolute/path/to/private-runtime.env -p 127.0.0.1::8080 mochi-write:local
```

镜像使用 Node.js 24、多阶段构建、非 root 用户，监听 `0.0.0.0:8080`，由同一进程提供 Web/API。
配置文件不进入镜像或 Git；开发 smoke 使用临时映射端口。生产运行仍要求真实身份、Cosmos 与配置，
镜像没有测试认证后门。`/health/live` 检查进程，`/health/ready` 检查 Cosmos；探针不调用模型。
CCP 管理部署与 digest。当前发布基于代码 `0896327`，镜像 digest 为
`sha256:9fbf82c9e9bbf970c8e3d38b336ac4a13ace260a94b3d049a54bc4e7f5d7f1fe`。
该版本已通过 110 项测试、15 项 E2E 和独立 review；部署后全局 18 故事及选定故事 14 对象的分区范围检查通过，CCP 检查无 drift。
云端导出内容与元数据语义已核验，ZIP 落盘完整性与收费数据库恢复验收仍需完成。
