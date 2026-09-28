import { readFile, writeFile } from 'node:fs/promises';

const BASE = (process.env.HIGHLIGHTLY_BASE_URL || 'https://nba.highlightly.net').replace(/\/$/, '');
const KEY = process.env.HIGHLIGHTLY_API_KEY || '';
const NOW = new Date(process.env.GAMEDAY_NOW || Date.now());
const SEASON = NOW.getUTCMonth() >= 6 ? NOW.getUTCFullYear() : NOW.getUTCFullYear() - 1;
const OUT = process.env.GAMEDAY_OUTPUT || 'gameday.json';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Fixtures verified against the official Knicks 2026 preseason schedule.
// They provide a matchup preview until Highlightly publishes the game.
const KNICKS = {
  abbreviation: 'NYK',
  displayName: 'New York Knicks',
  name: 'Knicks',
  logo: 'https://cdn.nba.com/logos/nba/1610612752/primary/L/logo.svg',
};

const PRESEASON_2026 = [
  {
    id: '0012600023',
    date: '2026-10-05T23:00:00Z',
    home: {
      abbreviation: 'PHI',
      displayName: 'Philadelphia 76ers',
      name: '76ers',
      logo: 'https://cdn.nba.com/logos/nba/1610612755/primary/L/logo.svg',
    },
    venue: 'Xfinity Mobile Arena',
  },
  {
    id: '0012600035',
    date: '2026-10-08T23:30:00Z',
    home: KNICKS,
    away: {
      abbreviation: 'WAS',
      displayName: 'Washington Wizards',
      name: 'Wizards',
      logo: 'https://cdn.nba.com/logos/nba/1610612764/primary/L/logo.svg',
    },
    venue: 'Madison Square Garden',
  },
  {
    id: '0012600043',
    date: '2026-10-12T23:30:00Z',
    home: KNICKS,
    away: {
      abbreviation: 'MIN',
      displayName: 'Minnesota Timberwolves',
      name: 'Timberwolves',
      logo: 'https://cdn.nba.com/logos/nba/1610612750/primary/L/logo.svg',
    },
    venue: 'Madison Square Garden',
  },
  {
    id: '0012600046',
    date: '2026-10-13T23:00:00Z',
    home: {
      abbreviation: 'TOR',
      displayName: 'Toronto Raptors',
      name: 'Raptors',
      logo: 'https://cdn.nba.com/logos/nba/1610612761/primary/L/logo.svg',
    },
    venue: 'Scotiabank Arena',
  },
  {
    id: '0012600055',
    date: '2026-10-15T23:30:00Z',
    home: KNICKS,
    away: {
      abbreviation: 'TOR',
      displayName: 'Toronto Raptors',
      name: 'Raptors',
      logo: 'https://cdn.nba.com/logos/nba/1610612761/primary/L/logo.svg',
    },
    venue: 'Madison Square Garden',
  },
];

function preseasonFallback(now) {
  const next = PRESEASON_2026.find(
    fixture => Date.parse(fixture.date) > now.getTime()
  );
  if (!next) return null;

  const team = value => ({
    id: null,
    name: value.displayName,
    abbreviation: value.abbreviation,
    logo: value.logo,
    score: null,
  });

  return {
    game: {
      id: `nba:${next.id}`,
      date: next.date,
      season: 2026,
      status: 'Scheduled',
      period: null,
      clock: null,
      home: team(next.home),
      away: team(next.away || KNICKS),
    },
    venue: { name: next.venue },
    opponent: next.home === KNICKS ? next.away : next.home,
  };
}

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
  const name = opponent?.name || '';
  const full = opponent?.displayName || '';
  const terms = [...new Set([name, full].filter(value => value.length > 3))];
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
  const fallback = preseasonFallback(now);

  const useFallback =
    fallback &&
    (!game ||
      (Date.parse(game.date) > now.getTime() &&
        Date.parse(fallback.game.date) < Date.parse(game.date)));

  const document = {
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

  if (useFallback || !game) {
    if (useFallback) {
      document.status = 'ready';
      document.source =
        'NBA Knicks official 2026 preseason schedule (fixture fallback)';
      document.phase = 'preseason';
      document.game = fallback.game;
      document.venue = fallback.venue;
      document.storylines = previews(feed, fallback.opponent, now);
      document.meta.fixture_fallback = true;
    }

    return document;
  }

  document.phase =
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

  document.storylines = previews(feed, opponent, now);

  const sameGame = previous?.game?.id === String(game.id);
  const staticFresh =
    sameGame &&
    Number.isFinite(Date.parse(previous.meta?.static_updated_at)) &&
    now.getTime() - Date.parse(previous.meta.static_updated_at) <
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

    ...(!isLive(game) && !isFinished(game)
      ? []
      : [
          ['box score', `/box-score/${game.id}`],
          [
            'highlights',
            '/highlights',
            { matchId: game.id, limit: 20 },
          ],
        ]),
  ];

  const results = await Promise.all(
    calls.map(async ([label, path, params]) => [
      label,
      await safe(label, () => request(path, params), errors),
    ])
  );

  const result = Object.fromEntries(results);
  const detail = one(result.detail);

  document.venue =
    detail?.venue || (sameGame ? previous.venue : null) || null;
  document.game_statistics = detail?.matchStatistics || null;
  document.events = Array.isArray(detail?.events)
    ? detail.events.slice(-30)
    : [];
  document.predictions = detail?.predictions || null;

  document.team_comparison = {
    label: `Games since Oct 1, ${SEASON - 1}`,
    knicks: staticFresh
      ? previous.team_comparison?.knicks ?? null
      : totals(result['knicks stats']),
    opponent: staticFresh
      ? previous.team_comparison?.opponent ?? null
      : totals(result['opponent stats']),
  };

  document.recent_form = staticFresh
    ? previous.recent_form
    : {
        knicks: rows(result['knicks form']).map(compactGame),
        opponent: rows(result['opponent form']).map(compactGame),
      };

  document.head_to_head = staticFresh
    ? previous.head_to_head || []
    : rows(result['head to head']).map(compactGame);

  document.lineups = result.lineups
    ? one(result.lineups)
    : sameGame
      ? previous.lineups
      : null;

  document.box_score = result['box score']
    ? rows(result['box score'])
    : sameGame
      ? previous.box_score
      : null;

  document.highlights = result.highlights
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

  document.meta.static_updated_at = staticFresh
    ? previous.meta.static_updated_at
    : now.toISOString();

  return document;
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
