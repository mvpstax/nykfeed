# Knicks JSON Feed

This package creates one frontend-friendly `feed.json` for a Knicks news app. It combines Hoops Rumors, RealGM, ESPN, Bluesky, Reddit, and NBA game data, then filters, sorts, and deduplicates the results.

## Fastest hosting setup: GitHub

1. Create a new public GitHub repository.
2. Upload the complete contents of this folder, including `.github`.
3. Open **Actions**, select **Refresh Knicks feed**, and choose **Run workflow** once.
4. Your frontend can fetch the raw file at:

   `https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/feed.json`

The included GitHub Action refreshes it every 15 minutes. GitHub schedules can run a little late during busy periods.

## Use it in Framer or Figma Make

```js
const FEED_URL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/feed.json";

const response = await fetch(FEED_URL, { cache: "no-store" });
if (!response.ok) throw new Error(`Feed request failed: ${response.status}`);

const data = await response.json();
console.log(data.items);
console.log(data.games);
```

Render cards from `data.items`. Use `item.type` to distinguish `article`, `social`, and `reddit` cards. For an in-app drawer, open `item.presentation.url`; if the publisher blocks iframe embedding, use `item.presentation.fallback` and open the system browser.

## Test locally

Node 22+ is recommended. No packages are required.

```bash
node scripts/update-feed.mjs
```

## Customize

Preview images are available as `item.image_url`. When a source omits an article image, the updater checks the publisher's Open Graph and Twitter image metadata. It checks up to three pages concurrently, applies request timeouts, and reuses successful metadata lookups from the previous feed for 24 hours. `image_status` is `available`, `not_provided`, or `fetch_failed`; `meta.images` reports totals. Social posts without media stay text-only. Use a local placeholder when `image_url` is null, and an image `onError` fallback for publisher hotlink failures. A discovered URL does not guarantee that the image server will allow display in every app.

Edit `sources.json` to change keywords, source limits, refresh behavior, or enabled adapters. The fetcher is fail-soft: one unavailable source is reported in `meta.source_status` without preventing the other sources from updating.

## Important source notes

- Sports Illustrated reads public JSON-LD article metadata on `https://www.si.com/nba/knicks`, limited to `/nba/knicks/` article links. No full article bodies are fetched. Missing images remain null. SI items request a preview drawer with an external article link, not an unverified iframe. If SI changes its page structure, the adapter reports a failure instead of silently reporting an empty successful feed.

- Knicks Film School uses its public Substack RSS at `https://knicksfilmschool.substack.com/feed`. The adapter reads titles, descriptions, dates, author names, and media when supplied. It does not fetch full article bodies or bypass subscription access. The existing seven-day age filter applies.

- Bluesky uses the custom Knicks feed curated by `ninjacat.social` and direct posts from `courtsideknicks.bsky.social`, replacing broad keyword search. Courtside replies and reposts are excluded. Both sources keep posts without requiring Knicks keywords; shared posts are deduplicated by their stable post URI. The existing seven-day age filter still applies. Render social text as plain text, not raw HTML, and respect `presentation.embed_attempt: false`: display a native social card with a link to the original instead of iframing the profile page.

- Basketball Reference is listed as `reference_only` and is intentionally not scraped. Sports Reference's data-use policy requires permission for products built from scraped data.
- ESPN and NBA adapters use best-effort public endpoints that can change. Their failures will not break the full feed.
- Reddit should use OAuth for a serious production or commercial launch. Review Reddit's Data API terms.
- Headlines, excerpts, images, posts, and links remain the property of their publishers. Confirm each source's reuse and display terms before monetization.
