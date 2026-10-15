import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  buildOdds,
  archivedOdds,
} from './update-odds.mjs'
import {
  extractLines,
  settle,
} from './update-betting-results.mjs'

const abbr = value =>
  String(value || '')
    .toUpperCase()
    .replace(/^NY$/, 'NYK')

async function read(path, optional = false) {
  try {
    return JSON.parse(
      await readFile(path, 'utf8'),
    )
  } catch (error) {
    if (
      optional &&
      error.code === 'ENOENT'
    ) {
      return null
    }

    throw error
  }
}

function sameGame(a, b) {
  return (
    a &&
    b &&
    abbr(a.home.abbreviation) ===
      abbr(b.home.abbreviation) &&
    abbr(a.away.abbreviation) ===
      abbr(b.away.abbreviation) &&
    Number.isFinite(Date.parse(a.date)) &&
    Number.isFinite(Date.parse(b.date)) &&
    Math.abs(
      Date.parse(a.date) -
        Date.parse(b.date),
    ) <=
      3 * 3600000
  )
}

export async function main() {
  const preview = await read('gameday.json')

  const game =
    preview?.status === 'ready'
      ? preview.game
      : null

  const schedule = await read(
    'games.json',
    true,
  )

  const archive =
    (await read(
      'betting-results.json',
      true,
    )) || {
      schema_version: 1,
      games: {},
    }

  let output = null

  if (
    game &&
    Date.parse(game.date) > Date.now()
  ) {
    try {
      const match = (
        schedule?.games || []
      ).find(
        entry =>
          /^espn:\d+$/.test(
            entry.game?.id || '',
          ) &&
          sameGame(entry.game, game),
      )

      const saved = Object.values(
        archive.games || {},
      ).find(
        record =>
          /^espn:\d+$/.test(
            record.game_id || '',
          ) &&
          sameGame(
            {
              home: {
                abbreviation: record.home,
              },
              away: {
                abbreviation: record.away,
              },
              date: record.game_date,
            },
            game,
          ),
      )

      const id =
        match?.game.id ||
        saved?.game_id ||
        (/^espn:\d+$/.test(game.id)
          ? game.id
          : null)

      if (!id) {
        throw new Error(
          'No matching ESPN game in games.json. Run Refresh Knicks Last Game.',
        )
      }

      const eventId = id.replace(
        'espn:',
        '',
      )

      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(eventId)}`,
        {
          signal:
            AbortSignal.timeout(20000),
        },
      )

      if (!response.ok) {
        throw new Error(
          `ESPN HTTP ${response.status}`,
        )
      }

      const summary = await response.json()

      if (
        String(summary.header?.id) !==
        eventId
      ) {
        throw new Error(
          'ESPN game ID mismatch',
        )
      }

      const competition =
        summary.header?.competitions?.[0]

      const competitors =
        competition?.competitors || []

      const home = competitors.find(
        team => team.homeAway === 'home',
      )

      const away = competitors.find(
        team => team.homeAway === 'away',
      )

      if (
        abbr(
          home?.team?.abbreviation,
        ) !==
          abbr(
            game.home.abbreviation,
          ) ||
        abbr(
          away?.team?.abbreviation,
        ) !==
          abbr(
            game.away.abbreviation,
          )
      ) {
        throw new Error(
          'ESPN team mismatch',
        )
      }

      if (
        competition?.status?.type
          ?.state !== 'pre'
      ) {
        throw new Error(
          'ESPN no longer lists this game as pregame',
        )
      }

      const now = new Date()

      const espnGame = {
        ...game,
        id,
        status: 'Scheduled',
      }

      const line = extractLines(
        summary,
        espnGame,
        now,
      )

      if (!line) {
        throw new Error(
          'ESPN has not posted pregame lines yet',
        )
      }

      const record = {
        ...settle(espnGame, line),
        checked_at: now.toISOString(),
      }

      archive.games = {
        ...(archive.games || {}),
        [id]: record,
      }

      archive.generated_at =
        now.toISOString()

      await writeFile(
        'betting-results.json',
        JSON.stringify(
          archive,
          null,
          2,
        ) + '\n',
      )

      output = archivedOdds(
        preview,
        {
          games: {
            [id]: record,
          },
        },
        now.getTime(),
      )
    } catch (error) {
      console.warn(
        `Fresh ESPN odds: ${error.message}`,
      )
    }

    // Only reuse genuinely recent snapshots.
    // Never change an old snapshot's timestamp.
    output ||= archivedOdds(
      preview,
      archive,
    )
  }

  // Existing Highlightly fallback.
  output ||= await buildOdds(preview)

  await writeFile(
    'odds.json',
    JSON.stringify(
      output,
      null,
      2,
    ) + '\n',
  )

  console.log(
    `Pregame odds: ${output.status}; ${output.source}; snapshot ${output.generated_at}`,
  )
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
