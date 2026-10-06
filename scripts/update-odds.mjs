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

async function api(route, params) {
  const url = new URL(BASE + route)

  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value))
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

  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export function normalizeBooks(markets) {
  const books = new Map()

  for (const market of markets) {
    if (
      market.type !== 'prematch' ||
      !/^(moneyline|full time result|spread\b|totals?\b|total points\b)/i
        .test(market.market || '')
    ) continue

    const values = (market.values || [])
      .filter(v =>
        Number.isFinite(Number(v.odd)) && Number(v.odd) > 1,
      )
      .map(v => ({
        value: String(v.value),
        odd: Number(v.odd),
      }))

    if (!values.length || !market.bookmakerId) continue

    const id = String(market.bookmakerId)

    if (!books.has(id)) {
      books.set(id, {
        id,
        name: market.bookmakerName || `Sportsbook ${id}`,
        markets: [],
      })
    }

    const book = books.get(id)

    if (!book.markets.some(m => m.market === market.market)) {
      book.markets.push({
        market: String(market.market),
        values,
      })
    }
  }

  return [...books.values()].sort((a, b) =>
    b.markets.length - a.markets.length ||
    a.name.localeCompare(b.name),
  )
}

export async function buildOdds(preview, request = api) {
  const game = preview?.status === 'ready'
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

  if (!game || !Number.isFinite(Date.parse(game.date))) {
    output.reason = 'No matchup is available yet.'
    return output
  }

  try {
    // NBA and ESPN ids are not Highlightly match ids.
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

        const match = rows(result).find(m =>
          m.homeTeam?.abbreviation === game.home.abbreviation &&
          m.awayTeam?.abbreviation === game.away.abbreviation &&
          Number.isFinite(Date.parse(m.date)) &&
          Math.abs(
            Date.parse(m.date) - Date.parse(game.date),
          ) <= 3 * 3600000,
        )

        if (match) matchId = Number(match.id) || null
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

    for (let offset = 0; offset < 100; offset += 5) {
      const result = await request('/odds', {
        matchId,
        oddsType: 'prematch',
        limit: 5,
        offset,
        bookmakerName: process.env.ODDS_BOOKMAKER || undefined,
      })

      if (
        /^(basic|free)$/i.test(String(result.plan?.tier || ''))
      ) {
        output.reason =
          'The current Highlightly plan does not include odds.'
        return output
      }

      for (const entry of rows(result)) {
        if (String(entry.matchId) === String(matchId)) {
          markets.push(...(entry.odds || []))
        }
      }

      if (
        rows(result).length < 5 ||
        (
          result.pagination?.totalCount != null &&
          offset + 5 >= result.pagination.totalCount
        )
      ) break
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

    console.warn(`Optional odds request failed: ${error.message}`)
  }

  return output
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!KEY) {
    throw new Error(
      'HIGHLIGHTLY_API_KEY is missing. Add it to GitHub Actions secrets.',
    )
  }

  const preview = JSON.parse(
    await readFile('gameday.json', 'utf8'),
  )

  const output = await buildOdds(preview)

  await writeFile(
    'odds.json',
    JSON.stringify(output, null, 2) + '\n',
  )

  console.log(
    `Wrote odds.json: ${output.status}; ${
      output.bookmakers.length
    } sportsbooks.`,
  )
}
