import {
  readFile,
  writeFile,
  rename,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const output = path.join(root, 'heat.json')

const API =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

const year =
  new Date().getUTCMonth() >= 8
    ? new Date().getUTCFullYear() + 1
    : new Date().getUTCFullYear()

let previous = {}

try {
  previous = JSON.parse(await readFile(output, 'utf8'))
} catch {}

const sources = []

const hash = value =>
  createHash('sha256').update(value).digest('hex').slice(0, 20)

const decode = value =>
  String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

const text = value =>
  decode(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (block, name) =>
  decode(
    block.match(
      new RegExp(
        `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,
        'i',
      ),
    )?.[1] || '',
  )

const attr = (block, name) =>
  decode(
    block.match(
      new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'),
    )?.[1] || '',
  )

const https = raw => {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const iso = raw =>
  Number.isFinite(Date.parse(raw))
    ? new Date(raw).toISOString()
    : null

async function request(url, asJson = true) {
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Knickside/1.0 (+https://www.knickside.com)',
      accept:
        'application/json, application/rss+xml, application/atom+xml, text/html, */*',
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return asJson ? response.json() : response.text()
}

async function safe(id, action, fallback) {
  try {
    const result = await action()

    sources.push({
      id,
      ok: true,
      checked_at: new Date().toISOString(),
    })

    return result
  } catch (error) {
    sources.push({
      id,
      ok: false,
      error: error.message,
      checked_at: new Date().toISOString(),
    })

    return fallback
  }
}

/* Bluesky moderation */

const adultLabels = new Set([
  'porn',
  'sexual',
  'nudity',
  'graphic-media',
  'nsfw',
  'adult',
])

const adultTerms =
  /\b(?:onlyfans|fansly|porn(?:hub|ographic|ography)?|nsfw|nudes?|naked|xxx|explicit\s+content|adult\s+content|sex\s+(?:work|worker|tape)|cam\s*girl)\b/i

function labels(object) {
  return Array.isArray(object?.labels) ? object.labels : []
}

function allowBlueskyPost(post) {
  if (!post?.uri || !post?.author?.did || !post?.record) {
    return false
  }

  const embed = post.embed
  const media = embed?.media || embed
  const quoted = embed?.record?.record || embed?.record

  const allLabels = [
    ...labels(post),
    ...labels(post.author),
    ...labels(embed),
    ...labels(media),
    ...labels(quoted),
    ...labels(quoted?.author),
  ]

  if (
    allLabels.some(
      label =>
        !label.neg &&
        adultLabels.has(
          String(label.val || '').toLowerCase(),
        ),
    )
  ) {
    return false
  }

  const selfLabels = post.record?.labels?.values || []

  if (
    selfLabels.some(label =>
      adultLabels.has(
        String(label.val || '').toLowerCase(),
      ),
    )
  ) {
    return false
  }

  const words = [
    post.record.text,
    post.author.displayName,
    post.author.description,
    ...(media?.images || []).map(image => image.alt),
    media?.alt,
    media?.external?.title,
    media?.external?.description,
    quoted?.value?.text,
    quoted?.record?.text,
  ]
    .filter(Boolean)
    .join(' ')

  return !adultTerms.test(words)
}

/* Roster */

const flatten = raw =>
  (raw?.athletes || [])
    .flatMap(group =>
      Array.isArray(group.items) ? group.items : [group],
    )
    .filter(person => person.id && person.displayName)

const roster = await safe(
  'roster',
  async () => {
    const people = flatten(
      await request(`${API}/teams/14/roster`),
    )

    if (!people.length) {
      throw new Error('Roster response was empty')
    }

    return people
  },
  previous.roster || [],
)

/* Relevance: never use the word "heat" alone. */

const relevant = value =>
  /\bmiami\s+heat\b|\bheatculture\b|\bheatnation\b/i.test(
    value,
  ) ||
  (/\bheat\b/i.test(value) &&
    /\bnba\b|basketball|adebayo|spoelstra|nba\.com/i.test(
      value,
    ))

function article(
  source,
  title,
  summary,
  url,
  published,
  image,
  author = null,
) {
  const safeUrl = https(url)
  const publishedAt = iso(published)

  if (!title || !safeUrl || !publishedAt) return null

  return {
    id: hash(safeUrl),
    type: 'article',
    source,
    source_key: source
      .toLowerCase()
      .replace(/\W+/g, '_'),
    team_ids: ['MIA'],
    title: text(title),
    summary: text(summary).slice(0, 1500),
    url: safeUrl,
    published_at: publishedAt,
    image_url: https(image),
    author,
    presentation: {
      open_mode: 'drawer',
      fallback: 'external_browser',
      url: safeUrl,
    },
  }
}

/* RSS articles */

async function rss(name, url, dedicated = false) {
  const xml = await request(url, false)

  if (!/<(?:rss|feed)\b/i.test(xml)) {
    throw new Error('No RSS or Atom feed returned')
  }

  return [
    ...xml.matchAll(
      /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi,
    ),
  ].flatMap(match => {
    const block = match[1]
    const title = text(tag(block, 'title'))
    const summary =
      tag(block, 'description') || tag(block, 'summary')

    const link =
      text(tag(block, 'link')) ||
      attr(
        block.match(/<link\b[^>]*>/i)?.[0] || '',
        'href',
      )

    if (
      !dedicated &&
      !relevant(`${title} ${text(summary)}`)
    ) {
      return []
    }

    const media =
      block.match(
        /<media:(?:content|thumbnail)\b[^>]*>/i,
      )?.[0] ||
      block.match(/<enclosure\b[^>]*>/i)?.[0] ||
      ''

    const image =
      attr(media, 'url') ||
      attr(
        decode(block).match(/<img\b[^>]*>/i)?.[0] ||
          '',
        'src',
      )

    const item = article(
      name,
      title,
      summary,
      link,
      text(
        tag(block, 'pubDate') ||
          tag(block, 'published') ||
          tag(block, 'updated'),
      ),
      image,
      text(tag(block, 'dc:creator')) || null,
    )

    return item ? [item] : []
  })
}

const definitions = [
  [
    'Hoops Rumors',
    'https://www.hoopsrumors.com/miami-heat/feed',
    true,
  ],
  [
    'Hot Hot Hoops',
    'https://hothothoops.com/feed/',
    true,
  ],
  [
    'All U Can Heat',
    'https://allucanheat.com/feed/',
    true,
  ],
  [
    'Yahoo Sports',
    'https://sports.yahoo.com/nba/rss.xml',
    false,
  ],
  [
    'CBS Sports',
    'https://www.cbssports.com/rss/headlines/nba',
    false,
  ],
]

const articleGroups = await Promise.all(
  definitions.map(([name, url, dedicated]) =>
    safe(
      name,
      () => rss(name, url, dedicated),
      (previous.items || []).filter(
        item => item.source === name,
      ),
    ),
  ),
)

articleGroups.push(
  await safe(
    'ESPN',
    async () => {
      const data = await request(
        `${API}/news?team=14&limit=50`,
      )

      return (data.articles || [])
        .filter(item =>
          relevant(
            `${item.headline} ${item.description}`,
          ),
        )
        .flatMap(item => {
          const result = article(
            'ESPN',
            item.headline,
            item.description,
            item.links?.web?.href,
            item.published,
            item.images?.[0]?.url,
            item.byline || null,
          )

          return result ? [result] : []
        })
    },
    (previous.items || []).filter(
      item => item.source === 'ESPN',
    ),
  ),
)

/* Approved Bluesky authors */

const authors = [
  'anthonychiang.bsky.social',
  'irawinderman.bsky.social',
]

const socials = await Promise.all(
  authors.map(actor =>
    safe(
      `bluesky:${actor}`,
      async () => {
        const profile = await request(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(
            actor,
          )}`,
        )

        const data = await request(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(
            profile.did,
          )}&filter=posts_no_replies&limit=40`,
        )

        return (data.feed || []).flatMap(entry => {
          const post = entry.post

          if (
            entry.reason ||
            post?.record?.reply ||
            post?.author?.did !== profile.did ||
            !allowBlueskyPost(post)
          ) {
            return []
          }

          if (!relevant(post.record.text || '')) {
            return []
          }

          const media = post.embed?.media || post.embed

          return [
            {
              id: hash(post.uri),
              type: 'social',
              source: 'Bluesky',
              source_key: `bluesky_${actor}`,
              team_ids: ['MIA'],
              author:
                post.author.displayName || actor,
              handle: post.author.handle,
              avatar_url: https(post.author.avatar),
              text: post.record.text || '',
              published_at: iso(
                post.record.createdAt,
              ),
              url: `https://bsky.app/profile/${
                post.author.did
              }/post/${post.uri.split('/').at(-1)}`,
              image_url: https(
                media?.images?.[0]?.fullsize ||
                  media?.external?.thumb,
              ),
              video_url: https(media?.playlist),
              video_thumbnail_url: https(
                media?.thumbnail,
              ),
              engagement: {
                replies: post.replyCount || 0,
                reposts: post.repostCount || 0,
                likes: post.likeCount || 0,
              },
            },
          ]
        })
      },
      (previous.items || []).filter(
        item =>
          item.source_key === `bluesky_${actor}`,
      ),
    ),
  ),
)

/* YouTube */

async function youtube(
  id,
  title,
  url,
  heatOnly = false,
) {
  const html = await request(url, false)

  const channelId =
    html.match(
      /"(?:externalId|channelId)":"(UC[\w-]{22})"/,
    )?.[1] ||
    html.match(/channel_id=(UC[\w-]{22})/)?.[1]

  if (!channelId) {
    throw new Error(
      'YouTube channel ID could not be resolved',
    )
  }

  const xml = await request(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    false,
  )

  const items = [
    ...xml.matchAll(
      /<entry>([\s\S]*?)<\/entry>/g,
    ),
  ]
    .flatMap(match => {
      const block = match[1]
      const videoId = text(tag(block, 'yt:videoId'))
      const headline = text(tag(block, 'title'))

      if (
        !/^[\w-]{11}$/.test(videoId) ||
        (heatOnly && !relevant(headline))
      ) {
        return []
      }

      return [
        {
          id: videoId,
          video_id: videoId,
          title: headline,
          channel: title,
          image_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          is_short: false,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          embed_url: `https://www.youtube.com/embed/${videoId}`,
          published_at: iso(
            text(tag(block, 'published')),
          ),
        },
      ]
    })
    .slice(0, 12)

  return {
    id,
    title,
    channel: title,
    channel_url: url,
    updated_at: new Date().toISOString(),
    stale: false,
    items,
  }
}

const videoDefinitions = [
  [
    'official_heat',
    'Official Miami Heat',
    'https://www.youtube.com/@MiamiHEAT',
    false,
  ],
  [
    'locked_on_heat',
    'Locked On Heat',
    'https://www.youtube.com/c/LockedOnHeat',
    false,
  ],
]

const rows = await Promise.all(
  videoDefinitions.map(([id, title, url, filter]) =>
    safe(
      id,
      () => youtube(id, title, url, filter),
      previous.rows?.find(row => row.id === id)
        ? {
            ...previous.rows.find(
              row => row.id === id,
            ),
            stale: true,
          }
        : null,
    ),
  ),
)

rows.push(
  await safe(
    'five_reasons',
    async () => {
      const html = await request(
        'https://www.fivereasonssports.com/south-florida/video/',
        false,
      )

      const channel = decode(html).match(
        /https:\/\/(?:www\.)?youtube\.com\/(?:channel\/[\w-]+|@[\w-]+|c\/[\w-]+|user\/[\w-]+)/,
      )?.[0]

      if (!channel) {
        throw new Error(
          'No channel link found on Five Reasons website',
        )
      }

      return youtube(
        'five_reasons',
        'Five on the Floor · Five Reasons',
        channel,
        true,
      )
    },
    previous.rows?.find(
      row => row.id === 'five_reasons',
    ) || null,
  ),
)

/* Reuse the shared Around the NBA row when available. */

try {
  const shared = JSON.parse(
    await readFile(
      path.join(root, 'youtube.json'),
      'utf8',
    ),
  )

  const nba = shared.rows?.find(
    row => row.id === 'around_nba',
  )

  if (nba) rows.push(nba)
} catch {}

/* Schedule */

const scheduleGroups = await Promise.all(
  [1, 2, 3].map(phase =>
    safe(
      `schedule:${phase}`,
      async () => {
        const data = await request(
          `${API}/teams/14/schedule?season=${year}&seasontype=${phase}`,
        )

        return (data.events || [])
          .filter(event =>
            event.competitions?.[0]?.competitors?.some(
              side =>
                String(side.team?.id) === '14',
            ),
          )
          .map(event => ({
            ...event,
            season: {
              ...event.season,
              type: phase,
            },
          }))
      },
      (previous.games || []).filter(
        event =>
          Number(event.season?.type) === phase,
      ),
    ),
  ),
)

/* Basic current regular-season team statistics */

const statistics = await safe(
  'team_statistics',
  async () => {
    const data = await request(
      `${API}/teams/14?enable=stats`,
    )

    const record = data.team?.record?.items?.find(
      item => item.type === 'total',
    )

    if (!record?.stats?.length) {
      throw new Error('No team record was returned')
    }

    const values = Object.fromEntries(
      record.stats.map(stat => [
        stat.name,
        stat.value,
      ]),
    )

    const fields = [
      ['gamesPlayed', 'Games played'],
      ['wins', 'Wins'],
      ['losses', 'Losses'],
    ]

    if (values.gamesPlayed > 0) {
      fields.push(
        ['avgPointsFor', 'Points per game'],
        [
          'avgPointsAgainst',
          'Opponent points per game',
        ],
        ['pointDifferential', 'Point differential'],
      )
    }

    return {
      categories: [
        {
          name: 'regular-season',
          displayName:
            'Regular season · ' +
            (record.summary || ''),
          stats: fields
            .filter(([key]) =>
              Number.isFinite(values[key]),
            )
            .map(([name, displayName]) => ({
              name,
              displayName,
              value: values[name],
            })),
        },
      ],
    }
  },
  previous.statistics || {},
)

/* Validate, deduplicate, and write */

const cutoff = Date.now() - 7 * 86400000
const unique = new Map()

for (const item of [
  ...articleGroups.flat(),
  ...socials.flat(),
]) {
  const time = Date.parse(item.published_at)

  if (
    Number.isFinite(time) &&
    time >= cutoff &&
    time <= Date.now() + 300000 &&
    !unique.has(item.url)
  ) {
    unique.set(item.url, item)
  }
}

const items = [...unique.values()]
  .sort(
    (a, b) =>
      Date.parse(b.published_at) -
      Date.parse(a.published_at),
  )
  .slice(0, 160)

if (
  !items.length &&
  !(previous.items || []).length
) {
  throw new Error(
    'No Heat posts were retrieved. Existing files were not replaced. Check source errors: ' +
      JSON.stringify(sources),
  )
}

const result = {
  schema_version: 1,
  team_id: 'MIA',
  generated_at: new Date().toISOString(),
  items,
  rows: rows.filter(Boolean),
  roster,
  games: [
    ...new Map(
      scheduleGroups
        .flat()
        .map(event => [event.id, event]),
    ).values(),
  ],
  statistics,
  sources,
}

await writeFile(
  output + '.tmp',
  JSON.stringify(result, null, 2) + '\n',
)

await rename(output + '.tmp', output)

console.log(
  `Heat: ${items.length} posts, ${result.rows.length} video rows, ${result.games.length} games, ${roster.length} players.`,
)

for (const source of sources) {
  console.log(
    `${source.ok ? 'OK' : 'WARN'} ${source.id}${
      source.error ? ': ' + source.error : ''
    }`,
  )
}
