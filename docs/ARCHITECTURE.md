# Mochi Write 架构

## 当前状态

已实现 React 资产编辑/故事阅读/导入导出及写作侧栏，Fastify 业务 API、个人认证、Cosmos adapter 与版本/采纳事务。
本地验证使用独立签名测试身份和内存存储，尚无真实 Cosmos/Entra 联调。
已选择 Azure Cosmos DB 作为业务主存储，并确认故事独立快照与页面感知 Agent 侧栏方向；技术栈、个人认证、数据布局与宿主接口已确定，详见 [首期实现契约](CONTRACTS.md)。实际依赖版本固定于 package.json 与 package-lock.json，已由 CCP 发布到 Azure Container Apps，完成本人 Entra 登录及 Cosmos 故事列表读取验证。

## 组件与所有权

浏览器 → Mochi Write 后端 → Mochi 内部 Agent API → 模型 provider。

| 项目 | 所有权 |
|---|---|
| mochi-write | 个人访问、页面、业务存储、素材检索、写作上下文、草稿与章节采纳 |
| mochi | provider 认证、模型调用、执行会话、任务状态与事件 |
| ccp | 云资源、身份权限、持久存储资源、备份和非镜像容器配置 |

Web 后端沿用 Mochi/CCP 已选的 Managed Identity 与 Entra app-only 认证方向；
个人浏览器登录是独立边界。调用方身份映射和实际 endpoint 由联合接入契约确定。
Mochi 不直接持有或修改正式小说数据，认证共享不挂载给本应用。

## 单 Agent 写作

已有故事的主要入口为 `CreativeWorkspace`。浏览器只提交自然语言消息、模型选择和可选的精确草稿引用，
Write 生成有限授权与故事 scope；Mochi 保存固定工具快照并执行自主取材、草稿和新章工具。
Write 持久 task 的原始消息与最终文字构成 UI 会话时间线，Mochi 完整 Pi 历史仍是后续模型回合的权威上下文，
前端不导入或重建可执行模型历史。草稿与正式章节分别阅读，保存只由业务收据确认。

以下无工具 Writing 链路继续保留在阅读与资产页面的侧栏。
应用负责组织本次要求、相关角色母版及快照、世界观、选定前文和按需加入的大纲。
Mochi 执行单 Agent 请求，返回任务事件及结果；应用校验并保存草稿，用户采纳后更新章节。
首期无需应用工具：由后端提供上下文并接收生成结果，不让模型访问本地路径或执行 shell。
Mochi 的无工具会话/任务 v1 API 已与应用进行本地 HTTP 联调；固定 wire schema 见 [实现契约](CONTRACTS.md)。
执行历史由服务持有，应用以 app-only token 调用，不借用户身份访问服务。

提交前先持久化输入快照；幂等恢复以 request key 查询任务，只有显式重试才再提交同一输入。
断开页面不代表任务取消；无法确认的中断不自动重复写入。正式内容版本与执行会话分别管理。

## 页面感知侧栏与宿主适配

侧栏先在 mochi-write 内独立实现，通过明确的宿主适配接口连接小说业务；第二个真实消费者接入时再提取共享包。
首期不发布通用组件包或建设插件系统，也不实施 ProjectOps 接入。

| 层级 | 职责 |
|---|---|
| 通用侧栏 | 消息、流式输出、会话切换、取消、重连和上下文展示 |
| 宿主应用 | 路由到业务对象的映射、会话范围、上下文解析、权限校验和结果操作 |
| Mochi | Agent 会话、执行任务、模型调用、事件与执行历史持久化 |

通用协议表达 scope、当前对象、选区和 revision，字段与宿主边界见 [首期实现契约](CONTRACTS.md)。
宿主主动提供结构化页面状态；侧栏不扫描 DOM，不依赖特定路由库、Cosmos DB 或小说数据模型。
后端验证客户端对象引用与访问权限，发送时固定目标、选区和版本；运行期间切换页面不改变已有任务目标。
章节采纳等业务操作由宿主提供，不放入通用侧栏核心。

默认按故事保持持续会话，同一故事内切换章节或设定只更新当前上下文；切换故事切换到对应会话，
全局资产库使用独立会话。允许主动新建会话，不强制按章节重开。
稳定指引与历史尽量保持不变，本轮页面上下文追加在本轮请求中；历史页面信息不覆盖当前目标。
缓存收益以 provider 实际 usage 为准，不以 session ID 或追加历史保证命中；缓存不消除上下文容量限制。
接近上下文预算时提示整理或新建会话，不静默增加摘要、评审等模型调用。
应用拥有会话与故事的关联、输入资料版本、草稿和采纳结果；Mochi 拥有执行会话与历史，不建立两份可独立编辑的对话 authority。

未来 ProjectOps 可以用同一模式提供项目、Backlog、Plan 和执行上下文，但代码开发需接入其执行与验收契约。
页面感知不授权代码执行，也不要求 Mochi 首期开放工具。

## Cosmos DB 与故事快照

Azure Cosmos DB 已确定为业务主存储。角色、世界观、故事快照、章节、版本、草稿及应用会话关联保存为业务文档，
正文保留 Markdown 字符串。章节和历史版本分别建模，不将整部故事或全部会话历史放进单一文档。
Blob 不作为首期业务主存储；附件或导出包存储在出现具体需求时另行确定。
按用户“最大程度使用免费额度”的要求，采用 Cosmos DB for NoSQL 的 Free Tier + 手动预配吞吐方向，替代此前 Serverless 建议。
CCP 已完成 Free Tier 名额核对并创建应用数据库与两个 container；后续扩容仍须核对账户总额度。
以单区域、账户总预配吞吐不超过可用免费额度为初始约束；Free Tier 当前为 1,000 RU/s 和 25 GB，
限额按账户合计，不为每个 container 或未来应用重复计算。当前应用数据库使用 400 RU/s 手动共享吞吐，账户与资源归属由 CCP 管理。
免费层不适用于 Serverless，须在账户创建时启用；超额存储、恢复及其他云资源不承诺免费。

故事业务 container 的分区路径确定为 `/projectId`，值为故事 ID；同一故事的快照、章节、版本与草稿共用分区。
此处 projectId 指小说作品，不是 ProjectOps 项目 ID。全局资产使用独立 library container，/scopeId 固定为 library，不能伪造故事归属。
跨分区操作不承诺原子性；两个 container 共享数据库吞吐，版本与采纳事务限定在同一分区，具体规则见首期实现契约。

用户要求最低限度恢复；实施基线采用平台 Continuous 7-day 备份，不建设独立备份服务或跨账户复制。
该档备份存储当前免费，实际恢复调用收费，恢复时另行确认目标、费用和数据核对步骤。
保留现有 Markdown 导出能力与迁移源文件；业务版本历史独立于平台备份，不能相互替代。
Continuous 7-day 已配置，但恢复演练尚未验收；恢复前查询实际可恢复时间范围并执行人工核对，不承诺零数据丢失或固定恢复时限。
资源、身份和备份配置由 CCP 管理，本项目负责业务 schema 与访问契约。

创建故事时，将选定角色与世界观完整复制为该故事拥有的初始化快照，保留来源 ID/版本用于溯源。
故事内当前设定独立演变并保留版本；母版修改或删除不改变既有故事，故事变化不回写母版。
后续加入角色或世界观时，在加入时复制快照；首期不实现母版更新自动合并。
既有 novel 增量快照导入时合成独立的完整故事资料，保留来源与原始增量供溯源。

先用脱敏 fixture 验证导入、导出及快照关联；真实素材保持私有，不修改原始目录。
本地导入导出按受信任 Linux/容器目录，验证静态 symlink containment 与正常并发冲突，
不要求同用户恶意 ancestor-swap resistance，无 native helper；其他平台另行确定。

## 技术与认证基线

React + TypeScript + Vite 前端，Node.js 24 + TypeScript + Fastify 后端，npm 单 package，前后端同仓库同容器。
个人 Entra ID + MSAL 授权码/PKCE，后端独立验证 access token 并限定本人 tenant/oid。
该方向作为生态后续 Web 应用标准；先在本应用验证公共模块，第二个消费者接入再提取共享包。

## 后续接入条件

设计契约已完成；真实实现与跨项目联调依赖见 [首期实现契约](CONTRACTS.md)。
MWT-002 已完成本地验收，MWT-003 已完成本地 Mochi 联调；MWT-004 已发布并验证本人登录和故事列表读取。
首批 18 故事、374 对象已导入；同批次重试未新增对象，全局 18 故事分页无重复。
云端导出曾暴露定故事查询范围问题；修复已发布，部署后的分区范围和全局分页检查通过。
374 对象的导出正文 hash、manifest 元数据与唯一 ID/路径均已核验；独立人工测试故事已验证真实模型生成、章节 v1 采纳及刷新一致、页面断开后查询原 run 恢复。
真实跨应用隔离、服务进程中断恢复、收费数据库恢复及 ZIP 落盘完整性尚未验收，主入口尚未切换。
MWT-005 已登记 `127.0.0.1:12600` 长期开发服务，尚未启动；云发布与本地服务运行分别验收。

## 外部文档入口

接入时查阅对应最新官方文档并固定实际验证版本：

- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/overview)
- [ACA 存储挂载](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts)
- [Entra 服务间认证](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra)

- [Cosmos DB Free Tier](https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier)
- [Cosmos DB 连续备份](https://learn.microsoft.com/en-us/azure/cosmos-db/continuous-backup-restore-introduction)

## 实现模块与验证边界

| 模块 | 职责 |
|---|---|
| src/shared/model.ts | v1 对象、内容、分页与错误类型 |
| src/server/auth.ts、config.ts、app.ts | 本人 JWT 验证、配置、同源写入边界与健康检查 |
| src/server/cosmos-store.ts、store.ts | Cosmos 分区查询、不可变版本 Create + head 条件写入 |
| src/server/library.ts | 受控词表、资产编辑/删除与独立快照复制 |
| src/server/import.ts、markdown.ts、export.ts | 旧格式与清单格式预检、可重试初始化和当前版本导出 |
| src/server/filesystem.ts、transfer-cli.ts | 只读本地源、不覆盖目录导出、CLI |
| src/web | MSAL、资产库、故事阅读、Markdown 渲染与目录导入/ZIP 下载 |
| src/web/sidebar、WritingHost.tsx | 无业务字段的通用侧栏与小说宿主适配；上下文预览、事件去重与宿主结果操作 |
| src/web/CreativeWorkspace.tsx、CreativeResults.tsx | 故事会话主入口、原任务轮询与工具游标去重、精确来源核对、独立草稿阅读及收据成果 |
| src/server/writing.ts、writing-routes.ts | 引用归属/版本、预算、请求恢复、scope 会话及草稿状态 |
| src/server/writing-store.ts、mochi-client.ts | 独立 writing records、同分区采纳事务、后端 app-only Mochi HTTP 客户端 |
| src/shared/creative-tools.ts、src/server/asset-tools.ts | callback wire v1 与故事分区关键词检索、版本绑定分页、精确全文读取及真实来源记录接口 |
| src/server/tool-auth.ts、tool-routes.ts | Mochi 服务 app-only 身份、严格 task/session/story scope 与 run 绑定；与本人编辑 API 分离 |
| tests/integration/mochi.mjs | 显式跨 Repo 真实 HTTP 与持久服务联调，假 provider，不运行真实模型 |
| tests/support、tests/e2e/browser | 隔离内存存储、签名测试身份与单独测试页面，不被生产构建引用 |

导入跨分区不承诺事务：先核对完整输入和既有对象冲突，再记录批次、建立 building 故事、写入资料，最后以 etag 发布 ready。
失败不会回滚已写内容；同批次重试保留对象 ID，未完成故事不对阅读 API 可见。资产版本与 head 在单一 Cosmos 分区事务中保存。
受控词表保留单一 identity；真实资料与导入产物不会进入 Repo。文件大小限制同时检查源文本和版本事务的持久化对象。
导入/导出的共享大小规则位于 `src/shared/bundle-limits.ts`：普通 Markdown 1 MiB、根清单 16 MiB、总包 16 MiB。
清单承载各对象溯源，可大于单篇正文；Web 选择、服务端预检和 CLI 安全读取使用相同限制。


写作记录使用 `recordType=writing`，不会被业务 `head` 查询或 Markdown 导出纳入。
会话关联与草稿分区跟随 scope；全应用幂等绑定单独放在 library，保存摘要和目标分区。
先绑定键、校验上下文并保存 pending 草稿，再查询/提交 Mochi；崩溃后输入仍可恢复，不存在跨分区事务承诺。
采纳单次 batch 包含版本 Create、章节 head Create/IfMatch、草稿 accepted IfMatch；失败不返回采纳成功。
新章节 ID 在首次提交前分配，反馈重写复用该 ID。只有 succeeded 完整文本可采纳，终态片段来自持久事件。
生产可不配置 Mochi，此时仅写作入口报告不可用，不使阅读服务的 readiness 失败。

MWT-010 已提供故事自主取材工具及反向 callback 注册器，独立于旧无工具 Writing 链路。
应用固定故事范围后，Mochi 才能调用 search_assets/read_asset；发现列表只含元数据和有界命中片段，全文按精确 revision 获取。
搜索每次最多扫描 1000 对象/8 MiB/50 页，HMAC cursor 绑定条件与当前资料版本摘要；重启失效后重新检索。
成功读取通过注入接口持久记录实际 ID/revision，创作 UI 据此展示来源；权限不能从资料或模型输出取得。
Cosmos 对正文进行有界应用内扫描，跨范围检测仅作 ID→projectId 元数据查询，不从其他故事读取正文。
具体参数、错误和预算见 [CONTRACTS](CONTRACTS.md#已实现的故事资产工具边界mwt-010)。
MWT-011 已在本地 main 接上持久任务/session/story/run 绑定、草稿与授权事务，MWT-012 已接入创作会话与真实来源 UI。
新增角色授权和云发布仍是独立部署事项；完整跨 Repo 与真实模型验收由 MWT-013 完成。

## 镜像发布所有权

应用 GitHub Actions 在本仓库 main 通过 OIDC 构建、推送并发布 image digest。CCP 的两个 ACA 资源仅忽略 image 字段，其余配置仍受 Terraform 管理。发布不读取 Terraform state，不调用 CCP workflow；触发与维护边界见 [README](../README.md#github-actions-日常发布)。

## 故事工具会话与授权事务

`Creative` 负责故事会话／任务持久绑定，`CreativeWorkflow` 驱动独立无工具意图解释及有界创作运行，
`CreativeChapters` 验证草稿、授权与幂等写章。`creative-routes` 是本人 API，`tool-routes` 是 Mochi app-only callback；
两者身份不能互换。工具配置固定于后端，正文与检索结果不能成为授权来源。

`CosmosCreativeStore` 在故事分区保存 `recordType:creative` 的会话、任务和不可变草稿，
在 library 登记请求 UUID 与故事／输入摘要。授权嵌于任务，正式提交在同一事务中消费授权、保存任务及草稿收据、
创建章节 head 与版本，并对会话 CAS；正常并发下撤回和提交只有一个先完成。原有 head 查询与导出不包括创作过程记录。

后台驱动不依赖浏览器连接。提交标记与稳定 key 持久化，未知结果只能查询原 key／操作，不能自动重新生成。
Mochi 保存完整 Pi 工具历史，后续创作回合复用同一执行会话；Write 显示的消息、草稿和收据来自自己的持久任务。
详细授权、安全与恢复规则见 [故事创作会话契约](CREATIVE_WORKSPACE.md)。此模块已接入本地 main，
浏览器工作区已接入，真实模型工具链验收由后续切片完成，不宣称已发布云端工具角色与配置。

浏览器 `story/:id/creative/:conversationId` 保持会话路由，`story/:id/draft/:draftId` 独立加载草稿；旧章节阅读路由继续有效。
任务轮询和按 after 游标查询的工具事件只恢复已有状态，不自动发送新请求。工具进展按 invocation 更新单项状态，
重复游标事件不能重复增加进展；草稿来自 Write 持久数据，模型文字或工具事件文本不直接创建「已保存」标识。
来源查看先读当前文档并比对本轮 opaque revision，变更／删除时说明原版本不可展示，不引入历史正文读取接口。
提交响应未知时在当前页面保留完整请求，以其 clientRequestId 查询原 task，显式重试也使用原输入和原键。
同故事最近会话选择保存于 sessionStorage；消息、草稿和授权的权威数据仍由后端持有。
