import json
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
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
    return (
        datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def valid_date(value):
    try:
        date = datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        )

        if date.tzinfo is None:
            return None

        timestamp = date.timestamp()

        if (
            timestamp <= 0
            or timestamp
            > datetime.now(timezone.utc).timestamp() + 300
        ):
            return None

        return (
            date.astimezone(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

    except (ValueError, TypeError, OverflowError):
        return None


def metadata_date(entry):
    for key in ("release_timestamp", "timestamp"):
        value = entry.get(key)

        if isinstance(value, (int, float)):
            try:
                date = valid_date(
                    datetime.fromtimestamp(
                        value, timezone.utc
                    ).isoformat()
                )

                if date:
                    return date, "timestamp"

            except (ValueError, OverflowError, OSError):
                pass

    # Day precision is explicitly labeled.
    raw = str(entry.get("upload_date") or "")

    if re.fullmatch(r"\d{8}", raw):
        try:
            date = datetime.strptime(
                raw, "%Y%m%d"
            ).replace(tzinfo=timezone.utc)

            value = valid_date(date.isoformat())

            if value:
                return value, "day"

        except ValueError:
            pass

    return None, None


def extract(url, flat=False):
    args = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--dump-single-json",
        "--skip-download",
        "--socket-timeout",
        "12",
        "--retries",
        "1",
        "--extractor-retries",
        "1",
    ]

    if flat:
        args += [
            "--flat-playlist",
            "--playlist-end",
            "10",
        ]
    else:
        args += ["--no-playlist"]

    result = subprocess.run(
        args + [url],
        capture_output=True,
        text=True,
        timeout=90 if flat else 25,
        check=True,
    )

    return json.loads(result.stdout)


def rss_dates(channel_id):
    if not re.fullmatch(
        r"UC[A-Za-z0-9_-]{22}",
        str(channel_id or ""),
    ):
        return {}

    url = (
        "https://www.youtube.com/feeds/videos.xml"
        "?channel_id=" + channel_id
    )

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0"},
    )

    with urllib.request.urlopen(
        request, timeout=15
    ) as response:
        root = ET.fromstring(response.read())

    namespaces = {
        "a": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
    }

    dates = {}

    for entry in root.findall("a:entry", namespaces):
        video_id = entry.findtext(
            "yt:videoId",
            namespaces=namespaces,
        )

        date = valid_date(
            entry.findtext(
                "a:published",
                namespaces=namespaces,
            )
        )

        if video_id and date:
            dates[video_id] = date

    return dates


def newest(row):
    return max(
        (
            valid_date(item.get("published_at")) or ""
            for item in row.get("items", [])
        ),
        default="",
    )


def fetch_row(
    key,
    title,
    channel,
    url,
    shorts,
    previous=None,
):
    data = extract(url, flat=True)

    entries = [
        e
        for e in data.get("entries", [])
        if isinstance(e, dict)
    ]

    old_items = {
        item["video_id"]: item
        for item in (previous or {}).get("items", [])
        if item.get("video_id")
    }

    channel_id = data.get("channel_id") or next(
        (
            e.get("channel_id")
            for e in entries
            if e.get("channel_id")
        ),
        None,
    )

    try:
        dates = rss_dates(channel_id)
    except (OSError, ValueError, ET.ParseError):
        dates = {}

    items = []
    seen = set()
    detail_lookups = 0

    for entry in entries:
        video_id = entry.get("id", "")

        if (
            not re.fullmatch(
                r"[A-Za-z0-9_-]{11}", video_id
            )
            or video_id in seen
            or not entry.get("title")
        ):
            continue

        seen.add(video_id)

        old = old_items.get(video_id, {})

        date = dates.get(video_id)
        precision = "timestamp" if date else None

        if not date:
            date = valid_date(
                old.get("published_at")
            )

            precision = (
                old.get(
                    "published_at_precision",
                    "timestamp",
                )
                if date
                else None
            )

        if not date:
            date, precision = metadata_date(entry)

        # Limit extra requests. Unknown dates stay null.
        if not date and detail_lookups < 3:
            detail_lookups += 1

            try:
                date, precision = metadata_date(
                    extract(
                        "https://www.youtube.com/watch?v="
                        + video_id
                    )
                )

            except (
                subprocess.SubprocessError,
                ValueError,
                OSError,
            ):
                pass

        thumbnails = [
            t
            for t in (
                entry.get("thumbnails") or []
            )
            if t.get("url", "").startswith(
                "https://"
            )
        ]

        if thumbnails:
            image = max(
                thumbnails,
                key=lambda t: (
                    (t.get("width") or 0)
                    * (t.get("height") or 0)
                ),
            ).get("url")
        else:
            image = (
                "https://i.ytimg.com/vi/"
                + video_id
                + "/hqdefault.jpg"
            )

        items.append(
            {
                "id": "youtube-" + video_id,
                "video_id": video_id,
                "title": entry["title"],
                "channel": channel,
                "image_url": image,
                "is_short": shorts,
                "url": (
                    "https://www.youtube.com/watch?v="
                    + video_id
                ),
                "embed_url": (
                    "https://www.youtube.com/embed/"
                    + video_id
                    + "?playsinline=1"
                ),
                "published_at": date,
                "published_at_precision": precision,
            }
        )

    if not items:
        raise ValueError(
            "No video metadata returned"
        )

    items.sort(
        key=lambda item: (
            item.get("published_at") or ""
        ),
        reverse=True,
    )

    row = {
        "id": key,
        "title": title,
        "channel": channel,
        "channel_url": url,
        "updated_at": now(),
        "stale": False,
        "items": items,
    }

    row["latest_video_at"] = newest(row) or None

    return row


def main():
    try:
        previous = json.loads(
            OUTPUT.read_text()
        )
    except FileNotFoundError:
        previous = {"rows": []}

    if not isinstance(
        previous.get("rows"), list
    ):
        raise ValueError(
            "youtube.json must have a rows array"
        )

    previous_rows = {
        row["id"]: row
        for row in previous["rows"]
    }

    rows = []
    statuses = []
    successes = 0

    for source in SOURCES:
        key, title, channel, url, shorts = source

        try:
            row = fetch_row(
                *source,
                previous=previous_rows.get(key),
            )

            successes += 1

            statuses.append(
                {"id": key, "ok": True}
            )

            dated = sum(
                bool(i.get("published_at"))
                for i in row["items"]
            )

            print(
                f"OK {key}: "
                f"{len(row['items'])} videos; "
                f"{dated} publish dates"
            )

        except (
            subprocess.SubprocessError,
            ValueError,
            OSError,
        ) as error:
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
                f"WARN {key}: refresh failed; "
                "keeping previous items"
            )

        rows.append(row)

    if not successes:
        raise RuntimeError(
            "All YouTube sources failed; "
            "existing youtube.json was preserved"
        )

    managed = {
        source[0]
        for source in SOURCES
    }

    # Preserve SNY and other separately managed rows.
    rows.extend(
        row
        for row in previous["rows"]
        if row.get("id") not in managed
    )

    rows.sort(
        key=newest,
        reverse=True,
    )

    output = {
        **previous,
        "generated_at": now(),
        "source_status": statuses,
        "rows": rows,
    }

    temporary = OUTPUT.with_suffix(".tmp")

    temporary.write_text(
        json.dumps(output, indent=2) + "\n"
    )

    temporary.replace(OUTPUT)


if __name__ == "__main__":
    main()
