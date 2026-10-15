import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const ROOT =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"

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
    signal: AbortSignal.timeout(20000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`)
  }

  return response.json()
}

const clean = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()

const number = (v) =>
  v === null ||
  v === undefined ||
  String(v).trim() === "" ||
  !Number.isFinite(Number(v))
    ? null
    : Number(v)

const score = (c) =>
  number(
    typeof c?.score === "object"
      ? c.score?.value
      : c?.score,
  )

export function parseMinutes(v) {
  if (/^\d+:\d{2}$/.test(String(v))) {
    const [m, s] = v.split(":").map(Number)
    return s < 60 ? m + s / 60 : null
  }

  return number(v)
}

export function parsePlayers(
  summary,
  event,
  season,
  phase,
) {
  const competition = summary.header?.competitions?.[0]

  if (
    String(summary.header?.id) !== String(event.id) ||
    !competition?.status?.type?.completed
  ) {
    throw new Error(
      `Game ${event.id} is not a matching completed summary`,
    )
  }

  const sides = competition.competitors || []

  const mine = sides.find(
    (c) => String(c.team?.id) === "18",
  )

  const other = sides.find(
    (c) => String(c.team?.id) !== "18",
  )

  if (
    !mine ||
    !other ||
    score(mine) === null ||
    score(other) === null
  ) {
    throw new Error(
      `Missing Knicks score for ${event.id}`,
    )
  }

  const group = summary.boxscore?.players?.find(
    (g) => String(g.team?.id) === "18",
  )

  const table = group?.statistics?.find(
    (g) =>
      g.labels?.includes("PTS") &&
      g.labels?.includes("MIN"),
  )

  if (!table?.athletes?.length) {
    throw new Error(
      `Missing player box score for ${event.id}`,
    )
  }

  const result = score(mine) > score(other) ? "W" : "L"
  const rows = []

  for (const row of table.athletes) {
    if (row.didNotPlay) continue

    const stats = Object.fromEntries(
      table.labels.map((label, i) => [
        label,
        row.stats?.[i],
      ]),
    )

    const minutes = parseMinutes(stats.MIN)

    if (minutes === null || minutes <= 0) continue

    const points = number(stats.PTS)
    const rebounds = number(stats.REB)
    const assists = number(stats.AST)

    if (
      [points, rebounds, assists].some(
        (v) => v === null || v < 0,
      )
    ) {
      throw new Error(
        `Incomplete player stats for ${event.id}`,
      )
    }

    rows.push({
      name: row.athlete?.displayName,
      game: {
        id: String(event.id),
        date: event.date,
        season,
        type: phase,
        matchup: `NYK ${
          mine.homeAway === "home" ? "vs." : "@"
        } ${other.team?.abbreviation || "OPP"}`,
        result,
        minutes,
        points,
        rebounds,
        assists,
        fg: stats.FG || null,
        three: stats["3PT"] || null,
      },
    })
  }

  if (!rows.length) {
    throw new Error(
      `No appearances found for ${event.id}`,
    )
  }

  return rows
}

async function main() {
  const roster = await read("players.json", null)

  if (
    !Array.isArray(roster?.players) ||
    roster.players.length < 5
  ) {
    throw new Error(
      "players.json must contain the current Knicks roster",
    )
  }

  const intel = await read("matchup.json", null)

  if (!intel?.game?.espn_id) {
    throw new Error(
      "Run Refresh Knicks Matchup first; matchup.json needs game.espn_id",
    )
  }

  const current = await get(
    `${ROOT}/summary?event=${intel.game.espn_id}`,
  )

  if (
    String(current.header?.id) !==
    String(intel.game.espn_id)
  ) {
    throw new Error("ESPN event identity mismatch")
  }

  const year = Number(current.header?.season?.year)
  const phaseId = Number(current.header?.season?.type)

  const phase = {
    1: "Preseason",
    2: "Regular Season",
    3: "Playoffs",
  }[phaseId]

  if (!year || !phase) {
    throw new Error(
      "ESPN did not supply a recognized season and competition",
    )
  }

  const season = `${year - 1}-${String(year).slice(-2)}`

  const schedule = await get(
    `${ROOT}/teams/18/schedule?season=${year}&seasontype=${phaseId}`,
  )

  const requested =
    schedule.requestedSeason || schedule.season

  if (
    Number(requested?.year) !== year ||
    Number(requested?.type) !== phaseId
  ) {
    throw new Error(
      "ESPN returned a different schedule competition",
    )
  }

  const events = (schedule.events || []).filter(
    (e) =>
      e.competitions?.[0]?.status?.type?.completed &&
      Date.parse(e.date) <= Date.now(),
  )

  if (!events.length) {
    throw new Error(
      `No completed ${phase} games; previous stats were kept`,
    )
  }

  const cache = await read("player-box-cache.json", {
    games: {},
  })

  const games = cache.games || {}
  const warnings = []

  for (let i = 0; i < events.length; i += 3) {
    await Promise.all(
      events.slice(i, i + 3).map(async (e) => {
        if (
          games[e.id]?.version === 1 &&
          games[e.id]?.season === season &&
          games[e.id]?.phase === phase
        ) {
          return
        }

        try {
          games[e.id] = {
            version: 1,
            season,
            phase,
            rows: parsePlayers(
              await get(`${ROOT}/summary?event=${e.id}`),
              e,
              season,
              phase,
            ),
          }
        } catch (error) {
          warnings.push(`${e.id}: ${error.message}`)
        }
      }),
    )
  }

  const available = events.filter(
    (e) =>
      games[e.id]?.version === 1 &&
      games[e.id]?.season === season &&
      games[e.id]?.phase === phase,
  )

  await writeFile(
    "player-box-cache.json",
    JSON.stringify({ games }, null, 2) + "\n",
  )

  // Keep the prior feed if this run has an incomplete sample.
  if (available.length !== events.length) {
    throw new Error(
      `Only ${available.length}/${events.length} boxes available. Existing player stats were kept. ${warnings.join(
        "; ",
      )}`,
    )
  }

  const old = await read("player-stats.json", {
    players: {},
  })

  const identities = new Map()

  for (const p of roster.players) {
    if (!/^nba:\d+$/.test(p.id)) {
      throw new Error(`Invalid NBA identity: ${p.id}`)
    }

    const key = clean(p.name)

    if (!key || identities.has(key)) {
      throw new Error(
        `Ambiguous roster name: ${p.name}`,
      )
    }

    identities.set(key, p.id)
  }

  const collected = Object.fromEntries(
    roster.players.map((p) => [p.id, []]),
  )

  for (const event of available) {
    for (const row of games[event.id].rows) {
      const id = identities.get(clean(row.name))

      if (id) collected[id].push(row.game)
    }
  }

  if (
    Object.values(collected).filter(
      (rows) => rows.length,
    ).length < 5
  ) {
    throw new Error(
      "Too few identity-matched players; existing stats were kept",
    )
  }

  const now = new Date().toISOString()
  const output = {}

  for (const p of roster.players) {
    const previous = old.players?.[p.id] || {}
    const currentGames = collected[p.id]

    const keep = (previous.game_log || []).filter(
      (g) =>
        !(
          g.season === season &&
          (g.type || g.phase) === phase
        ) &&
        !currentGames.some(
          (n) => String(n.id) === String(g.id),
        ),
    )

    // Preseason is never labeled as regular-season averages.
    const previousSeason =
      previous.season?.season === season &&
      phase === "Regular Season"
        ? null
        : previous.season || null

    output[p.id] = {
      ...previous,
      season: previousSeason,
      checked_at: now,
      game_log: [...currentGames, ...keep].sort(
        (a, b) =>
          Date.parse(b.date) - Date.parse(a.date),
      ),
    }
  }

  await writeFile(
    "player-stats.json",
    JSON.stringify(
      {
        schema_version: 1,
        team: "NYK",
        source: "ESPN completed Knicks box scores",
        updated_at: now,
        season,
        phase,
        sample: {
          games: events.length,
          scope:
            "Current competition; current roster; Knicks appearances only",
        },
        players: output,
      },
      null,
      2,
    ) + "\n",
  )

  console.log(
    `Saved ${events.length} ${phase} box scores for ${Object.keys(
      output,
    ).length} roster identities.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
