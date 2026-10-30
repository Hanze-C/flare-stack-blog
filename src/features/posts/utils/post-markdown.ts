import type { JSONContent } from "@tiptap/core";
import { parseMarkdown } from "@/features/posts/editor/markdown/parse-markdown";
import { serializeMarkdown } from "@/features/posts/editor/markdown/serialize-markdown";
import { parseVideoInput } from "@/features/posts/utils/video-source";

/*
 * Post content as the HTTP API exchanges it in Markdown (ADR 0032): parsed
 * like a paste, except that a video link alone on a line is a video block,
 * and an image must be one the server can show.
 */

const MEDIA_PATH = /^\/images\/[^/?#\s]+(?:\?\S*)?$/;

/** A web address, or the path of an uploaded **Media** item. */
export function isPostMarkdownImage(src: string): boolean {
  if (MEDIA_PATH.test(src)) return true;
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    new URL(src);
    return true;
  } catch {
    return false;
  }
}

/** The video a paragraph names when it holds nothing but its link. */
function videoOfLine(paragraph: JSONContent): JSONContent | null {
  const [only, ...rest] = paragraph.content ?? [];
  if (!only || rest.length > 0 || only.type !== "text") return null;
  if (only.marks?.some((mark) => mark.type !== "link")) return null;
  const input = parseVideoInput(only.text ?? "");
  return input.kind === "video"
    ? {
        type: "video",
        attrs: { ...input.source, title: null, cover: null, duration: null },
      }
    : null;
}

function liftVideoLinks(
  blocks: Array<JSONContent>,
  parentType?: string,
): Array<JSONContent> {
  return blocks.map((block, index) => {
    if (block.type === "paragraph") {
      // A list item opens with a paragraph.
      if (parentType === "listItem" && index === 0) return block;
      return videoOfLine(block) ?? block;
    }
    if (!block.content || block.type === "codeBlock") return block;
    return { ...block, content: liftVideoLinks(block.content, block.type) };
  });
}

export interface PostMarkdownContent {
  contentJson: JSONContent;
  /** Images that are neither web addresses nor Media paths. */
  refusedImages: Array<string>;
}

export function postContentFromMarkdown(markdown: string): PostMarkdownContent {
  const { content, refusedImages } = parseMarkdown(markdown, {
    acceptsImage: isPostMarkdownImage,
    headings: "keep",
  });
  const blocks = liftVideoLinks(content);
  return {
    contentJson: {
      type: "doc",
      content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
    },
    refusedImages,
  };
}

export function postContentToMarkdown(
  contentJson: JSONContent | null,
): string | null {
  // A body with nothing to write, such as one empty paragraph, is no body.
  return (contentJson && serializeMarkdown(contentJson)) || null;
}
