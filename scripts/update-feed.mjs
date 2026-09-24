import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { enrichImages, attributes } from "./preview-images.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const config = JSON.parse(
  await readFile(path.join(root, "sources.json"), "utf8")
);

const startedAt = new Date();
const statuses = [];
const collected = [];
const games = [];

const headers = {
  "user-agent":
    "KnicksFeed/1.0 (+https://github.com/mvpstax/nykfeed)",
  accept:
    "application/json, application/rss+xml, application/xml, text/xml, */*"
};

function decode(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([\da-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function text(value = "") {
  return decode(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const escaped = name.replace(":", "\\:");
  const match = block.match(
    new RegExp(
      `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
      "i"
    )
  );
  return match ? text(match[1]) : "";
}

function attr(block, tagName, attribute) {
  const match = block.match(
    new RegExp(
      `<${tagName}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`,
      "i"
    )
  );
  return match ? decode(match[1]) : "";
}

function iso(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? null
    : date.toISOString();
}

function idFor(...parts) {
  return createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 20);
}

function matchesTeam(...fields) {
  const haystack = fields
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return config.team.keywords.some(keyword =>
    haystack.includes(keyword.toLowerCase())
  );
}

function presentation(url) {
  return {
    open_mode: "drawer",
    embed_attempt: true,
    fallback: "external_browser",
    url
  };
}

async function get(url, format = "text", timeoutMs = config.settings.request_timeout_ms) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return format === "json"
      ? await response.json()
      : await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function imageFromRss(block) {
  const thumbnail = attr(block, "media:thumbnail", "url");
  if (thumbnail) return thumbnail;

  for (const match of block.matchAll(
    /<(?:media:content|enclosure)\b[^>]*>/gi
  )) {
    const a = attributes(match[0]);

    if (
      a.url &&
      (
        a.type?.startsWith("image/") ||
        a.medium === "image" ||
        /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(a.url)
      )
    ) {
      return decode(a.url);
    }
  }

  const body =
    block.match(
      /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i
    )?.[1] ||
    block.match(
      /<description[^>]*>([\s\S]*?)<\/description>/i
    )?.[1] ||
    "";

  return attr(decode(body), "img", "src") || null;
}

async function fetchRss(source) {
  const xml = await get(source.url, "text", source.request_timeout_ms || config.settings.request_timeout_ms);
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  let accepted = 0;

  for (const block of blocks.slice(
    0,
    config.settings.max_items_per_source * 2
  )) {
    const title = tag(block, "title");
    const summary = tag(block, "description");
    const url = tag(block, "link") || tag(block, "guid");

    if (
      !source.team_specific &&
      !matchesTeam(title, summary, url)
    ) {
      continue;
    }

    collected.push({
      id: idFor(source.id, url || title),
      type: "article",
      source: source.name,
      source_key: source.id,
      title,
      summary,
      author: tag(block, "dc:creator") || null,
      published_at: iso(
        tag(block, "pubDate") ||
        tag(block, "published") ||
        tag(block, "updated")
      ),
      url,
      image_url: imageFromRss(block),
      team: config.team.id,
      presentation: presentation(url)
    });

    accepted += 1;

    if (accepted >= config.settings.max_items_per_source) {
      break;
    }
  }

  return accepted;
}

function parseSiKnicks(html, source) {
  const articles = [];

  function visit(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const types = [value["@type"]].flat();

    if (
      types.includes("NewsArticle") ||
      types.includes("Article")
    ) {
      articles.push(value);
    }

    if (value["@graph"]) visit(value["@graph"]);
    if (value.itemListElement) visit(value.itemListElement);
    if (value.item) visit(value.item);
  }

  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // Skip malformed metadata blocks.
    }
  }

  const output = [];
  const seen = new Set();

  for (const article of articles) {
    let url;

    try {
      url = new URL(
        article.url || article["@id"],
        source.url
      );
    } catch {
      continue;
    }

    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.si.com" ||
      !url.pathname.startsWith("/nba/knicks/")
    ) {
      continue;
    }

    if (!article.headline || seen.has(url.href)) continue;
    seen.add(url.href);

    const authors = [article.author || []]
      .flat()
      .map(author =>
        typeof author === "string" ? author : author?.name
      )
      .filter(Boolean);

    const image = Array.isArray(article.image)
      ? article.image[0]
      : article.image;

    output.push({
      id: idFor(source.id, url.href),
      type: "article",
      source: source.name,
      source_key: source.id,
      title: text(article.headline),
      summary: text(article.description || ""),
      author: authors.join(", ") || null,
      published_at: iso(article.datePublished),
      url: url.href,
      image_url:
        (typeof image === "string" ? image : image?.url) ||
        null,
      team: config.team.id,
      presentation: {
        ...presentation(url.href),
        embed_attempt: false,
        render_mode: "article_preview"
      }
    });

    if (output.length >= config.settings.max_items_per_source) {
      break;
    }
  }

  if (!output.length) {
    throw new Error(
      "No Knicks article metadata found; SI page structure may have changed"
    );
  }

  return output;
}

async function fetchSiKnicks(source) {
  collected.push(
    ...parseSiKnicks(await get(source.url), source)
  );
}

function parseOfficialKnicks(html, source) {
  const raw = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!raw) throw new Error("Official Knicks article metadata unavailable");
  const page = JSON.parse(raw).props?.pageProps?.pageObject;
  if (!Array.isArray(page?.contentExpanded)) throw new Error("Official Knicks article list unavailable");
  const seen = new Set();
  const output = [];

  function visit(block) {
    if (!block || typeof block !== "object") return;
    if (Array.isArray(block)) {
      block.forEach(visit);
      return;
    }
    if (Array.isArray(block.posts)) {
      for (const article of block.posts) {
        if (article?.type !== "article" || article?.status !== "publish" || !article.title) continue;
        let url;
        try {
          url = new URL(article.permalink);
        } catch {
          continue;
        }
        if (url.protocol !== "https:" || url.hostname !== "www.nba.com" || !url.pathname.startsWith("/knicks/news/") || seen.has(url.href)) continue;
        seen.add(url.href);
        output.push({
          id: idFor(source.id, url.href),
          type: "article",
          source: source.name,
          source_key: source.id,
          title: text(article.title),
          summary: text(article.excerpt || article.attributes?.subhead || ""),
          author: article.author?.name || null,
          published_at: iso(article.date || article.timestamp),
          url: url.href,
          image_url: article.featuredImage?.src || article.featuredImage?.attributes?.src || null,
          team: config.team.id,
          presentation: {
            ...presentation(url.href),
            embed_attempt: false,
            render_mode: "article_preview"
          }
        });
      }
    }
    if (block.content) visit(block.content);
  }

  visit(page.contentExpanded);
  if (!output.length) throw new Error("No official Knicks articles found");

  return output
    .sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""))
    .slice(0, config.settings.max_items_per_source);
}

async function fetchOfficialKnicks(source) {
  collected.push(...parseOfficialKnicks(await get(source.url), source));
}

async function fetchEspn(source) {
  const data = await get(source.url, "json");
  let accepted = 0;

  for (const article of data.articles || []) {
    const title = article.headline || article.title || "";
    const summary = text(
      article.description || article.story || ""
    );

    if (!matchesTeam(title, summary)) continue;

    const url =
      article.links?.web?.href || article.link || "";

    collected.push({
      id: idFor(source.id, article.id || url || title),
      type: "article",
      source: source.name,
      source_key: source.id,
      title,
      summary,
      author: article.byline || null,
      published_at: iso(
        article.published || article.lastModified
      ),
      url,
      image_url: article.images?.[0]?.url || null,
      team: config.team.id,
      presentation: presentation(url)
    });

    accepted += 1;
  }

  return accepted;
}

function blueskyMediaFields(post) {
  // Playback URLs come from hydrated embed views.
  // The video blob inside post.record is not a playback URL.
  const embed = post.embed;

  const media =
    embed?.$type === "app.bsky.embed.recordWithMedia#view"
      ? embed.media
      : embed;

  const video =
    media?.$type === "app.bsky.embed.video#view"
      ? media
      : null;

  let videoUrl = null;

  try {
    const url = new URL(video?.playlist);

    if (url.protocol === "https:") {
      videoUrl = url.href;
    }
  } catch {
    // Missing or invalid playlist: keep the normal social card.
  }

  return {
    image_url:
      media?.images?.[0]?.thumb ||
      media?.external?.thumb ||
      video?.thumbnail ||
      null,
    video_url: videoUrl,
    video_type: videoUrl
      ? "application/vnd.apple.mpegurl"
      : null,
    video_poster_url: videoUrl
      ? video.thumbnail || null
      : null,
    video_alt: videoUrl
      ? video.alt || null
      : null,
    video_aspect_ratio: videoUrl
      ? video.aspectRatio || null
      : null
  };
}

async function fetchBlueskyTargeted(source) {
  const url = new URL(source.url);

  url.searchParams.set(
    "limit",
    String(Math.min(100, config.settings.max_items_per_source))
  );

  if (source.kind === "bluesky_feed") {
    url.searchParams.set("feed", source.feed_uri);
  } else {
    url.searchParams.set("actor", source.actor);
    url.searchParams.set(
      "filter",
      source.filter || "posts_no_replies"
    );
  }

  const data = await get(url, "json");

  if (!Array.isArray(data.feed)) {
    throw new Error("Bluesky response missing feed array");
  }

  let accepted = 0;

  for (const entry of data.feed) {
    if (
      source.include_reposts === false &&
      entry.reason?.$type === "app.bsky.feed.defs#reasonRepost"
    ) {
      continue;
    }

    const post = entry.post;

    if (!post?.uri || !post.author?.did || !post.record) {
      continue;
    }

    const rkey = post.uri.split("/").pop();
    const publicUrl =
      `https://bsky.app/profile/${post.author.did}/post/${rkey}`;

    collected.push({
      id: idFor("bluesky", post.uri),
      type: "social",
      source: "Bluesky",
      source_key: source.id,
      source_feed: source.name,
      uri: post.uri,
      author:
        post.author.displayName || post.author.handle || null,
      handle: post.author.handle || null,
      avatar_url: post.author.avatar || null,
      text: post.record.text || "",
      published_at: iso(
        post.record.createdAt || post.indexedAt
      ),
      url: publicUrl,
      ...blueskyMediaFields(post),
      engagement: {
        replies: post.replyCount || 0,
        reposts: post.repostCount || 0,
        likes: post.likeCount || 0
      },
      team: config.team.id,
      presentation: {
        ...presentation(publicUrl),
        embed_attempt: false,
        render_mode: "native_social_card"
      }
    });

    accepted += 1;
  }

  return accepted;
}

async function fetchBluesky(source) {
  let accepted = 0;

  for (const query of source.queries || ["Knicks"]) {
    const url = new URL(source.url);

    url.searchParams.set("q", query);
    url.searchParams.set(
      "limit",
      String(config.settings.max_items_per_source)
    );
    url.searchParams.set("sort", "latest");

    const data = await get(url, "json");

    for (const post of data.posts || []) {
      const body = post.record?.text || "";
      if (!matchesTeam(body)) continue;

      const did = post.author?.did;
      const rkey = post.uri?.split("/").pop();

      const publicUrl =
        did && rkey
          ? `https://bsky.app/profile/${post.author.handle || did}/post/${rkey}`
          : "https://bsky.app";

      collected.push({
        id: idFor(source.id, post.uri),
        type: "social",
        source: source.name,
        source_key: source.id,
        author:
          post.author?.displayName ||
          post.author?.handle ||
          null,
        handle: post.author?.handle || null,
        text: body,
        published_at: iso(
          post.record?.createdAt || post.indexedAt
        ),
        url: publicUrl,
        ...blueskyMediaFields(post),
        engagement: {
          replies: post.replyCount || 0,
          reposts: post.repostCount || 0,
          likes: post.likeCount || 0
        },
        team: config.team.id,
        presentation: presentation(publicUrl)
      });

      accepted += 1;
    }
  }

  return accepted;
}

async function fetchReddit(source) {
  const data = await get(source.url, "json");
  let accepted = 0;

  for (const child of data.data?.children || []) {
    const post = child.data || {};
    const url =
      `https://www.reddit.com${post.permalink || ""}`;

    collected.push({
      id: idFor(source.id, post.id),
      type: "reddit",
      source: source.name,
      source_key: source.id,
      subreddit: post.subreddit || "NYKnicks",
      title: post.title || "",
      summary: text(post.selftext || "").slice(0, 500),
      author: post.author || null,
      published_at: iso((post.created_utc || 0) * 1000),
      url,
      image_url: post.thumbnail?.startsWith("http")
        ? post.thumbnail
        : null,
      engagement: {
        score: post.score || 0,
        comments: post.num_comments || 0
      },
      team: config.team.id,
      presentation: presentation(url)
    });

    accepted += 1;
  }

  return accepted;
}

async function fetchNbaScoreboard(source) {
  const data = await get(source.url, "json");

  for (const game of data.scoreboard?.games || []) {
    const home = game.homeTeam || {};
    const away = game.awayTeam || {};

    if (
      ![home.teamTricode, away.teamTricode].includes(
        config.team.id
      )
    ) {
      continue;
    }

    games.push({
      id: String(game.gameId),
      type: "game",
      source: source.name,
      source_key: source.id,
      status: game.gameStatusText || null,
      game_status: game.gameStatus ?? null,
      start_time: iso(game.gameTimeUTC),
      period: game.period ?? null,
      game_clock: game.gameClock || null,
      home: {
        team: home.teamTricode,
        name: home.teamName,
        score: Number(home.score || 0)
      },
      away: {
        team: away.teamTricode,
        name: away.teamName,
        score: Number(away.score || 0)
      }
    });
  }

  return games.length;
}

function similarityKey(item) {
  return (item.title || item.text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      word =>
        word.length > 2 &&
        ![
          "the",
          "and",
          "for",
          "with",
          "new",
          "york",
          "knicks"
        ].includes(word)
    )
    .slice(0, 12)
    .sort()
    .join(" ");
}

function normalizedUrl(value = "") {
  try {
    const url = new URL(value);

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term"
    ].forEach(key => url.searchParams.delete(key));

    return `${url.hostname.replace(/^www\./, "")}${url.pathname}`
      .replace(/\/$/, "");
  } catch {
    return value;
  }
}

function deduplicate(items) {
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenTitles = new Map();
  const output = [];

  for (const item of items) {
    const urlKey = normalizedUrl(item.url);
    const normalizedTitle = similarityKey(item);
    const titleKey = normalizedTitle ? `${item.source_key}:${normalizedTitle}` : "";

    if (
      seenIds.has(item.id) ||
      (urlKey && seenUrls.has(urlKey))
    ) {
      continue;
    }

    if (titleKey && seenTitles.has(titleKey)) {
      const original = seenTitles.get(titleKey);
      original.also_reported_by ||= [];

      if (!original.also_reported_by.includes(item.source)) {
        original.also_reported_by.push(item.source);
      }

      continue;
    }

    seenIds.add(item.id);
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.set(titleKey, item);

    output.push(item);
  }

  return output;
}

for (const source of config.sources.filter(
  source => source.enabled
)) {
  const before = collected.length + games.length;

  try {
    if (source.kind === "rss") {
      await fetchRss(source);
    }

    if (source.kind === "si_knicks") {
      await fetchSiKnicks(source);
    }

    if (source.kind === "nba_knicks_articles") {
      await fetchOfficialKnicks(source);
    }

    if (source.kind === "espn_news") {
      await fetchEspn(source);
    }

    if (source.kind === "bluesky_search") {
      await fetchBluesky(source);
    }

    if (
      ["bluesky_feed", "bluesky_author"].includes(source.kind)
    ) {
      await fetchBlueskyTargeted(source);
    }

    if (source.kind === "reddit") {
      await fetchReddit(source);
    }

    if (source.kind === "nba_scoreboard") {
      await fetchNbaScoreboard(source);
    }

    statuses.push({
      source_key: source.id,
      ok: true,
      items: collected.length + games.length - before
    });
  } catch (error) {
    statuses.push({
      source_key: source.id,
      ok: false,
      items: 0,
      error: error.message
    });
  }
}

const cutoff =
  Date.now() -
  config.settings.article_age_hours * 60 * 60 * 1000;

const recent = collected.filter(
  item =>
    !item.published_at ||
    new Date(item.published_at).valueOf() >= cutoff
);

recent.sort((a, b) =>
  (b.published_at || "").localeCompare(a.published_at || "")
);

const items = (
  config.settings.deduplicate
    ? deduplicate(recent)
    : recent
).slice(0, config.settings.max_items);

let previous = null;

try {
  previous = JSON.parse(
    await readFile(path.join(root, "feed.json"), "utf8")
  );
} catch {
  // First run.
}

const imageSummary = await enrichImages(
  items,
  previous,
  config,
  headers
);

const output = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  team: config.team,
  meta: {
    item_count: items.length,
    game_count: games.length,
    refresh_duration_ms: Date.now() - startedAt.valueOf(),
    source_status: statuses,
    images: imageSummary,
    disclaimer:
      "Links and excerpts belong to their publishers. Review each source's terms before commercial use."
  },
  games,
  items
};

await writeFile(
  path.join(root, "feed.json"),
  `${JSON.stringify(output, null, 2)}\n`
);

console.log(
  `Wrote feed.json with ${items.length} items and ${games.length} games.`
);

for (const status of statuses) {
  console.log(
    `${status.ok ? "OK" : "WARN"} ${status.source_key}: ${status.items}` +
    (status.error ? ` (${status.error})` : "")
  );
}
