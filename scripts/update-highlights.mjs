import { writeFile } from "node:fs/promises";

const key = process.env.HIGHLIGHTLY_API_KEY;

if (!key) {
  throw new Error("Missing HIGHLIGHTLY_API_KEY GitHub secret");
}

async function main() {
  const url = new URL("https://nba.highlightly.net/highlights");
  url.searchParams.set("leagueName", "NBA");
  url.searchParams.set("limit", "40");

  const response = await fetch(url, {
    headers: {
      "x-rapidapi-key": key,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`Highlightly returned HTTP ${response.status}`);
  }

  const result = await response.json();

  if (!Array.isArray(result.data)) {
    throw new Error("Unexpected Highlightly response: missing data array");
  }

  // Diagnostics appear in GitHub Actions, without printing the API key.
  console.log(
    JSON.stringify(
      {
        returned: result.data.length,
        pagination: result.pagination ?? null,
        plan: result.plan ?? null,
      },
      null,
      2
    )
  );

  const unique = new Map();

  for (const clip of result.data) {
    if (clip.id == null) continue;

    const id = String(clip.id);

    unique.set(id, {
      id,
      type: "video",
      league: "NBA",
      source: "Highlightly",
      title: clip.title || "",
      summary: clip.description || "",
      image_url: clip.imgUrl || null,
      url: clip.url || null,
      embed_url: clip.embedUrl || null,
      provider: clip.source || null,
      channel: clip.channel || null,
      category: clip.category || null,
      verification: clip.type || null,
      match: clip.match || null,
    });
  }

  const items = [...unique.values()];

  const output = {
    generated_at: new Date().toISOString(),
    league: "NBA",
    item_count: items.length,
    items,
  };

  await writeFile(
    "highlights.json",
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log(`Saved ${items.length} NBA highlights.`);

  if (items.length === 0) {
    console.warn(
      "No highlights returned. Check the plan and pagination details above."
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
