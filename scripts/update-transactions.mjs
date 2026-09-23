import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourceUrl =
  "https://stats.nba.com/js/data/playermovement/NBA_Player_Movement.json";

const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../transactions.json"
);

const response = await fetch(sourceUrl, {
  headers: {
    "user-agent": "Mozilla/5.0 (compatible; KnicksFeed/1.0)",
    accept: "application/json",
    referer: "https://www.nba.com/players/transactions"
  },
  signal: AbortSignal.timeout(20000)
});

if (!response.ok) {
  throw new Error(`NBA transactions returned HTTP ${response.status}`);
}

const data = await response.json();
const rows = data?.NBA_Player_Movement?.rows;

if (!Array.isArray(rows) || rows.length === 0) {
  throw new Error("NBA transactions data is empty");
}

const now = Date.now();
const start = now - 30 * 24 * 60 * 60 * 1000;
const seen = new Set();
const transactions = [];

for (const row of rows) {
  const date = String(row.TRANSACTION_DATE || "").slice(0, 10);
  const dateMs = Date.parse(`${date}T00:00:00Z`);

  if (
    !Number.isFinite(dateMs) ||
    dateMs < start ||
    dateMs > now + 86400000
  ) {
    continue;
  }

  const description = String(row.TRANSACTION_DESCRIPTION || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!description) continue;

  const id = createHash("sha256")
    .update([
      date,
      row.Transaction_Type || "",
      row.TEAM_ID || "",
      row.PLAYER_ID || "",
      description
    ].join("|"))
    .digest("hex")
    .slice(0, 20);

  if (seen.has(id)) continue;
  seen.add(id);

  transactions.push({
    id,
    date,
    type: String(row.Transaction_Type || "other"),
    description,
    team_id: row.TEAM_ID == null
      ? null
      : String(Math.trunc(Number(row.TEAM_ID))),
    team_slug: row.TEAM_SLUG || null,
    player_id: row.PLAYER_ID == null
      ? null
      : String(Math.trunc(Number(row.PLAYER_ID))),
    player_slug: row.PLAYER_SLUG || null,
    is_knicks:
      String(Math.trunc(Number(row.TEAM_ID))) === "1610612752" ||
      /\b(?:New York Knicks|Knicks)\b/i.test(description),
    source_url: "https://www.nba.com/players/transactions"
  });
}

transactions.sort(
  (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)
);

const output = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  source: "NBA.com",
  source_url: sourceUrl,
  transactions: transactions.slice(0, 100)
};

await writeFile(
  outputPath,
  `${JSON.stringify(output, null, 2)}\n`
);

console.log(
  `Wrote ${output.transactions.length} transactions ` +
  `(${output.transactions.filter(item => item.is_knicks).length} Knicks).`
);
