"""Refresh player stats for the frontend."""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

from nba_api.stats.endpoints import (
    commonplayerinfo,
    playercareerstats,
    playergamelog,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "player-stats.json"

ROSTER_URL = os.getenv(
    "PLAYERS_URL",
    "https://raw.githubusercontent.com/mvpstax/nykfeed/refs/heads/main/players.json",
)


def line(row):
    """Convert NBA stats into the fields used by the player drawer."""
    result = {"gp": row.get("GP")}

    for key, source in (
        ("min", "MIN"),
        ("pts", "PTS"),
        ("reb", "REB"),
        ("ast", "AST"),
        ("stl", "STL"),
        ("blk", "BLK"),
    ):
        value = row.get(source)
        if value is not None:
            result[key] = round(float(value), 1)

    for key, source in (
        ("fg_pct", "FG_PCT"),
        ("three_pct", "FG3_PCT"),
        ("ft_pct", "FT_PCT"),
    ):
        value = row.get(source)
        if value is not None:
            result[key] = round(float(value) * 100, 1)

    return result


def records(dataset):
    """nba_api provides separate headers and row arrays."""
    data = dataset.get_dict()
    return [
        dict(zip(data["headers"], values))
        for values in data["data"]
    ]


def season_rows(raw):
    """Keep one row per season, preferring a combined TOT row after a trade."""
    by_season = {}

    for row in raw:
        season = row.get("SEASON_ID")
        if not season or not row.get("GP"):
            continue

        current = by_season.get(season)

        if current is None or row.get("TEAM_ABBREVIATION") == "TOT":
            by_season[season] = row
        elif (
            current.get("TEAM_ABBREVIATION") != "TOT"
            and row["GP"] > current["GP"]
        ):
            by_season[season] = row

    return [
        by_season[key]
        for key in sorted(by_season, reverse=True)
    ]


def fetch_player(player_id):
    career_response = playercareerstats.PlayerCareerStats(
        player_id=player_id,
        per_mode36="PerGame",
        timeout=20,
    )

    rows = season_rows(
        records(career_response.season_totals_regular_season)
    )

    if not rows:
        return {}

    latest = rows[0]["SEASON_ID"]

    result = {
        "stats": {
            "season": latest,
            "season_avg": line(rows[0]),
            "career": [
                {
                    "season": row["SEASON_ID"],
                    "team": row.get("TEAM_ABBREVIATION"),
                    **line(row),
                }
                for row in rows
            ],
            "game_log": [],
        }
    }

    try:
        bio = commonplayerinfo.CommonPlayerInfo(
            player_id=player_id,
            timeout=20,
        )
        info = records(bio.common_player_info)[0]
        result["height"] = info.get("HEIGHT") or None
        result["weight"] = (
            f'{info["WEIGHT"]} lbs'
            if info.get("WEIGHT")
            else None
        )
    except Exception as exc:
        print(f"Bio unavailable for {player_id}: {exc}", flush=True)

    time.sleep(0.6)

    try:
        games_response = playergamelog.PlayerGameLog(
            player_id=player_id,
            season=latest,
            season_type_all_star="Regular Season",
            timeout=20,
        )

        games = records(games_response.player_game_log)[:10]

        result["stats"]["game_log"] = [
            {
                "date": game["GAME_DATE"],
                "opponent": game["MATCHUP"],
                "result": game.get("WL"),
                **{
                    k: v
                    for k, v in line(game).items()
                    if k != "gp"
                },
            }
            for game in games
        ]
    except Exception as exc:
        print(f"Game log unavailable for {player_id}: {exc}", flush=True)

    return result


def main():
    local_roster = ROOT / "players.json"

    if local_roster.exists():
        roster = json.loads(local_roster.read_text())["players"]
    else:
        with urlopen(ROSTER_URL, timeout=20) as response:
            roster = json.load(response)["players"]

    previous = (
        json.loads(OUTPUT.read_text())
        if OUTPUT.exists()
        else {"players": {}}
    )
    cached = previous.get("players", {})
    refreshed = {}
    successes = 0

    for player in roster:
        key = str(player["nba_player_id"])

        try:
            record = fetch_player(key)

            if record:
                refreshed[key] = {
                    **cached.get(key, {}),
                    **record,
                }
                successes += 1
            elif key in cached:
                refreshed[key] = cached[key]

        except Exception as exc:
            print(
                f"Stats unavailable for {player['name']} ({key}): {exc}",
                flush=True,
            )
            if key in cached:
                refreshed[key] = cached[key]

        time.sleep(0.8)

    if not successes:
        raise RuntimeError(
            "No player stats refreshed; keeping the previous cache"
        )

    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "players": refreshed,
    }

    temporary = OUTPUT.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(payload, separators=(",", ":")) + "\n"
    )
    temporary.replace(OUTPUT)

    print(
        f"Updated {successes} players; "
        f"retained {len(refreshed) - successes} cached records"
    )


if __name__ == "__main__":
    main()
