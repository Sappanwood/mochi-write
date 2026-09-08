# 故事创作会话契约

本模块在已有故事中提供 Agent 自主取材、独立草稿和授权创建新章。MWT-016 另提供未建立作品的生命周期会话 API、
自然会话母版检索与固定来源；作品初始化事务及新入口 UI 由后续切片接入。正文手工编辑、自动压缩上下文与跨 session
长期续写不属于本次范围。原有无工具写作侧栏保持独立兼容。

## 所有权与授权

Write 持有原始用户消息、故事会话映射、任务、草稿、授权及章节；Mochi 持有执行会话、完整 Pi 消息和 provider 凭据。
浏览器通过本人 API 发起任务，不传工具配置、授权 ID、操作 ID 或 `authorized` 字段。
后端为故事会话注册固定 `search_assets`、`read_asset`、`create_chapter` 工具快照。
模型按需查询当前故事，用户无需预先勾选资料。作品正文、角色描述和检索结果均是资料，不能赋予权限。

每条用户消息先由独立、无工具的 Mochi 会话解释意图，沿用所选 provider/model。
输入只含本条原始用户消息与可信的故事／所选草稿元数据，不含作品正文或创作模型的授权判断。
输出固定为 `{intent,evidence:{start,end,text}}`，intent 为 discuss、draft、save_current、create_and_save、revoke 或 unclear。
后端严格检查 JSON 字段及 evidence 的 UTF-16 字符区间与原始消息一致。
这证明引用确实来自用户，不能消除自然语言分类误判；该剩余边界已接受，不用关键词表冒充语义判断。

只有明确的 save_current 或 create_and_save 解释能够创建一次性授权。含糊请求需要澄清，讨论和预览仅能生成草稿。
授权由后端绑定故事、会话、任务、原始消息摘要、操作 ID 和创建新章的单次额度。
save_current 还绑定用户当前所选草稿 ID、版本与 hash；不重新生成再保存不同文本。
新消息先暂停旧授权并确认旧运行停止，再处理下一请求；撤回与提交通过同一会话和任务的 CAS 排序。
撤回先提交时后续正式写入拒绝；章节先提交时保留收据，不以取消或模型失败抹掉已写事实。

## 草稿与章节

`create_chapter({mode:"draft",title,body})` 持久保存不可变草稿；标题最多 200 字符／512 UTF-8 字节，正文最多 48 KiB。
草稿有独立 ID、版本字符串 `1` 和正文 SHA-256，不自动加入章节目录。相同 invocation 重试不能产生第二份不同草稿。

`create_chapter({mode:"commit",draft_id,draft_revision,draft_hash})` 只保存确切的已持久化草稿，
不接受新正文、目标章节或自报授权。后端检查草稿归属、授权状态、原始任务与运行绑定。
只允许创建新章，不提供覆盖旧章的工具。新章 ID 在任务创建时预分配，创建版本 1，章节顺序为当前最大值加一。

故事分区内一次 Cosmos batch 同时写入：会话 CAS、任务／授权消费／收据、草稿收据、不可变章节版本和章节 head。
章节和版本采用 create-only；任何冲突或存储失败都不能返回成功。
稳定操作 ID 绑定精确草稿输入；同操作、同内容重试返回同一章节及收据，即使调用 ID 改变或授权已经消费。
同操作不同内容返回 operation_conflict；已经由其他操作保存的草稿不能再创建第二章。

收据为 `{operation_id,status:"committed",story_id,chapter_id,revision,content_hash}`。
其中 `revision` 是章节逻辑版本的字符串（新章为 `"1"`），`content_hash` 是原始正文的 `sha256:<hex>`。
它与资产 API 的不透明 `revision`（Cosmos `_etag`）不同：打开章节后用 GET 返回的资产 revision 调用 read_asset。
收据表示一次已提交事实，后续普通资产读取仍以存储中的当前章节为准。

## 持久执行与恢复

`stories` 分区保存 `recordType:creative` 的 conversation、task、draft，内部 ID 形如 `creative:<kind>:<UUID>`，
不会进入业务 `recordType:head` 列表或导出。`library` 中请求登记把客户端请求 UUID 绑定故事和输入摘要，拒绝跨故事复用。
Mochi callback 的 task ID 与操作 ID 使用 `storyUUID:taskUUID`，便于定位分区；身份和完整持久绑定仍逐项核对。

任务与会话的新消息占位先原子持久化，再由后台校验请求登记、模型与所选版本，随后解释／创作。
校验失败保留失败任务，不能恢复被本条消息撤回的旧授权。较早提交的外部查询即使稍后返回，也不能重新激活已被新消息取消的任务。
页面关闭不取消任务，GET 刷新只查询已有任务，不自动 POST 新任务。
解释与创作分别使用稳定幂等键；提交前持久标记。如果响应丢失，只按同 key 核实，不换 key 重放。
服务恢复查询已持久任务；不能确认的提交显示待核实／中断，不伪装成“没有写入”。
用户取消先撤回本地授权，再请求 Mochi 停止；停止尚未确认时保留 stopPending，阻止下一任务抢占同一会话。
模型最终文字与业务保存结果分开：模型可以失败或中断，而章节已经提交；只有 Write 收据支持“已保存”。
独立意图解释的用量保留在 intentUsage，创作运行用量为 usage；缺失统计保持未知。

## HTTP 接口

普通接口继承本人 Bearer 验证；POST 同时要求同源 Origin 和 JSON。路径中的 storyId、taskId、conversationId 为 UUID。
所有接口以 `/api/stories/:storyId/creative` 为前缀。

| 方法与路径 | 输入／结果 |
|---|---|
| GET /conversations | `{items}`，当前故事会话 |
| POST /conversations | `{}`，创建会话 |
| GET /tasks?conversationId=… | `{items}`，用户消息、输出、来源、草稿和收据 |
| POST /tasks | `{conversationId,clientRequestId,message,provider,model,selectedDraft?}`；返回已持久任务 |
| GET /tasks/:taskId | 原任务状态，不重新发起生成 |
| POST /tasks/:taskId/cancel | `{}`；撤回授权并停止原运行 |
| GET /tasks/:taskId/events?after=… | 原 run 的有序事件与游标 |
| POST /tasks/:taskId/verify | `{}`；核实原操作，不生成或重放 |
| GET /drafts?conversationId=… | `{items}`，独立草稿正文与收据 |
| GET /drafts/:draftId | 单份草稿，支持独立阅读与刷新 |

selectedDraft 为 `{draft_id,draft_revision,draft_hash}`，浏览器任务 DTO 不暴露后端授权记录。
Mochi callback `POST /api/agent/tools` 和 `GET /api/agent/operations/:operationId` 使用专用 app-only 身份，
沿用 [CONTRACTS](CONTRACTS.md) 的工具认证和响应大小边界。正式提交成功响应携带收据；操作查询返回 committed、rejected 或 not_found。
not_found 只说明查询时没有收据，不能证明另一个正在进行的请求不会提交。

## 验证与运行

服务需要已有 Cosmos／Mochi 接入，并配置 Mochi 到 Write 的工具回调身份与 allowlist。
main 注册个人创作 API 和工具 callback；未配置工具验证时 callback 拒绝访问。
具体环境项见 [README](../README.md)。云端角色与部署已于 2026-09-08 独立验收；数据库恢复仍待验收。
正式个人认证、Cosmos 与 Managed Identity 回调链下，合成故事的只产草稿、选中版本原样保存、直接生成并保存三轮均成功。
草稿轮未新增章节，两次保存后章节数依次为 1 和 2，正文与草稿及收据 hash 一致；刷新后可继续阅读正式章节与会话成果。

行为测试覆盖原始意图引用、精确草稿、授权撤回、跨范围拒绝、并发保存、幂等与丢失响应。
API 测试覆盖本人／服务身份分离和非法自报授权；第一切片已通过浏览器、真实 HTTP/Pi 工具集成和独立 deepseek-v4-flash smoke。
真实 smoke 验证自主读取设定／角色、直接保存及草稿次轮原样保存，保留合成作品与收据证据；不作为长篇叙事质量评测。

### 隔离验收入口

`MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration` 使用两个真实 HTTP 服务、签名身份和 Pi AgentSession，
由确定性 provider 驱动自主取材、精确草稿保存、历史恢复、隔离、工具错误及模型／工具／写入预算。
还覆盖提交响应丢失后保留收据，并在写回调等待响应时实际 SIGKILL 子进程，确认新进程恢复为 interrupted／unknown，
相同幂等键不会重放模型或写入。存储为隔离 fixture；这不替代收费 Cosmos 或云端身份验收。

真实模型 smoke 单独显式启用，不属于默认门禁。运行前取得模型和累计费用授权，准备两个 Repo 依赖：

```bash
MOCHI_REPO_ROOT=/absolute/path/to/mochi \
MOCHI_REAL_SMOKE=deepseek-v4-flash \
MOCHI_SMOKE_BUDGET_USD=10 \
MOCHI_SMOKE_REPORT=/tmp/creative-smoke.json \
node --import tsx tests/integration/creative-smoke.mjs
```

凭据从进程环境 `DEEPSEEK_API_KEY` 读取，也可通过 `MOCHI_SMOKE_AUTH_FILE` 显式指定含 DeepSeek api_key 的 Pi auth 文件；
不把凭据写入测试报告。脚本创建合成故事，验证直接写章保存、先看草稿、下一轮原样保存三条自然语言请求，
报告保留任务、来源、草稿正文、收据和用量。每次预算只覆盖该次进程；重试须扣除前次报告的费用上界，
累计不超过用户授权。报告按所有输入的峰值价格估算，缺失用量按请求预留上界计入，不作为实际账单。

## 生命周期会话与母版检索（MWT-016）

首次发送前不创建故事或独立创意业务对象。`POST /api/creative/conversations` 接受
`{clientRequestId,message,provider,model}`，返回 `{conversation,task}`（task 使用既有脱敏 DTO）。
后端为请求固定 storyId/conversationId，先在 library 登记请求摘要，再持久化带 `lifecycle:true` 的会话、
首条输入及任务。允许 stories 分区只有 creative records 而没有 story head；正式故事列表、阅读及旧会话创建仍要求 ready head。
相同键同输入找回原任务，异输入 409；中途仅会话已保存的请求由恢复流程使用已保存输入补齐任务。
这不是跨分区原子事务，不通过换键或另建故事掩盖未知结果。

`GET /api/creative/conversations` 返回 `{items}`，每项为生命周期 conversation 与 `established`，不包含旧三工具会话。
`GET /api/creative/conversations/:conversationId` 仅依据持久绑定解析故事；
`GET /api/creative/conversations/by-request/:clientRequestId` 返回原 `{conversation,task}`，供首次响应丢失后恢复，
未找到完整绑定为 404。三个 GET 都只读取，不发起 Mochi 请求或重放首条 POST。
任务、草稿、events、cancel、verify 复用上表的故事 creative 子路径；无 head 时必须验证其生命周期 conversation 绑定，
不能将预留 ID 用于普通故事端点或别的会话。

生命周期会话固定七工具：旧三项加 `library_vocabulary`、`search_library`、`read_library`、`initialize_story`。
旧 API 新建会话及旧 session 保持原三工具。Mochi session 创建前持久化派发标记，成功响应后保存 sessionId；
创建响应未知时任务显示 interrupted，保留记录、不自动创建第二个 session，用户可主动新建会话。
已绑定 session 后沿用原 run/key/事件恢复机制。MWT-016 中 initialize_story 仅登记完整 schema，处理明确拒绝；
不能将本切片的预留目标当作已初始化作品或正式保存成果。初始化实现消费 `CreativeLifecycle.target` 返回的 ready head 或 undefined。

| 工具 | 参数与结果 |
|---|---|
| library_vocabulary | `{}` → genres、ageBands 与检索维度含义，不统计或输出全体母版 |
| search_library | `{kind:character/world,name?,genre?,age_band?,gender?,occupation?,trait?,era?,tag?,limit?,cursor?}` → `{items,next_cursor}` |
| read_library | `{asset_id,revision}` → 指定版本完整 Content、version、content_hash 与来源字段 |

所有条件 AND；genre/tag 为单值成员匹配，gender/age_band 精确匹配，name/occupation/trait/era 为大小写不敏感子串。
trait 匹配 traits 字符串数组的任一元素。非法词表值 invalid_arguments；字段缺失或类型错误不匹配该条件，
空过滤仍能分页发现 legacy 资料。同名返回多个条目，不隐式挑选。文字条件最多 128 字符，genre/age_band 最多 40；
limit 默认 10、最多 20；cursor 最多 4096 UTF-8 bytes，封装固定 library scope、全部过滤条件和存储 continuation，
参数不一致返回 invalid_cursor。cursor 仅为分页状态，不承担授权，不承诺跨页事务快照。

检索只投影 ID、kind、name、revision、version、genres、age_band 和五个 sourceMetadata 字段，不从数据库取正文再筛选。
发现结果不等于真实读取。首次全文读取校验当前 head revision，成功前在同一事务记录 task 与 conversation 的真实来源
`{asset_id,kind,title,revision,version,content_hash,scope:library}`，不将完整母版塞进来源记录。
同 conversation 后续按已读来源点读不可变版本，核对 canonical Content SHA-256，即使母版更新或软删除也保持原内容；
未读来源不能任意请求历史版本。单次 Content 与来源 JSON 最多 60 KiB，发现与回调整体仍受 64 KiB 限制，超限拒绝不截断。
模型将自然条件映射至词表，按词表／摘要筛选／精确全文逐层取材；正文和来源均不能创建保存授权。
