"""Refresh player-stats.json from ESPN basketball data."""

import json
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path.cwd()
OUTPUT = ROOT / "player-stats.json"

ROSTER_URL = (
    "https://raw.githubusercontent.com/mvpstax/nykfeed/main/players.json"
)
TEAM_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/"
    "teams/18/roster"
)
PLAYER_URL = (
    "https://site.web.api.espn.com/apis/common/v3/sports/"
    "basketball/nba/athletes"
)

# ESPN's current Knicks roster does not include every player in our feed.
EXTRA_IDS = {
    "bruce brown": "4065670",
    "drew eubanks": "3914285",
    "james wiseman": "4432808",
    "john konchar": "3134932",
    "ochai agbaji": "4397018",
    "pacome dadiet": "5211983",
}


def get_json(url):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        },
    )

    for attempt in range(2):
        try:
            with urlopen(request, timeout=15) as response:
                return json.load(response)
        except (TimeoutError, URLError):
            if attempt:
                raise
            time.sleep(1)


def name_key(name):
    return "".join(
        c
        for c in unicodedata.normalize("NFKD", name.casefold())
        if not unicodedata.combining(c)
    )


def numeric(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def stat_line(names, values, game=False):
    data = dict(zip(names, values))

    fields = {
        "min": "minutes" if game else "avgMinutes",
        "pts": "points" if game else "avgPoints",
        "reb": "totalRebounds" if game else "avgRebounds",
        "ast": "assists" if game else "avgAssists",
        "stl": "steals" if game else "avgSteals",
        "blk": "blocks" if game else "avgBlocks",
        "fg_pct": "fieldGoalPct",
        "three_pct": (
            "threePointPct"
            if game
            else "threePointFieldGoalPct"
        ),
        "ft_pct": "freeThrowPct",
    }

    result = {}

    if not game and numeric(data.get("gamesPlayed")) is not None:
        result["gp"] = int(numeric(data["gamesPlayed"]))

    for output, source in fields.items():
        value = numeric(data.get(source))
        if value is not None:
            result[output] = value

    return result


def fetch_player(espn_id, bio):
    data = get_json(f"{PLAYER_URL}/{espn_id}/stats")

    averages = next(
        (
            category
            for category in data.get("categories", [])
            if category.get("name") == "averages"
        ),
        None,
    )

    if not averages:
        raise ValueError("No regular-season averages")

    # Use one row per year. For a traded player, prefer ESPN's
    # combined season total.
    by_year = {}

    for row in averages.get("statistics", []):
        year = row.get("season", {}).get("year")
        gp = numeric(
            dict(zip(averages["names"], row["stats"])).get(
                "gamesPlayed"
            )
        )

        if not year or not gp:
            continue

        current = by_year.get(year)

        if current is None or "totals" in row.get(
            "teamSlug", ""
        ).lower():
            by_year[year] = row
        elif "totals" not in current.get(
            "teamSlug", ""
        ).lower():
            current_gp = numeric(
                dict(
                    zip(
                        averages["names"],
                        current["stats"],
                    )
                ).get("gamesPlayed")
            ) or 0

            if gp > current_gp:
                by_year[year] = row

    seasons = list(by_year.values())
    seasons.sort(
        key=lambda row: row["season"]["year"],
        reverse=True,
    )

    if not seasons:
        raise ValueError("No seasons with games played")

    latest = seasons[0]["season"]

    result = {
        "stats": {
            "season": latest["displayName"],
            "season_avg": stat_line(
                averages["names"],
                seasons[0]["stats"],
            ),
            "career": [
                {
                    "season": row["season"]["displayName"],
                    "team": (
                        "TOT"
                        if "totals" in row.get(
                            "teamSlug", ""
                        ).lower()
                        else row.get(
                            "teamSlug", ""
                        ).replace("-", " ").title()
                    ),
                    **stat_line(
                        averages["names"],
                        row["stats"],
                    ),
                }
                for row in seasons
            ],
            "game_log": [],
        }
    }

    if bio:
        result["height"] = bio.get("displayHeight")
        result["weight"] = bio.get("displayWeight")

    try:
        log = get_json(
            f"{PLAYER_URL}/{espn_id}/gamelog"
            f"?season={latest['year']}"
        )

        regular = next(
            (
                item
                for item in log.get("seasonTypes", [])
                if "Regular Season"
                in item.get("displayName", "")
            ),
            None,
        )

        games = []

        for category in (regular or {}).get(
            "categories", []
        ):
            for row in category.get("events", []):
                event = log.get("events", {}).get(
                    row["eventId"],
                    {},
                )

                if not event.get("gameDate"):
                    continue

                opponent = event.get(
                    "opponent", {}
                ).get("abbreviation", "")

                games.append(
                    (
                        event["gameDate"],
                        {
                            "date": event["gameDate"][:10],
                            "opponent": (
                                f"{event.get('atVs', 'vs')} "
                                f"{opponent}"
                            ),
                            "result": event.get(
                                "gameResult"
                            ),
                            **stat_line(
                                log["names"],
                                row["stats"],
                                game=True,
                            ),
                        },
                    )
                )

        games.sort(
            key=lambda item: item[0],
            reverse=True,
        )

        result["stats"]["game_log"] = [
            row for _, row in games[:10]
        ]

    except Exception as exc:
        print(
            f"Game log unavailable for ESPN athlete "
            f"{espn_id}: {exc}",
            flush=True,
        )

    return result


def main():
    local = ROOT / "players.json"

    if local.exists():
        roster = json.loads(
            local.read_text()
        )["players"]
    else:
        roster = get_json(
            ROSTER_URL
        )["players"]

    espn_roster = get_json(
        TEAM_URL
    )["athletes"]

    by_name = {
        name_key(player["displayName"]): player
        for player in espn_roster
    }

    previous = (
        json.loads(
            OUTPUT.read_text()
        ).get("players", {})
        if OUTPUT.exists()
        else {}
    )

    result = {}
    successes = 0

    for player in roster:
        nba_id = str(player["nba_player_id"])
        bio = by_name.get(
            name_key(player["name"])
        )

        espn_id = (
            bio["id"]
            if bio
            else EXTRA_IDS.get(
                name_key(player["name"])
            )
        )

        if not espn_id:
            print(
                f"No ESPN match for "
                f"{player['name']}",
                flush=True,
            )

            if nba_id in previous:
                result[nba_id] = previous[nba_id]

            continue

        try:
            result[nba_id] = fetch_player(
                espn_id,
                bio,
            )
            successes += 1

            print(
                f"Updated {player['name']}",
                flush=True,
            )

        except Exception as exc:
            print(
                f"Stats unavailable for "
                f"{player['name']}: {exc}",
                flush=True,
            )

            if nba_id in previous:
                result[nba_id] = previous[nba_id]

        time.sleep(0.3)

    if not successes:
        raise RuntimeError(
            "No stats refreshed; previous file "
            "was preserved"
        )

    payload = {
        "updated_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "source": "ESPN",
        "players": result,
    }

    temporary = OUTPUT.with_suffix(
        ".json.tmp"
    )
    temporary.write_text(
        json.dumps(
            payload,
            separators=(",", ":"),
        ) + "\n"
    )
    temporary.replace(OUTPUT)

    print(
        f"Saved {successes}/{len(roster)} "
        f"players",
        flush=True,
    )


if __name__ == "__main__":
    main()
