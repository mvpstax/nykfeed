import { readFile, writeFile } from 'node:fs/promises';

const BASE = (process.env.HIGHLIGHTLY_BASE_URL || 'https://nba.highlightly.net').replace(/\/$/, '');
const KEY = process.env.HIGHLIGHTLY_API_KEY || '';
const NOW = new Date(process.env.GAMEDAY_NOW || Date.now());
const SEASON = NOW.getUTCMonth() >= 6 ? NOW.getUTCFullYear() : NOW.getUTCFullYear() - 1;
const OUT = process.env.GAMEDAY_OUTPUT || 'gameday.json';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function jsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function api(path, params = {}) {
  const url = new URL(BASE + path);

  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': KEY,
        ...(url.hostname.endsWith('.rapidapi.com')
          ? { 'x-rapidapi-host': url.hostname }
          : {}),
      },
      signal: AbortSignal.timeout(12000),
    });

    if (response.ok) return response.json();
    if (attempt === 0 && RETRYABLE.has(response.status)) continue;

    throw new Error(`${path}: HTTP ${response.status}`);
  }
}

function rows(value) {
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : [];
}

function one(value) {
  return Array.isArray(value) ? value[0] : value?.data ?? value;
}

function idOf(team) {
  return Number(team?.id) || null;
}

function isKnicks(team) {
  return (
    team?.abbreviation === 'NYK' ||
    /new york knicks/i.test(team?.displayName || '')
  );
}

function isFinished(game) {
  return game?.state?.description === 'Finished';
}

function isLive(game) {
  return ['In progress', 'End period', 'Half time'].includes(
    game?.state?.description
  );
}

function score(game, side) {
  const pieces = game?.state?.score?.[side];

  return Array.isArray(pieces) && pieces.length
    ? pieces.reduce((total, value) => total + (Number(value) || 0), 0)
    : null;
}

function compactGame(game) {
  return {
    id: String(game.id),
    date: game.date,
    season: game.season,
    status: game.state?.description || 'Scheduled',
    period: game.state?.period ?? null,
    clock: game.state?.clock ?? null,
    home: {
      id: idOf(game.homeTeam),
      name: game.homeTeam?.displayName || game.homeTeam?.name,
      abbreviation: game.homeTeam?.abbreviation,
      logo: game.homeTeam?.logo || null,
      score: score(game, 'homeTeam'),
    },
    away: {
      id: idOf(game.awayTeam),
      name: game.awayTeam?.displayName || game.awayTeam?.name,
      abbreviation: game.awayTeam?.abbreviation,
      logo: game.awayTeam?.logo || null,
      score: score(game, 'awayTeam'),
    },
  };
}

function recentGames(games, now = NOW) {
  return games
    .filter(
      game =>
        Number.isFinite(Date.parse(game.date)) &&
        Date.parse(game.date) >= now.getTime() - 36 * 3600000
    )
    .sort((a, b) => {
      if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1;

      const aFuture = Date.parse(a.date) >= now.getTime();
      const bFuture = Date.parse(b.date) >= now.getTime();

      if (aFuture !== bFuture) return aFuture ? -1 : 1;

      return aFuture
        ? Date.parse(a.date) - Date.parse(b.date)
        : Date.parse(b.date) - Date.parse(a.date);
    });
}

function totals(value) {
  const entry =
    rows(value).find(item => item.leagueName === 'NBA') ||
    rows(value)[0] ||
    one(value);

  if (!entry?.total?.games) return null;

  const map = part => ({
    played: part?.games?.played ?? null,
    wins: part?.games?.wins ?? null,
    losses: part?.games?.loses ?? null,
    scored: part?.points?.scored ?? null,
    allowed: part?.points?.received ?? null,
  });

  return {
    total: map(entry.total),
    home: map(entry.home),
    away: map(entry.away),
  };
}

function previews(feed, opponent, now = NOW) {
  const terms = [
    ...new Set(
      [opponent?.name, opponent?.displayName].filter(
        value => typeof value === 'string' && value.length > 3
      )
    ),
  ];

  const cutoff = now.getTime() - 21 * 86400000;

  return (feed?.items || [])
    .filter(
      item =>
        item.type === 'article' &&
        Date.parse(item.published_at) >= cutoff
    )
    .map(item => {
      const copy = `${item.title || ''} ${item.summary || ''}`;
      const mentionsOpponent = terms.some(term =>
        copy.toLowerCase().includes(term.toLowerCase())
      );

      const relevant =
        mentionsOpponent ||
        /preseason|training camp|rotation|starting lineup|season preview/i.test(
          copy
        );

      return { item, mentionsOpponent, relevant };
    })
    .filter(result => result.relevant)
    .sort(
      (a, b) =>
        Number(b.mentionsOpponent) - Number(a.mentionsOpponent) ||
        Date.parse(b.item.published_at) - Date.parse(a.item.published_at)
    )
    .slice(0, 3)
    .map(({ item, mentionsOpponent }) => ({
      id: String(item.id),
      title: item.title,
      summary: item.summary || null,
      image_url: item.image_url || null,
      source: item.source,
      published_at: item.published_at,
      url: item.url,
      relevance: mentionsOpponent ? 'matchup' : 'knicks_preseason',
      generated: false,
    }));
}

async function safe(label, fn, errors) {
  try {
    return await fn();
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}

export async function buildGameDay({
  request = api,
  now = NOW,
  feed = null,
  previous = null,
} = {}) {
  const errors = [];

  const [home, away] = await Promise.all([
    safe(
      'home schedule',
      () =>
        request('/matches', {
          league: 'NBA',
          season: SEASON,
          homeTeamAbbreviation: 'NYK',
          limit: 100,
        }),
      errors
    ),
    safe(
      'away schedule',
      () =>
        request('/matches', {
          league: 'NBA',
          season: SEASON,
          awayTeamAbbreviation: 'NYK',
          limit: 100,
        }),
      errors
    ),
  ]);

  const unique = new Map(
    [...rows(home), ...rows(away)]
      .filter(game => isKnicks(game.homeTeam) || isKnicks(game.awayTeam))
      .map(game => [game.id, game])
  );

  const game = recentGames([...unique.values()], now)[0] || null;

  const output = {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: 'Highlightly NBA & NCAAB API',
    status: game ? 'ready' : 'no_game',
    season: SEASON,
    phase: null,
    game: game ? compactGame(game) : null,
    venue: null,
    team_comparison: null,
    recent_form: null,
    head_to_head: [],
    lineups: null,
    box_score: null,
    game_statistics: null,
    events: [],
    predictions: null,
    highlights: [],
    storylines: [],
    meta: { errors },
  };

  if (!game) return output;

  output.phase =
    SEASON === 2026 &&
    Date.parse(game.date) < Date.parse('2026-10-20T00:00:00-04:00')
      ? 'preseason'
      : 'season';

  const knicks = isKnicks(game.homeTeam)
    ? game.homeTeam
    : game.awayTeam;

  const opponent = isKnicks(game.homeTeam)
    ? game.awayTeam
    : game.homeTeam;

  const knicksId = idOf(knicks);
  const opponentId = idOf(opponent);

  output.storylines = previews(feed, opponent, now);

  const sameGame = previous?.game?.id === String(game.id);

  const staticFresh =
    sameGame &&
    Number.isFinite(Date.parse(previous.meta?.static_updated_at)) &&
    now.getTime() -
      Date.parse(previous.meta.static_updated_at) <
      18 * 3600000;

  const nearGame =
    Math.abs(Date.parse(game.date) - now.getTime()) < 3 * 3600000 ||
    isLive(game);

  const calls = [
    ['detail', `/matches/${game.id}`],

    ...(knicksId && opponentId && !staticFresh
      ? [
          [
            'knicks stats',
            `/teams/statistics/${knicksId}`,
            { fromDate: `${SEASON - 1}-10-01` },
          ],
          [
            'opponent stats',
            `/teams/statistics/${opponentId}`,
            { fromDate: `${SEASON - 1}-10-01` },
          ],
          ['knicks form', '/last-five-games', { teamId: knicksId }],
          ['opponent form', '/last-five-games', { teamId: opponentId }],
          [
            'head to head',
            '/head-2-head',
            { teamIdOne: knicksId, teamIdTwo: opponentId },
          ],
        ]
      : []),

    ...(nearGame ? [['lineups', `/lineups/${game.id}`]] : []),

    ...(isLive(game) || isFinished(game)
      ? [
          ['box score', `/box-score/${game.id}`],
          [
            'highlights',
            '/highlights',
            { matchId: game.id, limit: 20 },
          ],
        ]
      : []),
  ];

  const results = await Promise.all(
    calls.map(async ([label, path, params]) => [
      label,
      await safe(label, () => request(path, params), errors),
    ])
  );

  const result = Object.fromEntries(results);
  const detail = one(result.detail);

  output.venue =
    detail?.venue || (sameGame ? previous.venue : null) || null;

  output.game_statistics = detail?.matchStatistics || null;
  output.events = Array.isArray(detail?.events)
    ? detail.events.slice(-30)
    : [];

  output.predictions = detail?.predictions || null;

  output.team_comparison = {
    label: `Games since Oct 1, ${SEASON - 1}`,
    knicks: staticFresh
      ? previous.team_comparison?.knicks ?? null
      : totals(result['knicks stats']),
    opponent: staticFresh
      ? previous.team_comparison?.opponent ?? null
      : totals(result['opponent stats']),
  };

  output.recent_form = staticFresh
    ? previous.recent_form
    : {
        knicks: rows(result['knicks form']).map(compactGame),
        opponent: rows(result['opponent form']).map(compactGame),
      };

  output.head_to_head = staticFresh
    ? previous.head_to_head || []
    : rows(result['head to head']).map(compactGame);

  output.lineups = result.lineups
    ? one(result.lineups)
    : sameGame
      ? previous.lineups
      : null;

  output.box_score = result['box score']
    ? rows(result['box score'])
    : sameGame
      ? previous.box_score
      : null;

  output.highlights = result.highlights
    ? rows(result.highlights).map(highlight => ({
        id: String(highlight.id),
        title: highlight.title,
        image_url: highlight.imgUrl || null,
        url: highlight.url,
        embed_url: highlight.embedUrl || null,
        source: highlight.source,
        category: highlight.category,
      }))
    : sameGame
      ? previous.highlights || []
      : [];

  output.meta.static_updated_at = staticFresh
    ? previous.meta.static_updated_at
    : now.toISOString();

  return output;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  if (!KEY) {
    console.error(
      'HIGHLIGHTLY_API_KEY is required. Existing gameday.json was not changed.'
    );
    process.exitCode = 1;
  } else {
    const data = await buildGameDay({
      feed: await jsonFile('feed.json'),
      previous: await jsonFile(OUT),
    });

    const roster = await jsonFile('players.json');
    const stats = await jsonFile('player-stats.json');

    data.players_to_watch = (roster?.players || [])
      .map(player => {
        const season = stats?.players?.[player.id]?.season;

        return season && Number.isFinite(Number(season.points))
          ? {
              id: player.id,
              name: player.name,
              jersey: player.jersey,
              photo_url: player.photo_url,
              season: season.season,
              points: season.points,
              rebounds: season.rebounds,
              assists: season.assists,
              games: season.games,
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.points) - Number(a.points))
      .slice(0, 3);

    if (data.meta.errors.length && !data.game) {
      console.error(data.meta.errors.join('\n'));
      console.error(
        'Game lookup failed; existing gameday.json was not changed.'
      );
      process.exitCode = 1;
    } else {
      await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');

      console.log(
        `Wrote ${OUT}: ${data.status}${
          data.game
            ? `, ${data.game.away.abbreviation} at ${data.game.home.abbreviation}`
            : ''
        }; ${data.meta.errors.length} optional errors.`
      );
    }
  }
}
