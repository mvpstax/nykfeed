export function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  }
  return result;
}

export function imageUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.replace(/&amp;/g, "&").replace(/&#38;/g, "&").trim(), base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function extractPreview(html, base) {
  const values = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const key = (a.property || a.name || "").toLowerCase();
    if (!values.has(key) && a.content) values.set(key, a.content);
  }
  for (const key of ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const url = imageUrl(values.get(key), base);
    if (url) return { url, source: key };
  }
  return null;
}

// Only visit configured publisher hosts, including on redirects.
async function articleHtml(url, allowedHosts, headers, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let current = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      if (current.protocol !== "https:" || !allowedHosts.has(current.hostname) || current.username || current.password || current.port) throw new Error("Unapproved article host");
      const response = await fetch(current, { headers, signal: controller.signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Redirect missing location");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      if (!response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); throw new Error("Not an HTML page"); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "", size = 0;
      try {
        while (size < 2_000_000) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          html += decoder.decode(chunk.value, { stream: true });
          if (/<\/head\s*>/i.test(html)) break;
        }
      } finally { await reader.cancel(); }
      return { html, url: current.href };
    }
    throw new Error("Too many redirects");
  } finally { clearTimeout(timer); }
}

export async function enrichImages(items, previous, config, headers) {
  const cached = new Map((previous?.items || []).map(item => [item.url, item]));
  const allowed = new Set(config.sources.map(source => new URL(source.url).hostname));
  const pending = [];
  for (const item of items) {
    item.image_url = imageUrl(item.image_url, item.url);
    if (item.image_url) { item.image_status = "available"; item.image_source = "source_feed"; continue; }
    if (item.type !== "article") { item.image_status = "not_provided"; continue; }
    const old = cached.get(item.url);
    if (old?.image_checked_at && Date.now() - Date.parse(old.image_checked_at) < 86400000 && imageUrl(old.image_url, item.url)) {
      item.image_url = old.image_url;
      item.image_status = "available";
      item.image_source = old.image_source;
      item.image_checked_at = old.image_checked_at;
    } else pending.push(item);
  }
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (index < pending.length) {
      const item = pending[index++];
      item.image_checked_at = new Date().toISOString();
      try {
        const page = await articleHtml(item.url, allowed, headers, config.settings.request_timeout_ms);
        const image = extractPreview(page.html, page.url);
        item.image_url = image?.url || null;
        item.image_source = image?.source || null;
        item.image_status = image ? "available" : "not_provided";
      } catch (error) {
        item.image_status = "fetch_failed";
        item.image_error = error.message;
      }
    }
  }));
  return { available: items.filter(item => item.image_url).length, missing: items.filter(item => !item.image_url).length, article_pages_checked: pending.length };
}
