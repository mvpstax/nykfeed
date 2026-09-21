import { writeFile } from "node:fs/promises";

const key = process.env.HIGHLIGHTLY_API_KEY;
if (!key) throw new Error("Missing HIGHLIGHTLY_API_KEY secret");

async function fetchHighlights(side) {
  const url = new URL("https://nba.highlightly.net/highlights");
  url.searchParams.set("leagueName", "NBA");
  url.searchParams.set(`${side}TeamAbbreviation`, "NYK");
  url.searchParams.set("limit", "40");

  const response = await fetch(url, {
    headers: { "x-rapidapi-key": key },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Highlightly returned HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!Array.isArray(result.data)) {
    throw new Error("Unexpected Highlightly response");
  }

  return result.data;
}

const home = await fetchHighlights("home");
const away = await fetchHighlights("away");

const unique = new Map();

for (const clip of [...home, ...away]) {
  if (clip.id == null) continue;
  unique.set(clip.id, {
    id: String(clip.id),
    type: "video",
    source: "Highlightly",
    title: clip.title || "",
    summary: clip.description || "",
    image_url: clip.imgUrl || null,
    url: clip.url || null,
    embed_url: clip.embedUrl || null,
    provider: clip.source || null,
    category: clip.category || null,
    verification: clip.type || null,
    match: clip.match || null,
  });
}

const items = [...unique.values()];

await writeFile(
  "highlights.json",
  JSON.stringify({
    generated_at: new Date().toISOString(),
    team: "NYK",
    item_count: items.length,
    items,
  }, null, 2) + "\n"
);

console.log(`Saved ${items.length} highlights.`);
