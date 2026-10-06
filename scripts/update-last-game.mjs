import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const BASE = (
  process.env.HIGHLIGHTLY_BASE_URL ||
  'https://nba.highlightly.net'
).replace(/\/$/, '')

const CHANNEL = 'UCWJ2lWNubArHWmf3FIHbfcQ'

const rows = value =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : []

const nyk = team =>
  team?.abbreviation === 'NYK' ||
  /knicks/i.test(team?.displayName || team?.name || '')

const day = date =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date))

const decode = text =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

const tag = (xml, name) =>
  decode(
    xml.match(
      new RegExp(
        `<${name}[^>]*>([\\s\\S]*?)</${name}>`
      )
    )?.[1] || ''
  )

async function file(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function api(path, params = {}) {
  const key = process.env.HIGHLIGHTLY_API_KEY

  if (!key) {
    throw new Error('HIGHLIGHTLY_API_KEY secret is missing')
  }

  const url = new URL(BASE + path)

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value))
  }

  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key': key,
      ...(url.hostname.endsWith('.rapidapi.com')
        ? { 'x-rapidapi-host': url.hostname }
        : {}),
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`)
  }

  return response.json()
}

async function schedule(side, season) {
  const all = []

  for (let offset = 0; offset < 1000; offset += 100) {
    const data = await api('/matches', {
      league: 'NBA',
      season,
      [`${side}TeamAbbreviation`]: 'NYK',
      limit: 100,
      offset,
    })

    const page = rows(data)
    all.push(...page)

    if (
      page.length < 100 ||
      offset + 100 >=
        (data.pagination?.totalCount ?? Infinity)
    ) {
      return all
    }
  }

  throw new Error('Schedule pagination exceeded safety limit')
}

export function matchVideo(video, game) {
  const opponent = nyk(game.homeTeam)
    ? game.awayTeam
    : game.homeTeam

  const title = video.title.toLowerCase()

  if (
    video.channel_id !== CHANNEL ||
    !/knicks/.test(title) ||
    !/full (?:game )?highlights/.test(title)
  ) {
    return false
  }

  if (!/\bvs\.?\b|versus/.test(title)) {
    return false
  }

  const aliases = [
    opponent?.name,
    opponent?.displayName,
    ...(opponent?.abbreviation === 'PHI'
      ? ['76ers', 'sixers']
      : []),
  ].filter(Boolean)

  if (
    !aliases.some(name =>
      title.includes(name.toLowerCase())
    )
  ) {
    return false
  }

  const played = Date.parse(game.date)
  const published = Date.parse(video.published_at)

  if (
    !Number.isFinite(published) ||
    published < played ||
    published > played + 72 * 3600000
  ) {
    return false
  }

  // Require the actual game date in the headline.
  const expected = day(game.date).toLowerCase()

  const alternate = expected
    .replace(/, /g, ' ')
    .replace(/\s+/g, ' ')

  const normalized = title
    .replace(/[,|]/g, ' ')
    .replace(/\s+/g, ' ')

  return (
    title.includes(expected) ||
    normalized.includes(alternate)
  )
}

export function stat(record, names) {
  const entry = (record.statistics || []).find(item =>
    names.includes(String(item.name).toLowerCase())
  )

  return entry?.value != null &&
    Number.isFinite(Number(entry.value))
    ? Number(entry.value)
    : null
}

export async function main() {
  const now = new Date()

  const season =
    now.getUTCMonth() >= 6
      ? now.getUTCFullYear()
      : now.getUTCFullYear() - 1

  const previous = await file('last-game.json')

  const [home, away] = await Promise.all([
    schedule('home', season),
    schedule('away', season),
  ])

  const game = [
    ...new Map(
      [...home, ...away].map(item => [item.id, item])
    ).values(),
  ]
    .filter(
      item =>
        item.state?.description === 'Finished' &&
        (nyk(item.homeTeam) || nyk(item.awayTeam)) &&
        Date.parse(item.date) <= now.getTime()
    )
    .sort(
      (a, b) => Date.parse(b.date) - Date.parse(a.date)
    )[0]

  if (!game) {
    if (previous?.game) {
      console.log(
        'No new completed game found; retaining existing recap.'
      )
      return
    }

    await writeFile(
      'last-game.json',
      JSON.stringify(
        {
          generated_at: now.toISOString(),
          game: null,
        },
        null,
        2
      ) + '\n'
    )

    return
  }

  const same = previous?.game?.id === String(game.id)
  const errors = []

  let video = same ? previous.video : null

  if (!video) {
    try {
      const response = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
        {
          signal: AbortSignal.timeout(20000),
        }
      )

      if (!response.ok) {
        throw new Error(
          `NBA YouTube feed: HTTP ${response.status}`
        )
      }

      const xml = await response.text()

      const videos = [
        ...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g),
      ].map(([, entry]) => {
        const id = tag(entry, 'yt:videoId')

        return {
          video_id: id,
          title: tag(entry, 'title'),
          channel_id: tag(entry, 'yt:channelId'),
          published_at: tag(entry, 'published'),
          image_url:
            `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${id}`,
          embed_url:
            `https://www.youtube.com/embed/${id}`,
        }
      })

      video =
        videos.find(
          item =>
            /^[\w-]{11}$/.test(item.video_id) &&
            matchVideo(item, game)
        ) || null
    } catch (error) {
      errors.push(error.message)
    }
  }

  let box = same ? previous.box_score || [] : []

  try {
    box = rows(await api(`/box-score/${game.id}`))
  } catch (error) {
    errors.push(error.message)
  }

  const players = box
    .filter(group => nyk(group.team))
    .flatMap(group => group.team?.boxScores || [])
    .map(record => ({
      name: record.player?.name || 'Player',

      points: stat(record, [
        'total points scored',
        'total points',
        'points',
      ]),

      rebounds: stat(record, [
        'total rebounds',
        'rebounds',
      ]),

      assists: stat(record, [
        'total assists',
        'assists',
      ]),
    }))
    .filter(player => player.points !== null)
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)

  const score = side => {
    const values = game.state?.score?.[side]

    return Array.isArray(values) &&
      values.length &&
      values.every(value =>
        Number.isFinite(Number(value))
      )
      ? values.reduce(
          (sum, value) => sum + Number(value),
          0
        )
      : null
  }

  const team = (value, side) => ({
    name: value.displayName || value.name,
    abbreviation: value.abbreviation,
    logo: value.logo || null,
    score: score(side),
  })

  await writeFile(
    'last-game.json',
    JSON.stringify(
      {
        generated_at: now.toISOString(),

        game: {
          id: String(game.id),
          date: game.date,
          status: 'Finished',
          home: team(game.homeTeam, 'homeTeam'),
          away: team(game.awayTeam, 'awayTeam'),
        },

        video,
        top_performers: players,
        box_score: box,
        meta: { errors },
      },
      null,
      2
    ) + '\n'
  )

  console.log(
    `Last game ${game.id}: ${
      video ? 'NBA highlights matched' : 'highlights pending'
    }; ${errors.length} optional errors`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
