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
  const control = {
    intent: "discuss",
    mode: "discover",
    body: "守望者举起银色灯盏，紫色火光越过雾港。\n",
    includeChapter: true,
    assets: [],
    failAfterCommit: false,
  };
  return {
    calls,
    control,
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
                intent: control.intent,
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
          if (control.intent === "save_current") {
            assert.ok(input.task.selected_draft);
            content =
              results.length === 0
                ? tool("initialize_story", {
                    mode: "commit",
                    ...input.task.selected_draft,
                  })
                : [{ type: "text", text: "已保存选定初始化版本。" }];
          } else if (
            control.mode === "chapter" ||
            control.mode === "continue"
          ) {
            const name =
              control.mode === "continue"
                ? "create_chapter"
                : "initialize_story";
            if (results.length === 0)
              content = tool(
                name,
                control.mode === "continue"
                  ? { mode: "draft", title: "后续章节", body: control.body }
                  : {
                      mode: "draft",
                      title: "合成雾港故事",
                      assets: control.assets,
                      chapter: { title: "雾港首章", body: control.body },
                    },
              );
            else if (
              results.length === 1 &&
              control.intent === "create_and_save"
            ) {
              const { draft_id, draft_revision, draft_hash } = last.data;
              content = tool(name, {
                mode: "commit",
                draft_id,
                draft_revision,
                draft_hash,
              });
            } else content = [{ type: "text", text: "本轮成果已处理。" }];
          } else if (results.length === 0)
            content = tool("library_vocabulary", {});
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
          else if (control.mode === "initialize" && results.length === 5) {
            const sources = [results[2], results[4]].map(
              (r) => JSON.parse(textOf(r)).data,
            );
            content = tool("initialize_story", {
              mode: "draft",
              title: "合成雾港故事",
              assets: [
                {
                  kind: "setting",
                  title: "雾港约定",
                  body: "紫色火焰为归船引航。",
                },
                ...sources.map((source) => ({
                  kind: "snapshot",
                  source_id: source.asset_id,
                  source_version: source.version,
                  source_hash: source.content_hash,
                })),
              ],
              ...(control.includeChapter
                ? { chapter: { title: "雾港首章", body: control.body } }
                : {}),
            });
          } else if (
            control.mode === "initialize" &&
            results.length === 6 &&
            ["initialize_only", "create_and_save"].includes(control.intent)
          ) {
            const { draft_id, draft_revision, draft_hash } = last.data;
            content = tool("initialize_story", {
              mode: "commit",
              draft_id,
              draft_revision,
              draft_hash,
            });
          } else
            content = [
              {
                type: "text",
                text: "已找到合成角色与世界观，先讨论方向，尚未建立作品。",
              },
            ];
          if (
            control.failAfterCommit &&
            results.some((r) => JSON.parse(textOf(r)).receipt)
          )
            reason = "length";
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
