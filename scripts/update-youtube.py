import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "youtube.json"

SOURCES = [
    (
        "around_nba",
        "Around the NBA",
        "NBA",
        "https://www.youtube.com/@NBA/videos",
        False,
    ),
    (
        "official_knicks",
        "Official Knicks",
        "New York Knicks",
        "https://www.youtube.com/@NYKnicks/videos",
        False,
    ),
    (
        "espn_ny_shorts",
        "ESPN New York Shorts",
        "ESPN New York",
        "https://www.youtube.com/@espnnewyork/shorts",
        True,
    ),
]


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_row(key, title, channel, url, shorts):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "yt_dlp",
            "--ignore-config",
            "--flat-playlist",
            "--dump-single-json",
            "--playlist-end",
            "10",
            "--skip-download",
            "--socket-timeout",
            "12",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=90,
        check=True,
    )

    data = json.loads(result.stdout)
    items = []
    seen = set()

    for entry in data.get("entries", []):
        if not isinstance(entry, dict):
            continue

        video_id = entry.get("id", "")

        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            continue

        if video_id in seen or not entry.get("title"):
            continue

        seen.add(video_id)

        thumbnails = [
            thumbnail
            for thumbnail in entry.get("thumbnails", [])
            if thumbnail.get("url", "").startswith("https://")
        ]

        thumbnail_url = None

        if thumbnails:
            thumbnail_url = max(
                thumbnails,
                key=lambda thumbnail: (
                    (thumbnail.get("width") or 0)
                    * (thumbnail.get("height") or 0)
                ),
            ).get("url")

        items.append(
            {
                "id": "youtube-" + video_id,
                "video_id": video_id,
                "title": entry["title"],
                "channel": channel,
                "image_url": thumbnail_url,
                "is_short": shorts,
                "url": "https://www.youtube.com/watch?v=" + video_id,
                "embed_url": (
                    "https://www.youtube.com/embed/"
                    + video_id
                    + "?playsinline=1"
                ),
            }
        )

    if not items:
        raise ValueError("No video metadata returned")

    return {
        "id": key,
        "title": title,
        "channel": channel,
        "channel_url": url,
        "updated_at": now(),
        "stale": False,
        "items": items,
    }


def main():
    try:
        previous = json.loads(OUTPUT.read_text())
    except (OSError, ValueError):
        previous = {}

    previous_rows = {
        row["id"]: row
        for row in previous.get("rows", [])
    }

    rows = []
    statuses = []
    successes = 0

    for source in SOURCES:
        key, title, channel, url, shorts = source

        try:
            row = fetch_row(*source)
            successes += 1

            statuses.append({"id": key, "ok": True})

            print(f"OK {key}: {len(row['items'])} videos")

        except (subprocess.SubprocessError, ValueError, OSError) as error:
            row = dict(
                previous_rows.get(
                    key,
                    {
                        "id": key,
                        "title": title,
                        "channel": channel,
                        "channel_url": url,
                        "updated_at": None,
                        "items": [],
                    },
                )
            )

            row["stale"] = True

            statuses.append(
                {
                    "id": key,
                    "ok": False,
                    "error": type(error).__name__,
                }
            )

            print(
                f"WARN {key}: refresh failed; retaining previous items"
            )

        rows.append(row)

    if not successes:
        raise RuntimeError(
            "All YouTube sources failed; existing youtube.json was preserved"
        )

    output = {
        "generated_at": now(),
        "source_status": statuses,
        "rows": rows,
    }

    temporary_file = OUTPUT.with_suffix(".tmp")
    temporary_file.write_text(json.dumps(output, indent=2) + "\n")
    temporary_file.replace(OUTPUT)


if __name__ == "__main__":
    main()
