import type { JSONContent } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { jsonContentHasType, mediaPathKey } from "./content";

describe("mediaPathKey", () => {
  it("reads the key of a Media path, alone or on the site's address", () => {
    expect(mediaPathKey("/images/a.png?quality=80", "blog.example")).toBe(
      "a.png",
    );
    expect(
      mediaPathKey("https://blog.example/images/a.png", "blog.example"),
    ).toBe("a.png");
    expect(
      mediaPathKey("http://BLOG.example/images/a.png?v=2", "blog.example"),
    ).toBe("a.png");
  });

  it("takes any other address for an external image", () => {
    for (const src of [
      "https://cdn.example/images/a.png",
      "https://blog.example.evil/images/a.png",
      "https://blog.example:8443/images/a.png",
      "//blog.example/images/a.png",
      "https://blog.example/uploads/a.png",
      "ftp://blog.example/images/a.png",
    ]) {
      expect(mediaPathKey(src, "blog.example")).toBeUndefined();
    }
  });
});

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
