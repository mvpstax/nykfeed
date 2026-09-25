"""Refresh Knicks season stats and game logs from NBA live box scores."""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from nba_api.live.nba.endpoints import boxscore, scoreboard

ROOT = Path(__file__).resolve().parents[1]
STATS = ROOT / "player-stats.json"
HISTORY = ROOT / "player-game-history.json"
ROSTER = ROOT / "players.json"
NYK = 1610612752
CHECK_GAME_ID = "0022000180"

COUNTS = {
    "pts": "points",
    "reb": "reboundsTotal",
    "ast": "assists",
    "stl": "steals",
    "blk": "blocks",
}
SHOTS = {
    "fg": ("fieldGoalsMade", "fieldGoalsAttempted"),
    "three": ("threePointersMade", "threePointersAttempted"),
    "ft": ("freeThrowsMade", "freeThrowsAttempted"),
}


def live_scoreboard():
    return scoreboard.ScoreBoard(timeout=15).scoreboard.games.get_dict()


def live_boxscore(game_id):
    return boxscore.BoxScore(game_id, timeout=15).game.get_dict()


def season_for(date):
    year, month = map(int, date[:7].split("-"))
    start = year if month >= 7 else year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def minutes(value):
    match = re.fullmatch(
        r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?",
        value or "",
    )
    if not match:
        raise ValueError(f"Unexpected NBA minutes value: {value!r}")
    hours, mins, seconds = match.groups()
    return round(
        int(hours or 0) * 60 + int(mins or 0) + float(seconds or 0) / 60,
        3,
    )


def game_entry(game):
    if int(game["gameStatus"]) != 3 or not str(game["gameId"]).startswith("002"):
        raise ValueError("Only completed regular-season games can be cached")

    home, away = game["homeTeam"], game["awayTeam"]
    if NYK not in (int(home["teamId"]), int(away["teamId"])):
        raise ValueError("Box score is not a Knicks game")

    knicks_home = int(home["teamId"]) == NYK
    team, opponent = (home, away) if knicks_home else (away, home)

    date = game["gameCode"][:8]
    if not re.fullmatch(r"\d{8}", date):
        raise ValueError("Missing gameCode date")
    date = f"{date[:4]}-{date[4:6]}-{date[6:]}"

    result = "W" if int(team["score"]) > int(opponent["score"]) else "L"
    players = {}

    for player in team["players"]:
        if str(player.get("played", "")).lower() not in ("1", "true"):
            continue

        stats = player["statistics"]
        line = {"min": minutes(stats["minutes"])}
        line.update({key: int(stats[source]) for key, source in COUNTS.items()})

        for key, (made, attempted) in SHOTS.items():
            line[f"{key}_made"] = int(stats[made])
            line[f"{key}_attempted"] = int(stats[attempted])

        players[str(player["personId"])] = line

    if not players:
        raise ValueError("Final box score contains no Knicks players")

    return {
        "date": date,
        "opponent": ("vs " if knicks_home else "@ ") + opponent["teamTricode"],
        "result": result,
        "players": players,
    }


def display_line(line):
    result = {
        key: round(line[key], 1) if key == "min" else line[key]
        for key in ("min", *COUNTS)
        if key in line
    }

    for key in SHOTS:
        made = line[f"{key}_made"]
        attempted = line[f"{key}_attempted"]
        result[f"{key}_pct"] = (
            round(made * 100 / attempted, 1) if attempted else 0
        )

    return result


def average(lines):
    count = len(lines)
    totals = {
        key: sum(line[key] for line in lines)
        for key in ("min", *COUNTS)
    }
    result = {
        "gp": count,
        **{key: round(value / count, 1) for key, value in totals.items()},
    }

    for key in SHOTS:
        made = sum(line[f"{key}_made"] for line in lines)
        attempted = sum(line[f"{key}_attempted"] for line in lines)
        result[f"{key}_pct"] = (
            round(made * 100 / attempted, 1) if attempted else 0
        )

    return result


def update(stats, history, roster_ids, game_id, entry):
    season = season_for(entry["date"])
    old_season = history.get("season")

    if old_season and old_season != season:
        if old_season > season:
            raise ValueError(
                f"Refusing to move season backward from {old_season} to {season}"
            )
        history = {"season": season, "games": {}}

    if not old_season:
        baseline = max(
            (
                record.get("stats", {}).get("season", "")
                for record in stats.get("players", {}).values()
            ),
            default="",
        )
        if baseline and baseline >= season:
            raise ValueError(
                f"Cannot rebuild {season} from a partial game history; "
                f"existing snapshot is {baseline}"
            )
        history = {"season": season, "games": {}}

    if history["games"].get(game_id) == entry:
        return stats, history, False

    history["games"][game_id] = entry
    players = stats.setdefault("players", {})

    for player_id in roster_ids:
        record = players.setdefault(player_id, {})
        player_stats = record.setdefault("stats", {})

        logs = [
            (game["date"], gid, game, game["players"][player_id])
            for gid, game in history["games"].items()
            if player_id in game["players"]
        ]
        logs.sort(key=lambda row: (row[0], row[1]), reverse=True)

        player_stats["season"] = season
        player_stats["season_avg"] = (
            average([row[3] for row in logs]) if logs else None
        )
        player_stats["game_log"] = [
            {
                "date": game["date"],
                "opponent": game["opponent"],
                "result": game["result"],
                **display_line(line),
            }
            for _, _, game, line in logs[:10]
        ]
        player_stats.pop("career", None)

    stats["source"] = "NBA live box scores via nba_api"
    stats["updated_at"] = datetime.now(timezone.utc).isoformat()
    return stats, history, True


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    )
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify scoreboard and box score access without writing files",
    )
    args = parser.parse_args()

    games = live_scoreboard()

    if args.check:
        sample = live_boxscore(CHECK_GAME_ID)
        assert (
            sample.get("gameId") == CHECK_GAME_ID
            and sample.get("homeTeam", {}).get("players")
        ), "Box score incomplete"
        print(
            f"NBA live feed reachable: {len(games)} scoreboard games, "
            "sample box score OK"
        )
        return

    if not ROSTER.exists():
        raise FileNotFoundError(f"Expected {ROSTER}")
    if not STATS.exists():
        raise FileNotFoundError(
            f"Expected {STATS}; upload the existing stats snapshot first"
        )

    roster_ids = {
        str(player["nba_player_id"])
        for player in json.loads(ROSTER.read_text())["players"]
    }
    stats = json.loads(STATS.read_text())
    history = (
        json.loads(HISTORY.read_text())
        if HISTORY.exists()
        else {"season": None, "games": {}}
    )

    changed = False

    for game in games:
        game_id = str(game["gameId"])

        if int(game["gameStatus"]) != 3 or not game_id.startswith("002"):
            continue
        if NYK not in (
            int(game["homeTeam"]["teamId"]),
            int(game["awayTeam"]["teamId"]),
        ):
            continue

        entry = game_entry(live_boxscore(game_id))
        stats, history, updated = update(
            stats, history, roster_ids, game_id, entry
        )
        changed |= updated
        print(f'{game_id}: {"saved" if updated else "already cached"}')

    if changed:
        write_json(HISTORY, history)
        write_json(STATS, stats)
    else:
        print("No new completed Knicks regular-season game; cache unchanged")


if __name__ == "__main__":
    main()
