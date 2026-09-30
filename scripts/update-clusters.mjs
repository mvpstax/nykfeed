import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const HOUR = 60 * 60 * 1000;
const MAX_CLUSTER_SIZE = 6;

const STOP = new Set(
  `a an and are as at be been being by can could for from
  has have he her his how i if in into is it its just may
  might more new no not of on or our out over said says she
  should some than that the their them there these they this
  to was were what when where which who why will with would
  you your york knick knicks nba basketball team teams player
  players season latest report reports reportedly update
  updates analysis look take notes news breaking center
  situation potential despite solved far value long shot
  outlook move intriguing official`.split(/\s+/)
);

const SYNONYMS = {
  signed: 'sign',
  signs: 'sign',
  signing: 'sign',
  signings: 'sign',
  waived: 'waive',
  waives: 'waive',
  waiving: 'waive',
  traded: 'trade',
  trades: 'trade',
  trading: 'trade',
  acquires: 'acquire',
  acquired: 'acquire',
  acquisition: 'acquire',
  injured: 'injury',
  injuries: 'injury',
  wins: 'win',
  won: 'win',
  beats: 'beat',
  defeated: 'beat',
  returns: 'return',
  returning: 'return',
  agreed: 'agree',
  agrees: 'agree',
};

const EVENTS = [
  ['waiver', /\bwaiv(?:e|es|ed|ing)\b/],
  ['trade', /\btrad(?:e|es|ed|ing)|\bacquir(?:e|es|ed)\b/],
  ['extension', /\bextension|\bextend(?:s|ed)?\b/],
  [
    'signing',
    /\bsign(?:s|ed|ing|ings)?\b|\bagree(?:s|d)? to.*\b(?:deal|contract)\b/,
  ],
  [
    'injury',
    /\binjur|\bsurgery\b|\bruled out\b|\bquestionable\b|\b(?:ankle|knee|hamstring|wrist|foot|concussion)\b/,
  ],
  [
    'result',
    /\b(?:beats?|defeats?|wins?|loss|loses?|victory|recap)\b/,
  ],
  [
    'lineup',
    /\b(?:starting lineup|named starter|starting five)\b/,
  ],
];

const TEAM_NAMES = (
  `hawks celtics nets hornets bulls cavaliers mavericks nuggets
  pistons warriors rockets pacers clippers lakers grizzlies
  heat bucks timberwolves pelicans thunder magic sixers 76ers
  suns blazers kings spurs raptors jazz wizards`
).split(/\s+/);

const BODY_PARTS = [
  'ankle',
  'knee',
  'hamstring',
  'wrist',
  'foot',
  'concussion',
  'shoulder',
  'back',
  'calf',
  'achilles',
];

function normalize(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[’']s\b/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contains(text, phrase) {
  return ` ${text} `.includes(` ${phrase} `);
}

function intersect(a, b) {
  return [...a].filter(value => b.has(value));
}

function publisher(article) {
  const label = normalize(
    article.source || article.source_key
  );

  // Multiple feeds from one publisher count as one source.
  for (const brand of [
    'espn',
    'yahoo',
    'sports illustrated',
    'cbs',
    'fox',
    'hoops rumors',
    'realgm',
  ]) {
    if (label.includes(brand)) return brand;
  }

  try {
    return new URL(article.url).hostname.replace(/^www\./, '');
  } catch {
    return label || 'unknown';
  }
}

function peopleRegistry(roster) {
  const names = new Set(
    [
      'Jalen Brunson',
      'Karl-Anthony Towns',
      'Mikal Bridges',
      'OG Anunoby',
      'Josh Hart',
      'Miles McBride',
      'Liam Robbins',
      ...roster.map(player => player.name).filter(Boolean),
    ].map(normalize)
  );

  const surnameCounts = new Map();

  for (const name of names) {
    const surname = name.split(' ').at(-1);

    surnameCounts.set(
      surname,
      (surnameCounts.get(surname) || 0) + 1
    );
  }

  return [...names].map(name => {
    const surname = name.split(' ').at(-1);
    const aliases = [name];

    if (
      surname.length >= 4 &&
      surnameCounts.get(surname) === 1
    ) {
      aliases.push(surname);
    }

    if (name === 'karl anthony towns') {
      aliases.push('kat');
    }

    return { name, aliases };
  });
}

function signals(article, registry) {
  const text = normalize(article.title);

  const people = registry.filter(person =>
    person.aliases.some(alias => contains(text, alias))
  );

  const names = new Set(
    people.map(person => person.name)
  );

  const nameWords = new Set(
    people.flatMap(person =>
      person.aliases.flatMap(alias => alias.split(' '))
    )
  );

  // Remove player names so they cannot dominate similarity.
  const words = new Set(
    text
      .split(' ')
      .map(word => SYNONYMS[word] || word)
      .filter(
        word =>
          word.length >= 3 &&
          !STOP.has(word) &&
          !nameWords.has(word)
      )
  );

  const event =
    EVENTS.find(([, expression]) =>
      expression.test(text)
    )?.[0] || 'other';

  const speculative =
    /\b(?:could|might|may|should|would|rumor|rumors|rumour|proposal|proposed|hypothetical|prediction|predicts|mock)\b/.test(
      text
    );

  const teams = new Set(
    TEAM_NAMES.filter(team => contains(text, team))
  );

  const body = new Set(
    BODY_PARTS.filter(part => contains(text, part))
  );

  const availability =
    /\b(?:return|returns|returning|cleared|available)\b/.test(text)
      ? 'available'
      : /\b(?:ruled out|sidelined|out with|out for)\b/.test(text)
        ? 'out'
        : null;

  const contract = /\bexhibit 9\b/.test(text)
    ? 'exhibit9'
    : /\bexhibit 10\b/.test(text)
      ? 'exhibit10'
      : /\b(?:10|ten) day\b/.test(text)
        ? 'ten-day'
        : /\btwo way\b/.test(text)
          ? 'two-way'
          : null;

  return {
    text,
    names,
    words,
    event,
    speculative,
    teams,
    body,
    contract,
    availability,
  };
}

function clusterArticles(items, roster = [], previous = []) {
  const articles = items.filter(
    item =>
      item.type === 'article' &&
      item.id &&
      item.title &&
      Number.isFinite(Date.parse(item.published_at))
  );

  const registry = peopleRegistry(roster);

  const features = new Map(
    articles.map(article => [
      article.id,
      signals(article, registry),
    ])
  );

  const frequency = new Map();

  for (const feature of features.values()) {
    for (const word of feature.words) {
      frequency.set(
        word,
        (frequency.get(word) || 0) + 1
      );
    }
  }

  // Rare headline words carry more weight than common ones.
  const weight = word =>
    1 +
    Math.log(
      (articles.length + 1) /
      ((frequency.get(word) || 0) + 1)
    );

  const weightSum = words =>
    [...words].reduce(
      (total, word) => total + weight(word),
      0
    );

  function score(a, b) {
    if (publisher(a) === publisher(b)) return 0;

    const x = features.get(a.id);
    const y = features.get(b.id);

    const gap = Math.abs(
      Date.parse(a.published_at) -
      Date.parse(b.published_at)
    );

    const windowHours =
      x.event === 'result' || y.event === 'result'
        ? 18
        : 48;

    if (gap > windowHours * HOUR) return 0;

    if (x.speculative !== y.speculative) return 0;

    if (
      x.event !== 'other' &&
      y.event !== 'other' &&
      x.event !== y.event
    ) {
      return 0;
    }

    if (
      x.names.size &&
      y.names.size &&
      !intersect(x.names, y.names).length
    ) {
      return 0;
    }

    if (
      x.teams.size &&
      y.teams.size &&
      !intersect(x.teams, y.teams).length
    ) {
      return 0;
    }

    if (
      x.body.size &&
      y.body.size &&
      !intersect(x.body, y.body).length
    ) {
      return 0;
    }

    if (
      x.event === 'injury' &&
      y.event === 'injury' &&
      x.availability &&
      y.availability &&
      x.availability !== y.availability
    ) {
      return 0;
    }

    if (
      x.contract &&
      y.contract &&
      x.contract !== y.contract
    ) {
      return 0;
    }

    if (x.text === y.text) return 1;

    const common = new Set(
      intersect(x.words, y.words)
    );

    const union = new Set([
      ...x.words,
      ...y.words,
    ]);

    const coverage =
      weightSum(common) /
      Math.max(
        1,
        Math.min(
          weightSum(x.words),
          weightSum(y.words)
        )
      );

    const jaccard =
      weightSum(common) /
      Math.max(1, weightSum(union));

    const sharedPerson =
      intersect(x.names, y.names).length > 0;

    const sameEvent =
      x.event !== 'other' &&
      x.event === y.event;

    const samePeople =
      sharedPerson &&
      x.names.size === y.names.size &&
      intersect(x.names, y.names).length === x.names.size;

    const specificTransaction =
      ['signing', 'waiver', 'extension'].includes(x.event) &&
      gap <= 36 * HOUR;

    if (
      samePeople &&
      sameEvent &&
      common.size >= 1 &&
      (specificTransaction || coverage >= 0.42)
    ) {
      return 0.75 + jaccard * 0.2;
    }

    // Unknown subjects/events need stronger headline agreement.
    if (
      common.size >= 4 &&
      coverage >= 0.72 &&
      jaccard >= 0.46
    ) {
      return 0.65 + jaccard * 0.3;
    }

    return 0;
  }

  const pairs = [];

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const value = score(articles[i], articles[j]);

      if (value) {
        pairs.push({
          a: articles[i],
          b: articles[j],
          value,
        });
      }
    }
  }

  pairs.sort(
    (a, b) =>
      b.value - a.value ||
      String(a.a.id).localeCompare(String(b.a.id))
  );

  const assigned = new Set();
  const groups = [];

  for (const pair of pairs) {
    if (
      assigned.has(pair.a.id) ||
      assigned.has(pair.b.id)
    ) {
      continue;
    }

    const members = [pair.a, pair.b];

    assigned.add(pair.a.id);
    assigned.add(pair.b.id);

    const candidates = articles
      .filter(article => !assigned.has(article.id))
      .map(article => ({
        article,
        value: Math.min(
          ...members.map(member => score(member, article))
        ),
      }))
      .sort((a, b) => b.value - a.value);

    for (const { article } of candidates) {
      if (members.length >= MAX_CLUSTER_SIZE) break;

      // Complete-link matching prevents topic chaining.
      if (
        members.every(
          member => score(member, article) > 0
        )
      ) {
        members.push(article);
        assigned.add(article.id);
      }
    }

    groups.push(members);
  }

  const usedIds = new Set();

  return groups
    .map(members => {
      const ordered = [...members].sort(
        (a, b) =>
          Date.parse(b.published_at) -
            Date.parse(a.published_at) ||
          String(a.id).localeCompare(String(b.id))
      );

      const memberIds = new Set(
        members.map(article => article.id)
      );

      const matches = previous
        .filter(
          cluster =>
            cluster.id &&
            Array.isArray(cluster.item_ids) &&
            !usedIds.has(cluster.id)
        )
        .map(cluster => {
          const overlap = cluster.item_ids.filter(
            id => memberIds.has(id)
          ).length;

          return {
            cluster,
            overlap,
            ratio:
              overlap /
              new Set([
                ...memberIds,
                ...cluster.item_ids,
              ]).size,
          };
        })
        .filter(
          match =>
            match.overlap >= 2 &&
            match.ratio >= 0.4
        )
        .sort(
          (a, b) =>
            b.overlap - a.overlap ||
            b.ratio - a.ratio
        );

      const anchor = [...members].sort(
        (a, b) =>
          Date.parse(a.published_at) -
            Date.parse(b.published_at) ||
          String(a.id).localeCompare(String(b.id))
      )[0];

      const id =
        matches[0]?.cluster.id ||
        `cluster_${createHash('sha256')
          .update(String(anchor.id))
          .digest('hex')
          .slice(0, 12)}`;

      usedIds.add(id);

      const lead = ordered[0];
      const feature = features.get(lead.id);

      return {
        id,
        lead_item_id: lead.id,
        item_ids: ordered.map(article => article.id),
        source_count: new Set(members.map(publisher)).size,
        updated_at: lead.published_at,
        title: lead.title,
        event_type: feature.event,
        entities: [...feature.names],
      };
    })
    .sort(
      (a, b) =>
        Date.parse(b.updated_at) -
        Date.parse(a.updated_at)
    );
}

function selfTest() {
  const article = (
    id,
    title,
    source = id,
    hours = 0
  ) => ({
    id,
    title,
    source,
    type: 'article',
    published_at: new Date(
      Date.UTC(2026, 8, 30) + hours * HOUR
    ).toISOString(),
  });

  const roster = [
    { name: 'Drew Eubanks' },
    { name: 'James Wiseman' },
  ];

  const count = list =>
    clusterArticles(list, roster).length;

  const a = article(
    'a',
    'Knicks sign Drew Eubanks to Exhibit 9 contract'
  );

  const b = article(
    'b',
    'Drew Eubanks signs Exhibit 9 deal with New York'
  );

  assert.equal(count([a, b]), 1);

  assert.equal(
    count([
      a,
      article(
        'c',
        'Knicks sign James Wiseman to Exhibit 9 contract'
      ),
    ]),
    0
  );

  assert.equal(
    count([
      a,
      article(
        'c',
        'Drew Eubanks could sign Exhibit 9 contract'
      ),
    ]),
    0
  );

  assert.equal(
    count([a, article('c', 'Knicks waive Drew Eubanks')]),
    0
  );

  assert.equal(
    count([
      a,
      article(
        'c',
        'Knicks sign Drew Eubanks to Exhibit 10 contract'
      ),
    ]),
    0
  );

  assert.equal(count([a, { ...b, source: 'a' }]), 0);

  assert.equal(
    count([
      a,
      {
        ...b,
        published_at: article('z', '', 'z', 60).published_at,
      },
    ]),
    0
  );

  assert.equal(
    count([
      article('a', 'Jalen Brunson out with ankle injury'),
      article('b', 'Jalen Brunson out with knee injury'),
    ]),
    0
  );

  assert.equal(
    count([
      a,
      b,
      article(
        'c',
        'Knicks center situation far from solved despite Wiseman Eubanks signings'
      ),
    ]),
    1
  );

  const first = clusterArticles([a, b], roster);

  const next = clusterArticles(
    [
      a,
      b,
      article(
        'c',
        'Drew Eubanks signs Exhibit 9 contract',
        'c',
        1
      ),
    ],
    roster,
    first
  );

  assert.equal(next[0].id, first[0].id);
  assert.equal(next[0].item_ids.length, 3);

  assert.equal(
    count([
      article(
        'a',
        'Jalen Brunson ruled out with ankle injury'
      ),
      article(
        'b',
        'Jalen Brunson cleared to return after ankle injury'
      ),
    ]),
    0
  );

  assert.equal(
    count([
      article('a', 'Drew Eubanks’ signing confirmed'),
      b,
    ]),
    1
  );

  const broad = clusterArticles(
    [
      a,
      b,
      article(
        'c',
        'Knicks center situation far from solved despite Wiseman Eubanks signings'
      ),
    ],
    roster
  );

  assert.equal(broad[0].item_ids.length, 2);

  console.log('Passed clustering checks.');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const feed = JSON.parse(
    await readFile('feed.json', 'utf8')
  );

  if (!Array.isArray(feed.items)) {
    throw new Error('feed.json needs an items array');
  }

  let roster = [];
  let previous = feed.clusters || [];

  try {
    roster =
      JSON.parse(
        await readFile('players.json', 'utf8')
      ).players || [];
  } catch {}

  try {
    const state = JSON.parse(
      await readFile('story-cluster-state.json', 'utf8')
    );

    if (Array.isArray(state.clusters)) {
      previous = state.clusters;
    }
  } catch {}

  feed.clusters = clusterArticles(
    feed.items,
    roster,
    previous
  );

  for (const item of feed.items) {
    delete item.cluster_id;
  }

  const itemMap = new Map(
    feed.items.map(item => [item.id, item])
  );

  for (const cluster of feed.clusters) {
    for (const id of cluster.item_ids) {
      itemMap.get(id).cluster_id = cluster.id;
    }
  }

  await writeFile(
    'feed.json',
    JSON.stringify(feed, null, 2) + '\n'
  );

  await writeFile(
    'story-cluster-state.json',
    JSON.stringify(
      {
        schema_version: 1,
        clusters: feed.clusters,
      },
      null,
      2
    ) + '\n'
  );

  console.log(
    `Grouped ${feed.clusters.length} events across ${
      feed.clusters.reduce(
        (sum, cluster) => sum + cluster.item_ids.length,
        0
      )
    } articles.`
  );
}
