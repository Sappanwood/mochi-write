# 故事创作会话契约

本模块在已有故事中提供 Agent 自主取材、独立草稿和授权创建新章。正文手工编辑、新故事初始化、
自动压缩上下文与跨 session 长期续写不属于第一切片。原有无工具写作侧栏保持独立兼容。

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
具体环境项见 [README](../README.md)。本地实现与隔离测试不代表云端角色、部署或数据库恢复已经验收。

行为测试覆盖原始意图引用、精确草稿、授权撤回、跨范围拒绝、并发保存、幂等与丢失响应。
API 测试覆盖本人／服务身份分离和非法自报授权；完整切片还要求浏览器与真实 HTTP/Pi 工具集成、独立真实模型 smoke。
