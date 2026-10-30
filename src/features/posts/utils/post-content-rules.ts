import type { JSONContent } from "@tiptap/core";

/*
 * What a `contentJson` write may hold, the same rules Markdown writes follow
 * (ADR 0032): only node and mark types the editor schema knows, and only
 * images the server can show. The lists are written out so a JSON write does
 * not load the editor schema; a test keeps them equal to it.
 */

export const POST_NODE_TYPES: ReadonlyArray<string> = [
  "doc",
  "text",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "image",
  "video",
  "inlineMath",
  "blockMath",
];

export const POST_MARK_TYPES: ReadonlyArray<string> = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
];

const NODE_TYPES = new Set(POST_NODE_TYPES);
const MARK_TYPES = new Set(POST_MARK_TYPES);

export interface PostContentProblems {
  /** Node types the editor does not know, each once. */
  nodeTypes: Array<string>;
  /** Mark types the editor does not know, each once. */
  markTypes: Array<string>;
  /** Sources of the images, in document order, to be checked by the caller. */
  imageSources: Array<string>;
}

function typeName(type: string | undefined) {
  return type === undefined || type === "" ? "(missing type)" : type;
}

/** Unknown node and mark types in `contentJson`, and every image source. */
export function inspectPostContent(
  contentJson: JSONContent,
): PostContentProblems {
  const nodeTypes = new Set<string>();
  const markTypes = new Set<string>();
  const imageSources: Array<string> = [];

  const visit = (node: JSONContent) => {
    if (!node.type || !NODE_TYPES.has(node.type)) {
      nodeTypes.add(typeName(node.type));
    }
    for (const mark of node.marks ?? []) {
      if (!MARK_TYPES.has(mark.type)) markTypes.add(typeName(mark.type));
    }
    if (node.type === "image") {
      const src = node.attrs?.src;
      imageSources.push(typeof src === "string" ? src : "");
    }
    node.content?.forEach(visit);
  };
  visit(contentJson);

  return {
    nodeTypes: [...nodeTypes],
    markTypes: [...markTypes],
    imageSources,
  };
}
