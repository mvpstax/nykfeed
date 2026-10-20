import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  buildGameDay,
  selectPreviewStories,
} from './update-gameday.mjs';
import {
  main as refreshOdds,
} from './refresh-pregame-odds.mjs';

const abbr = value =>
  String(value || '').toUpperCase().replace(/^NY$/, 'NYK');

const live = game =>
  /in progress|in-progress|end period|half time|halftime|live/i.test(
    game?.status || ''
  );

const ended = game =>
  /finished|final|completed|cancelled|canceled|postponed|abandoned/i.test(
    game?.status || ''
  );

const isKnicks = game =>
  [game?.home, game?.away].some(
    team => abbr(team?.abbreviation) === 'NYK'
  );

async function read(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function write(path, data) {
  await writeFile(
    path,
    JSON.stringify(data, null, 2) + '\n'
  );
}

export function chooseScheduleGame(
  schedule,
  now = new Date()
) {
  return (schedule?.games || [])
    .map(entry => entry.game ? entry : { game: entry })
    .filter(({ game }) =>
      isKnicks(game) &&
      /^espn:\d+$/.test(String(game.id)) &&
      Number.isFinite(Date.parse(game.date)) &&
      !ended(game) &&
      (
        Date.parse(game.date) >= now.getTime() ||
        (
          live(game) &&
          Date.parse(game.date) >=
            now.getTime() - 8 * 3600000
        )
      )
    )
    .sort((a, b) =>
      Number(live(b.game)) - Number(live(a.game)) ||
      Date.parse(a.game.date) - Date.parse(b.game.date)
    )[0] || null;
}

export function shouldUseSchedule(
  preview,
  entry,
  now = new Date()
) {
  if (!entry) return false;

  const current =
    preview?.status === 'ready' ? preview.game : null;

  if (!current || ended(current)) return true;
  if (live(current)) return false;
  if (live(entry.game)) return true;

  if (Date.parse(current.date) < now.getTime()) {
    return true;
  }

  return (
    Date.parse(entry.game.date) <
    Date.parse(current.date) - 3 * 3600000
  );
}

export async function buildSchedulePreview(
  entry,
  feed,
  now = new Date(),
  fetcher = fetch
) {
  let game = structuredClone(entry.game);
  let venue = entry.venue || null;

  const errors = [];
  const eventId = String(game.id).replace('espn:', '');

  try {
    const response = await fetcher(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`,
      {
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      throw new Error(`ESPN HTTP ${response.status}`);
    }

    const summary = await response.json();
    const competition =
      summary.header?.competitions?.[0];

    const home = competition?.competitors?.find(
      team => team.homeAway === 'home'
    );

    const away = competition?.competitors?.find(
      team => team.homeAway === 'away'
    );

    const date =
      competition?.date || summary.header?.date;

    if (
      String(summary.header?.id) !== eventId ||
      abbr(home?.team?.abbreviation) !==
        abbr(game.home.abbreviation) ||
      abbr(away?.team?.abbreviation) !==
        abbr(game.away.abbreviation) ||
      !Number.isFinite(Date.parse(date)) ||
      Math.abs(
        Date.parse(date) - Date.parse(game.date)
      ) > 3 * 3600000
    ) {
      throw new Error('ESPN matchup verification failed');
    }

    const status =
      competition.status || summary.header?.status;

    const type = status?.type;

    const scoreValue = team => {
      const raw = team?.score?.value ?? team?.score;

      return (
        raw !== null &&
        raw !== undefined &&
        raw !== '' &&
        Number.isFinite(Number(raw))
      )
        ? Number(raw)
        : null;
    };

    game = {
      ...game,
      date,
      status: type?.completed
        ? 'Finished'
        : type?.state === 'in'
          ? 'In progress'
          : type?.state === 'pre'
            ? type.description || 'Scheduled'
            : game.status,
      period: status?.period ?? null,
      clock: status?.displayClock ?? null,
      home: {
        ...game.home,
        score: type?.state === 'pre'
          ? null
          : scoreValue(home),
      },
      away: {
        ...game.away,
        score: type?.state === 'pre'
          ? null
          : scoreValue(away),
      },
    };

    venue =
      summary.gameInfo?.venue ||
      competition.venue ||
      venue;
  } catch (error) {
    errors.push(`ESPN detail: ${error.message}`);
  }

  const opponent =
    abbr(game.home.abbreviation) === 'NYK'
      ? game.away
      : game.home;

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: 'ESPN schedule fallback',
    status: 'ready',
    season: now.getUTCMonth() >= 6
      ? now.getUTCFullYear()
      : now.getUTCFullYear() - 1,
    phase: /preseason/i.test(
      game.phase || entry.phase || ''
    )
      ? 'preseason'
      : 'season',
    game,
    venue,
    team_comparison: null,
    recent_form: null,
    head_to_head: [],
    lineups: null,
    box_score: null,
    game_statistics: null,
    events: [],
    predictions: null,
    highlights: [],
    storylines: selectPreviewStories(
      feed,
      opponent,
      now
    ),
    players_to_watch: [],
    meta: {
      errors,
      schedule_fallback: true,
      feed_generated_at: feed?.generated_at || null,
    },
  };
}

export async function main() {
  const now = new Date();

  const [
    feed,
    previous,
    schedule,
    roster,
    stats,
  ] = await Promise.all(
    [
      'feed.json',
      'gameday.json',
      'games.json',
      'players.json',
      'player-stats.json',
    ].map(read)
  );

  let preview;

  try {
    preview = await buildGameDay({
      now,
      feed,
      previous,
      ...(!process.env.HIGHLIGHTLY_API_KEY
        ? {
            request: async () => {
              throw new Error(
                'Highlightly key unavailable; trying ESPN schedule'
              );
            },
          }
        : {}),
    });
  } catch (error) {
    console.warn(
      `Highlightly preview: ${error.message}`
    );

    preview = {
      status: 'no_game',
      game: null,
      meta: {
        errors: [error.message],
      },
    };
  }

  const entry = chooseScheduleGame(schedule, now);

  if (shouldUseSchedule(preview, entry, now)) {
    const lookupErrors = preview.meta?.errors || [];

    preview = await buildSchedulePreview(
      entry,
      feed,
      now
    );

    preview.meta.errors.push(...lookupErrors);

    console.log(
      `Schedule fallback: ${preview.game.away.abbreviation} at ${preview.game.home.abbreviation}`
    );
  }

  if (
    !preview.game &&
    preview.meta?.errors?.length
  ) {
    throw new Error(
      'Game lookup failed. Existing preview and odds were preserved.'
    );
  }

  const coverage = (preview.storylines || [])
    .map(story => story.title || '')
    .join(' ')
    .toLowerCase();

  preview.players_to_watch = (roster?.players || [])
    .map(player => {
      const season = stats?.players?.[player.id]?.season;

      const valid =
        Number(season?.games) > 0 &&
        season?.points != null;

      const name = String(player.name || '');
      const last = name.split(' ').at(-1).toLowerCase();

      return {
        id: player.id,
        name,
        jersey: player.jersey,
        position: player.position,
        photo_url: player.photo_url,
        season: valid ? season.season : null,
        points: valid ? season.points : null,
        rebounds: valid ? season.rebounds : null,
        assists: valid ? season.assists : null,
        games: valid ? season.games : null,
        priority:
          last && coverage.includes(last)
            ? 10
            : /brunson|towns/i.test(name)
              ? 3
              : 0,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 4)
    .map(({ priority, ...player }) => player);

  await write('gameday.json', preview);

  console.log(
    `Game preview: ${preview.status}; ${preview.game?.id || 'none'}`
  );

  // Refresh odds only after the selected game has been saved.
  await refreshOdds();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
