import { describe, expect, it } from "vitest";
import {
  resolvePublicName,
  withCategoryFilter,
  withTagFilter,
  withUncategorizedFilter,
} from "./post-public-search";

describe("posts public search", () => {
  it("opens a Tag as the only filter", () => {
    expect(withTagFilter("Workers")).toEqual({ tagName: "Workers" });
  });

  it("opens a Category as the only filter", () => {
    expect(withCategoryFilter("生活")).toEqual({ categoryName: "生活" });
  });

  it("opens uncategorized as its own view", () => {
    expect(withUncategorizedFilter()).toEqual({ uncategorized: true });
  });

  it("addresses a Tag or Category by its name in any case", () => {
    const names = ["Workers", "生活", "workers-kv"];
    expect(resolvePublicName(names, "Workers")).toBe("Workers");
    expect(resolvePublicName(names, "workers")).toBe("Workers");
    expect(resolvePublicName(names, "WORKERS-KV")).toBe("workers-kv");
    expect(resolvePublicName(names, "生活")).toBe("生活");
  });

  it("prefers the exact spelling when two names differ only in case", () => {
    expect(resolvePublicName(["Go", "GO"], "GO")).toBe("GO");
    expect(resolvePublicName(["Go", "GO"], "go")).toBe("Go");
  });

  it("finds no page for an unknown name and no filter for no name", () => {
    expect(resolvePublicName(["Workers"], "Pages")).toBeNull();
    expect(resolvePublicName([], "Workers")).toBeNull();
    expect(resolvePublicName(["Workers"], undefined)).toBeUndefined();
  });
});
