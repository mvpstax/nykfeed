import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ROOT =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

const CHANNEL = 'UCWJ2lWNubArHWmf3FIHbfcQ'

const NOW = new Date(process.env.RECAP_NOW || Date.now())

const YEAR =
  NOW.getUTCMonth() >= 6
    ? NOW.getUTCFullYear() + 1
    : NOW.getUTCFullYear()

async function file(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function get(url, text = false) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': 'KnicksFeed/1.0',
      Accept: text
        ? 'application/atom+xml'
        : 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${new URL(url).pathname}`
    )
  }

  return text ? response.text() : response.json()
}

const number = value =>
  value != null &&
  String(value).trim() !== '' &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null

const decode = text =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")

const tag = (xml, name) =>
  decode(
    xml.match(
      new RegExp(
        `<${name}[^>]*>([\\s\\S]*?)</${name}>`
      )
    )?.[1] || ''
  )

export function compact(event, phase) {
  const competition = event.competitions?.[0]

  const home = competition?.competitors?.find(
    team => team.homeAway === 'home'
  )

  const away = competition?.competitors?.find(
    team => team.homeAway === 'away'
  )

  if (
    !home ||
    !away ||
    !Number.isFinite(Date.parse(event.date))
  ) {
    return null
  }

  const status =
    competition.status?.type || event.status?.type

  const team = side => ({
    name: side.team.displayName,

    abbreviation:
      side.team.abbreviation === 'NY'
        ? 'NYK'
        : side.team.abbreviation,

    logo:
      side.team.logo ||
      side.team.logos?.[0]?.href ||
      null,

    score: status?.completed
      ? number(
          typeof side.score === 'object'
            ? side.score.value
            : side.score
        )
      : null,
  })

  return {
    id: `espn:${event.id}`,
    date: event.date,

    status: status?.completed
      ? 'Finished'
      : status?.state === 'in'
        ? 'In progress'
        : status?.description || 'Scheduled',

    phase,
    home: team(home),
    away: team(away),
  }
}

export function boxScore(data) {
  return (data.boxscore?.players || []).map(group => ({
    team: {
      name: group.team.displayName,

      boxScores: (group.statistics || []).flatMap(section =>
        (section.athletes || []).map(row => ({
          player: {
            name: row.athlete.displayName,
          },

          statistics: row.didNotPlay
            ? []
            : [
                ['PTS', 'Total Points Scored'],
                ['REB', 'Total Rebounds'],
                ['AST', 'Total Assists'],
                ['MIN', 'Total Minutes Played'],
              ].flatMap(([key, name]) => {
                const index = (
                  section.labels ||
                  section.names ||
                  []
                ).indexOf(key)

                const value =
                  index >= 0
                    ? number(row.stats?.[index])
                    : null

                return value === null
                  ? []
                  : [{ name, value }]
              }),
        }))
      ),
    },
  }))
}

export function matchVideo(video, game) {
  if (
    video.channel_id.replace(/^UC/, '') !==
    CHANNEL.replace(/^UC/, '')
  ) {
    return false
  }

  const title = video.title.toLowerCase()

  if (
    !/knicks/.test(title) ||
    !/full (?:game )?highlights/.test(title) ||
    !/\bvs\.?\b|versus/.test(title)
  ) {
    return false
  }

  const opponent =
    game.home.abbreviation === 'NYK'
      ? game.away
      : game.home

  const terms = [
    opponent.name,
    opponent.name.split(' ').at(-1),
    ...(opponent.abbreviation === 'PHI'
      ? ['76ers', 'sixers']
      : []),
  ]

  if (
    !terms.some(term =>
      title.includes(term.toLowerCase())
    )
  ) {
    return false
  }

  const expected = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
    .format(new Date(game.date))
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')

  if (
    !title
      .replace(/[,|]/g, ' ')
      .replace(/\s+/g, ' ')
      .includes(expected)
  ) {
    return false
  }

  const stamp = Date.parse(video.published_at || '')

  return (
    !Number.isFinite(stamp) ||
    (stamp >= Date.parse(game.date) &&
      stamp <= Date.parse(game.date) + 72 * 3600000)
  )
}

export async function main() {
  const cached = await file('games.json')
  const last = await file('last-game.json')
  const errors = []

  const requests = await Promise.allSettled(
    [1, 2, 3].map(type =>
      get(
        `${ROOT}/teams/ny/schedule?season=${YEAR}&seasontype=${type}`
      )
    )
  )

  const phases = [
    'Preseason',
    'Regular season',
    'Playoffs',
  ]

  const entries = []

  const old = new Map(
    (cached?.games || []).map(entry => [
      entry.game.id,
      entry,
    ])
  )

  if (last?.game) {
    old.set(last.game.id, last)
  }

  for (let index = 0; index < requests.length; index++) {
    const result = requests[index]

    if (result.status === 'rejected') {
      errors.push(
        `${phases[index]} schedule: ${result.reason.message}`
      )
      continue
    }

    for (const event of result.value.events || []) {
      const game = compact(event, phases[index])

      if (game) {
        entries.push({
          ...(old.get(game.id) || {}),
          game,
        })
      }
    }
  }

  if (!entries.length) {
    throw new Error(
      `No Knicks schedule returned; existing files retained. ${errors.join(
        '; '
      )}`
    )
  }

  // Preserve cached games if one phase temporarily fails.
  for (const entry of old.values()) {
    if (
      entry.game.id.startsWith('espn:') &&
      Date.parse(entry.game.date) >=
        Date.UTC(YEAR - 1, 6, 1) &&
      Date.parse(entry.game.date) <
        Date.UTC(YEAR, 6, 1) &&
      !entries.some(
        existing => existing.game.id === entry.game.id
      )
    ) {
      entries.push(entry)
    }
  }

  entries.sort(
    (a, b) =>
      Date.parse(a.game.date) - Date.parse(b.game.date)
  )

  const finished = entries
    .filter(
      entry =>
        entry.game.status === 'Finished' &&
        Date.parse(entry.game.date) <= NOW.getTime()
    )
    .sort(
      (a, b) =>
        Date.parse(b.game.date) - Date.parse(a.game.date)
    )

  // Fill up to three missing completed-game box scores per run.
  for (const entry of finished
    .filter(entry => !entry.box_score?.length)
    .slice(0, 3)) {
    try {
      entry.box_score = boxScore(
        await get(
          `${ROOT}/summary?event=${entry.game.id.replace(
            'espn:',
            ''
          )}`
        )
      )
    } catch (error) {
      errors.push(
        `Box score ${entry.game.id}: ${error.message}`
      )
    }
  }

  let videos = []

  try {
    const xml = await get(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
      true
    )

    videos = [
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
  } catch (error) {
    errors.push(`NBA YouTube: ${error.message}`)
  }

  // Also check the NBA row from your existing YouTube updater.
  const youtube = await file('youtube.json')

  for (const row of youtube?.rows || []) {
    if (
      row.channel !== 'NBA' ||
      !/@NBA(?:\/|$)|\/UCWJ2lWNubArHWmf3FIHbfcQ(?:\/|$)/i.test(
        row.channel_url || ''
      )
    ) {
      continue
    }

    for (const video of row.items || []) {
      videos.push({
        ...video,
        channel_id: CHANNEL,
      })
    }
  }

  for (const entry of finished) {
    if (!entry.video) {
      entry.video =
        videos.find(
          video =>
            /^[\w-]{11}$/.test(video.video_id || '') &&
            matchVideo(video, entry.game)
        ) || null
    }

    const value = (row, name) =>
      row.statistics.find(stat => stat.name === name)
        ?.value ?? null

    entry.top_performers = (entry.box_score || [])
      .filter(group => /knicks/i.test(group.team.name))
      .flatMap(group => group.team.boxScores)
      .map(row => ({
        name: row.player.name,
        points: value(row, 'Total Points Scored'),
        rebounds: value(row, 'Total Rebounds'),
        assists: value(row, 'Total Assists'),
      }))
      .filter(player => player.points !== null)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3)
  }

  const meta = {
    errors,
    source:
      'ESPN public schedule and game summary; official NBA YouTube',
  }

  await writeFile(
    'games.json',
    JSON.stringify(
      {
        generated_at: NOW.toISOString(),
        games: entries,
        meta,
      },
      null,
      2
    ) + '\n'
  )

  await writeFile(
    'last-game.json',
    JSON.stringify(
      {
        generated_at: NOW.toISOString(),
        ...(finished[0] || { game: null }),
        meta,
      },
      null,
      2
    ) + '\n'
  )

  console.log(
    `Wrote ${entries.length} games; latest result: ${
      finished[0]?.game.id || 'none'
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
