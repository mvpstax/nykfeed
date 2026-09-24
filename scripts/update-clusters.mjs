import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const feed = JSON.parse(await readFile('feed.json', 'utf8'));
if (!Array.isArray(feed.items)) throw new Error('feed.json needs an items array');

const STOP = new Set(`a an and are as at be by can could for from has have in is it its of on or the their these this to was were will with new york knick knicks nba basketball team teams player players roster spot spots season latest notes rumor rumors report reports reportedly update updates analysis look looking take takes why how what who more after before into about just only says said another some his her deal deals contract contracts`.split(' '));
const DAY = 24 * 60 * 60 * 1000;
const articles = feed.items.filter(item =>
  item.type === 'article' && item.id && item.title && item.source_key &&
  Number.isFinite(Date.parse(item.published_at))
);

function tokens(title) {
  return new Set(title.toLowerCase().normalize('NFKD').replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .map(word => word.replace(/(ings|ing|ed|s)$/i, ''))
    .filter(word => word.length >= 3 && !STOP.has(word)));
}

const words = new Map(articles.map(item => [item.id, tokens(item.title)]));
const frequency = new Map();
for (const set of words.values()) {
  for (const word of set) {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  }
}

function similarity(a, b) {
  if (a.source_key === b.source_key) return 0;
  if (Math.abs(Date.parse(a.published_at) - Date.parse(b.published_at)) > 3 * DAY) return 0;

  // Possible future signings are separate from completed signings.
  const speculative = title => /\b(?:could|might|may) sign\b/i.test(title);
  const announced = title => /\bsign(?:s|ed)?\b/i.test(title);
  if ((speculative(a.title) && announced(b.title)) ||
      (speculative(b.title) && announced(a.title))) return 0;

  const aa = words.get(a.id);
  const bb = words.get(b.id);
  const common = [...aa].filter(word => bb.has(word));
  if (common.length < 2) return 0;
  if (!common.some(word => (frequency.get(word) || 0) <= 8)) return 0;

  const coverage = common.length / Math.min(aa.size, bb.size);
  if (coverage < 0.48) return 0;
  return coverage + common.length * 0.03;
}

const groups = [];
const assigned = new Set();
const pairs = [];

for (let i = 0; i < articles.length; i++) {
  for (let j = i + 1; j < articles.length; j++) {
    const score = similarity(articles[i], articles[j]);
    if (score) pairs.push({ a: articles[i], b: articles[j], score });
  }
}
pairs.sort((x, y) => y.score - x.score);

for (const { a, b } of pairs) {
  if (assigned.has(a.id) || assigned.has(b.id)) continue;

  const members = [a, b];
  assigned.add(a.id);
  assigned.add(b.id);

  for (const candidate of articles) {
    if (members.length >= 5 || assigned.has(candidate.id)) continue;
    if (members.every(member => similarity(member, candidate) > 0)) {
      members.push(candidate);
      assigned.add(candidate.id);
    }
  }
  groups.push(members);
}

for (const item of feed.items) delete item.cluster_id;

feed.clusters = groups.map(members => {
  const ordered = [...members].sort((a, b) =>
    b.published_at.localeCompare(a.published_at)
  );
  const anchor = [...members].sort((a, b) =>
    a.published_at.localeCompare(b.published_at)
  )[0];
  const id = `cluster_${createHash('sha256')
    .update(anchor.id).digest('hex').slice(0, 12)}`;

  for (const item of members) item.cluster_id = id;

  return {
    id,
    lead_item_id: ordered[0].id,
    item_ids: ordered.map(item => item.id),
    source_count: new Set(members.map(item => item.source_key)).size,
    updated_at: ordered[0].published_at,
  };
}).sort((a, b) => b.updated_at.localeCompare(a.updated_at));

await writeFile('feed.json', JSON.stringify(feed, null, 2) + '\n');
console.log(`Added ${feed.clusters.length} story clusters covering ${assigned.size} articles.`);
