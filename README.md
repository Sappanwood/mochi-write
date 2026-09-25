# Mochi Write

供个人使用的小说创作 Web app，将本地 Markdown 创作资料迁移为可浏览、可管理的作品与资产库。
Agent 执行由 Mochi 提供，云基础设施与部署由 CCP 管理。

## 当前状态

已实现个人登录接入、角色/世界观编辑、故事阅读、Markdown 导入导出及 Mochi 单 Agent 写作侧栏。
角色头像与默认 2.5D 生图提示词入口已通过 [Actions 发布](https://github.com/Sappanwood/mochi-write/actions/runs/36115082586)上线。质量门禁、部署健康检查及新增头像 API 的匿名读写拒绝检查通过；发布后 [CCP 审计](https://github.com/Sappanwood/ccp/actions/runs/36115711671)无漂移。线上已用合成角色验证裁剪上传、保存后刷新读取、移除头像后保留提示词，以及携带精确角色版本进入预填但未发送的 2.5D 提示词会话；测试角色已删除。CCP 已部署私有 Blob、容器级身份权限和 ACA 环境变量，见下文配置。
侧栏支持上下文预览、持续会话、生成/反馈重写、取消/恢复与原子章节采纳。
故事级写作指引已发布：故事页维护、跨会话注入、执行快照查看及导入导出保留。线上已验证保存／清空、版本冲突、刷新恢复，以及现有订阅模型读取指引生成独立草稿；指引为创作提示，不保证逐条格式约束，验收中每段句数未严格遵循。
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
另包含固定应用工具身份下的 search → read → draft → commit、精确草稿保存、完整工具历史、身份隔离、预算及真实进程中断验证。
不调用真实模型，不替代 Cosmos/Entra 云端联调。它不属于独立 Repo 的默认 `check`。
独立收费 smoke 的授权、凭据和报告入口见[隔离验收说明](docs/CREATIVE_WORKSPACE.md#隔离验收入口)。

运行入口为 `npm run dev`（TypeScript 后端）或构建后的 `npm start`；均提供 `dist/web` 静态页面，
修改前端后需要重新构建。后端要求通过环境传入以下配置，不自动读取 `.env`：

| 变量 | 含义 |
|---|---|
| `ENTRA_TENANT_ID` / `ENTRA_OWNER_OID` | 允许的租户与本人对象 UUID |
| `ENTRA_SPA_CLIENT_ID` / `ENTRA_API_CLIENT_ID` | 独立 SPA/API registration UUID |
| `APP_ORIGIN` | 精确同源地址，无路径或尾部斜杠；公开地址要求 HTTPS |
| `COSMOS_ENDPOINT` | 既有 Cosmos HTTPS endpoint |
| `COSMOS_DATABASE` | 默认 `mochi-write` |
| `PORTRAIT_BLOB_ENDPOINT` | 可选，Azure 公有云 Storage account 的 `https://<account>.blob.core.windows.net`，不含路径、SAS 或凭据 |
| `PORTRAIT_BLOB_CONTAINER` | 默认 `portraits`，预先创建的私有 container |
| `AZURE_CLIENT_ID` | 可选的 user-assigned Managed Identity client ID |
| `MOCHI_ORIGIN` / `MOCHI_ENTRA_AUDIENCE` | 可选但必须成对；Mochi 精确 origin 与 Entra API audience UUID |
| `MOCHI_TOOLS_CLIENT_ID` / `MOCHI_TOOLS_PRINCIPAL_ID` | 可选但必须成对；反向工具 callback 的 Mochi 服务 client/principal UUID，要求 Write.Tools.Invoke app role；main 已注册可信任务 callback，缺少此配置时拒绝工具请求 |
| `HOST` / `PORT` | 默认 loopback / 8080；容器显式传 `HOST=0.0.0.0` |

Mochi 侧还需配置固定 Write HTTPS callback、operations endpoint 和三个工具的 allowlist；
Write 的反向角色配置必须对应上述身份。该接入不自动创建云端权限。授权／恢复契约见
[故事创作会话](docs/CREATIVE_WORKSPACE.md)，已有故事可直接进入创作主工作区。

后端目前使用 Managed Identity，不自动创建数据库、container 或 registration。API registration 需签发 v2 access token，
scope 为 `api://<API client ID>/Write.Access`；SPA redirect 为 `APP_ORIGIN/redirect.html`。
MSAL v5 使用独立 redirect bridge 页面，反向代理不得为该页面设置 COOP header。

CCP 已在既有 `mochidataa4c005ba3f` Storage Account 配置私有 `mochi-write-portraits` Blob container、关闭匿名访问，
并为 Write Managed Identity 在该 container 授予 `Storage Blob Data Contributor`；ACA 已注入对应
`PORTRAIT_BLOB_ENDPOINT` 与 `PORTRAIT_BLOB_CONTAINER`。部署参数见 [CCP 输出](https://github.com/Sappanwood/ccp/blob/main/docs/WRITE_DEPLOYMENT_OUTPUTS.json)。
浏览器通过本人 API 读写图片，不使用公共链接或 SAS；后端不自动创建资源。此容器不受现有 Files/Cosmos 备份覆盖，
完整头像备份需使用包含附件的导出包；资源身份读写和清理、应用页面的主要头像路径均已云端验收。
未配置 Blob 时仍可阅读文字、整理和保存提示词；图片读写以及含头像附件的导入导出会明确报错，不产生缺图的成功备份。
头像、提示词与角色版本一起保存；上传后须点击「保存头像与提示词」才关联角色，冲突可保留草稿后对照最新版本。
「整理 2.5D 提示词」只准备已有文字会话的输入，用户发送后调用现有模型；输出由用户复制回提示词栏并保存，不直接调用生图模型。
原图在浏览器裁剪为正方形，服务器重新编码为 512×512 JPEG；原图不保存。旧头像与未采纳上传保留，不自动删除，以保护历史版本及故事快照。
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

- 新建创作与最近会话：默认首页 `#free/new` 从空白开始；`#free/conversations` 恢复已有讨论和候选，包括尚无正式资产的会话。角色／故事新建入口可先写想法，发送前不创建资产。
- 故事书架、角色库与世界观：角色默认阅读并可轻量编辑，故事书架默认阅读正式章节。资产可带已保存版本开始自由会话，或返回关联会话；初始资料显式可见，不作为永久保存目标。
- 书架和资产卡片显示正文短摘要与可读更新时间；故事显示资料自身的更新时间。最近会话显示最近消息、中文状态和正式关联名称，保存计数只取真实收据。
- 故事阅读页默认收起关联会话与目录，首屏呈现正文；“带此故事新建会话”以已保存故事开启新会话，“返回已有会话”恢复原讨论。导入导出在“更多”中，完整引用与操作记录可在会话详情中查看。
- 桌面审稿支持收起导航、拖动分栏、整稿及选区反馈、同组版本并排对照。“准备保存此稿”只准备精确引用和可编辑请求，发送后才进入保存授权流程。
- 自由会话默认单栏，可按需打开资料与草稿，桌面支持专心阅读；手机在讨论和信息视图中均可输入反馈。布局、引用和阅读位置随当前会话恢复，新稿到达只提示。
- 正式保存收据可打开资产或故事，再返回原自由会话；会话输入、精确引用和信息阅读状态保存在当前标签页的 sessionStorage，支持刷新恢复。临时人工编辑不自动发送给 Agent。
- 旧链接继续有效；“更多”中的“旧创作会话与草稿”“旧版新建故事”和故事页面的“旧故事创作会话”提供原协议入口，不迁移历史。本地新会话已支持世界观完整候选、精确旧稿保存与母版更新；世界观新建入口使用自由会话。旧会话明确提示能力限制并提供主动新建入口；旧直接编辑和章节新版本侧栏保留。新增能力尚未发布。

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

书架的「新建故事」从自然对话开始，不要求先填标题或勾选资料；首次发送才建立可恢复会话。
「创作会话」列表可返回尚未建立作品的讨论。Agent 按条件检索角色／世界观，再读取所需的固定母版版本。
已有故事打开后进入创作会话，用户可主动新建或选择会话；已建立的零章作品也能换会话继续首章。
可以说「先写一章给我看看」，也可明确要求「写一章并保存」。会话文字与正文草稿分开：右侧「独立草稿」打开单独阅读页，
「选择此版本」会把精确草稿带回输入框，发送保存要求后才执行授权解释，不自动重生成或保存。

可以先确认设定、快照和大纲建立作品，再写首章；也可以确认首章时一并建立。初始化草稿的阅读页展示作品、
关联资料全文、母版来源、资料新增／更新范围与可选首章。选择某版本再发送保存要求，默认一并确认该版本相关资料。

后端收据分别显示「作品已建立」「首章已保存」或「章节已保存」；仅建作品时可打开零章作品，含章成果可打开正式章节。
保存后留在原会话继续创作；模型失败或取消不抹掉已保存的成果；
保存结果待核实时使用「核实保存结果」，停止尚未确认时使用「重试停止」。新消息会撤回上一轮未来写入授权并请求停止。
查看本轮来源会核对资料版本，资料已变更或删除时不将新版当作原引用。

刷新会话或草稿页只查询原任务和成果，不自动再调用模型。首次发送与后续消息在 sessionStorage 保留待核实请求；
响应未知后的刷新只按原 request ID 查询，显式重试使用原输入和原键。明确被服务器拒绝的输入仍可修改后重新发送。
「阅读章节」「查看故事资料」继续访问既有阅读页，阅读页可返回创作会话。创作与意图解释分别显示实际用量，缺失统计为未知。
第一切片已通过本地跨 Repo 故障验收，并于 2026-09-08 发布云端工具身份、配置及创作工作区。

### 新故事流程本地验收（2026-09-08）

MWT-019 本地候选通过 193 项测试、30 项浏览器 E2E 和真实 HTTP/Pi 集成；合成资料的实际
`deepseek-v4-flash` 验收通过先建零章作品、同会话保存首章、未建作品预览后精确保存，以及直接建立并保存首章。
正式内容与冻结候选一致，母版保持不变，刷新查询不增加模型调用。该轮 29 次模型调用费用保守上界
USD 0.10470592；连同此前验收及本次全部失败重试，累计上界 USD 0.68676828，仍按累计 USD 10 预算计算。
验收暴露并修正了独立意图解释的 thinking 耗尽、首章工具选择和资料 revision 提示问题；失败未计作通过。
这是本地真实模型与隔离存储证据；新版生产浏览器验收范围见下节。

### 新故事流程云端部署（2026-09-08）

源码 `494cba31567db49f1ab3ea4bec2933c2a73c968c` 经
[检查、构建与部署 34206133631](https://github.com/Sappanwood/mochi-write/actions/runs/34206133631) 成功上线，
revision 为 `mochi-write--0000006`，镜像 digest 为
`sha256:fd8a9cd5d75217065f8949fb753eae2c58c73106edda58db88b078cc9c06e86e`。
[访问应用](https://mochi-write.whitemeadow-6e32159b.eastus.azurecontainerapps.io/) 沿用本人 Entra 登录。

配套 Mochi `db05247` 已发布，配置 revision 为 `mochi-agent--0000008`；CCP `720a00a` 的更新仅增加
四个工具登记和五条 library metadata 索引。两次独立维护均完成 owner 释放、auth/data 备份及凭据摘要核对。
Write live/ready 与首页均为 200，匿名故事请求为 401；实际 Write Managed Identity 读取 library metadata 返回 200，
新增索引存在且转换进度为 100%。最终完整真实生产 Terraform plan 无配置或镜像漂移。

本人登录后的正式浏览器已从书架实际点击「新建故事」，使用 Agent 编写并经 UI 提交的合成消息，完成自然检索两份
合成母版、复制完整快照、先建立零章作品，再在同一 Mochi session 保存首章并更新一项设定。
生产 MI 工具回调成功，冻结候选与正式正文/资料及收据 hash 一致，母版和未修改资料保持不变。
实际打开章节并刷新后内容一致、没有重放任务；返回原会话后成功续写独立草稿并打开阅读，正式章节数保持一章。
升级前的三工具合成云会话也在原 session 完成取材和草稿续写，原有两章不变。

上述四轮 `deepseek-v4-flash` 生产验收费用保守上界 USD 0.0694342；连同此前全部失败重试累计
USD 0.75620248，低于累计 USD 10 预算。先预览/重写后精确建立及直接建立保存仍以 MWT-019 本地真实模型
候选验收为证据，不声称这些分支全部经过生产浏览器验证。首次模型目录冷读取超时经重新进入页面恢复，未产生模型调用。

### 第一切片云端发布（2026-09-08）

[云端入口](https://mochi-write.whitemeadow-6e32159b.eastus.azurecontainerapps.io/) 使用既有本人 Entra 登录。
Write 发布代码为 `53a2973bf925c4649536f0954d4ac7d641401113`，
[构建与部署 34184281613](https://github.com/Sappanwood/mochi-write/actions/runs/34184281613) 成功；
镜像 digest 为 `sha256:492df20008778aceb48c38d4d1df85c00f6c8ad961681dca13cd06b85dcbd1bb`，revision 为 `mochi-write--0000005`。
配套 Mochi 为 `ec98d45549816ce0df8f3df6382587d96e9a1c11`、revision `mochi-agent--0000006`；
CCP 部署了仅授予 Mochi runtime Managed Identity 的 `Write.Tools.Invoke` 和三个固定工具配置，最终 Terraform plan 无变更。

独立合成故事通过真实 `deepseek-v4-flash` 完成三轮：自主读取设定与角色后只产草稿、将选中版本原样保存、重新取材写另一章并直接保存。
草稿轮没有新增章节，随后章节数分别为 1 和 2；正式正文与对应草稿完全一致，收据 hash 匹配，刷新后章节和会话成果保留。
三轮实际 usage 完整，本轮费用保守上界 USD 0.02845084；加上此前本地 smoke 上界合计 USD 0.09984128，均为估算而非账单。
该验收覆盖正式个人登录、Cosmos 持久化、Managed Identity 工具回调和正常创作路径；数据库恢复及云端进程故障验收仍单独跟踪。

### 保留的无工具写作侧栏

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
此前由 CCP 发布的版本基于代码 `0896327`，镜像 digest 为
`sha256:9fbf82c9e9bbf970c8e3d38b336ac4a13ace260a94b3d049a54bc4e7f5d7f1fe`。
该版本已通过 110 项测试、15 项 E2E 和独立 review；部署后全局 18 故事及选定故事 14 对象的分区范围检查通过，CCP 检查无 drift。
云端导出内容与元数据语义已核验，ZIP 落盘完整性与收费数据库恢复验收仍需完成。

## GitHub Actions 日常发布

main 的应用相关变更通过质量检查后自动构建、推送并发布 ACA。PR 执行质量检查，不请求 Azure OIDC。纯文档 push 不触发构建或部署。

`.github/workflows/ci.yml` 使用 Node.js 24.14.1、Dockerfile 和 linux/amd64，完成现有质量门禁后，
通过本 Repo main 的 OIDC 身份推送 `mochia4c005ba3f.azurecr.io/mochi-write`。Actions Summary 和 `image`
artifact 的 `image.json` 保存 commit、build run ID 和不可变 digest；镜像使用 commit tag，实际发布按 digest。

重新部署：在 Actions → **Deploy verified build** → **Run workflow** 选择 main，填写本 Repo 某次成功
**CI and image** 的 run ID。入口验证来源为本 Repo main push、workflow 与 commit 相符，再读取其 image artifact。
回到旧版本时，从上一次成功部署 Summary 找到 build run ID，使用同一入口；不会重新构建或修改 Terraform。
构建记录和成功部署记录保留 90 天，过期 artifact 不能通过此入口部署，需重新构建。部署失败保留失败日志，不自动回滚。

两个发布入口共用 Repo 内 `production-deploy` concurrency group，不取消正在运行的发布；GitHub 只保留一个 pending job，
更多排队请求可能替换此前 pending，且不保证排队次序。每次发布后核对 Summary 的 commit/digest/revision。
发布后检查 ACA ready revision、`/health/live`、`/health/ready`、Web 页面和匿名 `/api/stories` 返回 401。

CCP/Terraform 管理 ACA、身份权限、环境变量、挂载及缩放等非镜像配置；本 Repo 的 workflow 只传入目标容器和 image。
Terraform 精确忽略 `template[0].container[0].image`，避免基础设施更新回退已发布版本；基础设施操作期间由本人协调暂停应用发布。
Azure RBAC 的 Container App write 无法限制为单独 image 字段，image-only 是受信任 main workflow 的代码约束。

仓库使用已有 Variables：`AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID`、`ACR_NAME`。
不配置 GitHub environment（会改变现有 main OIDC subject），不使用 Azure client secret、跨仓库 PAT 或 GitHub App。
本地发布脚本行为检查：`python3 -m unittest discover -s scripts -p 'test_*.py'`。

2026-09-07 首次真实发布已通过：[CI / 构建 / 部署运行 34121369312](https://github.com/Sappanwood/mochi-write/actions/runs/34121369312)。
提交 `746c3c56fbd8f69b854a88f51e222144e5734979`，发布镜像 `mochia4c005ba3f.azurecr.io/mochi-write@sha256:53bd6dc2535f1429d196e7f08de2bb907ca4c019dbf806e4f91fe507f3aba120`，revision `mochi-write--0000003`。
GitHub runner 完成 OIDC 推送与 ACA 更新，健康、页面和匿名拒绝检查通过；手动入口的 run 来源解析也已对该成功构建验证。
此证据不包含 Mochi 的业务可用性或真实模型调用。

### 发布验收与结束条件

发布前按实际变更确定下表的验收范围；多类变更取受影响检查的并集，重复链路只执行一次。
既有本地与 CI 质量门禁、任务明确约定的验收继续执行；本表约束发布后的追加检查。
纯文档变更完成文档检查即可，不触发发布。

| 变更类型 | 发布后验收范围 |
|---|---|
| 文案、样式、普通 UI | 现有自动部署检查；视觉或交互需要确认时查看受影响页面，不追加真实模型调用 |
| 普通业务逻辑 | 自动部署检查，加一条受影响的主要用户路径 |
| 模型、工具调用、跨应用协议 | 自动部署检查，加一条覆盖本次改动的真实模型链路；可同时作为主要用户路径验收 |
| 身份、存储、恢复、基础设施 | 自动部署检查，加针对本次变更的专项验收；覆盖相关失败行为和关键边界，不展开无关故障演练 |

真实模型验收沿用已授权范围和预算，使用合成素材；缺少所需授权或环境时明确记录待验收，
不能将部署成功写成业务验收通过。已通过的旧功能、模型分支和恢复证据，仅在相关实现、依赖、
运行条件变化或出现新失败时补测受影响部分。历史上尚未验收的事项保持原状态；除本次变更涉及
或任务明确要求外，不加入本轮发布门禁。

目标版本部署成功、所选验收及任务约定全部通过、受影响的长期文档已同步，即完成本次发布。
达到条件后直接收尾，不追加全量生产浏览器巡检、模型分支遍历或恢复演练。所需检查失败或未执行时，
分别报告部署和验收状态；部分交付须有用户对具体范围的明确接受，不能自行降低结束条件。

### 发布收尾记录

普通发布使用以下四项简报，附 Actions 或已有任务的证据链接：

- 版本：commit 和部署运行链接。
- 部署结果：成功、失败或未执行。
- 验收结果：本次检查范围、结果和证据链接。
- 已知问题：影响、待验收项；没有则写无。

commit、digest、build run ID 和 revision 复用现有 Actions Summary 与 artifact；完整命令输出留在
Actions 日志，Actions 外执行的验收引用已有任务或 execution 的证据，无记录时在本次对话说明实际结果。
单项发布沿用已有任务，不额外创建 Plan 或 Report；已有 execution 的验证、验收和多阶段交付结案仍遵循 ProjectOps 契约。
长期文档仅更新系统当前行为、状态和操作契约，不逐次复制发布日志、费用明细或测试过程；既有历史证据保留。
用户对具体发布和验收的授权覆盖其必要子步骤，不逐步重复确认；超出原授权的操作再单独确认。


自由会话已支持结合近期对话承接选项和省略，讨论及草稿反馈不再受逐字意图证据拦截；分类异常继续无正式写权限的对话，只有正式保存要求严格授权。该调整已通过 [Actions 发布](https://github.com/Sappanwood/mochi-write/actions/runs/34734685054)，目标 revision 与自动健康检查通过。真实 DeepSeek V4 Flash 已完成两轮合成对话验收：给出故事走向选项后，直接承接“第二个，但让冲突更激烈一点。”，未要求意图澄清、未获得保存授权或产生保存收据；刷新后对话历史正常保留。实现边界见 [自由会话服务](docs/FREE_SESSION.md#独立核验与运行)。

自由会话 v2 后端已增量接通，当前范围与接口见 [自由会话服务](docs/FREE_SESSION.md)。旧链接可继续访问；候选组、轻量发现、显式引用与角色 draft 已可通过新 API 使用；角色正式保存与同 session 故事初始化/首章/续章、反向独立母版已接通；`#free/new` 与 `#free/conversation/:id` 已提供双关注点界面、@ 精确引用与公开原任务核实；默认首页和主导航已切换到自由会话，v2 已通过 [Actions 发布](https://github.com/Sappanwood/mochi-write/actions/runs/34492485165) 上线。真实 HTTP/Pi 假 provider 集成与正式 UI 确定性测试覆盖无预选自然检索、精确旧稿和角色/故事双向衔接；本地 v2 已用现有 openai-codex 订阅的 gpt-5.6-luna 完成合成角色交错改稿、精确旧稿保存、同 session 故事双向衔接与原句自然检索更新验收；续章经过明确版本纠错后保存，不能视为无人介入首轮成功。线上已用现有订阅的 gpt-5.6-luna 验证同 session 角色→故事→独立母版、精确保存、原 OP 核实与刷新恢复；故事候选首次漏角色快照，经一次明确补全后保存，不能视为首轮完整成功。

本地世界观增量已通过真实 `deepseek-v4-flash` API 的同 session 预览、反馈、精确旧稿保存、自然检索更新以及世界观→角色→故事首章流程。官方目前将该旧 ID 映射到 V4.1-Flash；先前失败与必要表述纠正保留在交付证据，不宣称始终首轮成功。世界观及资料增量现已一并部署；线上世界观候选的精确保存与正式全文读取已验证。

可选真实合成验收脚本为 `tests/integration/world-smoke.mjs`，不在默认集成门禁中自动调用。
执行前明确账户和费用授权；设置 `MOCHI_REAL_SMOKE=deepseek-v4-flash`、绝对路径
`MOCHI_REPO_ROOT`、`MOCHI_SMOKE_AUTH_FILE` 与新的 `MOCHI_SMOKE_REPORT`，然后运行
`node --import tsx tests/integration/world-smoke.mjs`。脚本使用独立内存业务数据、临时 HTTP/Pi
服务，记录所有任务、实际用量、候选和收据；每轮仍受应用执行预算限制。分类拒绝时最多两次
显式重提会写入报告，不代表生产服务自动重试，也不会重放成功保存。报告不包含凭据。

## 已开篇故事资料修订

新自由会话已支持角色快照、设定和大纲的完整资料候选与整包保存；信息区显示每项模式、来源和基础版本，可选择旧稿保存并从收据往返正式资料。旧 conversation 保留原能力，通过提示主动新建。保存后的下一轮可读取新资料续章。云端已按兼容 Mochi runtime → CCP 19 条配置 → Write 的顺序完成发布。

本地资料增量通过 Write 335 项单测、55 项浏览器测试与跨 Repo HTTP/Pi 集成，Mochi 131 项测试及 CCP 44 项 Python/31 项 Terraform mock 检查。合成资料的真实 deepseek-v4-flash 路径已验收完整五成员包、精确旧稿保存和读取新设定续章；包含失败重提与提示修正，详细证据由对应 ProjectOps execution/Report 保存。不得将其解释为首次无人纠正或云端验收。

线上合成 `deepseek-v4-flash` 链路已验证同 session 世界观精确保存、母版与未保存角色完整复制入五成员资料包、同组反馈后保存第一稿、正式资料 v2 读取与续章，以及收据往返和刷新恢复。两次意图分类拒绝经明确重述继续，一次执行状态未知经原 run 查询恢复；没有放宽校验或重放成功保存，不代表首次无人纠正成功。生产证据保留于本次发布记录；基础设施按实际两镜像复查无漂移。
