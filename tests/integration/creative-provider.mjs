import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
export function controlledCreativeProvider() {
  const calls = [];
  const control = { intent: "create_and_save", failAfterCommit: false };
  return {
    calls,
    control,
    configureRuntime(pi, streamFactory) {
      const original = pi.runtime.streamSimple;
      pi.runtime.streamSimple = (model, context) => {
        calls.push(JSON.parse(JSON.stringify(context)));
        const index = context.messages.findLastIndex(
          (message) => message.role === "user",
        );
        const input = JSON.parse(textOf(context.messages[index]));
        const toolResults = context.messages
          .slice(index + 1)
          .filter((message) => message.role === "toolResult");
        let content,
          reason = "stop";
        const tool = (name, args) => {
          reason = "toolUse";
          return [
            { type: "toolCall", id: randomUUID(), name, arguments: args },
          ];
        };
        if (!context.tools?.length) {
          content = [
            {
              type: "text",
              text: JSON.stringify({
                intent: control.intent,
                evidence: {
                  start: 0,
                  end: input.user_message.length,
                  text: input.user_message,
                },
              }),
            },
          ];
        } else if (input.task.intent === "save_current") {
          assert.ok(
            context.messages
              .slice(0, index)
              .some((message) => message.role === "toolResult"),
            "Follow-up requires previous complete tool history",
          );
          const selected = input.task.selected_draft;
          if (toolResults.length === 0)
            content = tool("read_asset", {
              asset_id: selected.draft_id,
              revision: selected.draft_revision,
            });
          else if (toolResults.length === 1)
            content = tool("create_chapter", { mode: "commit", ...selected });
          else content = [{ type: "text", text: "已保存选定版本。" }];
        } else {
          const result = toolResults.length
            ? JSON.parse(textOf(toolResults.at(-1)))
            : undefined;
          if (toolResults.length === 0)
            content = tool("search_assets", { query: "林舟", limit: 5 });
          else if (toolResults.length === 1) {
            assert.equal(result.outcome, "ok");
            const asset = result.data.items[0];
            assert.ok(asset, "Synthetic character must be discovered");
            content = tool("read_asset", {
              asset_id: asset.asset_id,
              revision: asset.revision,
            });
          } else if (toolResults.length === 2) {
            assert.equal(result.outcome, "ok");
            assert.ok(result.data.content.includes("黄铜指环"));
            content = tool("create_chapter", {
              mode: "draft",
              title: "暴风灯塔",
              body: "林舟摸了摸祖父留下的黄铜指环。雷声滚过潮汐港，他仍举起灯，为归船照亮海岸。\n",
            });
          } else if (
            toolResults.length === 3 &&
            input.task.allowed_action === "create_chapter_once"
          ) {
            assert.equal(result.outcome, "ok");
            const { draft_id, draft_revision, draft_hash } = result.data;
            content = tool("create_chapter", {
              mode: "commit",
              draft_id,
              draft_revision,
              draft_hash,
            });
          } else {
            if (control.failAfterCommit) reason = "length";
            content = [{ type: "text", text: "会话回复与独立正文不同。" }];
          }
        }
        const message = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content,
          stopReason: reason,
          usage: {
            input: 20,
            output: 10,
            cacheRead: 2,
            cacheWrite: 0,
            totalTokens: 32,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        const stream = streamFactory();
        stream.push({ type: "done", reason, message });
        return stream;
      };
      return () => {
        pi.runtime.streamSimple = original;
      };
    },
  };
}
