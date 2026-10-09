import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ROOT =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'

const num = value =>
  value == null ||
  String(value).trim() === '' ||
  !Number.isFinite(Number(value))
    ? null
    : Number(value)

const abbr = value =>
  String(value || '')
    .toUpperCase()
    .replace(/^NY$/, 'NYK')

async function read(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function request(id) {
  const response = await fetch(
    `${ROOT}/summary?event=${encodeURIComponent(id)}`,
    {
      signal: AbortSignal.timeout(20000),
    },
  )

  if (!response.ok) {
    throw new Error(`ESPN HTTP ${response.status}`)
  }

  return response.json()
}

function totalNumber(value) {
  return num(
    String(value ?? '').replace(/^[ou]\s*/i, ''),
  )
}

export function extractLines(
  summary,
  game,
  now = new Date(),
) {
  const home = abbr(game.home.abbreviation) === 'NYK'
  const finished = game.status === 'Finished'

  const choices = (summary.pickcenter || [])
    .map(item => {
      const side = home ? 'home' : 'away'

      const team = home
        ? item.homeTeamOdds
        : item.awayTeamOdds

      const closeSpread = num(
        item.pointSpread?.[side]?.close?.line,
      )

      const closeTotal = totalNumber(
        item.total?.over?.close?.line ??
          item.total?.under?.close?.line,
      )

      const closeMoney = num(
        item.moneyline?.[side]?.close?.odds,
      )

      let spread = closeSpread

      if (spread === null) {
        const detail = String(item.details || '').match(
          /^([A-Z]+)\s+([+-]?\d+(?:\.\d+)?)$/i,
        )

        if (detail) {
          const quotedTeam = abbr(detail[1])
          const quoted = num(detail[2])

          if (
            [
              abbr(game.home.abbreviation),
              abbr(game.away.abbreviation),
            ].includes(quotedTeam)
          ) {
            spread =
              quotedTeam === 'NYK' ? quoted : -quoted
          }
        }

        if (
          spread === null &&
          typeof team?.favorite === 'boolean' &&
          num(item.spread) !== null
        ) {
          spread =
            Math.abs(num(item.spread)) *
            (team.favorite ? -1 : 1)
        }
      }

      const total = closeTotal ?? num(item.overUnder)
      const moneyline =
        closeMoney ?? num(team?.moneyLine)

      const present = [spread, total, moneyline].filter(
        value => value !== null,
      ).length

      const allClosing =
        (spread === null || closeSpread !== null) &&
        (total === null || closeTotal !== null) &&
        (moneyline === null || closeMoney !== null)

      return {
        source: 'ESPN',
        bookmaker: item.provider?.name || 'Provider',
        bookmaker_id: String(item.provider?.id || ''),
        captured_at: now.toISOString(),
        line_type: finished
          ? allClosing
            ? 'closing'
            : 'reported'
          : 'pregame',
        spread,
        total,
        moneyline,
        priority: num(item.provider?.priority) ?? 999,
        present,
      }
    })
    .filter(item => item.present > 0)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        b.present - a.present,
    )

  if (!choices.length) return null

  const { priority, present, ...line } = choices[0]

  return line
}

export function settle(game, line) {
  const home = abbr(game.home.abbreviation) === 'NYK'

  const mine = num(
    (home ? game.home : game.away).score,
  )

  const other = num(
    (home ? game.away : game.home).score,
  )

  const finished =
    game.status === 'Finished' &&
    mine !== null &&
    other !== null

  const margin = finished ? mine - other : null
  const total = finished ? mine + other : null

  const spreadMargin =
    finished && line?.spread != null
      ? margin + line.spread
      : null

  const totalMargin =
    finished && line?.total != null
      ? total - line.total
      : null

  return {
    game_id: game.id,
    game_date: game.date,
    home: game.home.abbreviation,
    away: game.away.abbreviation,

    status: line ? 'available' : 'unavailable',

    reason: line
      ? null
      : 'No betting lines were reported for this game.',

    line: line || null,
    final_points: total,
    knicks_margin: margin,

    spread_result:
      spreadMargin === null
        ? null
        : Math.abs(spreadMargin) < 0.0001
          ? 'Push'
          : spreadMargin > 0
            ? 'Covered'
            : 'Did not cover',

    total_result:
      totalMargin === null
        ? null
        : Math.abs(totalMargin) < 0.0001
          ? 'Push'
          : totalMargin > 0
            ? 'Over'
            : 'Under',

    moneyline_result:
      !finished || line?.moneyline == null
        ? null
        : margin === 0
          ? 'Push'
          : margin > 0
            ? 'Won'
            : 'Lost',
  }
}

export async function main() {
  const schedule = await read('games.json')

  if (
    !Array.isArray(schedule?.games) ||
    !schedule.games.length
  ) {
    throw new Error(
      'games.json is missing. Run Refresh Knicks Last Game first.',
    )
  }

  const previous = await read('betting-results.json')

  const archive = {
    ...(previous?.games || {}),
  }

  const now = new Date()

  const games = schedule.games
    .map(entry => entry.game)
    .filter(game => /^espn:\d+$/.test(game.id))

  const finished = games
    .filter(game => game.status === 'Finished')
    .sort(
      (a, b) =>
        Date.parse(b.date) - Date.parse(a.date),
    )

  const upcoming = games
    .filter(
      game =>
        game.status !== 'Finished' &&
        Date.parse(game.date) > now.getTime() &&
        Date.parse(game.date) <
          now.getTime() + 7 * 86400000,
    )
    .sort(
      (a, b) =>
        Date.parse(a.date) - Date.parse(b.date),
    )
    .slice(0, 3)

  const missing = finished
    .filter(game => {
      const saved = archive[game.id]

      return (
        saved?.line?.line_type !== 'closing' &&
        (!saved?.checked_at ||
          now.getTime() - Date.parse(saved.checked_at) >
            30 * 60000)
      )
    })
    .slice(0, 6)

  const errors = []

  for (const game of [...upcoming, ...missing]) {
    try {
      const data = await request(
        game.id.replace('espn:', ''),
      )

      if (
        data.header?.id &&
        String(data.header.id) !==
          game.id.replace('espn:', '')
      ) {
        throw new Error('Game ID mismatch')
      }

      const fresh = extractLines(data, game, now)
      const old = archive[game.id]?.line

      // Preserve a captured pregame line unless
      // the provider supplies explicit closing lines.
      const keepOld =
        old &&
        (old.line_type === 'closing' ||
          (game.status === 'Finished' &&
            old.line_type === 'pregame' &&
            fresh?.line_type !== 'closing'))

      const line = keepOld
        ? old
        : fresh || old || null

      archive[game.id] = {
        ...settle(game, line),
        checked_at: now.toISOString(),
      }
    } catch (error) {
      errors.push(`${game.id}: ${error.message}`)

      archive[game.id] = {
        ...settle(
          game,
          archive[game.id]?.line || null,
        ),
        checked_at: now.toISOString(),
        reason: archive[game.id]?.line
          ? null
          : 'Betting data could not refresh. It will be retried.',
      }
    }
  }

  // Use current final scores, including score corrections.
  for (const game of games) {
    if (archive[game.id]) {
      archive[game.id] = {
        ...archive[game.id],
        ...settle(game, archive[game.id].line),
      }
    }
  }

  if (
    errors.length === upcoming.length + missing.length &&
    errors.length > 0
  ) {
    throw new Error(
      `All betting requests failed; existing file retained. ${errors.join('; ')}`,
    )
  }

  await writeFile(
    'betting-results.json',
    JSON.stringify(
      {
        schema_version: 1,
        generated_at: now.toISOString(),
        games: archive,
        meta: { errors },
      },
      null,
      2,
    ) + '\n',
  )

  console.log(
    `Saved betting data for ${Object.keys(archive).length} games; ${errors.length} optional errors.`,
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
