import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

export function initializationProvider() {
  const calls = [];
  return {
    calls,
    configureRuntime(pi, streamFactory) {
      const original = pi.runtime.streamSimple;
      pi.runtime.streamSimple = (model, context) => {
        calls.push(JSON.parse(JSON.stringify(context)));
        const start = context.messages.findLastIndex((m) => m.role === "user");
        const input = JSON.parse(textOf(context.messages[start]));
        const results = context.messages
          .slice(start + 1)
          .filter((m) => m.role === "toolResult");
        let content;
        let reason = "stop";
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
                intent: "discuss",
                evidence: {
                  start: 0,
                  end: input.user_message.length,
                  text: input.user_message,
                },
              }),
            },
          ];
        } else {
          const last = results.length
            ? JSON.parse(textOf(results.at(-1)))
            : undefined;
          if (last) assert.equal(last.outcome, "ok", JSON.stringify(last));
          if (results.length === 0) content = tool("library_vocabulary", {});
          else if (results.length === 1)
            content = tool("search_library", {
              kind: "character",
              occupation: "守望者",
              limit: 5,
            });
          else if (results.length === 2 || results.length === 4) {
            const hit = last.data.items[0];
            assert.ok(hit, "A synthetic library asset must be discovered");
            assert.equal(
              "markdown" in hit,
              false,
              "Discovery must not return full text",
            );
            content = tool("read_library", {
              asset_id: hit.asset_id,
              revision: hit.revision,
            });
          } else if (results.length === 3)
            content = tool("search_library", {
              kind: "world",
              era: "近代",
              limit: 5,
            });
          else
            content = [
              {
                type: "text",
                text: "已找到合成角色与世界观，先讨论方向，尚未建立作品。",
              },
            ];
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
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
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
