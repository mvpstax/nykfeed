import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

const AUTHOR = "https://sny.tv/authors/ian-begley"

const PLAYLISTS = [
  // SNY Knicks coverage
  "PLBPOanRI_4PHe2p9OHDetWUswktQRNGh0",

  // The Putback with Ian Begley
  "PLBPOanRI_4PG-8A1ky6wwBMFWzhX0vrt6",
]

const KEY = "sny_ian_begley"
const ROW = "sny_knicks_insider"
const DAYS = 30

const idFor = (value) =>
  createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 20)

export function text(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (_, code) => {
        const names = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        }

        if (code[0] !== "#") {
          return names[code.toLowerCase()] || ""
        }

        const n =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10)

        return Number.isFinite(n) &&
          n > 0 &&
          n <= 0x10ffff
          ? String.fromCodePoint(n)
          : ""
      },
    )
    .replace(/\s+/g, " ")
    .trim()
}

const titleKey = (value) =>
  text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

function safeUrl(value, base) {
  try {
    const u = new URL(value, base)
    return u.protocol === "https:" ? u.href : null
  } catch {
    return null
  }
}

function canonical(value) {
  try {
    const u = new URL(value)
    return u.origin + u.pathname.replace(/\/$/, "")
  } catch {
    return String(value || "")
  }
}

function recent(value) {
  const time = Date.parse(value)

  return (
    Number.isFinite(time) &&
    time <= Date.now() + 300000 &&
    time >= Date.now() - DAYS * 86400000
  )
}

async function read(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return fallback
    throw e
  }
}

async function get(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; KnicksFeed/1.0)",
      Accept:
        "text/html,application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(25000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.text()
}

export function parseArticles(html) {
  const raw = html.match(
    /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  )?.[1]

  if (!raw) {
    throw new Error("SNY structured page data is missing")
  }

  const entries =
    JSON.parse(raw).props?.pageProps?.entries

  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("SNY author entries are missing")
  }

  const articles = []

  for (const e of entries) {
    const authors = (e.authorList || [])
      .map((a) => text(a.title))
      .filter(Boolean)

    if (!authors.some((a) => /ian begley/i.test(a))) {
      continue
    }

    const tags = (e.snyTags || [])
      .map(
        (t) =>
          `${t.teamIdentifier || ""} ${t.label || ""}`,
      )
      .join(" ")

    if (!/\bknicks\b/i.test(`${e.title} ${tags}`)) {
      continue
    }

    const title = text(e.title || e.headline)

    if (
      !title ||
      !recent(e.publish_date) ||
      !e.url
    ) {
      continue
    }

    // SNY's structured entries omit the /articles prefix.
    const path =
      e.url.startsWith("/") &&
      !e.url.startsWith("/articles/")
        ? "/articles" + e.url
        : e.url

    const url = safeUrl(path, "https://sny.tv")

    if (
      !url ||
      !["sny.tv", "www.sny.tv"].includes(
        new URL(url).hostname,
      )
    ) {
      continue
    }

    const image = safeUrl(e.photo?.imageUrl)

    articles.push({
      id: idFor(canonical(url)),
      type: "article",
      source: "SNY",
      source_key: KEY,
      title,
      summary: text(e.subheadline),
      author: authors.join(", "),
      published_at: new Date(
        e.publish_date,
      ).toISOString(),
      url,
      image_url: image,
      image_status: image ? "available" : "missing",
      team: "NYK",
      presentation: {
        open_mode: "drawer",
        embed_attempt: false,
        fallback: "external_browser",
        url,
        render_mode: "article_preview",
      },
    })
  }

  return articles
}

export function parseVideos(xml) {
  if (!/<feed\b/.test(xml)) {
    throw new Error(
      "YouTube did not return an Atom feed",
    )
  }

  const channel = xml.match(
    /<yt:channelId>([^<]+)<\/yt:channelId>/,
  )?.[1]

  if (channel !== "UCL_OEjsHTwsHK6WKWs7s7Uw") {
    throw new Error(
      "Playlist channel does not match SNY",
    )
  }

  const tag = (block, name) =>
    text(
      block.match(
        new RegExp(
          `<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`,
          "i",
        ),
      )?.[1],
    )

  const items = []

  for (const match of xml.matchAll(
    /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi,
  )) {
    const b = match[1]
    const video = tag(b, "yt:videoId")
    const title = tag(b, "title")
    const published = tag(b, "published")

    if (
      !/^[\w-]{11}$/.test(video) ||
      !title ||
      !recent(published)
    ) {
      continue
    }

    items.push({
      id: `youtube-${video}`,
      video_id: video,
      title,
      channel: "SNY",
      image_url:
        `https://i.ytimg.com/vi/${video}/hqdefault.jpg`,
      is_short: false,
      url:
        `https://www.youtube.com/watch?v=${video}`,
      embed_url:
        `https://www.youtube.com/embed/${video}?playsinline=1&rel=0`,
      published_at: new Date(
        published,
      ).toISOString(),
    })
  }

  return items
}

function unique(items, key) {
  return [
    ...new Map(
      items.map((item) => [key(item), item]),
    ).values(),
  ]
}

export function mergeArticles(existing, incoming) {
  const byUrl = new Map(
    existing.map((item) => [
      canonical(item.url),
      item,
    ]),
  )

  // Match syndicated copies only when SNY/Begley
  // attribution and the normalized headline match.
  const byTitle = new Map(
    existing
      .filter(
        (item) =>
          /sny/i.test(item.source || "") ||
          /ian begley/i.test(item.author || ""),
      )
      .map((item) => [
        titleKey(item.title),
        item,
      ]),
  )

  const articles = incoming.map((item) => {
    const old =
      byUrl.get(canonical(item.url)) ||
      byTitle.get(titleKey(item.title))

    // Preserve IDs already used by story clusters.
    return old ? { ...item, id: old.id } : item
  })

  const urls = new Set(
    articles.map((item) => canonical(item.url)),
  )

  const ids = new Set(
    articles.map((item) => item.id),
  )

  return [
    ...existing.filter(
      (item) =>
        item.source_key !== KEY &&
        !urls.has(canonical(item.url)) &&
        !ids.has(item.id),
    ),
    ...articles,
  ].sort(
    (a, b) =>
      Date.parse(b.published_at) -
      Date.parse(a.published_at),
  )
}

async function main() {
  const feed = await read("feed.json", null)

  if (!Array.isArray(feed?.items)) {
    throw new Error(
      "feed.json is missing or invalid; run your main feed refresh first",
    )
  }

  const youtube = await read("youtube.json", {
    rows: [],
  })

  if (!Array.isArray(youtube.rows)) {
    throw new Error(
      "youtube.json has no rows array",
    )
  }

  const previous = await read("sny.json", {
    articles: [],
    videos: [],
  })

  const urls = [
    AUTHOR,
    ...PLAYLISTS.map(
      (id) =>
        `https://www.youtube.com/feeds/videos.xml?playlist_id=${id}`,
    ),
  ]

  const results = await Promise.allSettled(
    urls.map(get),
  )

  const status = []

  let articles = (previous.articles || []).filter(
    (a) => recent(a.published_at),
  )

  const successfulVideos = []
  let videoSuccesses = 0

  for (
    let index = 0;
    index < results.length;
    index++
  ) {
    const result = results[index]

    try {
      if (result.status === "rejected") {
        throw result.reason
      }

      if (index === 0) {
        articles = unique(
          [
            ...articles,
            ...parseArticles(result.value),
          ],
          (a) => canonical(a.url),
        )
      } else {
        successfulVideos.push(
          ...parseVideos(result.value),
        )
        videoSuccesses++
      }

      status.push({
        source_key:
          index === 0
            ? KEY
            : `sny_playlist_${index}`,
        ok: true,
      })
    } catch (e) {
      status.push({
        source_key:
          index === 0
            ? KEY
            : `sny_playlist_${index}`,
        ok: false,
        error: e.message,
      })
    }
  }

  if (!status.some((s) => s.ok)) {
    throw new Error(
      `All SNY sources failed. Existing feeds were kept. ${JSON.stringify(
        status,
      )}`,
    )
  }

  const videos = unique(
    [
      ...(previous.videos || []).filter(
        (v) => recent(v.published_at),
      ),
      ...successfulVideos,
    ],
    (v) => v.video_id,
  )
    .sort(
      (a, b) =>
        Date.parse(b.published_at) -
        Date.parse(a.published_at),
    )
    .slice(0, 15)

  articles = articles
    .sort(
      (a, b) =>
        Date.parse(b.published_at) -
        Date.parse(a.published_at),
    )
    .slice(0, 20)

  const now = new Date().toISOString()

  feed.items = mergeArticles(
    feed.items,
    articles,
  )

  feed.generated_at = now

  feed.meta = {
    ...feed.meta,
    item_count: feed.items.length,
    sny_updated_at: now,
    sny_source_status: status,
  }

  if (Array.isArray(feed.clusters)) {
    const valid = new Set(
      feed.items.map((item) => item.id),
    )

    feed.clusters = feed.clusters
      .map((c) => {
        if (!Array.isArray(c.item_ids)) {
          return c
        }

        const item_ids = c.item_ids.filter(
          (id) => valid.has(id),
        )

        return {
          ...c,
          item_ids,
          lead_item_id: valid.has(c.lead_item_id)
            ? c.lead_item_id
            : item_ids[0],
        }
      })
      .filter(
        (c) =>
          !Array.isArray(c.item_ids) ||
          c.item_ids.length > 0,
      )
  }

  const oldRow = youtube.rows.find(
    (row) => row.id === ROW,
  )

  const priorVideos = (
    oldRow?.items || []
  ).filter(
    (v) =>
      !v.published_at ||
      recent(v.published_at),
  )

  const rowVideos = videos.length
    ? videos
    : videoSuccesses === 0
      ? priorVideos
      : []

  const otherRows = youtube.rows.filter(
    (row) => row.id !== ROW,
  )

  if (rowVideos.length) {
    otherRows.push({
      id: ROW,
      title: "SNY · Knicks Insider",
      channel: "SNY",
      channel_url:
        "https://www.youtube.com/playlist?list=" +
        PLAYLISTS[0],
      updated_at: videoSuccesses
        ? now
        : oldRow?.updated_at ||
          previous.generated_at ||
          now,
      stale: videoSuccesses === 0,
      items: rowVideos,
    })
  }

  youtube.rows = otherRows
  youtube.generated_at = now

  const output = {
    schema_version: 1,
    generated_at: now,
    source_status: status,
    articles,
    videos,
  }

  for (const [name, data] of [
    ["sny.json", output],
    ["feed.json", feed],
    ["youtube.json", youtube],
  ]) {
    await writeFile(
      name,
      JSON.stringify(data, null, 2) + "\n",
    )
  }

  console.log(
    `SNY: ${articles.length} articles; ${rowVideos.length} videos. Existing non-SNY rows kept.`,
  )

  for (const entry of status) {
    console.log(JSON.stringify(entry))
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
