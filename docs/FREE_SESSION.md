# 自由创作会话服务

## 当前范围

MWT-025 增量实现 `/api/creative/free` 本人 API、独立会话身份、固定资产引用、只读工具、目标后绑定、两阶段执行及 OP 恢复。
浏览器仍使用旧入口；新工作区、候选组/候选引用存储、角色正式保存与故事业务桥接分别由后续切片接入。
`FreeCallback` 的 `FreeToolHandler` 与 `FreeReferences` 的 `CandidateAccess` 是后续业务接入点。
没有 handler 时候选发现/读稿/写工具返回 `tool_not_available`，不会写正式资产或用聊天文字冒充候选。
新 session 创建时仍固定完整十工具 v2 快照，因此后续接入无需改变旧 session 快照。

## 身份与引用

空白、角色、故事入口都用同一种 `protocolVersion:2` conversation，不带 `kind` 或 `storyId` 保存目标。
记录本身的 `kind:"conversation"` 只是存储分类。首次 POST 才在 library 同一事务创建 conversation、首 task、请求索引和来源记录；
同键同输入返回原结果，异输入 409。初始 `initialRefs` 与每条消息 `refs` 分离，各最多 8 项；原消息最多 16 KiB，完整输入最多 32 KiB。
仅查看资料不改变输入或目标。初始关联和成功收据构成关联投影，不授予写权限；一会话可关联多个资产，同一资产可被多个会话关联。

资产引用为 `{type:"asset",kind,asset_id,story_id?,revision,version,content_hash}`。
character/world 禁止 story_id；故事及其资料必须提供 story_id，story 本身 asset_id=story_id。
新引用必须匹配未删除当前 head 的不透明 revision、逻辑 version 和完整 Content 的 canonical SHA-256。
已在本会话记录的旧来源允许读取不可变版本，软删除或编辑不替换旧内容；缺失或 hash 不一致明确不可取得。
编辑目标另读当前 head，固定资料的旧版本不会自动成为新的保存 baseRevision；保存旧候选仍必须匹配候选冻结目标/版本，不自动 rebase。

成功全文读取先持久化 source，才返回正文；搜索命中不算已读。来源带 initial/explicit/agent_read、task、调用 ID、读取时间和精确引用。
工具只读 allowlist 包括 library，以及本轮初始/显式引用或后端核验的故事，最多 8 个；模型无法扩展。
每 task 最多 20 条来源，单次完整 Content 最多 60 KiB。

## 本人 API

全部接口继承本人 delegated Bearer；POST 必须同源 Origin 与 JSON。以下路径以 `/api/creative/free` 为根。
列表分页默认/最多 20，cursor 绑定对应列表或会话，不承担授权。

| 方法与路径 | 行为 |
|---|---|
| POST /conversations | `{clientRequestId,message,provider,model,thinkingLevel?,initialRefs?,refs?}` → `{conversation,task}` |
| GET /conversations | `cursor?,limit?` → `{items,nextCursor}`，只列 v2 |
| GET /conversations/by-request/:clientRequestId | 恢复原 `{conversation,task}`，不派发 |
| GET /conversations/:id | `{conversation,activeTask?,associations,nextCursor}` |
| GET /conversations/:id/tasks | 会话任务分页 `{items,nextCursor}` |
| POST /conversations/:id/tasks | 原输入及 refs，无 initialRefs/target/action/authorizationId → `{task}` |
| GET /conversations/:id/tasks/:taskId | `{task,receipts,sources,nextCursor}`；跨会话拒绝 |
| POST /conversations/:id/tasks/:taskId/cancel | 撤回业务 OP 并停止原 run；stopPending 时 HTTP202/cancel_pending |
| POST /conversations/:id/tasks/:taskId/verify | 只查原 run/OP 并修复投影；不发模型或重做业务提交 |
| GET /conversations/:id/tasks/:taskId/events | `after` 单调游标，事件带 phase/runId；library 持久投影并去重 |
| GET /conversations/:id/references | `ref` URL 编码 JSON，最多 4096 bytes；只读本会话已记录引用，返回 exact/unavailable |

任务 DTO 只暴露目标/动作摘要、运行状态/用量与恢复信息，不暴露授权 ID、可信执行 payload 或完整 binding。
401/403 为身份/范围失败，404 为缺失，409 为请求/版本/授权冲突；错误保留原输入和已持久成果。

## 独立核验与运行

Write 先持久原消息、refs、epoch、sourceMessageId、taskId、operationId，再以独立无工具 session 解释原消息与可信引用摘要。
解释器 thinking=off、最多 2048 输出 tokens、失败不自动重试；费用/用量与创作运行分开。自然语义由此隔离解释器判断，仍存在分类误判风险。
输出严格验证 intent、目标 mode/kind、最多 8 个字段条件、原 UTF-16 证据区间和修改证据；否定、转述、多操作或不支持条件进入澄清。

需要检索时，原 Mochi session 的 `<taskId>:resolve:1` 只有读权限，连 draft 都拒绝。
其结果不作为授权：Write 另行按冻结条件完整查询最多 20 个摘要/5 页/60 KiB，重新 AND 匹配、核对唯一性并重读当前 head。
“之前/那个/先前/上次”还要求对象出现在本会话初始/显式/实际已读来源或成功关联历史；全库单条但无此关联不授予权限。
查询分页未完成、无匹配、多匹配、条件不符或版本变化都澄清。核验记录保存原消息 hash、分类 run/result、条件、实际候选 IDs/revisions、完整性与最终 head。
已明确目标或新建意图可直接 execute，不能从上轮 binding 推导本轮授权。明确引用仍须核验全部冻结条件的合法性及当前 head 的 AND 匹配；只有一条引用不免除该检查。

绑定只生成一次 `{operationId,authorizationId,target,action,baseRevision,selectedDraft?,evidenceDigest}`。
action 为 create_character/update_character/initialize_story/save_first_chapter/create_chapter；save_current 按精确候选归约。
没有正式保存意图时仅冻结 `draftContext`，不创建 ledger 或有权 scope；新故事候选的 ID 由后端预分配，既有故事候选保留原目标。
execute 同原 session、同 sourceMessageId，冻结 scope/refs/binding/draft_context_digest，不能改写已派发 run 或换 key 绕过 unknown。
两阶段共享 8 次模型、20 次工具、300000ms（排队除外）；execute 扣除 resolve 实际 execution_usage，缺失用量不能猜余额继续。

## 分区、取消与恢复

所有 v2 过程记录使用 `recordType:"free"`、`schemaVersion:2`、`free:<type>:<UUID>`，位于 library/scopeId=library；不进入正式 head 列表或导出。
OP directory 在 library 中与 task binding/conversation CAS 一起 create-only，固定 partition 与 binding digest，永不换目标。
角色 ledger 位于 library，故事 ledger 位于 stories/projectId=storyId；只允许目标对应分区。
`FreeOperations` 提供 active ledger 激活、撤回 tombstone、严格原 OP 查询与收据投影；正式业务 batch 的具体实现留给保存切片。

取消先 CAS 会话 epoch 并标记 cancel_pending，再在目标分区创建 revoked tombstone 或 CAS active→revoked。
激活与撤回遇到同一 create-only/CAS 冲突时以目标 ledger 为准。业务先 committed 则保留收据，取消不会回滚。
目标或远端停止未确认保留 stopPending，并以 previous_operation_pending 拒绝下一任务派发。迟到解析必须通过原 epoch/activeTaskId CAS。
intent/resolve/execute 的派发标记与有效 task、会话 epoch 在同一 library CAS 中占位；两种 session 创建也采用同一边界。取消先成功时不 POST；占位先成功时，取消保留 pending，直到原 run 或创建响应已核实。

target ledger 是提交事实，library task/关联资产只是投影。投影失败可点读 directory 指向的同一 ledger，核对 binding/目标/精确稿后重复恢复。
unknown/不存在不证明未提交；不新建 OP、不重跑模型或补业务对象。session 创建前持久 dispatch 标记，创建结果未知不重复创建；
用户保留原记录，可另开新 conversation。run 已标 dispatch 后响应未知，核实只按持久 runId 或原 key GET。

## 兼容与验证

v1 无工具/三工具/七工具 session、旧 `creative:` records、story 分区事务、`#creative` 链接及查看即引用 UI 保持原状，不迁移/升级旧快照。
新工具白名单顺序为 library_vocabulary/1、search_library/1、read_library/1、search_assets/2、read_asset/2、discover_artifacts/2、read_artifact/2、save_character/2、initialize_story/2、create_chapter/2。
v2 回调继承专用 app-only 身份，逐项校验 app/session/task/run/phase/scope；请求/响应上限仍 128/64 KiB。

`npm run check` 覆盖新身份、目标证据、跨分区恢复、取消、API 与存储行为及既有 v1 测试。
`MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration` 增加真实 HTTP、签名身份、Pi AgentSession 和假 provider 的 v2 两阶段/同 session 续聊、预算与事件验证。
上述证据不表示云部署、真实模型、完整候选业务或正式保存验收完成。
