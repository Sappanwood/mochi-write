import { describe, expect, it } from "vitest";
import { references } from "../src/server/markdown.js";

const path = "projects/灯塔/setting.md";
describe("imported Markdown references", () => {
  it.each([
    "[library/characters/林舟.md](../../library/characters/林舟.md)",
    "[library/characters/仅为显示名.md](../../library/characters/林舟.md)",
    "[`library/characters/仅为显示名.md`](../../library/characters/林舟.md)",
    '[人物 [library/characters/显示名.md]](../../library/characters/林舟.md "library/characters/标题.md")',
    "[library/characters/显示名.md][人物]\n\n[人物]: ../../library/characters/林舟.md",
  ])("reads the destination without interpreting the label: %s", (text) => {
    expect(references({ path, text })).toEqual(["library/characters/林舟.md"]);
  });

  it("keeps adjacent master and snapshot links separate in a table", () => {
    expect(
      references({
        path,
        text: "| [library/characters/林舟.md](../../library/characters/林舟.md) | [snapshots/林舟.md](snapshots/林舟.md) |",
      }),
    ).toEqual([
      "library/characters/林舟.md",
      "projects/灯塔/snapshots/林舟.md",
    ]);
  });

  it("supports encoded destinations, spaces, balanced parentheses and anchors", () => {
    expect(
      references({
        path,
        text: '[人物](<../../library/characters/林 舟(青年).md#资料> "说明")\n[快照](snapshots/%E6%9E%97%E8%88%9F.md)',
      }),
    ).toEqual([
      "library/characters/林 舟(青年).md",
      "projects/灯塔/snapshots/林舟.md",
    ]);
  });

  it("preserves legacy bare and inline-code routes", () => {
    expect(
      references({
        path,
        text: "../../library/characters/林舟.md\n`library/worlds/雾海.md`\n| snapshots/林舟.md |",
      }),
    ).toEqual([
      "library/characters/林舟.md",
      "library/worlds/雾海.md",
      "projects/灯塔/snapshots/林舟.md",
    ]);
  });

  it("does not treat external links or their labels as bundled files", () => {
    expect(
      references({
        path,
        text: "[library/characters/林舟.md](https://example.com/library/characters/林舟.md)",
      }),
    ).toEqual([]);
  });

  it.each([
    "../../../escape.md",
    "../../library/%2e%2e/%2e%2e/escape.md",
    "/library/characters/林舟.md",
    "../../library/characters/a%5Cb.md",
    "../../library/characters/a%00b.md",
    "../../library/characters/%ZZ.md",
  ])("rejects unsafe or malformed local destinations: %s", (target) => {
    expect(() => references({ path, text: `[人物](${target})` })).toThrow();
  });
});
