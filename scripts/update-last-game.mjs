import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ROOT =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

const CHANNEL = 'UCWJ2lWNubArHWmf3FIHbfcQ'

const easternDate = date =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date))

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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': 'KnicksFeed/1.0',
      Accept: text ? 'application/atom+xml' : 'application/json',
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${new URL(url).pathname}`)
  }

  return text ? res.text() : res.json()
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
      new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`),
    )?.[1] || '',
  )

export function compact(event, phase) {
  const c = event.competitions?.[0]

  const home = c?.competitors?.find(
    team => team.homeAway === 'home',
  )

  const away = c?.competitors?.find(
    team => team.homeAway === 'away',
  )

  if (
    !home ||
    !away ||
    !Number.isFinite(Date.parse(event.date))
  ) {
    return null
  }

  const status = c.status?.type || event.status?.type

  const team = side => ({
    name: side.team.displayName,
    abbreviation:
      side.team.abbreviation === 'NY'
        ? 'NYK'
        : side.team.abbreviation,
    logo: side.team.logo || side.team.logos?.[0]?.href || null,
    score: status?.completed
      ? number(
          typeof side.score === 'object'
            ? side.score.value
            : side.score,
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

const BOX_VERSION = 2

const STAT_NAMES = {
  MIN: 'Total Minutes Played',
  PTS: 'Total Points Scored',
  REB: 'Total Rebounds',
  AST: 'Total Assists',
  STL: 'Total Steals',
  BLK: 'Total Blocks',
  TO: 'Total Turnovers',
  OREB: 'Offensive Rebounds',
  DREB: 'Defensive Rebounds',
  PF: 'Personal Fouls',
  '+/-': 'Plus Minus',
}

const SHOOTING = {
  FG: ['Field Goals Made', 'Field Goals Attempted'],
  '3PT': ['Three Pointers Made', 'Three Pointers Attempted'],
  FT: ['Free Throws Made', 'Free Throws Attempted'],
}

export function parseStats(section, values = []) {
  const stats = []

  const indexOf = key => {
    for (const labels of [section.labels, section.names]) {
      const index =
        labels?.findIndex(
          label => String(label).toUpperCase() === key,
        ) ?? -1

      if (index >= 0) return index
    }

    return -1
  }

  for (const [key, name] of Object.entries(STAT_NAMES)) {
    const raw = values[indexOf(key)]
    let value = number(raw)

    if (key === 'MIN' && /^\d+:\d{2}$/.test(String(raw))) {
      const [minutes, seconds] = String(raw)
        .split(':')
        .map(Number)

      value = seconds < 60 ? minutes + seconds / 60 : null
    }

    if (value !== null) stats.push({ name, value })
  }

  for (const [key, names] of Object.entries(SHOOTING)) {
    const pair = String(values[indexOf(key)] ?? '').match(
      /^(\d+)\s*[-/]\s*(\d+)$/,
    )

    if (pair) {
      const made = Number(pair[1])
      const attempted = Number(pair[2])

      if (made <= attempted) {
        stats.push(
          { name: names[0], value: made },
          { name: names[1], value: attempted },
        )
      }
    }
  }

  return stats
}

export function boxScore(data) {
  return (data.boxscore?.players || []).map(group => {
    const seen = new Set()

    const rows = (group.statistics || []).flatMap(section =>
      (section.athletes || []).flatMap(row => {
        if (!row.athlete?.displayName) return []

        const id = String(
          row.athlete.id || row.athlete.displayName,
        )

        if (seen.has(id)) return []
        seen.add(id)

        const minuteIndex = (
          section.labels ||
          section.names ||
          []
        ).indexOf('MIN')

        return [
          {
            player: {
              id,
              name: row.athlete.displayName,
              position:
                row.athlete.position?.abbreviation || null,
              jersey: row.athlete.jersey ?? null,
              photo_url: row.athlete.headshot?.href || null,
            },
            starter:
              typeof row.starter === 'boolean'
                ? row.starter
                : null,
            didNotPlay: row.didNotPlay === true,
            reason: row.didNotPlay
              ? row.reason || 'Did not play'
              : null,
            minutes_display: row.didNotPlay
              ? null
              : row.stats?.[minuteIndex] || null,
            statistics: row.didNotPlay
              ? []
              : parseStats(section, row.stats),
          },
        ]
      }),
    )

    // Team rebounds need not equal the sum of player rebounds.
    const totals = (group.statistics || []).find(
      section => section.totals?.length,
    )

    return {
      team: {
        id: String(group.team?.id || ''),
        name: group.team?.displayName || 'Team',
        abbreviation:
          group.team?.abbreviation === 'NY'
            ? 'NYK'
            : group.team?.abbreviation || null,
        logo: group.team?.logo || null,
        boxScores: rows,
        totals: totals ? parseStats(totals, totals.totals) : [],
      },
    }
  })
}

export function matchVideo(video, game) {
  if (
    String(video.channel_id || '').replace(/^UC/, '') !==
    CHANNEL.replace(/^UC/, '')
  ) {
    return false
  }

  const title = String(video.title || '').toLowerCase()

  if (
    video.is_short ||
    (video.duration_seconds != null &&
      video.duration_seconds < 120)
  ) {
    return false
  }

  if (
    !/knicks/.test(title) ||
    !/full (?:game )?highlights/.test(title) ||
    !/\b(?:vs|versus|at)\b/.test(title)
  ) {
    return false
  }

  const opponent =
    game.home.abbreviation === 'NYK' ? game.away : game.home

  const terms = [
    opponent.name,
    opponent.name.split(' ').at(-1),
    ...(opponent.abbreviation === 'PHI'
      ? ['76ers', 'sixers']
      : []),
  ]

  if (
    !terms.some(term => title.includes(term.toLowerCase()))
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
        `${ROOT}/teams/ny/schedule?season=${YEAR}&seasontype=${type}`,
      ),
    ),
  )

  const phases = ['Preseason', 'Regular season', 'Playoffs']
  const entries = []

  const old = new Map(
    (cached?.games || []).map(entry => [
      entry.game.id,
      entry,
    ]),
  )

  if (last?.game) old.set(last.game.id, last)

  for (let i = 0; i < requests.length; i++) {
    const result = requests[i]

    if (result.status === 'rejected') {
      errors.push(
        `${phases[i]} schedule: ${result.reason.message}`,
      )
      continue
    }

    for (const event of result.value.events || []) {
      const game = compact(event, phases[i])

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
      `No Knicks schedule returned; existing files retained. ${errors.join('; ')}`,
    )
  }

  // Keep cached season games if a schedule request temporarily fails.
  for (const entry of old.values()) {
    if (
      entry.game.id.startsWith('espn:') &&
      Date.parse(entry.game.date) >=
        Date.UTC(YEAR - 1, 6, 1) &&
      Date.parse(entry.game.date) <
        Date.UTC(YEAR, 6, 1) &&
      !entries.some(e => e.game.id === entry.game.id)
    ) {
      entries.push(entry)
    }
  }

  entries.sort(
    (a, b) =>
      Date.parse(a.game.date) - Date.parse(b.game.date),
  )

  const finished = entries
    .filter(
      entry =>
        entry.game.status === 'Finished' &&
        Date.parse(entry.game.date) <= NOW.getTime(),
    )
    .sort(
      (a, b) =>
        Date.parse(b.game.date) - Date.parse(a.game.date),
    )

  // Upgrade up to three cached box scores per refresh.
  for (const entry of finished
    .filter(
      entry =>
        !entry.box_score?.length ||
        entry.box_score_version !== BOX_VERSION,
    )
    .slice(0, 3)) {
    try {
      const updated = boxScore(
        await get(
          `${ROOT}/summary?event=${entry.game.id.replace('espn:', '')}`,
        ),
      )

      if (
        updated.length &&
        updated.some(group => group.team.boxScores.length)
      ) {
        entry.box_score = updated
        entry.box_score_version = BOX_VERSION
      } else {
        errors.push(
          `Box score ${entry.game.id}: player stats not yet available`,
        )
      }
    } catch (error) {
      errors.push(
        `Box score ${entry.game.id}: ${error.message}`,
      )
    }
  }

  let videos = []

  try {
    const xml = await get(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
      true,
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
        image_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`,
        embed_url: `https://www.youtube.com/embed/${id}`,
      }
    })
  } catch (error) {
    errors.push(`NBA YouTube: ${error.message}`)
  }

  const youtube = await file('youtube.json')

  for (const row of youtube?.rows || []) {
    if (
      row.channel !== 'NBA' ||
      !/@NBA(?:\/|$)|\/UCWJ2lWNubArHWmf3FIHbfcQ(?:\/|$)/i.test(
        row.channel_url || '',
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

  const needsArchive = finished.slice(0, 10).some(
    entry =>
      !(entry.video && matchVideo(entry.video, entry.game)) &&
      !videos.some(video => matchVideo(video, entry.game)),
  )

  if (needsArchive) {
    const pending = finished.slice(0, 3).filter(
      entry =>
        !(entry.video && matchVideo(entry.video, entry.game)) &&
        !videos.some(video => matchVideo(video, entry.game)),
    )

    const sources = [
      `https://www.youtube.com/channel/${CHANNEL}/videos`,
      ...pending.map(entry => {
        const opponent =
          entry.game.home.abbreviation === 'NYK'
            ? entry.game.away
            : entry.game.home

        const date = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(new Date(entry.game.date))

        const query =
          `KNICKS ${opponent.name.split(' ').at(-1)} ` +
          `FULL GAME HIGHLIGHTS ${date}`

        return (
          `https://www.youtube.com/channel/${CHANNEL}/search?query=` +
          encodeURIComponent(query)
        )
      }),
    ]

    const playlists = new Set()

    const searches = await Promise.allSettled(
      sources.map(async (url, index) => {
        const { stdout } = await run(
          'python3',
          [
            '-m',
            'yt_dlp',
            '--ignore-config',
            '--flat-playlist',
            '--playlist-end',
            index === 0 ? '240' : '20',
            '--dump-single-json',
            '--skip-download',
            '--no-warnings',
            '--socket-timeout',
            '15',
            '--retries',
            '1',
            url,
          ],
          {
            timeout: 120000,
            maxBuffer: 16 * 1024 * 1024,
          },
        )

        const listing = JSON.parse(stdout)

        if (listing.channel_id !== CHANNEL) {
          throw new Error('Unexpected YouTube channel')
        }

        for (const item of listing.entries || []) {
          if (
            /full game highlights/i.test(item.title || '') &&
            (item.title || '').includes(
              `${YEAR - 1}-${String(YEAR).slice(-2)}`,
            ) &&
            /^https:\/\/www\.youtube\.com\/playlist\?list=[\w-]+$/.test(
              item.url || '',
            )
          ) {
            playlists.add(item.url)
          }
        }

        return (listing.entries || []).flatMap(item => {
          if (
            item.channel_id &&
            item.channel_id !== CHANNEL
          ) {
            return []
          }

          const id = item.id

          if (!/^[\w-]{11}$/.test(id || '')) return []

          return [
            {
              video_id: id,
              title: item.title,
              channel_id: CHANNEL,
              duration_seconds: number(item.duration),
              published_at: item.timestamp
                ? new Date(
                    item.timestamp * 1000,
                  ).toISOString()
                : null,
              image_url:
                `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${id}`,
              embed_url:
                `https://www.youtube.com/embed/${id}`,
            },
          ]
        })
      }),
    )

    for (const result of searches) {
      if (result.status === 'fulfilled') {
        videos.push(...result.value)
      } else {
        errors.push(
          `NBA upload search: ${result.reason.message.slice(0, 400)}`,
        )
      }
    }

    for (const url of [...playlists].slice(0, 2)) {
      try {
        const { stdout } = await run(
          'python3',
          [
            '-m',
            'yt_dlp',
            '--ignore-config',
            '--flat-playlist',
            '--playlist-end',
            '120',
            '--dump-single-json',
            '--skip-download',
            '--no-warnings',
            '--socket-timeout',
            '15',
            '--retries',
            '1',
            url,
          ],
          {
            timeout: 90000,
            maxBuffer: 16 * 1024 * 1024,
          },
        )

        const listing = JSON.parse(stdout)

        if (listing.channel_id !== CHANNEL) {
          throw new Error('Unexpected playlist owner')
        }

        for (const item of listing.entries || []) {
          if (
            item.channel_id !== CHANNEL ||
            !/^[\w-]{11}$/.test(item.id || '')
          ) {
            continue
          }

          videos.push({
            video_id: item.id,
            title: item.title,
            channel_id: CHANNEL,
            duration_seconds: number(item.duration),
            published_at: item.timestamp
              ? new Date(
                  item.timestamp * 1000,
                ).toISOString()
              : null,
            image_url:
              `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
            url:
              `https://www.youtube.com/watch?v=${item.id}`,
            embed_url:
              `https://www.youtube.com/embed/${item.id}`,
          })
        }
      } catch (error) {
        errors.push(
          `NBA highlights playlist: ${error.message.slice(0, 400)}`,
        )
      }
    }
  }

  for (const entry of finished) {
    if (
      entry.video &&
      !matchVideo(entry.video, entry.game)
    ) {
      entry.video = null
    }

    const candidate =
      entry.video ||
      videos.find(
        video =>
          /^[\w-]{11}$/.test(video.video_id || '') &&
          matchVideo(video, entry.game),
      )

    entry.video = candidate
      ? {
          ...candidate,
          channel: 'NBA',
          channel_id: CHANNEL,
          channel_url: 'https://www.youtube.com/@NBA',
          game_id: entry.game.id,
          game_date: easternDate(entry.game.date),
          game_date_utc: entry.game.date,
          matchup: {
            home: entry.game.home,
            away: entry.game.away,
          },
          competition: 'NBA',
          phase: entry.game.phase,
          season: `${YEAR - 1}-${String(YEAR).slice(-2)}`,
          association: 'official-channel-teams-and-date',
          metadata_checked_at: NOW.toISOString(),
          published_at: candidate.published_at || null,
          duration_seconds:
            candidate.duration_seconds ?? null,
        }
      : null

    entry.highlight_status = entry.video
      ? 'available'
      : 'pending'

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

  const document = {
    generated_at: NOW.toISOString(),
    games: entries,
    meta,
  }

  await writeFile(
    'games.json',
    JSON.stringify(document, null, 2) + '\n',
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
      2,
    ) + '\n',
  )

  console.log(
    `Wrote ${entries.length} games; latest result: ${
      finished[0]?.game.id || 'none'
    }; ${errors.length} optional errors`,
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
