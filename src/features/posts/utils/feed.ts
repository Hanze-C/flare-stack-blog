import { desc, isNotNull, sql } from "drizzle-orm";
import { Feed } from "feed";
import type { SiteConfig } from "@/features/config/config.schema";
import * as ConfigService from "@/features/config/service/config.service";
import { publicModifiedAt } from "@/features/posts/public-snapshot";
import { renderFeedHtml } from "@/features/posts/utils/feed-html";
import { getDb } from "@/lib/db";
import { PostsTable } from "@/lib/db/schema";
import { serverEnv } from "@/lib/env/server.env";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getPublicFeedEmail(social: SiteConfig["social"]) {
  const emailUrl = social.find((link) => link.platform === "email")?.url.trim();

  if (!emailUrl) return undefined;

  const rawAddress = emailUrl
    .replace(/^mailto:/i, "")
    .split("?")[0]
    ?.trim();

  if (!rawAddress) return undefined;

  const address = decodeURIComponent(rawAddress);
  return EMAIL_PATTERN.test(address) ? address : undefined;
}

export async function buildFeed(env: Env, executionCtx: ExecutionContext) {
  const db = getDb(env);
  const siteConfig = await ConfigService.getSiteConfig({
    env,
    db,
    executionCtx,
  });
  const posts = await db
    .select({
      id: PostsTable.id,
      publicSnapshotJson: PostsTable.publicSnapshotJson,
      publicSlug: PostsTable.publicSlug,
    })
    .from(PostsTable)
    .where(isNotNull(PostsTable.publicSnapshotJson))
    .orderBy(
      desc(
        sql`json_extract(${PostsTable.publicSnapshotJson}, '$.publishedAt')`,
      ),
    )
    .limit(100);
  const { DOMAIN } = serverEnv(env);
  const year = new Date().getUTCFullYear();
  const feedAuthor = {
    name: siteConfig.author,
    email: getPublicFeedEmail(siteConfig.social),
    link: `https://${DOMAIN}/`,
  };

  // The feed was last updated when its newest change was published, not when
  // it was built and not when a draft was saved.
  const updated = posts.reduce<Date | undefined>((latest, post) => {
    if (!post.publicSnapshotJson) return latest;
    const modifiedAt = publicModifiedAt(post.publicSnapshotJson);
    return !latest || modifiedAt > latest ? modifiedAt : latest;
  }, undefined);

  const feed = new Feed({
    updated,
    title: siteConfig.title,
    description: siteConfig.description,
    id: `https://${DOMAIN}/`,
    link: `https://${DOMAIN}/`,
    favicon: `https://${DOMAIN}/favicon.ico`,
    copyright: `All rights reserved ${year}, ${siteConfig.author}`,
    generator: siteConfig.title,
    author: feedAuthor,
  });

  posts.forEach((post) => {
    const snapshot = post.publicSnapshotJson;
    if (!snapshot) return;
    feed.addItem({
      title: snapshot.title,
      id: post.id.toString(),
      link: `https://${DOMAIN}/post/${encodeURIComponent(post.publicSlug ?? snapshot.slug)}`,
      description: snapshot.summary ?? "",
      content: renderFeedHtml(snapshot.contentJson, `https://${DOMAIN}`),
      author: [feedAuthor],
      date: publicModifiedAt(snapshot),
      published: new Date(snapshot.publishedAt),
    });
  });

  return feed;
}
