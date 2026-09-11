# 自由创作会话服务

## 当前范围

MWT-025–028 增量实现 `/api/creative/free` 本人 API、独立会话身份、固定资产引用、只读工具、目标后绑定、两阶段执行及 OP 恢复。
浏览器 `#free/new` 与 `#free/conversation/:id` 已接入候选组、精确引用、资产发现、角色和故事成果阅读及原 OP 核实。默认首页与创作导航使用自由会话；资产模式保留独立阅览及轻量直接编辑，旧 v1 入口明确保留。角色正式保存、同一会话的故事初始化、首章、续章和反向独立母版已接通。
`FreeCallback` 的 `FreeToolHandler` 与 `FreeReferences` 的 `CandidateAccess` 是后续业务接入点。
默认 handler 支持 discover_artifacts/read_artifact，以及 save_character/initialize_story/create_chapter 的 draft/commit。角色正式写入只来自后端核验绑定和真实 OP 收据。
新 conversation 固定 materials-v1 十二工具；此前 world-v1 十一工具及无标记十工具仍按持久快照继续。HTTP 输入不能设置或升级能力。世界观保存已接通；新增资料能力的实现边界见文末。

## 身份与引用

空白、角色、世界观、故事入口都用同一种 `protocolVersion:2` conversation，不带 `kind` 或 `storyId` 保存目标。
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
每 task 最多 20 条来源，单次完整 Content 最多 60 KiB。实际读取记录先固定 conversation CAS revision，再查询同 invocation 和计数；冲突使用原 invocation 重读校验，不重复计数或越过上限。来源 ref 同时支持资产和候选，候选成员按 member_id 固定；初始化成员目录本身不计作全文读取。

## 本人 API

全部接口继承本人 delegated Bearer；POST 必须同源 Origin 与 JSON。以下路径以 `/api/creative/free` 为根。
列表分页默认/最多 20，cursor 绑定对应列表或会话，不承担授权。

| 方法与路径 | 行为 |
|---|---|
| GET /discover | 首条消息前的正式资产发现，参数同会话 discover；不允许 candidate、不创建会话 |
| POST /references/resolve | 首条消息前解析正式资产 locator，不允许 candidate |
| POST /conversations | `{clientRequestId,message,provider,model,thinkingLevel?,initialRefs?,refs?}` → `{conversation,task}` |
| GET /conversations | `cursor?,limit?` → `{items,nextCursor}`，只列 v2 |
| GET /conversations/by-request/:clientRequestId | 恢复原 `{conversation,task}`，不派发 |
| GET /conversations/:id | `{conversation,activeTask?,associations,nextCursor}` |
| GET /conversations/:id/tasks | 会话任务分页 `{items,nextCursor}` |
| POST /conversations/:id/tasks | 原输入及 refs，无 initialRefs/target/action/authorizationId → `{task}` |
| GET /conversations/:id/tasks/:taskId | `{task,receipts,candidates,sources,nextCursor}`；跨会话拒绝 |
| POST /conversations/:id/tasks/:taskId/cancel | 撤回业务 OP 并停止原 run；stopPending 时 HTTP202/cancel_pending |
| POST /conversations/:id/tasks/:taskId/verify | 只查原 run/OP 并修复投影；不发模型或重做业务提交 |
| GET /conversations/:id/tasks/:taskId/events | `after` 单调游标，事件带 phase/runId；library 持久投影并去重 |
| GET /conversations/:id/groups | `{items,nextCursor}`，稳定成果组分页 |
| GET /conversations/:id/groups/:groupId/drafts | `{items,nextCursor}`，按 ordinal 分页的精确稿摘要 |
| GET /conversations/:id/drafts/:draftId | `{draft,claim?,receipt?}`，本人读取本会话完整冻结包及原 OP 状态 |
| GET /conversations/:id/discover | `kind,query?,story_id?,limit?,cursor?`，`{items,next_cursor}`；kind 为资产类型或 candidate |
| POST /conversations/:id/references/resolve | 资产 locator 或完整 candidate ref → `{ref}`，供 @ 和引用按钮统一使用，不发消息或记录为 Agent 已读 |
| GET /conversations/:id/references | `ref` URL 编码 JSON，最多 4096 bytes；只读本会话已记录引用，返回 exact/unavailable；exact 资产附当前 head 的 `currentVersion/currentDeleted`（若仍存在），正文始终为引用版本 |

任务 DTO 只暴露目标/动作摘要、运行状态/用量与恢复信息，不暴露授权 ID、可信执行 payload 或完整 binding。
401/403 为身份/范围失败，404 为缺失，409 为请求/版本/授权冲突；错误保留原输入和已持久成果。

## 候选与轻量发现

`FreeCandidates.freeze` 只在有效 task 的 authorized/running 状态工作。`free:group` 保存稳定组身份和 nextOrdinal；
`free:candidate` create-only 保存完整 payload，draftRevision 恒为 `"1"`。conversation、task、group CAS 与 candidate create 在同一 library batch；
正常并发冲突后以原 invocation 重试，失败不消耗编号。每 task 最多 8 稿、冻结包合计 1 MiB；角色/世界观/章包 60 KiB，初始化包 256 KiB。
同 invocation 同输入读回原稿，异输入 operation_conflict。改写必须同时传 group_id/parent_ref，父稿同组同类型，允许从旧稿分叉；
新组可传 derived_from。parent/derived/derivation 保留冻结 provenance，内部校验读取不记为 Agent 已读；只有 read 工具向 Agent 返回全文才记 agent_read。draftHash 覆盖 id/groupId/artifactKind/完整 payload（Content、可信 draftContext、动作、父稿、派生与成员）；ordinal 和时间不参与 hash。
来源与保存状态不写回候选；候选不进入正式 head、导出或自动清理。

save_character draft 共享 Library 的 Content/词表验证，只允许有界角色字段；更新保留未知合法 metadata，
正文原换行不变，规范化在冻结前完成。候选冻结目标及 baseRevision 与正式授权分开，参考世界观/故事/其他资料不会成为保存目标。
用户明确原样保存选定候选时使用 save_current，即使称保存为新母版也不重新生成；引用候选作素材后要求改写并保存不属于原样保存。
选定候选可以和多份背景资料一起发送；save_current 仍只接受一份精确候选，并核验原消息全部目标条件及候选冻结目标/当前基础版本。
`freeze` 的服务端 extra 接口承载初始化 members/business 包与 action，供故事桥接消费；此接口不作为客户端或模型可传的授权。
成员 ID 由业务桥接分配，冻结后独立于来源后续变化；read_artifact 无 member_id 的初始化响应仅返回成员目录。

资产发现使用存储层的名称、类型、ID、所属 story_id、revision/version 投影，不读取正文。character/world 查 library，story 跨故事查询，
setting/outline/snapshot/chapter 必须指定可读 story_id；候选仅当前 conversation。limit 默认/最多 20，cursor 绑定会话及检索条件。
同名保留各自身份和所属信息，不自动选唯一同名对象。候选发现返回草稿摘要；用 `{type:"candidate",group_id,draft_id,draft_revision,draft_hash,member_id?}` 引用。
资产 locator 为 `{type:"asset",kind,asset_id,story_id?,revision,version}`，resolve 点读所选当前 head 并生成 content_hash；
编辑/删除/换版本返回 reference_changed/reference_unavailable，不偷偷选择最新版。发送仍重新核验完整 typed ref，原消息文字与 refs 分开保存；浏览与 resolve 不附加输入或授予写权限。
本人原版本查看仅接受本会话已记录资产或本会话候选；旧资产 history 缺失/hash 不符返回 unavailable，绝不用当前 head 替代。

## 世界观候选

`save_world/2` draft 接受完整 name、markdown、genres；age_band、era、tags 可省略，更新时保留原值。角色专属写字段被拒绝；未知合法 metadata 保留，完整 Content 冻结前规范化，正文不改换行。新世界观预览不创建正式身份，既有世界观预览固定目标及 baseRevision；同组反馈沿用 parent，另建只作取材。derived_from 只接受世界观母版或本会话完整世界观候选，不支持故事资料提升或世界观候选导入故事。

自然目标条件仅 name、genre、age_band、era、tag，复用完整查询、唯一性与当前 head 核验。旧 conversation 的世界观讨论/阅读照常，draft/save 在派发创作前进入 `world_creation_unavailable` 澄清。

## 独立核验与运行

Write 先持久原消息、refs、epoch、sourceMessageId、taskId、operationId，再以独立无工具 session 解释原消息与可信引用摘要。
解释器 thinking=off、最多 2048 输出 tokens、失败不自动重试；费用/用量与创作运行分开。自然语义由此隔离解释器判断，仍存在分类误判风险。
解释器输入附原文前 256 个 Unicode 字符的有界 UTF-16 起止位置表，辅助生成证据索引；原消息不改写，后端不自动修补错误索引。
输出严格验证 intent、目标 mode/kind、最多 8 个字段条件、原 UTF-16 证据区间和修改证据；否定、转述、多操作或不支持条件进入澄清。
目标 mode 描述产出或保存对象，引用素材不会把全新角色或故事变成已有目标。明确 draft + mode=new 时，同类型候选也只作素材，不继承其目标、baseRevision 或改写 reference；新故事分配新的预留 ID。explicit 同组反馈与 save_current 仍核验并沿用所选候选的冻结上下文；检索 story 仅支持 name，同字段条件不重复，gender/age_band/genre/tag 仅支持 eq。
目标条件只描述要选择的原有对象；期望的新性格、职业或正文改写要求不是旧目标筛选条件。明确引用候选的改写及新建属性由创作阶段处理，解释器不把新值拿来匹配旧稿；后端仍逐项校验解释结果，错误分类进入澄清。

需要检索时，原 Mochi session 的 `<taskId>:resolve:1` 只有读权限，连 draft 都拒绝。
其结果不作为授权：Write 另行按冻结条件完整查询最多 20 个摘要/5 页/60 KiB，重新 AND 匹配、核对唯一性并重读当前 head。
“之前/那个/先前/上次”还要求对象出现在本会话初始/显式/实际已读来源或成功关联历史；全库单条但无此关联不授予权限。
查询分页未完成、无匹配、多匹配、条件不符或版本变化都澄清。核验记录保存原消息 hash、分类 run/result、条件、实际候选 IDs/revisions、完整性与最终 head。
已明确目标或新建意图可直接 execute，不能从上轮 binding 推导本轮授权。明确引用仍须核验全部冻结条件的合法性及当前 head 的 AND 匹配；只有一条引用不免除该检查。

绑定只生成一次 `{operationId,authorizationId,target,action,baseRevision,selectedDraft?,evidenceDigest}`。
action 为 create_character/update_character/create_world/update_world/initialize_story/save_first_chapter/create_chapter；save_current 按精确候选归约。
没有正式保存意图时仅冻结 `draftContext`，不创建 ledger 或有权 scope；新故事候选的 ID 由后端预分配，既有故事候选保留原目标。
execute 同原 session、同 sourceMessageId，冻结 scope/refs/binding/draft_context_digest，不能改写已派发 run 或换 key 绕过 unknown。
两阶段共享 8 次模型、20 次工具、300000ms（排队除外）；execute 扣除 resolve 实际 execution_usage，缺失用量不能猜余额继续。

## 分区、取消与恢复

所有 v2 过程记录使用 `recordType:"free"`、`schemaVersion:2`、`free:<type>:<UUID>`，位于 library/scopeId=library；不进入正式 head 列表或导出。
OP directory 在 library 中与 task binding/conversation CAS 一起 create-only，固定 partition 与 binding digest，永不换目标。
角色和世界观 ledger 位于 library，故事 ledger 位于 stories/projectId=storyId；只允许目标对应分区。
`FreeOperations` 提供 active ledger 激活、撤回 tombstone、严格原 OP 查询与收据投影；角色、世界观与故事正式 batch 均已接通，过程与业务分区不混写。

取消先 CAS 会话 epoch 并标记 cancel_pending，再在目标分区创建 revoked tombstone 或 CAS active→revoked。
激活与撤回遇到同一 create-only/CAS 冲突时以目标 ledger 为准。业务先 committed 则保留收据，取消不会回滚。
目标或远端停止未确认保留 stopPending，并以 previous_operation_pending 拒绝下一任务派发。迟到解析必须通过原 epoch/activeTaskId CAS。
intent/resolve/execute 的派发标记与有效 task、会话 epoch 在同一 library CAS 中占位；两种 session 创建也采用同一边界。取消先成功时不 POST；占位先成功时，取消保留 pending，直到原 run 或创建响应已核实。

target ledger 是提交事实，library task/关联资产只是投影。投影失败可点读 directory 指向的同一 ledger，核对 binding/目标/精确稿后重复恢复。
unknown/不存在不证明未提交；不新建 OP、不重跑模型或补业务对象。session 创建前持久 dispatch 标记，创建结果未知不重复创建；
用户保留原记录，可另开新 conversation。run 已标 dispatch 后响应未知，核实只按持久 runId 或原 key GET。

## 角色与世界观正式保存

`save_character/2` 与 `save_world/2` commit 仅接受 `{mode:"commit",draft_id,draft_revision:"1",draft_hash}`。
后端重读持久 task，核对 directory/binding digest、action、目标、baseRevision 和 active OP。
`save_current` 只保存 binding.selectedDraft；直接创作保存只接受当前 task 生成且 kind 与工具一致的母版稿，不能由模型移用其他目标/轮次的候选。
已绑定目标的旧稿必须匹配原目标和基础版本，无目标的新母版预览稿才可在后续保存轮分配新母版 ID。
规范化在 draft 冻结前完成；commit 复用 Library 的 Content/词表校验，完整冻结 Content 原样写入，不改换行、不重新生成或自动 rebase。
更新只覆盖允许的 Content 字段，保留实体 source/path/raw/sourceAssetId/sourceVersion 和所有合法 legacy metadata；metadata 中的 name/id/revision 不参与覆盖后端目标证据。

独立 `free:claim:<draftId>` 在 library create-only/CAS 固定 `{draftId,operationId,payloadHash}`。
正式业务提交前，同一 library batch 将 OP 的 `draftRef/payloadHash` CAS 冻结并创建/替换 claim。
同 OP 此后仅允许该精确输入，响应未知也不能换稿；不同输入在产生新 claim 或业务写入前返回 operation_conflict。
同 OP 可重入；其他 OP 仅在原 directory 指向的 ledger 明确 revoked/conflict 且没有收据时以原 claim revision 替换。
unknown/缺失和 committed 都不释放候选，避免响应丢失后另建母版。draft API 的 claim 返回 operationId/status；receipt 点读原 OP，并核对 claim/稿 ID/revision/hash 一致，不依赖任务投影或显示其他稿的收据。

母版提交为单个 library batch：OP Replace/IfMatch（消费授权并保存 receipt）、不可变 version Create、head Create 或 Replace/IfMatch。
新建包括软删除 head 在内均 create-only 冲突；更新必须仍是同一未删母版、相同 kind 和冻结 baseRevision。事务冲突关闭原 OP 为 conflict，保留输入和候选。
同 OP 同精确输入、包括并发提交，返回原收据；不同稿/hash 返回 operation_conflict。取消和 commit CAS 同一 OP，先成功者决定。
收据 kind 为 character_created/character_updated 或 world_created/world_updated，content_hash 为完整 Content hash，revision 为正式逻辑版本字符串；head revision 仍是不透明 CAS 标记。
投影失败不改变保存成功；响应未知只读原 OP。下一轮可读取最新 head 继续修改，已固定参考仍读取原版本。母版保存不改故事独立快照或其他资产。

## 角色与故事衔接

`initialize_story/2` draft 使用与旧入口共用的初始化构建器和包校验。新故事采用 execute 前预分配的 story ID；既有故事必须为 ready、零章、基础 revision 一致，且必须带首章。资料仍最多 8 项、业务最多 10 对象；不能更新已有章节作品的资料。
仅建作品返回 story_initialized 并设置 initializationPending；作品加首章返回 first_chapter_saved 并清除该 guard。独立解释器可返回 `chapterEvidence:{start,end,text}`，仅 initialize_story 接受，必须精确匹配原 UTF-16 消息且含“首章”或“第一章”；明确新建并保存首章归约 save_first_chapter，无该证据的 initialize_story 仅允许建立作品。预览无 binding，save_current 从选定冻结包恢复唯一动作。证据片段不消除已接受的独立分类误判风险。

角色候选作为新故事来源时不会被当作角色修改目标；同类型整稿引用仍可选作改写对象，member 引用只作为资料。`assets[].candidate_ref` 仅接受当前会话完整角色候选，不接受成员或其他类型，复制完整 Content，成员 sourceRef 固定实际候选版本，不填写 sourceAssetId/sourceVersion。母版来源必须已有 initial/explicit/agent_read 记录，以原版本读取全部 Content，包括未知合法 metadata，并保留 sourceAssetId/sourceVersion。成员 ID 由后端分配；母版或候选后续改写均不改变已冻结包。内部展开不伪记 agent_read。

故事角色提炼为母版时生成完整独立 Content 与 `derivation:{source_ref,retained,rewritten,excluded}`，并可通过候选详情读取正文和说明。声明来自故事资产或初始化成员时必须提供说明且只能 new_character；derived_from 与 source_ref 同时存在时必须一致。模型应将剧情、关系的排除/改写落实到正文，后端不声称验证文学改写质量。正式保存 create-only，不覆盖来源或同名母版，不改变原故事快照。

故事提交先在 library 中将 directory 的 draftRef/payloadHash 与独立 claim 同 batch CAS 冻结；该输入一经固定，即使响应未知也不能换稿。随后在目标故事分区 CAS 固定 ledger 的同一精确输入，最后将 OP committed/receipt、业务不可变版本与 head Create/IfMatch 同 batch 提交。取消与提交竞争同一目标 ledger；library 投影失败只核实原 OP，不重写业务。它们是分区内独立事务，未提供跨分区原子性。

`create_chapter/2` draft 只对有效既有故事和非 pending 状态生成，冻结后端 chapterId；commit 验证相同故事/基础版本和 chapterId，只创建一章并与 OP 收据一起提交，story head CAS 参与 guard。候选章的正文 hash 与收据保持原规则。建立作品、写首章和后续章均沿用原 conversation/Mochi session；角色母版保存与故事保存各自一轮、各一 OP，后轮失败不回滚已成功成果。

## 兼容与验证

v1 无工具/三工具/七工具 session、旧 `creative:` records、story 分区事务、`#creative` 链接及查看即引用 UI 保持原状，不迁移/升级旧快照。
旧 v2 工具白名单顺序为 library_vocabulary/1、search_library/1、read_library/1、search_assets/2、read_asset/2、discover_artifacts/2、read_artifact/2、save_character/2、initialize_story/2、create_chapter/2。
新集合将 discover_artifacts/2 替换为 /3（kind 增加 world），末尾新增 save_world/2；其余工具保持原版本。两种集合都沿用 tool_protocol_version=2，恢复以持久能力字段为准，不更换已有运行时 session。
v2 回调继承专用 app-only 身份，逐项校验 app/session/task/run/phase/scope；请求/响应上限仍 128/64 KiB。
角色候选先读取受控词表；非法题材或年龄层返回协议 invalid_arguments，不把 Library 的界面错误文案当作工具错误码。
新工具快照的来源引用用嵌套 type 判别联合区分 asset/candidate，禁止混入另一类字段；parent_ref 与初始化 candidate_ref 只接受完整候选，derived_from/source_ref 保留合法 member 引用。改写必须同时提供 group_id 和精确 parent_ref。初始化复制候选角色使用完整 `{kind: "snapshot", candidate_ref}`，不混入 title/body 或母版复制字段；顶层 derived_from 只记录来源，不创建角色快照。身份关系、hash、范围和版本仍由 Write 校验；旧持久工具快照不原地修改。

`npm run check` 覆盖新身份、目标证据、跨分区恢复、取消、API 与存储行为及既有 v1 测试。
`MOCHI_REPO_ROOT=/absolute/path/to/mochi npm run test:integration` 增加真实 HTTP、签名身份、Pi AgentSession 和假 provider 的 v2 两阶段/同 session 续聊、预算与事件验证。
`free-session.mjs` 从没有 initialRefs 的会话自主 search/read 建立实际来源历史，随后原样发送
“找到之前那个侦探角色，把职业改成记者并保存”，本轮不带 refs；断言独立完整查询、目标身份/基础版本、
两阶段同 session 和同键恢复，日志记录合成来源、绑定证据与精确收据。检索摘要本身不计全文来源。
`free-story-bridge.mjs` 记录角色旧稿/改稿、初始化包、反向母版的精确引用及首章/续章/母版收据。
浏览器验证范围见下文；这些确定性测试不证明真实模型能自主完成同样路径，也不表示 v2 已云部署。

真实模型 smoke 必须在执行前确认本次 provider/model、账户通路与消费授权，失败及重试累计记录；有明确费用上限时按本次授权执行，不得继承旧 Plan
额度或直接套用历史 smoke 脚本的硬编码预算。仅用合成角色/故事，验收同 session 双向衔接、按成果改稿、
精确旧稿保存、无 @ 自主取材与检索后确定目标保存。未取得本次授权时此项保持未完成。
本地 gpt-5.6-luna / openai-codex 订阅已完成上述合成真实链路：同 session 角色候选→故事快照/首章/续章→独立母版，以及无预选引用的原句职业更新。续章因模型抄错版本字符，经过明确原版本纠错后保存；记录不等同无人介入首轮成功。真实调用证明更新前旧版全文与来源保留，更新后再次精确读取旧来源由当前确定性测试覆盖。
2026-09-11，v2 已经 [Actions 发布](https://github.com/Sappanwood/mochi-write/actions/runs/34492485165) 上线。
现有 openai-codex 订阅的 gpt-5.6-luna 使用合成素材完成同 session 角色候选→精确母版保存→故事首章与完整角色快照→反向独立母版。
实际 7 个用户任务包含一次明确补全：首份故事候选漏传角色快照，未正式保存；补全稿保留原 group 和精确 parent_ref，
其正式快照全文与来源母版一致。三个正式 OP 均通过公开核实接口返回原收据，刷新后两母版、故事收据与原快照一致；
反向保存没有修改故事快照。该结果覆盖真实 Managed Identity 回调和角色／故事目标分区提交，不能称为无人介入首轮完整成功。
匿名请求本人 API、本人 token 调用服务 callback 均被拒绝；旧无工具、三工具、七工具会话已验证只读恢复。
云端未重跑续章、自然目标更新或故障恢复矩阵，这些路径保留各自既有证据与待验收边界。


## 浏览器双关注点（MWT-029）

`#free/new` 首次发送前选择模型/思考强度；成功后转到 `#free/conversation/:id` 并锁定设置。
会话没有资产类型导航分支。桌面只有讨论与信息两主区，手机 390px 在讨论/信息切换；
信息区在正式详情、单份候选与 explorer 间切换。组内第 N 稿仅作显示，发送和读取使用完整精确 ref。
本会话多组候选可交错产生，新稿只增加提示，不替换当前阅读、不清空输入或引用。

输入 `@名称` 直接补全角色、世界观、作品与本会话候选；进入故事资料范围后同时补全其资料。
同名显示类型、范围/组及版本，方向键和 Enter 或点击选中。精确解析尚未返回时禁发；选择失败释放等待，迟到成功不清空后来输入，离开会话后不写回旧选择。补全与信息区“引用到对话”形成同一种可删除、可打开的标记。
只打开详情、来源、候选或 explorer 不写入消息 refs。历史消息标出已固定显式引用；浏览也不改变 task 的目标。
来源按 initial/explicit/agent_read 区分，仅搜索命中不算全文读取。已记录来源从 scoped references API 读取，
当前 head 只用于版本关系/删除状态提示，不作为旧版内容替代；原版不可取得禁用引用按钮。
首次发现的未记录资产经 resolve 固定版本，再读本人业务接口并核对 revision/version；期间变化明确拒绝，重新发现由用户触发。

信息区显示正式/候选、所属范围、新建/更新和冻结基础版本；初始化复用完整包阅读组件展示资料与可选首章。
角色反向母版显示保留、改写与排除说明。正式保存只显示真实 receipt；模型回复不产生保存标识。
未绑定显示解析/检索/澄清，不把右侧对象作为默认目标。已绑定显示后端确切目标/动作，冲突、失败、取消、待核实分开。

浏览器 sessionStorage 按 conversation ID 保留未发送输入、refs、当前阅读/滚动、最近六份内容与手机视图；
只缓存 UI 状态，不缓存全文或作为权限依据。POST 前保存完整原请求，响应未知时保持原键与固定输入，
“查询原请求”使用 GET by-request/task；“按原请求重试”才复用原 POST。迟到成功响应不清空用户后来编辑的内容。
任务、来源、成果组与组内版本按服务端 cursor 完整读取；定时刷新只 GET 投影，不重放 task 或模型。
显式“核实原任务与保存结果”调用公开 POST verify 查询原 run/OP 并修复投影。committed 但原 run 尚未终止仍禁止新消息；
确认撤回且 stopPending=false 后允许继续。刷新期间不把 GET task 当作远端终态恢复。

`tests/e2e/free.spec.ts` 使用隔离存储、真实本人 JWT/Fastify HTTP、实际 v2 callback 与确定性假 Mochi，
覆盖桌面/390px、同名/交错旧稿、角色→故事→角色、来源变动和精确不可得、丢响应及公开 verify。
它验证正式 UI，不代替 [MWT-024 原型历史走查](prototypes/free-session/README.md)、真实 Pi 集成或付费模型验收。


## 模式导航与资产往返（MWT-030）

默认无 hash 和 `#free/new` 打开自由创作。`#free/conversations` 按 conversation 展示最近任务时间、候选成果组、已确认保存数和关联资产；无正式成果的会话同样可恢复，多资产关联不重复会话行。列表读取现有 conversations/tasks/groups 分页，不新增创意对象或业务保存目标。

资产模式的 `#library/character`、`#library/world` 和 `#stories` 展示正式内容，故事书架默认进入 `#story/:id/chapter` 阅读。角色详情默认阅读，保留编辑和 CAS 冲突后的草稿对照。`ContentReading` 复用资产与自由信息区的标签、基础属性和 Markdown 正文；explorer 仅是自由信息区的查找状态。

`#free/new/character`、`#free/new/world` 与 `#free/new/story` 预填可编辑创作意图；发送前不建立会话或资产。`#free/new/asset/:id`、`#free/new/story/:id` 点读正式 head 并 resolve 精确 initialRefs，在输入上方明确展示。仅初始资料进入 initialRefs，进入后浏览不会附加引用或切换目标；世界观可讨论、预览、精确保存及更新，正式内容通过相同资产入口往返。

每个未发起入口分别保留输入；精确初始资料缓存于 sessionStorage，刷新不替换已展示版本；版本冲突保留输入，可显式“重新读取初始资料”后继续。每个已建会话保留自己的输入、引用、阅读对象和阅读位置。真实收据的“打开正式内容”进入资产／故事阅读页（角色和世界观使用 `#asset/:id/read` 读取正式 head，绕开已有人工草稿；章节收据打开实际保存的章），“返回原自由会话”恢复原会话；正式资产页同时提供关联会话及带当前已保存资料另开会话入口。正式角色阅读提供“继续未保存编辑”，恢复原人工正文及原 CAS 基线，不因阅读新 head 自动 rebase。人工编辑沿用页面内草稿与版本检查，明确标为临时人工编辑，不混同持久候选，也不自动发送正文给 Agent。

`#creative/new`、`#creative/conversations`、`#creative/conversation/:id`、`#creative/draft/:storyId/:draftId`、`#story/:id/creative` 与 `#story/:id/draft/:draftId` 继续使用原协议；导航保留“旧创作会话与草稿”，书架保留“旧版新建故事”，故事阅读保留“旧故事创作会话”。历史不迁移、不删除，旧侧栏仍限原资产／阅读页面，自由会话不挂载 WritingHost。移动端自由会话提供独立模式与内容导航。

新建世界观默认进入自由会话，原 `#new/world` 直接编辑链接仍可用。旧 conversation 顶部明确列出世界观仅可讨论/阅读，并提供主动新建入口；新入口只预填意图，未发送前不建记录，不转移旧聊天、候选或授权。原侧栏及章节新版本功能保留。

## 单故事资料候选

新建 conversation 现在使用 materials-v1 十二工具快照：world-v1 基础上 discover_artifacts/4、read_artifact/3，追加 revise_story_materials/2。旧 world-v1/十工具/v1 保留持久能力，不升级。
资料候选与正式 commit 已实现。目标限定 ready、非 pending、已有章节的单故事。独立解释 materials 请求并核验原文证据后固定 1–8 个成员；snapshot 可新建或更新，setting/outline 仅更新唯一既有对象。缺失/多匹配澄清，不能 upsert。包成员逐项固定后端 ID、模式、基础 revision/version 与来源，创作工具只按 key 提供完整 name/markdown 或 copy_source，不得漏项/增项。
同组反馈保持原成员和基线，即使正式资料后来变化；改变成员范围需明确另建组。首次来源复制只传 key/copy_source=true，不同时传 name/markdown；同组反馈每项都传完整 name/markdown（包括既有来源成员），不再使用 copy_source。来源复制完整 Content 与合法 metadata，母版保留 sourceAssetId/sourceVersion；同会话未保存角色复制保留 sourceCandidate 的 conversationId/groupId/draftId/draftRevision/draftHash，不要求先存母版。候选 sourceRef 保持精确来源；内部展开不伪记 agent_read。跨会话候选、世界观候选入故事仍拒绝。
单 Content 60 KiB、参数120 KiB、完整包256 KiB，每task八稿/1 MiB沿用原限制。候选成员目录不算全文读取，read_artifact/3 按 member_id 返回全文并记录来源。

## 单故事资料正式保存

revise_story_materials commit 仅接收 draft_id/revision/hash，绑定的 materials 与候选成员必须完全一致。
library directory/claim 固定精确输入，stories ledger 再 CAS 固定，最后一个故事 batch 包含全部成员 version Create、
head Create/IfMatch、未修改业务内容的 story head IfMatch guard 与 OP/receipt。最多 8 成员、18 操作，实际 batch JSON 最多1 MiB。
任一成员冲突使整包业务不写；既有章节、未列成员、母版与其他故事不变。资料更新保留未知合法 Content metadata 及实体来源。
取消与提交竞争同 ledger，同键同包返回原收据；响应或投影未知只核实原 OP，不重跑模型或另建快照。
收据 assets 明确每成员 ID/kind/mode/逻辑版本/完整 Content hash，content_hash 为精确 draft_hash，无 chapter。
资料保存后下一轮可读取新 head 用于续章，旧已记录引用仍读旧版；两个 OP 独立。

## 资料候选阅读

信息区逐项显示新增/更新、冻结的基础业务版本、完整正文与属性、母版或本会话候选的精确入包来源。参考来源独立列示，引用不自动增加成员。浏览、切换旧稿和新稿提醒不授权保存。资料真实收据列出各成员模式与结果版本，可进入对应资料阅读页并返回原会话。旧十工具/world-v1 会话提示资料能力限制并提供主动新建入口，原聊天、候选和授权不转移。

资料分类器提示短消息（最多 256 个 UTF-16 code units）使用完整原文证据，长消息按位置表选择精确片段；这不改变后端的逐字核验和意图授权。模型仍可能产生非法结构、位置或目标，拒绝后由用户澄清；产品不自动修正授权或重试。
