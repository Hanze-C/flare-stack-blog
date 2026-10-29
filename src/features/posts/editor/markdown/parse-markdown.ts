import type { JSONContent } from "@tiptap/core";
import { getMarkdownManager } from "@/features/posts/editor/markdown/markdown-manager";

const MIN_HEADING_LEVEL = 2;
const MAX_HEADING_LEVEL = 4;

const FRONT_MATTER = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export interface ParseMarkdownOptions {
  /** Whether an image may stay an image; the others are kept as text. */
  acceptsImage: (src: string) => boolean;
  /**
   * `fit` moves every heading so the highest is H2, as for a paste of a
   * document with its own title. `keep` lowers them one level only when
   * there is an H1, so H2 to H4 come back as they were written.
   */
  headings: "fit" | "keep";
}

export interface ParsedMarkdown {
  content: Array<JSONContent>;
  /** Sources of the refused images, kept as `![alt](src)` text. */
  refusedImages: Array<string>;
}

function imageAsText(node: JSONContent): JSONContent {
  const alt = node.attrs?.alt ?? "";
  const src = node.attrs?.src ?? "";
  return { type: "text", text: `![${alt}](${src})` };
}

function minHeadingLevel(nodes: Array<JSONContent>): number {
  return nodes.reduce((min, node) => {
    const own =
      node.type === "heading"
        ? (node.attrs?.level ?? min)
        : Number.POSITIVE_INFINITY;
    return Math.min(min, own, minHeadingLevel(node.content ?? []));
  }, Number.POSITIVE_INFINITY);
}

interface NormalizeContext {
  acceptsImage: (src: string) => boolean;
  headingOffset: number;
  refusedImages: Array<string>;
}

function acceptImage(node: JSONContent, context: NormalizeContext) {
  const src = node.attrs?.src ?? "";
  if (context.acceptsImage(src)) return true;
  context.refusedImages.push(src);
  return false;
}

function normalizeInline(
  nodes: Array<JSONContent>,
  context: NormalizeContext,
): Array<JSONContent> {
  return nodes.map((node) => {
    if (node.type !== "image") return node;
    acceptImage(node, context);
    return imageAsText(node);
  });
}

/** Images are blocks in the editor, so a paragraph splits around them. */
function splitParagraph(
  paragraph: JSONContent,
  context: NormalizeContext,
): Array<JSONContent> {
  const content = paragraph.content ?? [];
  if (!content.some((node) => node.type === "image")) return [paragraph];

  const blocks: Array<JSONContent> = [];
  let run: Array<JSONContent> = [];
  const flush = () => {
    if (run.some((node) => node.type !== "text" || node.text?.trim())) {
      blocks.push({ ...paragraph, content: run });
    }
    run = [];
  };

  for (const node of content) {
    if (node.type !== "image") {
      run.push(node);
    } else if (acceptImage(node, context)) {
      flush();
      blocks.push(node);
    } else {
      run.push(imageAsText(node));
    }
  }
  flush();
  return blocks;
}

function normalizeBlocks(
  blocks: Array<JSONContent>,
  context: NormalizeContext,
): Array<JSONContent> {
  return blocks.flatMap((block): Array<JSONContent> => {
    switch (block.type) {
      case "image":
        if (acceptImage(block, context)) return [block];
        return [{ type: "paragraph", content: [imageAsText(block)] }];
      case "paragraph":
        return splitParagraph(block, context);
      case "heading": {
        const level =
          (block.attrs?.level ?? MIN_HEADING_LEVEL) + context.headingOffset;
        return [
          {
            ...block,
            attrs: {
              ...block.attrs,
              level: Math.min(
                Math.max(level, MIN_HEADING_LEVEL),
                MAX_HEADING_LEVEL,
              ),
            },
            content: normalizeInline(block.content ?? [], context),
          },
        ];
      }
      case "codeBlock":
        return [block];
      default: {
        if (!block.content) return [block];
        const content = normalizeBlocks(block.content, context);
        if (block.type === "listItem" && content[0]?.type !== "paragraph") {
          content.unshift({ type: "paragraph" });
        }
        return [{ ...block, content }];
      }
    }
  });
}

function headingOffset(
  minLevel: number,
  headings: ParseMarkdownOptions["headings"],
) {
  if (!Number.isFinite(minLevel)) return 0;
  if (headings === "fit") return MIN_HEADING_LEVEL - minLevel;
  return minLevel < MIN_HEADING_LEVEL ? MIN_HEADING_LEVEL - minLevel : 0;
}

/**
 * Markdown as editor content: front matter is dropped, headings stay within
 * H2 to H4, images become blocks of their own, and what the editor has no
 * node for (task lists, footnotes, HTML it does not know) is kept as text.
 */
export function parseMarkdown(
  markdown: string,
  options: ParseMarkdownOptions,
): ParsedMarkdown {
  const parsed = getMarkdownManager().parse(markdown.replace(FRONT_MATTER, ""));
  const content = parsed.content ?? [];
  const context: NormalizeContext = {
    acceptsImage: options.acceptsImage,
    headingOffset: headingOffset(minHeadingLevel(content), options.headings),
    refusedImages: [],
  };

  return {
    content: normalizeBlocks(content, context),
    refusedImages: context.refusedImages,
  };
}
