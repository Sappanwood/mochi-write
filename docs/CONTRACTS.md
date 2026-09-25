# Mochi Write 首期实现契约

## 状态与适用范围

2026-09-07 按用户确认完成设计基线。本文规定 MWT-002 至 MWT-004 的实现边界。
MWT-002 已实现工程、个人认证、资产编辑、故事阅读、独立快照和导入导出；MWT-003 已实现写作侧栏、Mochi v1 接入、草稿与原子采纳。
本地验收使用隔离存储和签名测试身份；MWT-004 已完成 Azure Container Apps 发布、本人 Entra 登录及 `/api/stories` HTTP 200 验证。
首批 18 故事、374 对象已导入云端；同批次重试 created 0、skipped 374，全局 18 故事分页无重复。
定故事查询范围修复 `0896327` 已发布并通过云端分区范围核对，CCP 检查无 drift。
云端导出的 374 份 Markdown hash、全部 manifest attributes/fields、唯一路径与 ID 均匹配期望；
独立人工测试故事已通过 2 次真实 `deepseek-v4-flash` 任务验证：章节 v1 采纳并刷新一致；queued 时页面断开，重开后原 run 成功且未重新提交。
真实跨应用隔离、服务进程中断恢复、收费数据库恢复及 ZIP 落盘完整性尚未验收，主入口尚未切换。
MWT-002 使用临时 loopback 端口完成本地验收；MWT-005 已由 ProjectOps 登记长期开发 endpoint，
该本地 endpoint 仅完成登记和只读验收、尚未启动；启动须独立准备运行配置与可用 Managed Identity。
用户确认的生态标准为 React + TypeScript + Vite、Node.js 24 + TypeScript + Fastify、npm、同仓库同容器，
以及个人 Entra ID + MSAL。现有项目在相关改造时逐步对齐；本条不授权重写其他项目或发布共享包。

## 工程与质量

单 package，src/web、src/server、src/shared 分开；web/sidebar 保持宿主适配边界。
共享模块方向为侧栏、上下文协议、Mochi 客户端、认证接入和基础 UI；第二个真实消费者接入时再提取包。
共享的是接入机制，各应用的 audience、权限判断和业务操作独立。后端同时提供静态资源和 /api 路由。
使用普通 CSS 和少量共享组件。首个代码任务固定实际稳定依赖版本及 lockfile，不在设计文档猜测版本号。

当前质量入口已建立，实际版本以 package.json 与 lockfile 为准。src/server/auth.ts 验证签名与个人访问声明，
config.ts 校验启动配置，app.ts 统一保护已注册的 /api 业务路由；匿名端点限于登录配置和健康检查。
src/web/auth.ts 使用 MSAL sessionStorage 缓存，登录后以受保护的 /api/session 确认后端授权。
MSAL v5 popup/silent 响应经同源 /redirect.html 独立 bridge 传回主窗口；Vite 将其作为单独入口构建。
Entra SPA registration 的 redirect URI 须精确为 APP_ORIGIN/redirect.html；代理不得为该页设置 COOP。
运行配置与当前可验证范围见 [README](../README.md#开发与验证)。

MWT-002 建立 npm run check（格式/lint、TypeScript、行为测试、构建）和 npm run test:e2e（Playwright）。
使用 Vitest 验证业务逻辑与 API；外部模型 mock 不替代 MWT-003 的真实服务联调。
中高风险行为先确认失败用例，再实现；重点为本人认证拒绝、导入引用、快照隔离、版本冲突、重复采纳与导航中任务目标固定。
Markdown 渲染禁用原始 HTML，链接按允许协议处理；日志不记录正文、提示词、token 和 provider 原始异常。

本地服务已登记于 workspace `.pops/workspace.json` 的 `projects.mochi-write.dev`，由 ProjectOps 独立 manager 管理。
单 `web` endpoint 为 `127.0.0.1:12600`，同一进程提供 Web/API；Repo cwd `.` 执行 `npm run dev`，
通过 `HOST` 和 `PORT=${WEB_PORT}`、`APP_ORIGIN=${WEB_ORIGIN}` 固定监听地址与同源地址。端口冲突时失败，不自动换端口。
本次登记已核对 Workspace Control 保留端口；不创建其 descriptor 或 artifact store，不迁移其他服务。
先构建前端并准备真实 Entra/Cosmos 环境与 Managed Identity，才可显式启动。配置、命令与环境继承说明见 README。
登记和端口检查不证明服务运行或云端连接成功；隔离测试继续使用临时端口。

## 个人认证与应用认证

浏览器使用 MSAL Browser 授权码 + PKCE，单租户、精确 redirect URI、独立 SPA/API registration。
API delegated scope 定义为 Write.Access；后端使用成熟 JWT 库验证签名、允许算法、issuer、audience、有效期、
tenant、调用 SPA client ID、scope 与本人 oid。拒绝 app-only 用户访问、错误账号和伪造身份 header，不按 email 授权。
浏览器只拿本应用访问 token，不获得 Cosmos 或 Mochi 凭据。token 使用 MSAL 支持的缓存机制，不自行复制到业务存储。
只有登录壳、固定静态资源、非敏感登录配置与健康检查可匿名；所有业务 API 从启动起拒绝未认证请求。
API 使用显式 Bearer，写请求要求同源 Origin 和 JSON，不提供跨域 CORS 或自建密码系统。

后端使用独立 Managed Identity 访问 Cosmos，并获取 Mochi 的 Entra app-only token；不转发用户 token 充当应用身份。
Cosmos 授权限定应用数据范围，Mochi 登记 app_id=mochi-write 及 client/principal ID 对，角色沿用 Mochi.Invoke。
CCP 管理 registration、角色及部署配置；客户端可公开配置只含 tenant、SPA client ID、API scope。
个人认证与 Mochi provider 管理独立，不因侧栏接入自动授予 provider 管理权限。

## Cosmos DB 布局与版本

使用 NoSQL、单区域、Free Tier、手动共享吞吐；一个应用数据库 mochi-write，两个 container 共用数据库吞吐。
初始请求 400 RU/s；CCP 核对账户现有分配后确保账户合计不超过可用免费额度，不假定本应用独享 1,000 RU/s。
免费名额被占用时先检查既有账户可否承载，不能自动创建付费替代。免费 25 GB 包含账户已有用量与索引开销。

| Container | 分区路径 | 内容 |
|---|---|---|
| library | /scopeId，固定 library | 全局角色、世界观、词表、资产版本、资产库会话关联 |
| stories | /projectId，故事 UUID | 故事、角色/世界观快照、章节、版本、草稿、故事会话关联及导入状态 |

projectId 是小说作品 ID。故事列表可做跨分区分页读取；单故事操作明确传 projectId。
用户输入、文档 ID 和来源路径不直接充当数据库访问授权。
默认 Session consistency；保存后返回服务端确认的当前版本，不能以 UI 乐观更新宣称持久化成功。
只索引查询字段（kind、标题/名称、标签、状态、顺序、更新时间、关联 ID），正文、原始导入字段与长上下文不纳入普通索引。
首期名称/标签筛选及分页为主要检索；正文关键词仅对已选范围有界扫描，不引入向量库或全文检索服务。

公共字段：schemaVersion=1、id、kind、分区字段、createdAt、updatedAt；时间为 UTC ISO 8601。
业务对象使用服务器生成 UUID，名称可改且不承担 identity；持久文档 id 可由 kind、对象 UUID、版本号确定性组合。
可编辑对象有 currentVersion 正整数与 Cosmos _etag；不可变内容版本有 entityId、version、content 和来源说明。
API 的 revision 是不透明并发标记；客户端保存必须带读取时 revision，冲突返回 409 并保留未保存内容。
版本创建与 head 更新在同分区事务中完成，禁止覆盖历史版本；恢复旧内容创建新版本。
每章独立对象，章节顺序为正整数且允许间隔及并列；展示按 order、id 排序，首期无拖拽重排契约。
新章节默认顺序为当前最大值加一；用户仍可显式设置正整数。带 manifest 的回导保留稳定 ID 并允许相同顺序，旧 novel 无清单导入仍拒绝重复顺序歧义。

故事快照存完整内容，初始化版本不可变，当前版本独立演变；sourceAssetId/sourceVersion 仅溯源。
新建故事先捕获各资产版本，再写 building 状态、快照和设定，引用齐全后切为 ready；只展示 ready 故事。
初始化不是跨分区事务，失败保留可重试进度；同一次请求使用稳定初始化 ID，不复制重复故事。
母版删除不级联删除故事。首期没有母版自动合并能力。

草稿保存目标章节/预分配章节 ID、baseRevision（新章为 null）、请求 ID、Mochi run ID、Markdown 输出和状态。
成功且完整的输出才可采纳；失败、取消或截断的部分输出仅供查看，不当作完整章节。
采纳在同故事分区事务中创建版本、更新章节 head、标记草稿 accepted 与结果版本；重复采纳返回既有结果。
不同草稿竞争同一基础版本时只允许一个成功；新章节用预分配 ID 的 create-only 保护，不以 upsert 覆盖。

## 导入导出 v1

保留 novel 原布局语义：library 下角色/世界观/词表，projects 下故事、大纲、设定、快照和 story 章节。
导出包根带 manifest.json：schema=mochi-write/export@1、exportedAt、entries。
每个 entry 含 path、kind、entityId、projectId（全局资产为 null）、version、sha256；路径为包内相对路径。
文档为 UTF-8 Markdown + YAML frontmatter；未知字段保存在 content.sourceMetadata，原始名称、路径及内容可溯源。
当前版本导出不含 provider 凭据或执行聊天历史，不声称导出了业务所有历史版本；Cosmos 备份承担数据库恢复。
有 manifest 的导入保留 ID；无 manifest 的旧 novel 导入为每个源条目创建 ID，并保存 sourcePath/hash 到导入清单。
同一导入批次重试按清单去重；发现已有对象且内容不同时报冲突，不静默覆盖或合并。

旧快照以母版基础内容加故事增量组成独立故事资料，保留两部分，不调用模型重写合并；无法解释的冲突列入预检诊断。
预检核对字符编码、frontmatter、重复 ID/路径、引用和章节顺序；未解析引用不得被当作成功导入。
源文件只读；导出不覆盖已有目标。可信本地 Linux/容器目录边界下拒绝路径逃逸和静态 symlink，
不承诺恶意同用户 ancestor 替换，无 native helper。限制单文档与批次大小，超限拒绝而非截断；当前限制：普通 Markdown 单文件 1 MiB、根 manifest.json 单文件 16 MiB、整个包累计 16 MiB、最多 1000 个文件，Markdown 正文最多 262144 字符。
含溯源的完整持久化对象最多 768 KiB，为同分区版本 + head 事务保留余量；合成快照超限同样拒绝。
HTTP 导入 JSON 传输额外限制 32 MiB，导出包含 manifest 在内也须满足包限制。
清单包含全部对象属性和原始溯源，故不使用普通 Markdown 的单篇上限；前端目录选择、CLI 限长读取与服务端预检共用同一大小规则，超限拒绝，不删除溯源或截断。

## 侧栏宿主协议 v1

PageContext：schemaVersion=1、scope:{type,id}、location:{type,id,revision}|null、selection:{text}|null。
首期 scope.type 为 story 或 library，location.type 为应用定义值；通用组件只展示宿主提供的名称，不解析小说字段。
历史对象引用只包含 ID/版本；正文由后端校验归属后读取。选区为用户输入，不能授权读取其他对象。
发送请求包含 conversationId、clientRequestId、message、pageContext 与显式 attachedRefs。
发送时冻结目标与输入版本；版本已变化时返回冲突供用户重发，不静默替换上下文。路由改变只影响下一次发送。
宿主接口负责 getContext、resolveContext、list/openConversation、submit/cancel、subscribe/resume 和 renderResultActions。
这是应用内接口边界，不伪装为已发布的 Mochi HTTP schema；Mochi 适配器转换它与双方联调后的 wire protocol。

默认按 scope 恢复最近会话，保留多会话列表并允许主动新建；章节导航不重开会话。
Mochi 持有消息历史与执行状态，应用仅保存 scope/session 映射、请求快照、草稿和采纳结果。
稳定前缀不重写，页面内容追加到本轮；同会话串行，上一任务结束前禁止第二次生成。
提交幂等键为应用范围内 clientRequestId；同键不同内容拒绝，未知提交结果先查询，不生成新键自动重试。
需要事件游标、终态结果获取与取消；重连按游标去重，终态结果可在没有完整流事件时重新获取。
页面关闭不取消任务，取消不删除历史；未知中断明确展示，不自动重放有副作用操作。
上下文预算不足时阻止提交并提示新建会话/减少资料，不自动摘要或自动调用模型。
缓存统计有则显示、无则未知，不以连续 session 保证命中，不根据未知定价估算费用。

## 接入交付与未满足条件

| 后续任务 | 必须落实的条件 |
|---|---|
| MWT-002 | 固定依赖/可执行 schema，质量入口，资产与阅读实现；用户确认以临时端口本地验收，长期登记已由 MWT-005 完成，尚未启动 |
| MWT-003 + mochi/MOC-001 | 固定会话/任务 HTTP 与事件 schema，验证上述幂等/恢复/隔离要求，接通真实无工具 API |
| MWT-004 + mochi/MOC-004 | 联合部署与真实写作验收；不能以管理页上线代替 Agent API 可用 |
| MWT-004 + ccp/CCP-004 | 已落实数据库、身份、镜像、Continuous 7-day 和发布；首批导入、幂等、导出修复发布及导出内容语义已验证；ZIP 落盘完整性及恢复演练仍待完成 |

业务会话/任务已与 Mochi 进行本地真实 HTTP 联调；使用签名测试身份、隔离持久存储及假 provider。
云端已验证本人认证与 Cosmos 读取，发布后 CCP 资源检查无 drift；另已验证独立人工测试故事的真实模型生成、采纳与页面断开恢复；跨应用身份隔离、服务进程中断及收费数据库恢复仍待验收。实时任务状态以 ProjectOps 为准。
容器契约：linux/amd64、非 root、PORT=8080、0.0.0.0 监听；/health/live 查进程，/health/ready 查应用必需配置与 Cosmos 可用性。
Mochi 暂不可用不使资产阅读服务整体 unready；写作入口明确显示不可用。探针不调用付费模型。
应用 Actions 管理镜像 digest，CCP 管理账户/身份和非镜像配置；应用不执行 Terraform apply；实际公网地址与 Entra redirect 在部署时成对配置。
最低恢复采用平台 Continuous 7-day，恢复调用收费；保留源资料和手动导出，恢复前查询可恢复时间，
恢复后核对对象数量/引用/版本及权限再切换应用。无零丢失、固定 RTO 或跨账户灾备承诺。

## 官方依据

- [Cosmos 事务边界](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch)
- [Free Tier](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier)
- [连续备份](https://learn.microsoft.com/en-us/azure/cosmos-db/continuous-backup-restore-introduction)
- [Entra 授权码与 PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Entra token 声明与 app-only roles](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)

## 已实现的故事资产工具边界（MWT-010）

2026-09-08 已实现本地 `search_assets` / `read_asset` 及 `/api/agent/tools` 注册模块，遵循 Mochi 接受的应用工具 wire v1。
MWT-011 在 `main` 注册可信持久任务绑定、草稿与授权写章；详见 [故事创作会话契约](CREATIVE_WORKSPACE.md)。
本地切片已通过隔离集成和真实模型 smoke；2026-09-08 已完成生产 Managed Identity 与云端工具部署验收。
正式身份链下独立合成故事通过自主读取资产、独立草稿、精确保存和直接生成并保存；正文与草稿及收据 hash 一致，发布版本与边界见 README。

callback 通过 `MOCHI_TOOLS_CLIENT_ID` / `MOCHI_TOOLS_PRINCIPAL_ID` 成对配置 Mochi 调用身份，
使用现有 Write API audience、tenant 的 v2 RS256 JWT，核对 azp/oid、有效期及 Write.Tools.Invoke 角色，拒绝任何 scp。
普通业务路由仍要求本人 delegated Bearer，写入要求同源 Origin；个人 token 不可调用工具，callback token 不可编辑普通资产。
callback POST 仅接收 JSON，实际请求体最多 128 KiB，序列化响应最多 64 KiB；超限拒绝而不截断。

`registerAgentTools` 必须注入可信 `resolveTask(taskId)`；它返回持久 task/session/story/sourceMessage/operation/authorization
绑定及 `bindRun(runId)`，入口逐项比对 scope，随后等待首次 run 原子绑定（异 run 拒绝）。body 的 app_id 只核对固定
mochi-write 身份，不承担认证。未知工具、未知字段或版本拒绝；create_chapter 按故事创作会话契约执行。
无配置的认证边界 fail closed，生产 resolver 只返回持久且匹配的任务。

search 参数为 `{query,kind?,limit?,cursor?}`：query 最多 256 Unicode 字符，空字符串浏览；kind 为 setting/outline/snapshot/chapter；
limit 默认 10、范围 1–20。仅扫描故事当前非删除对象的标题与正文，大小写不敏感子串查询；排除全局母版和其他故事。
每次扫描最多 1000 份资料、8 MiB 标题/正文 UTF-8 总量和 50 个存储页，超限 result_too_large；不向模型传全库正文。
结果按 kind、ID 升序，固定 `{items:[{asset_id,kind,title,summary,revision}],next_cursor}`；summary 最多 512 字符，
正文命中时包含命中附近片段。空结果为 `items:[]/next_cursor:null`，发现记录不声称已读取全文。
cursor 为 HMAC 保护的进程内令牌，绑定故事、原始 query、kind、limit、offset 和全部可检索对象 ID/kind/revision 摘要；
最长 4096 字节，参数变化/篡改/进程重启返回 invalid_cursor；故事资料变化返回 revision_conflict，须重新从第一页查询。
扫描使用 Cosmos Session consistency，不承诺跨多页事务快照或任意并发修改下的可串行化读取。

read 参数固定 `{asset_id,revision}`，均为 1–128 UTF-8 字节。返回 `{asset_id,kind,title,revision,content}`，正文保持精确文本。
不存在/删除返回 not_found，当前版本变化返回 revision_conflict，跨故事/母版返回 forbidden_scope。
跨范围识别仅查询 ID 对应 projectId 元数据（每 container 最多 2 条），不读取其他故事正文。
结果先检查 JSON 大小（预留 envelope 空间），成功前等待 `recordSource({asset_id,kind,title,revision})` 持久化；
来源失败不能返回成功。readDraft 仅访问当前 task/session 授权草稿，已接入持久化和创作 UI。
材料仅是创作资料，不能创建权限或取代 system 指令；系统提示与来源 UI 在工具会话接入时落实。

合法 callback 的业务拒绝返回 HTTP 200 与固定 `{protocol_version:1,invocation_id,outcome:"error",error:{code,retryable:false}}`；
成功返回同基础字段、`outcome:"ok"/data`。认证、JSON、wire schema、存储故障为 HTTP 失败，不透传凭据或数据库原文。

## 已实现的 v1 数据与 API

`content` 为 `{name, markdown, genres, ageBand, sourceMetadata}`；后者保存 JSON 兼容的完整 frontmatter。
编辑更新规范化字段及对应 frontmatter 名称/受控字段，保留其他原始字段；导入来源保存在
`source:{path, hash, raw, base?, delta?}`。base/delta 为导入时母版与原始增量，不依赖后续母版可用性。
增量快照按“母版（导入时）+ 本故事增量（优先）”原文分段组合，不以模型重写；重复增量源、缺失引用与无法识别路径拒绝。
world/name 两种世界观名称字段均接受；章节默认从 chNN.md 取正整数顺序，也支持 frontmatter 的 order。
旧库 `_vocabulary.md` 的 genres/age_band 表格形成单一词表；未导入时沿用初始受控值。

当前对象 head 带 `recordType=head`，ID 为业务 UUID。版本文档使用 `version:<entityId>:<version>`，
`kind=version`、entityId、version、content 保存该版本完整对象，使用 Create-only。
Cosmos 事务以 head 的 IfMatch etag 保护更新；409/412 映射为 API 409，其他存储失败返回 503。
删除资产产生带 deleted 的新版本，不级联。building → ready 是初始化发布元数据变更，仅条件更新 head，不改内容版本。
旧导入以批次标识和源路径确定 UUID，library 内 `kind=import` 文档冻结批次输入摘要；改动输入时拒绝复用旧批次。
有 manifest 的重导入以原 ID、版本和内容核对，不需要同一批次标识。不同批次的旧素材可以产生不同 ID，不承诺跨批次内容去重。

导出使用 `library/<kind>/<UUID>.md`、`projects/<story UUID>/<kind>/<UUID>.md`，不以可改名称作 identity。
清单 entry 在基本字段之外包含 attributes（对象属性与溯源）及 fields（规范化名称、题材、年龄层），使 ID、版本、
未知字段和完整快照可精确恢复。导出是当前内容快照，不含已删除母版；故事快照的 sourceAssetId 允许只作为历史溯源。
受信任 Linux 目录导出以 mkdir 占位目标，再逐项 wx 写入，manifest 最后生成；失败保留部分目录，不提供整目录原子发布承诺。
Web 目录选择仅上传相对路径与文本，不向后端授予本地路径访问；静态 symlink 检查由文件系统 CLI 执行。

| API | 当前行为 |
|---|---|
| GET /api/auth-config | 匿名，仅 tenantId、spaClientId、scope |
| GET /api/session、/api/vocabulary | 验证当前本人访问、读取受控词表 |
| GET /api/library | 必填 kind=character/world；可选 name、genre、ageBand |
| POST /api/library | `{kind,content}`，服务器生成 UUID |
| GET /api/library/:id | 读取未删除资产及 revision |
| PUT /api/library/:id | `{revision,content}`，保存新版本 |
| DELETE /api/library/:id | `{revision}`，创建删除版本 |
| GET /api/stories、/api/stories/:id | 分页故事列表、ready 故事信息 |
| GET /api/stories/:id/documents | kind=setting/outline/snapshot/chapter，限定故事分区 |
| GET /api/stories/:id/documents/:documentId | 校验故事与文档归属后读取 |
| POST /api/stories/:id/snapshots | `{assetId,requestId}`，幂等复制母版当时版本 |
| POST /api/import/preview、/api/import | `{batchId,files:[{path,text}]}`，预检或写入 |
| POST /api/export | 空 JSON 对象，返回 `{files}`，浏览器生成 ZIP |

列表接受 limit（默认 40，最大 100）及不透明 cursor，返回 `{items,cursor?}`。存储分页按 ID，阅读页面收齐选定范围后按 order、ID 排序。
Cosmos SDK 4.10 查询启用 `enableQueryControl`；仅跨分区列表启用 `forceQueryPlan`，以支持复合 continuation。
定故事查询以 SQL 的 `projectId` 条件和逻辑 `partitionKey` 双重限定范围；定分区查询不强制 query plan，
以保留 SDK 的逻辑分区路由与原生 continuation。
初始或中间物理页可能没有 resources 或 cursor；后端在同一 iterator 上继续读取，直到收到数据或
`hasMoreResults()` 为 false。仅后者表示空结果终态；仅迭代器仍有后续结果时交还数据页 cursor，丢弃终态残留 token。
参数和空页语义遵循 [Azure SDK 分页说明](https://learn.microsoft.com/en-us/javascript/api/overview/azure/cosmos-readme?view=azure-node-latest)。
所有业务路由都验证 Bearer；写操作要求 APP_ORIGIN 和 application/json。错误包含安全 message 和可选路径诊断，不记录正文/token。
正文仍无手工编辑器；Agent 会话、生成与采纳路由见下文 MWT-003 已实现契约。

CCP 配置 Cosmos 索引时显式保留 `/recordType/?`、`/kind/?`、`/deleted/?`、`/status/?`、`/content/name/?`、
`/content/genres/[]/?`、`/content/ageBand/?`、`/order/?`、`/updatedAt/?`、`/sourceAssetId/?`、`/conversationId/?`，排除其余路径；
consistent 模式自动索引系统字段 `id` 和 `_ts`，不在策略 included/excluded paths 中显式覆盖 `/id/?` 或 `/_ts/?`；
依据 [Cosmos 索引策略](https://learn.microsoft.com/en-us/cosmos-db/indexing-policies#index-size)。
当前查询不需要多字段 ORDER BY 或 composite index。应用不会创建/改写 container 索引或吞吐配置。

官方接入依据补充：[MSAL v5 redirect bridge](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/redirect-bridge)、
[Cosmos JavaScript SDK](https://learn.microsoft.com/en-us/javascript/api/overview/azure/cosmos-readme?view=azure-node-latest)。


## MWT-003 写作接入 v1（已实现）

`src/web/sidebar/contracts.ts` 定义应用内 HostAdapter，通用核心只消费标签、引用和任务展示数据。
`WritingHost.tsx` 负责路由、小说数据、目标章节表单及采纳按钮；侧栏不解析小说模型或扫描 DOM。
按 scope 切换会话，章节导航不重开；浏览器 sessionStorage 仅保留已选会话 ID，服务端仍校验 scope 归属。
宿主目标表单变化只使发送预览失效，不重置用户已选资料。位置引用总校验版本，但仅显式 attachedRefs 的正文会发送。

发送 schema 在 `src/shared/writing.ts`：除既有 conversationId/clientRequestId/message/pageContext/attachedRefs，
还含 provider、model、target 及可选 feedbackDraftId。target 为 `{id,revision,name,order}`，新章 id/revision 为 null，
资产库 target 为 null。后端为新章预分配 ID；反馈重写保留原草稿 target 与预分配 ID。
选择最多 20 份引用；每轮构造的 UTF-8 prompt 最多 24000 bytes，超限拒绝。后端根据 Mochi 模型目录检查
稳定前缀、Mochi 历史及本轮总 UTF-8 bytes，按一 byte 一 token 保守估计，并保留 `min(4096,max_output_tokens)` 输出预算。
这不是精确 tokenizer 计费值，不自动摘要或调用额外模型。实际输出上限在草稿中固定并发送给 Mochi。

| 应用 API | 行为 |
|---|---|
| GET /api/writing/models | 代理 Mochi 模型目录，不返回 provider 凭据 |
| GET/POST /api/writing/conversations | 按 scope 列出关联 / 创建稳定前缀的会话并保存关联 |
| GET /api/writing/history | 校验 scope/conversationId 后读取 Mochi 历史 |
| POST /api/writing/context | 校验发送 schema、归属、版本与本轮预算，返回固定 prompt 预览 |
| POST /api/writing/submit | 固定输入、登记请求键、保存 pending 草稿、查询/提交同一请求 |
| GET /api/writing/drafts | 列出当前 scope/conversationId 的草稿 |
| GET /api/writing/drafts/:draftId | 恢复查询并保存服务端结果；未知请求只查询，不重新提交 |
| GET /api/writing/drafts/:draftId/events | 按 after 游标读取对应 Mochi 事件页 |
| POST /api/writing/drafts/:draftId/cancel | 显式取消任务，保留历史和可查看片段 |
| POST /api/writing/drafts/:draftId/accept | 原子采纳成功完整输出；重复返回原结果 |

GET 参数统一为 `type=story|library&id=<scope ID>`，资产库 id 固定 library；history/drafts 列表需 conversationId，events 可带 after。
POST conversations 直接提交 scope；submit/context 提交完整发送 schema；cancel/accept 为空 JSON 对象，scope 放 query。
所有端点沿用本人 Bearer、同源 Origin 与 JSON 边界。未配置 Mochi 时明确返回写作不可用，不影响阅读 readiness。

与 Mochi 固定的 wire 使用 snake_case：

| Mochi API | 请求/响应 |
|---|---|
| POST /v1/sessions | `{system_prompt}` → session_id、created_at、system_prompt；前缀创建后不可改 |
| GET /v1/models | models 含 provider、id、name、auth、context_window、max_output_tokens |
| GET /v1/sessions/:id/history | messages 含 role、content、run_id，唯一执行历史来源 |
| POST /v1/sessions/:id/runs | `{idempotency_key,provider,model,prompt,max_output_tokens}` → run |
| GET /v1/runs/by-key?key=... | 应用范围幂等查询；404 才表示该键未登记 |
| GET /v1/runs/:id、POST /v1/runs/:id/cancel | run 状态与终态结果；cancel body 为 `{}` |
| GET /v1/runs/:id/events?after=N | `{events,next_cursor}`，每页最多 100，cursor 从 1 开始 |

run 状态为 queued/running/succeeded/failed/cancelled/interrupted；只有 succeeded 的非空 result.text 是可采纳完整输出。
非成功终态的 partial 从持久 text_delta 事件分页读取，只供查看（最多 262144 字符），不转为成功结果。
前端按游标丢弃重复事件，刷新后可从 0 重读；终态可以直接查询，不依赖收齐所有流事件。
usage 沿用服务的实际 input/output/cache_read/cache_write/total_tokens，无值为 null，不估算价格或保证缓存。
HTTP 错误转换为安全应用错误，409 保留冲突，未知网络/服务故障为 503；不输出 provider 原始异常或正文日志。

写作记录为 schemaVersion=1、recordType=writing，有独立 kind=conversation/draft/request，创建/更新时间为 UTC。
业务 head 查询与 Markdown 导出排除这些记录。全应用 `request:<UUID>` 绑定在 library 分区，固定输入摘要和目标分区；
草稿则保存在 scope 分区，含输入快照、prompt、request ID、session 关联、Mochi run ID、目标/base revision、输出与状态。
不承诺请求键绑定与故事草稿跨分区原子；先绑定再持久 pending，失败后同输入可重试，不静默改键或改输入。

采纳单次同故事 batch：不可变版本 Create、章节 head Create 或 IfMatch Replace、draft IfMatch accepted/resultVersion。
任何缺少 operation result、存储失败或 etag 冲突都不能宣称采纳成功。完整事务 JSON 保守限制为 1900 KiB，超限拒绝。
并发草稿竞争同一基础版本或同一预分配新章 ID 时只允许一个成功；重复采纳读取 accepted 返回既有 ID/版本。
由其他任务造成的确定性 4xx 提交拒绝会标记失败；网络中断保留 pending，可先查状态后显式以原请求重试。

本地验收命令包括 `npm run check`、`npm run test:e2e` 和显式 `MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration`。
最后一项启动双方真实 HTTP 服务与 Pi AgentSession，使用隔离存储、本地 RS256 身份和假 provider，验证持久任务及重启恢复。
不自动发现另一 Repo，不纳入单 Repo 默认门禁，不授权真实云资源、付费模型或私人素材发送。

## 生命周期会话与母版工具扩展（MWT-016）

`/api/creative/conversations` 的首次发送、列表、按 conversation/request ID 恢复及七工具快照详见
[创作会话契约](CREATIVE_WORKSPACE.md#生命周期会话与母版检索mwt-016)。原本人/服务身份、callback v1、128 KiB 请求与 64 KiB 响应上限不变。
未建立会话的预留 storyId 只允许通过持久绑定访问 creative records，不是普通故事存在证明；旧 API 和旧三工具快照保持原行为。

Store 新增 `searchLibrary` 元数据投影和 `getVersion(id,projectId,version)` 精确点读。检索固定 library 分区，
name/genres/ageBand 复用规范 Content 字段；补充 `sourceMetadata.gender/occupation/era` 字符串、`traits/tags` 字符串数组。
缺失或非法类型在对应条件下不匹配，无过滤浏览不排除 legacy 对象。数据库查询只 SELECT 元数据，以参数化 WHERE 过滤并沿用分页诊断。
CCP 索引策略须追加 `/content/sourceMetadata/gender/?`、`/content/sourceMetadata/occupation/?`、
`/content/sourceMetadata/era/?`、`/content/sourceMetadata/traits/[]/?`、`/content/sourceMetadata/tags/[]/?`；不索引完整 sourceMetadata 或正文。
不可变 version 点读校验 entityId/version/分区及 Content hash；只有当前 conversation 已读来源可继续引用历史版本。
MWT-017 已启用 initialize_story，精确包、授权与双分支收据见创作会话契约；七工具云配置须在后续发布前一起验证。


## 精确初始化数据与兼容（MWT-017）

`CreativeReceipt` 是旧 ChapterReceipt 与 InitializationReceipt 的联合；初始化收据携带精确 draft 引用、资料列表及可选首章，
content_hash 等于整个规范包的 draft_hash。初始化 draft 的 `artifactKind` 与包字段、输入／输出／事务字节上限见
[创作会话契约](CREATIVE_WORKSPACE.md#精确初始化包与首章保存mwt-017)。write callback 只保存服务端冻结的完整包，不接收新 ID 或替换正文。

业务 `initializationPending?:true` 仅由初始化事务管理，普通内容导出排除该字段，导入清单显式携带时拒绝；
导入同一零章作品只核实其内容，不清除既有标记，也不允许借导入添加首章。
新导入的独立作品沿用既有故事行为，不作为原 session 恢复。snapshot 无母版来源时是合法原创快照；存在来源则 sourceAssetId/sourceVersion 必须同时给出。
新保存成果仍只以 head/version 进入导出，creative task/draft/conversation 不混入业务内容。

新增行为验收覆盖仅建立、整包首章、精确旧版本、关联资料 CAS、完整来源复制、only 与含章授权隔离、双提交竞争、取消、丢响应、
实际 JSON 预算，以及原创快照／零章作品导入导出。沿用 check、浏览器与显式跨 Repo integration 入口，不调用真实模型作为单 Repo 门禁。


## 新建与会话页面（MWT-018）

浏览器新建、列表、生命周期会话及独立初始化阅读路由见[创作工作区](CREATIVE_WORKSPACE.md#浏览器新建与恢复mwt-018)。
首次与后续消息在发送前保留原 request ID／输入，刷新只读查询；明确拒绝后可编辑，未知结果不自动重发。
无 head 目标只使用有持久绑定的 creative API，descriptor 确认已建立才读取普通作品。
已建立 initializationPending 作品通过既有 POST /stories/:id/creative/conversations 主动创建新 session 时，
返回 lifecycle:true 并使用七工具快照；其他旧故事仍使用原三工具，不新增自动 session 控制。
POST tasks 的 selectedDraft 必须在新任务占位／停止旧任务前通过当前故事／会话归属、版本与 hash 校验，错误返回 409；
同输入同键的有效重复任务仍返回原记录，支持保存后的恢复。
初始化收据的顶层 revision 属于作品；显示正式首章版本读取 chapter.revision。UI 仅以真实收据生成成果，失败不抹掉成果。
浏览器验收覆盖空／普通书架、首条响应丢失恢复、零章建立、固定母版全文、精确旧草稿、同 session 首章资料更新、
主动换 session、明确输入拒绝与 390px 布局；旧章节与侧栏测试继续运行。


## 自由会话协议 v2

`/api/creative/free` 与 v1 路由并存；记录使用 free 命名空间，callback 按 protocol_version 分流，不放宽旧 story scope。十工具快照、独立目标核验、任务预算、本人 API、候选组/不可变版本、统一显式引用解析、有界发现、角色完整 Content 精确保存（OP/版本/head 同分区原子、候选 claim、create-only/IfMatch）、故事初始化/首章/续章及反向独立角色母版（固定来源、目标故事分区 OP/业务 batch、library directory/claim CAS）与来源/OP 恢复详见 [自由会话服务](FREE_SESSION.md)。

## 单故事资料候选

资料包角色来源可为本会话未保存完整候选。snapshot 实体可选 sourceCandidate={conversationId,groupId,draftId,draftRevision:"1",draftHash}，严格身份/hash 格式，供正式独立快照溯源；不代表可跨会话访问候选，也不修改 Content。母版来源仍用 sourceAssetId/sourceVersion。资料候选由后端固定成员 ID/版本/来源，完整契约见 FREE_SESSION 的单故事资料候选章节。

## 故事写作指引

仅 story 允许可选 `guidance:string`，最多 4000 UTF-16 code units；无字段视为空，更新时 trim 两端空白，空字符串表示移除。
`PUT /api/stories/:id/guidance` 接收 `{revision,text}` 并返回完整故事 Document，沿用本人 Bearer、同源 Origin 和 JSON 边界。
要求 ready、未删除的真实故事及原 revision，复用 head/version 条件事务；不修改 Content 或其他资料，版本冲突返回 409。
指引随 manifest attributes 往返，旧无字段数据无需迁移，其他实体携带 guidance 会被 schema 拒绝。
执行注入及快照展示见 [自由会话服务](FREE_SESSION.md#故事写作指引)。
