import type { JSONContent } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { FALLBACK_SLUG, jsonContentHasType, slugify } from "./content";

const doc = (...content: Array<JSONContent>): JSONContent => ({
  type: "doc",
  content,
});

describe("jsonContentHasType", () => {
  it("returns false for empty content", () => {
    expect(jsonContentHasType(null, "codeBlock")).toBe(false);
    expect(jsonContentHasType(doc(), "codeBlock")).toBe(false);
  });

  it("finds nested code and math nodes", () => {
    const content = doc(
      {
        type: "paragraph",
        content: [{ type: "inlineMath", attrs: { latex: "x" } }],
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const n = 1;" }],
      },
    );

    expect(jsonContentHasType(content, "codeBlock")).toBe(true);
    expect(jsonContentHasType(content, ["inlineMath", "blockMath"])).toBe(true);
    expect(jsonContentHasType(content, "blockMath")).toBe(false);
    expect(jsonContentHasType(content, "image")).toBe(false);
  });
});

describe("slugify", () => {
  it.each([
    ["Hello, World!", "hello-world"],
    ["Hello   under_score", "hello-under-score"],
    ["你好，世界 2026", "你好世界-2026"],
    ["--Dashes--  and---more--", "dashes-and-more"],
  ])("makes a slug of %j", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it.each([
    ["a ligature", "ﬁle", "file"],
    ["an ffi ligature", "o\uFB03ce", "office"],
    [
      "fullwidth letters and digits",
      "ＡＵＤＩＴ３ Fullwidth",
      "audit3-fullwidth",
    ],
    ["a fullwidth space", "ＡＢＣ\u3000ＤＥＦ", "abc-def"],
    ["sharp s", "Straße", "strasse"],
    ["capital sharp s", "STRAẞE", "strasse"],
    ["accents", "Café Crème", "cafe-creme"],
    ["decomposed accents", "Cafe\u0301", "cafe"],
  ])("keeps the letters of %s", (_name, title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it.each([
    ["emoji alone", "😀🎉"],
    ["a joined emoji", "👩\u200D💻"],
    ["symbols alone", "★ ✓ ?!"],
    ["empty", ""],
    ["blank", "   "],
    ["nothing", null],
    ["a script it does not keep", "ひらがな"],
  ])("falls back to untitled-log for %s", (_name, title) => {
    expect(slugify(title)).toBe(FALLBACK_SLUG);
    expect(FALLBACK_SLUG).toBe("untitled-log");
  });

  it("drops emoji and keeps the letters around them", () => {
    expect(slugify("Launch 🚀 day")).toBe("launch-day");
  });
});
