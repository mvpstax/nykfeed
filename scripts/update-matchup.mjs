import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const abbr = value =>
  String(value || "")
    .toUpperCase()
    .replace(/^NY$/, "NYK")
    .replace(/^WAS$/, "WSH");

const number = value =>
  value == null ||
  String(value).trim() === "" ||
  !Number.isFinite(Number(value))
    ? null
    : Number(value);

const score = team =>
  number(
    typeof team?.score === "object"
      ? team.score?.value
      : team?.score
  );

const dateKey = value =>
  new Date(value).toLocaleDateString("en-CA", {
    timeZone: "America/New_York"
  });

const person = athlete => ({
  id: String(athlete?.id || ""),
  name:
    athlete?.displayName ||
    athlete?.fullName ||
    "Player",
  position: athlete?.position?.abbreviation || "",
  jersey: athlete?.jersey ?? null,
  photo: athlete?.headshot?.href || null
});

async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function get(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${new URL(url).pathname}`
    );
  }

  return response.json();
}

function sameGame(a, b) {
  return (
    a &&
    b &&
    abbr(a.home.abbreviation) ===
      abbr(b.home.abbreviation) &&
    abbr(a.away.abbreviation) ===
      abbr(b.away.abbreviation) &&
    Math.abs(
      Date.parse(a.date) - Date.parse(b.date)
    ) < 3 * 3600000
  );
}

export function injuriesFor(summary, teamId) {
  const group = summary.injuries?.find(
    item =>
      String(item.team?.id) === String(teamId)
  );

  return {
    reported: !!group,
    players: (group?.injuries || []).map(item => ({
      ...person(item.athlete),
      status: item.status || "Not specified",
      detail: [
        item.details?.type,
        item.details?.location !== "Other"
          ? item.details?.location
          : null
      ]
        .filter(Boolean)
        .join(" · "),
      reported_at: item.date || null
    }))
  };
}

function eventGame(event, teamId) {
  const competition = event.competitions?.[0];
  const sides = competition?.competitors || [];

  const mine = sides.find(
    item =>
      String(item.team?.id) === String(teamId)
  );

  const other = sides.find(
    item =>
      String(item.team?.id) !== String(teamId)
  );

  if (
    !mine ||
    !other ||
    !competition.status?.type?.completed ||
    score(mine) === null ||
    score(other) === null
  ) {
    return null;
  }

  return {
    id: String(event.id),
    date: event.date,
    points: score(mine),
    allowed: score(other),
    home: mine.homeAway === "home",
    opponent: abbr(other.team?.abbreviation),
    result:
      score(mine) > score(other)
        ? "W"
        : score(mine) < score(other)
          ? "L"
          : "T"
  };
}

export function normalizeBox(summary) {
  return (summary.boxscore?.teams || []).map(group => {
    const stats = Object.fromEntries(
      (group.statistics || []).map(stat => [
        stat.name,
        stat.displayValue
      ])
    );

    const pair = text => {
      const match = String(text || "").match(
        /^(\d+)\s*[-/]\s*(\d+)$/
      );

      return match
        ? [Number(match[1]), Number(match[2])]
        : null;
    };

    const players = summary.boxscore?.players?.find(
      item =>
        String(item.team?.id) ===
        String(group.team?.id)
    );

    const seen = new Set();

    const rows = (
      players?.statistics || []
    ).flatMap(section =>
      (section.athletes || []).flatMap(row => {
        if (
          row.didNotPlay ||
          !row.athlete?.id ||
          seen.has(String(row.athlete.id))
        ) {
          return [];
        }

        seen.add(String(row.athlete.id));

        const raw =
          row.stats?.[
            (section.labels || []).indexOf("MIN")
          ];

        const parts = String(raw || "")
          .split(":")
          .map(Number);

        const minutes =
          parts.length === 2
            ? parts[0] + parts[1] / 60
            : number(raw);

        return [{
          ...person(row.athlete),
          starter: row.starter === true,
          minutes: Number.isFinite(minutes)
            ? minutes
            : 0
        }];
      })
    );

    return {
      id: String(group.team?.id),

      fg:
        pair(
          stats.fieldGoalsMade +
          "-" +
          stats.fieldGoalsAttempted
        ) ||
        pair(
          stats["fieldGoalsMade-fieldGoalsAttempted"]
        ),

      three:
        pair(
          stats.threePointFieldGoalsMade +
          "-" +
          stats.threePointFieldGoalsAttempted
        ) ||
        pair(
          stats[
            "threePointFieldGoalsMade-threePointFieldGoalsAttempted"
          ]
        ),

      rebounds: number(stats.totalRebounds),
      assists: number(stats.assists),
      turnovers: number(stats.totalTurnovers),
      players: rows
    };
  });
}

export function aggregate(games, boxes, teamId) {
  const samples = games
    .map(game =>
      boxes[game.id]?.find(
        team => team.id === String(teamId)
      )
    )
    .filter(Boolean);

  const mean = key =>
    samples.length === games.length &&
    games.length &&
    samples.every(item => item[key] != null)
      ? samples.reduce(
          (total, item) => total + item[key],
          0
        ) / games.length
      : null;

  const pct = key => {
    if (
      samples.length !== games.length ||
      !games.length ||
      !samples.every(item => item[key])
    ) {
      return null;
    }

    const made = samples.reduce(
      (total, item) => total + item[key][0],
      0
    );

    const attempts = samples.reduce(
      (total, item) => total + item[key][1],
      0
    );

    return attempts > 0
      ? made / attempts * 100
      : null;
  };

  return {
    games: games.length,
    boxes: samples.length,
    wins: games.filter(
      game => game.result === "W"
    ).length,
    losses: games.filter(
      game => game.result === "L"
    ).length,

    points: games.length
      ? games.reduce(
          (total, game) => total + game.points,
          0
        ) / games.length
      : null,

    allowed: games.length
      ? games.reduce(
          (total, game) => total + game.allowed,
          0
        ) / games.length
      : null,

    fg: pct("fg"),
    three: pct("three"),
    rebounds: mean("rebounds"),
    assists: mean("assists"),
    turnovers: mean("turnovers")
  };
}

export function estimateLineup(
  games,
  boxes,
  teamId,
  roster,
  injuries
) {
  const current = new Map(
    roster.map(player => [player.id, player])
  );

  const excluded = new Set(
    injuries
      .filter(player =>
        /^(out|doubtful|suspended|inactive)$/i.test(
          player.status
        )
      )
      .map(player => player.id)
  );

  const candidates = new Map();
  let used = 0;

  for (
    const [index, game] of
    games.slice(0, 3).entries()
  ) {
    const sample = boxes[game.id]?.find(
      team => team.id === String(teamId)
    );

    if (!sample?.players.length) continue;
    used++;

    for (const player of sample.players) {
      if (
        !current.has(player.id) ||
        excluded.has(player.id)
      ) {
        continue;
      }

      const old = candidates.get(player.id) || {
        ...current.get(player.id),
        weight: 0
      };

      old.weight +=
        (player.starter ? 100 : 0) *
          (3 - index) +
        player.minutes * (3 - index);

      candidates.set(player.id, old);
    }
  }

  const selected = [...candidates.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(({ weight, ...player }) => ({
      ...player,
      availability:
        injuries.find(
          item => item.id === player.id
        )?.status || null
    }));

  return {
    status:
      selected.length === 5
        ? "estimated"
        : "unavailable",

    source: "Estimate from ESPN game logs",

    method:
      `Estimated from starts and minutes in ${used} recent ` +
      `${used === 1 ? "game" : "games"}. ` +
      "Out and doubtful players excluded. " +
      "Not a reported lineup.",

    players:
      selected.length === 5 ? selected : []
  };
}

function reportedLineup(
  summary,
  preview,
  side,
  teamId,
  roster,
  injuries
) {
  const byId = new Map(
    roster.map(player => [player.id, player])
  );

  const group = summary.boxscore?.players?.find(
    item =>
      String(item.team?.id) === String(teamId)
  );

  const espn = (
    group?.statistics || []
  ).flatMap(section =>
    (section.athletes || [])
      .filter(
        row =>
          row.starter === true &&
          !row.didNotPlay
      )
      .map(row => ({
        ...person(row.athlete),
        ...(byId.get(
          String(row.athlete.id)
        ) || {})
      }))
  );

  const payload = preview.lineups?.[side];

  const provider =
    abbr(payload?.team?.abbreviation) ===
    abbr(preview.game?.[side]?.abbreviation)
      ? (payload.lineup || [])
          .filter(row => row.isStarter === true)
          .map(row => {
            const found = roster.find(
              player =>
                player.name.toLowerCase() ===
                String(row.player).toLowerCase()
            );

            return found || {
              id: `highlightly:${row.id}`,
              name: row.player,
              position:
                row.positionAbbreviation || "",
              jersey: row.jersey ?? null,
              photo: null
            };
          })
      : [];

  const rows = [
    ...new Map(
      (espn.length === 5 ? espn : provider)
        .map(player => [player.id, player])
    ).values()
  ];

  if (rows.length !== 5) return null;

  return {
    status: "reported",
    source:
      espn.length === 5
        ? "ESPN"
        : "Highlightly",
    method:
      "Starters marked by the data provider. " +
      "Check availability for late changes.",
    players: rows.map(player => ({
      ...player,
      availability:
        injuries.find(
          item => item.id === player.id
        )?.status || null
    }))
  };
}

export async function main() {
  const preview = await read("gameday.json");
  const schedule = await read("games.json");

  if (
    !preview?.game ||
    preview.status !== "ready"
  ) {
    await writeFile(
      "matchup.json",
      JSON.stringify({
        schema_version: 1,
        status: "no_game",
        generated_at: new Date().toISOString(),
        game: null
      }, null, 2) + "\n"
    );

    return;
  }

  const game = preview.game;

  const match = (schedule?.games || []).find(
    entry =>
      /^espn:\d+$/.test(
        entry.game?.id || ""
      ) &&
      sameGame(entry.game, game)
  );

  const espnId =
    match?.game.id.replace("espn:", "") ||
    (
      /^espn:\d+$/.test(game.id)
        ? game.id.replace("espn:", "")
        : null
    );

  if (!espnId) {
    throw new Error(
      "No matching ESPN game. " +
      "Run Refresh Knicks Last Game first."
    );
  }

  const summary = await get(
    `${ROOT}/summary?event=${espnId}`
  );

  if (
    String(summary.header?.id) !== espnId
  ) {
    throw new Error("Summary game mismatch");
  }

  const competition =
    summary.header?.competitions?.[0];

  const year = Number(
    summary.header?.season?.year
  );

  const phase = Number(
    summary.header?.season?.type
  );

  if (
    !Number.isInteger(year) ||
    ![1, 2, 3].includes(phase)
  ) {
    throw new Error(
      "Season or phase is unavailable; " +
      "previous data retained."
    );
  }

  const phaseName = {
    1: "Preseason",
    2: "Regular season",
    3: "Playoffs"
  }[phase];

  const season =
    `${year - 1}–${String(year).slice(-2)}`;

  const boxes = {
    ...(
      (await read("matchup-cache.json"))
        ?.boxes || {}
    )
  };

  const errors = [];

  const teams = await Promise.all(
    ["away", "home"].map(async side => {
      const competitor =
        competition?.competitors?.find(
          item => item.homeAway === side
        );

      if (
        !competitor ||
        abbr(
          competitor.team.abbreviation
        ) !==
          abbr(game[side].abbreviation)
      ) {
        throw new Error(
          "Matchup teams do not match"
        );
      }

      const teamId = competitor.team.id;

      const [
        scheduleResult,
        rosterResult
      ] = await Promise.allSettled([
        get(
          `${ROOT}/teams/${teamId}/schedule` +
          `?season=${year}&seasontype=${phase}`
        ),
        get(
          `${ROOT}/teams/${teamId}/roster`
        )
      ]);

      let events = [];

      if (
        scheduleResult.status === "fulfilled" &&
        Number(
          scheduleResult.value
            .requestedSeason?.year ??
          scheduleResult.value.season?.year
        ) === year &&
        Number(
          scheduleResult.value
            .requestedSeason?.type ??
          scheduleResult.value.season?.type
        ) === phase
      ) {
        events =
          scheduleResult.value.events || [];
      } else {
        errors.push(
          `${competitor.team.abbreviation}: ` +
          "current-phase schedule unavailable"
        );
      }

      const games = events
        .map(event =>
          eventGame(event, teamId)
        )
        .filter(
          item =>
            item &&
            Date.parse(item.date) <
              Date.parse(game.date)
        )
        .sort(
          (a, b) =>
            Date.parse(b.date) -
            Date.parse(a.date)
        );

      const roster =
        rosterResult.status === "fulfilled"
          ? (
              rosterResult.value.athletes ||
              []
            ).map(person)
          : [];

      if (
        rosterResult.status === "rejected"
      ) {
        errors.push(
          `${competitor.team.abbreviation}: ` +
          "roster unavailable"
        );
      }

      return {
        side,
        id: String(teamId),
        name: competitor.team.displayName,
        abbreviation: abbr(
          competitor.team.abbreviation
        ),
        logo:
          competitor.team.logos?.[0]?.href ||
          game[side].logo ||
          null,
        color:
          `#${competitor.team.color || "006bb6"}`,
        games,
        roster,
        availability: injuriesFor(
          summary,
          teamId
        )
      };
    })
  );

  const ids = [
    ...new Set(
      teams.flatMap(team =>
        team.games
          .filter(
            item =>
              !boxes[item.id]?.some(
                box =>
                  box.id === team.id &&
                  box.players?.length
              )
          )
          .map(item => item.id)
      )
    )
  ].slice(0, 12);

  for (
    let index = 0;
    index < ids.length;
    index += 4
  ) {
    await Promise.all(
      ids
        .slice(index, index + 4)
        .map(async id => {
          try {
            const data = await get(
              `${ROOT}/summary?event=${id}`
            );

            if (
              String(data.header?.id) !== id
            ) {
              throw new Error("Game mismatch");
            }

            boxes[id] = normalizeBox(data);
          } catch (error) {
            errors.push(
              `Box ${id}: ${error.message}`
            );
          }
        })
    );
  }

  const now = new Date();

  const output = {
    schema_version: 1,
    status: "ready",
    generated_at: now.toISOString(),
    source:
      "ESPN; Highlightly when reported",
    game: {
      ...game,
      espn_id: espnId
    },
    season,
    phase: phaseName,
    venue:
      summary.gameInfo?.venue?.fullName ||
      preview.venue?.name ||
      null,

    broadcasts: [
      ...new Set([
        ...(preview.broadcasts || []),

        ...(
          competition?.broadcasts || []
        ).flatMap(
          item => item.names || []
        ),

        ...(
          summary.broadcasts || []
        ).flatMap(item =>
          item.names ||
          item.media?.shortName
            ? item.names ||
              [item.media.shortName]
            : []
        )
      ])
    ],

    teams: {},
    meta: { errors }
  };

  for (const team of teams) {
    const latest = team.games[0];

    const restDays = latest
      ? Math.max(
          0,
          Math.round(
            (
              Date.parse(
                dateKey(game.date)
              ) -
              Date.parse(
                dateKey(latest.date)
              )
            ) / 86400000
          ) - 1
        )
      : null;

    const lineup =
      reportedLineup(
        summary,
        preview,
        team.side,
        team.id,
        team.roster,
        team.availability.players
      ) ||
      estimateLineup(
        team.games,
        boxes,
        team.id,
        team.roster,
        team.availability.players
      );

    output.teams[team.side] = {
      id: team.id,
      name: team.name,
      abbreviation: team.abbreviation,
      logo: team.logo,
      color: team.color,

      stats: aggregate(
        team.games,
        boxes,
        team.id
      ),

      lineup,
      availability: team.availability,
      rest_days: restDays,
      recent: team.games.slice(0, 5),

      home_record:
        `${
          team.games.filter(
            item =>
              item.home &&
              item.result === "W"
          ).length
        }–${
          team.games.filter(
            item =>
              item.home &&
              item.result === "L"
          ).length
        }`,

      away_record:
        `${
          team.games.filter(
            item =>
              !item.home &&
              item.result === "W"
          ).length
        }–${
          team.games.filter(
            item =>
              !item.home &&
              item.result === "L"
          ).length
        }`
    };
  }

  await writeFile(
    "matchup-cache.json",
    JSON.stringify({
      schema_version: 1,
      boxes
    }, null, 2) + "\n"
  );

  await writeFile(
    "matchup.json",
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log(
    `Matchup: ${output.teams.away.abbreviation} ` +
    `at ${output.teams.home.abbreviation}; ` +
    `${phaseName}; ${errors.length} optional errors.`
  );
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
