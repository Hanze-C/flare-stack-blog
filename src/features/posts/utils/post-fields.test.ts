import { describe, expect, it } from "vitest";
import {
  isPostSummaryFormat,
  isValidPostSlug,
  isValidPostTitle,
  POST_SLUG_MAX_LENGTH,
  truncateGeneratedSlug,
} from "./post-fields";

describe("isValidPostTitle", () => {
  it("takes a title with text, up to the limit", () => {
    expect(isValidPostTitle("  Hello  ")).toBe(true);
    expect(isValidPostTitle("x".repeat(200))).toBe(true);
  });

  it("refuses an empty, blank or overlong title", () => {
    expect(isValidPostTitle("")).toBe(false);
    expect(isValidPostTitle("   ")).toBe(false);
    expect(isValidPostTitle("x".repeat(201))).toBe(false);
  });
});

describe("isPostSummaryFormat", () => {
  it("takes tabs, line breaks and an emoji joiner", () => {
    expect(isPostSummaryFormat("one\ttwo\r\nthree\nfour")).toBe(true);
    expect(isPostSummaryFormat("👩\u200D💻")).toBe(true);
    expect(isPostSummaryFormat("")).toBe(true);
  });

  it.each(["a\u0000b", "a\u000Bb", "\u001B[31m", "a\u200Bb", "a\u202Eb"])(
    "refuses %j",
    (summary) => {
      expect(isPostSummaryFormat(summary)).toBe(false);
    },
  );
});

describe("isValidPostSlug", () => {
  it.each(["hello-world", "你好-世界", "v1.2", "  padded  ", "Mixed_Case"])(
    "takes %j",
    (slug) => {
      expect(isValidPostSlug(slug)).toBe(true);
    },
  );

  it.each([
    "",
    "   ",
    "a/b",
    "a?b",
    "a#b",
    "100%",
    "a\\b",
    "two words",
    "tab\tbed",
    "bell\u0007",
    ".",
    "..",
    "x".repeat(POST_SLUG_MAX_LENGTH + 1),
  ])("refuses %j", (slug) => {
    expect(isValidPostSlug(slug)).toBe(false);
  });
});

describe("truncateGeneratedSlug", () => {
  it("leaves a short slug alone", () => {
    expect(truncateGeneratedSlug("hello-world")).toBe("hello-world");
  });

  it("cuts a long slug, leaving room for a suffix, without a trailing dash", () => {
    const cut = truncateGeneratedSlug(`${"a".repeat(179)}-${"b".repeat(50)}`);
    expect(cut).toBe("a".repeat(179));
    expect(isValidPostSlug(`${cut}-123-abcdef`)).toBe(true);
  });
});
