import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const BASE = (
  process.env.HIGHLIGHTLY_BASE_URL ||
  'https://nba.highlightly.net'
).replace(/\/$/, '')

const KEY = process.env.HIGHLIGHTLY_API_KEY || ''

const day = date =>
  new Date(date).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  })

const rows = data =>
  Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : []

const abbr = value =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^NY$/, 'NYK')

const valid = value =>
  typeof value === 'number' &&
  Number.isFinite(value)

const signed = value =>
  value > 0 ? `+${value}` : String(value)

const decimal = value =>
  value > 0
    ? 1 + value / 100
    : 1 + 100 / Math.abs(value)

async function api(route, params) {
  if (!KEY) {
    throw new Error('HIGHLIGHTLY_API_KEY is missing')
  }

  const url = new URL(BASE + route)

  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key': KEY,
      ...(url.hostname.endsWith('.rapidapi.com')
        ? { 'x-rapidapi-host': url.hostname }
        : {}),
    },
    signal: AbortSignal.timeout(20000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json()
}

export function normalizeBooks(markets) {
  const books = new Map()

  for (const market of markets) {
    if (
      market.type !== 'prematch' ||
      !/^(moneyline|full time result|spread\b|totals?\b|total points\b)/i.test(
        market.market || '',
      )
    ) {
      continue
    }

    const values = (market.values || [])
      .filter(
        value =>
          Number.isFinite(Number(value.odd)) &&
          Number(value.odd) > 1,
      )
      .map(value => ({
        value: String(value.value),
        odd: Number(value.odd),
      }))

    if (!values.length || !market.bookmakerId) {
      continue
    }

    const id = String(market.bookmakerId)

    if (!books.has(id)) {
      books.set(id, {
        id,
        name:
          market.bookmakerName ||
          `Sportsbook ${id}`,
        markets: [],
      })
    }

    const book = books.get(id)

    if (
      !book.markets.some(
        item => item.market === market.market,
      )
    ) {
      book.markets.push({
        market: String(market.market),
        values,
      })
    }
  }

  return [...books.values()].sort(
    (a, b) =>
      b.markets.length - a.markets.length ||
      a.name.localeCompare(b.name),
  )
}

export async function buildOdds(
  preview,
  request = api,
) {
  const game =
    preview?.status === 'ready'
      ? preview.game
      : null

  const output = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'Highlightly',
    game_id: game?.id || null,
    match_id: null,
    odds_type: 'prematch',
    price_format: 'decimal',
    status: 'unavailable',
    reason: null,
    bookmakers: [],
  }

  if (
    !game ||
    !Number.isFinite(Date.parse(game.date))
  ) {
    output.reason = 'No matchup is available yet.'
    return output
  }

  try {
    let matchId =
      /^\d+$/.test(String(game.id)) &&
      !preview.meta?.fixture_fallback
        ? Number(game.id)
        : null

    if (!matchId) {
      for (
        let offset = 0;
        offset < 400 && !matchId;
        offset += 100
      ) {
        const result = await request('/matches', {
          date: day(game.date),
          timezone: 'America/New_York',
          league: 'NBA',
          limit: 100,
          offset,
        })

        const match = rows(result).find(
          item =>
            abbr(item.homeTeam?.abbreviation) ===
              abbr(game.home.abbreviation) &&
            abbr(item.awayTeam?.abbreviation) ===
              abbr(game.away.abbreviation) &&
            Number.isFinite(Date.parse(item.date)) &&
            Math.abs(
              Date.parse(item.date) -
                Date.parse(game.date),
            ) <=
              3 * 3600000,
        )

        if (match) {
          matchId = Number(match.id) || null
        }

        if (rows(result).length < 100) break
      }
    }

    if (!matchId) {
      output.reason =
        'This matchup has not been published by the odds provider yet. Preseason coverage may be limited.'

      return output
    }

    output.match_id = matchId

    const markets = []

    for (
      let offset = 0;
      offset < 100;
      offset += 5
    ) {
      const result = await request('/odds', {
        matchId,
        oddsType: 'prematch',
        limit: 5,
        offset,
        bookmakerName:
          process.env.ODDS_BOOKMAKER || undefined,
      })

      if (
        /^(basic|free)$/i.test(
          String(result.plan?.tier || ''),
        )
      ) {
        output.reason =
          'The current Highlightly plan does not include odds.'

        return output
      }

      for (const entry of rows(result)) {
        if (
          String(entry.matchId) === String(matchId)
        ) {
          markets.push(...(entry.odds || []))
        }
      }

      if (
        rows(result).length < 5 ||
        (result.pagination?.totalCount != null &&
          offset + 5 >=
            result.pagination.totalCount)
      ) {
        break
      }
    }

    output.bookmakers = normalizeBooks(markets)

    output.status = output.bookmakers.length
      ? 'available'
      : 'unavailable'

    output.reason = output.bookmakers.length
      ? null
      : 'No pregame lines have been posted for this matchup.'
  } catch (error) {
    output.reason = /401|403/.test(error.message)
      ? 'The odds provider rejected access. Check the GitHub secret and your Highlightly plan.'
      : 'Odds could not refresh. They will be checked again on the next scheduled run.'

    console.warn(
      `Optional odds request failed: ${error.message}`,
    )
  }

  return output
}

export function archivedOdds(
  preview,
  archive,
  now = Date.now(),
) {
  const game =
    preview?.status === 'ready'
      ? preview.game
      : null

  if (
    !game ||
    !Number.isFinite(Date.parse(game.date)) ||
    Date.parse(game.date) <= now
  ) {
    return null
  }

  // NBA and ESPN use different IDs.
  // Match the home team, away team and tipoff time.
  const candidates = Object.values(
    archive?.games || {},
  )
    .filter(record => {
      const stamp = Date.parse(
        record.line?.captured_at || '',
      )

      return (
        record.status === 'available' &&
        record.line?.line_type === 'pregame' &&
        abbr(record.home) ===
          abbr(game.home.abbreviation) &&
        abbr(record.away) ===
          abbr(game.away.abbreviation) &&
        Number.isFinite(
          Date.parse(record.game_date),
        ) &&
        Math.abs(
          Date.parse(record.game_date) -
            Date.parse(game.date),
        ) <=
          3 * 3600000 &&
        Number.isFinite(stamp) &&
        stamp <= now + 60000 &&
        now - stamp < 2 * 3600000 &&
        stamp < Date.parse(game.date)
      )
    })
    .sort(
      (a, b) =>
        Date.parse(b.line.captured_at) -
        Date.parse(a.line.captured_at),
    )

  const record = candidates[0]

  if (!record) return null

  const line = record.line

  const homeKnicks =
    abbr(game.home.abbreviation) === 'NYK'

  const markets = []

  if (valid(line.spread)) {
    const homeSpread = homeKnicks
      ? line.spread
      : -line.spread

    markets.push({
      market: `Spread ${signed(
        homeSpread,
      )}/${signed(-homeSpread)}`,
      values: [],
    })
  }

  if (valid(line.total)) {
    markets.push({
      market: `Totals ${line.total}`,
      values: [],
    })
  }

  if (
    valid(line.moneyline) &&
    Math.abs(line.moneyline) >= 100
  ) {
    markets.push({
      market: 'Moneyline',
      values: [
        {
          value: homeKnicks ? 'Home' : 'Away',
          odd: decimal(line.moneyline),
        },
      ],
    })
  }

  if (!markets.length) return null

  return {
    schema_version: 1,

    // Preserve the actual snapshot time.
    generated_at: line.captured_at,
    converted_at: new Date(now).toISOString(),

    source: line.source || 'ESPN',

    // Use the ID expected by the game preview.
    game_id: String(game.id),
    archive_game_id: record.game_id,

    match_id: null,
    odds_type: 'prematch',
    price_format: 'decimal',
    status: 'available',
    reason: null,

    bookmakers: [
      {
        id: `espn:${
          line.bookmaker_id ||
          line.bookmaker ||
          'default'
        }`,
        name: `${
          line.bookmaker || 'Provider'
        } (ESPN)`,
        markets,
      },
    ],
  }
}

async function main() {
  const preview = JSON.parse(
    await readFile('gameday.json', 'utf8'),
  )

  let archive = null

  try {
    archive = JSON.parse(
      await readFile(
        'betting-results.json',
        'utf8',
      ),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(
        'Saved betting data could not be read; trying Highlightly.',
      )
    }
  }

  // Prefer fresh ESPN lines already saved by the
  // betting-results workflow. Fall back to Highlightly.
  const output =
    archivedOdds(preview, archive) ||
    (await buildOdds(preview))

  await writeFile(
    'odds.json',
    JSON.stringify(output, null, 2) + '\n',
  )

  console.log(
    `Wrote odds.json: ${output.status}; source ${output.source}; ${output.bookmakers.length} sportsbooks.`,
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
