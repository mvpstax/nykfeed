import { readFile, writeFile } from 'node:fs/promises';

const url = 'https://www.nba.com/knicks/roster';
const outputPath = 'players.json';
const coreOrder = [1628973, 1626157, 1628969, 1628384, 1628404];

const response = await fetch(url, {
  signal: AbortSignal.timeout(30000),
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KnicksFeed/1.0)' },
});
if (!response.ok) {
  throw new Error(`Official Knicks roster returned HTTP ${response.status}`);
}

const html = await response.text();
const jsonText = html.match(
  /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
)?.[1];
if (!jsonText) {
  throw new Error('Official Knicks roster data was not found; kept previous players.json');
}

const page = JSON.parse(jsonText).props?.pageProps;
const roster = page?.rosterData?.roster;
if (!Array.isArray(roster) || roster.length < 12 || roster.length > 30) {
  throw new Error('Official Knicks roster was incomplete; kept previous players.json');
}

const players = roster.map(player => {
  const nbaId = Number(player.id);
  const name = String(player.name || player.displayName || '').trim();

  if (!Number.isInteger(nbaId) || !name ||
      Number(player.teamId) !== 1610612752) {
    throw new Error('A roster entry was invalid; kept previous players.json');
  }

  return {
    id: `nba:${nbaId}`,
    nba_player_id: nbaId,
    name,
    first_name: player.firstName || null,
    last_name: player.lastName || null,
    jersey: player.number ?? null,
    position: player.position || null,
    height: player.height || null,
    photo_url: `https://cdn.nba.com/headshots/nba/latest/1040x760/${nbaId}.png`,
  };
});

if (new Set(players.map(player => player.id)).size !== players.length) {
  throw new Error('Duplicate roster player ID; kept previous players.json');
}

// Some camp entries have provisional numbers already used by a core player.
for (const player of players) {
  if (player.jersey != null &&
      !coreOrder.includes(player.nba_player_id) &&
      players.some(other =>
        other.id !== player.id && other.jersey === player.jersey
      )) {
    player.jersey = null;
  }
}

players.sort((a, b) => {
  const ai = coreOrder.indexOf(a.nba_player_id);
  const bi = coreOrder.indexOf(b.nba_player_id);

  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return a.name.localeCompare(b.name);
});

let previous = null;
try {
  previous = JSON.parse(await readFile(outputPath, 'utf8'));
} catch {
  // First run.
}

const result = {
  schema_version: 1,
  team: 'NYK',
  source: 'NBA official Knicks roster',
  source_url: url,
  season: page.layout?.settings?.seasonYear?.roster || null,
  updated_at: new Date().toISOString(),
  players,
};

if (previous &&
    JSON.stringify(previous.players) === JSON.stringify(players) &&
    previous.season === result.season) {
  console.log(`Roster unchanged: ${players.length} players.`);
} else {
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`Saved ${players.length} players from the official Knicks roster.`);
}
