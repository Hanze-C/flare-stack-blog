import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { createSchemaExtensions } from "@/features/posts/editor/schema";
import {
  inspectPostContent,
  POST_MARK_TYPES,
  POST_NODE_TYPES,
} from "./post-content-rules";

describe("Post content rules", () => {
  it("know exactly the node and mark types of the editor schema", () => {
    const schema = getSchema(createSchemaExtensions());
    expect([...POST_NODE_TYPES].sort()).toEqual(
      Object.keys(schema.nodes).sort(),
    );
    expect([...POST_MARK_TYPES].sort()).toEqual(
      Object.keys(schema.marks).sort(),
    );
  });

  it("finds unknown node and mark types at any depth, each once", () => {
    const problems = inspectPostContent({
      type: "doc",
      content: [
        { type: "callout", content: [{ type: "paragraph" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "highlight" }] },
            { type: "text", text: "b", marks: [{ type: "highlight" }] },
          ],
        },
        { type: "callout" },
        { content: [] },
      ],
    });
    expect(problems.nodeTypes).toEqual(["callout", "(missing type)"]);
    expect(problems.markTypes).toEqual(["highlight"]);
  });

  it("lists image sources, an absent one as empty", () => {
    const problems = inspectPostContent({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "/images/a.png" } },
        { type: "image", attrs: {} },
      ],
    });
    expect(problems.imageSources).toEqual(["/images/a.png", ""]);
  });
});
