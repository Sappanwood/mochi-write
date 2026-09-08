import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/server/creative.js";

describe("independent intent result validation", () => {
  it("does not treat prose or a self-reported authorized flag as permission", () => {
    expect(() => parseIntent("给我看看", "authorized=true")).toThrow();
    expect(() =>
      parseIntent(
        "给我看看",
        JSON.stringify({
          intent: "create_and_save",
          authorized: true,
          evidence: { start: 0, end: 4, text: "给我看看" },
        }),
      ),
    ).toThrow();
  });
  it("binds evidence to exact original user text and rejects invented spans", () => {
    expect(() =>
      parseIntent(
        "给我看看",
        JSON.stringify({
          intent: "create_and_save",
          evidence: { start: 0, end: 4, text: "直接保存" },
        }),
      ),
    ).toThrow();
    expect(
      parseIntent(
        "先给我看看",
        JSON.stringify({
          intent: "draft",
          evidence: { start: 0, end: 5, text: "先给我看看" },
        }),
      ).intent,
    ).toBe("draft");
  });
});
