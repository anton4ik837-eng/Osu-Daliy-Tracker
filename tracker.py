import os, json, sqlite3, csv
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

UID=34437510
API="https://osu.ppy.sh/api/v2"
Path("data").mkdir(exist_ok=True); Path("reports").mkdir(exist_ok=True)

def main():
    cid=os.getenv("OSU_CLIENT_ID"); secret=os.getenv("OSU_CLIENT_SECRET")
    if not cid or not secret: raise RuntimeError("Set OSU_CLIENT_ID and OSU_CLIENT_SECRET in GitHub Actions secrets")
    token=requests.post("https://osu.ppy.sh/oauth/token",data={"client_id":int(cid),"client_secret":secret,"grant_type":"client_credentials","scope":"public"},timeout=30)
    token.raise_for_status(); headers={"Authorization":"Bearer "+token.json()["access_token"]}
    s=requests.Session(); s.headers.update(headers)
    now=datetime.now(timezone.utc).isoformat(timespec="seconds")
    p=s.get(f"{API}/users/{UID}/osu",params={"key":"id"},timeout=30); p.raise_for_status(); user=p.json()
    st=user.get("statistics") or {}
    country_code=(user.get("country") or {}).get("code")

    # Regional placement and flag are provided by osu! World, also used by the
    # osu! subdivide nations extension. Missing/unassigned regions are non-fatal.
    region_info = {"country_code": country_code, "region_code": None, "region_name": None,
                   "placement": None, "flag_url": None}
    try:
        rw=requests.get(f"https://osuworld.octo.moe/api/users/{UID}",params={"mode":"osu"},timeout=20)
        rw.raise_for_status()
        world_user=rw.json()
        if isinstance(world_user,dict) and not world_user.get("error"):
            world_country=world_user.get("country_id") or country_code
            region_code=world_user.get("region_id")
            region_info.update({
                "country_code": world_country,
                "region_code": region_code,
                "placement": world_user.get("placement"),
            })
            if world_country and region_code:
                flags_response=requests.get(
                    "https://raw.githubusercontent.com/Cavitedev/osu-subdivide-nations/main/extension/public/flags.json",
                    timeout=25,
                )
                flags_response.raise_for_status()
                country_regions=flags_response.json().get(world_country,{})
                region_data=(country_regions.get("regions") or {}).get(region_code,{})
                region_info["region_name"]=region_data.get("name") or region_code
                region_info["flag_url"]=region_data.get("flag")

    best=s.get(f"{API}/users/{UID}/scores/best",params={"mode":"osu","limit":100,"legacy_only":0},timeout=30); best.raise_for_status()
    recent=s.get(f"{API}/users/{UID}/scores/recent",params={"mode":"osu","limit":100,"include_fails":1,"legacy_only":0},timeout=30); recent.raise_for_status()
    conn=sqlite3.connect("data/tracker.sqlite")
    conn.execute("""CREATE TABLE IF NOT EXISTS snapshots(ts TEXT PRIMARY KEY, username TEXT, pp REAL, global_rank INTEGER, country_rank INTEGER, accuracy REAL, playcount INTEGER, playtime INTEGER, max_combo INTEGER, level REAL, raw TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS scores(id TEXT PRIMARY KEY, kind TEXT, ended_at TEXT, beatmap_id INTEGER, title TEXT, pp REAL, accuracy REAL, combo INTEGER, rank TEXT, mods TEXT, misses INTEGER, raw TEXT)""")
    prev=conn.execute("SELECT pp,global_rank,accuracy FROM snapshots ORDER BY ts DESC LIMIT 1").fetchone()
    level=(user.get("statistics") or {}).get("level")
    conn.execute("INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)",(now,user.get("username"),st.get("pp"),st.get("global_rank"),st.get("country_rank"),st.get("hit_accuracy"),st.get("play_count"),st.get("play_time"),st.get("maximum_combo"),(level or {}).get("current") if isinstance(level,dict) else level,json.dumps(user,ensure_ascii=False)))
    added=0
    for kind,items in [("best",best.json()),("recent",recent.json())]:
        for x in items:
            bid=x.get("beatmap") or {}; bset=x.get("beatmapset") or {}; stats=x.get("statistics") or {}
            mods=x.get("mods") or []
            modstr="".join(str(m.get("acronym","")) if isinstance(m,dict) else str(m) for m in mods) or "NM"
            cur=conn.execute("INSERT OR IGNORE INTO scores VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(str(x.get("id")),kind,x.get("ended_at") or x.get("created_at"),x.get("beatmap_id") or bid.get("id"),bset.get("title") or bid.get("version") or "Unknown",x.get("pp"),x.get("accuracy"),x.get("max_combo"),x.get("rank"),modstr,stats.get("miss",0),json.dumps(x,ensure_ascii=False)))
            added+=cur.rowcount
    conn.commit()
    rows=conn.execute("SELECT ts,username,pp,global_rank,country_rank,accuracy,playcount,playtime,max_combo,level FROM snapshots ORDER BY ts").fetchall()
    with open("reports/snapshots.csv","w",newline="",encoding="utf-8") as f:
        w=csv.writer(f); w.writerow(["ts","username","pp","global_rank","country_rank","accuracy","playcount","playtime","max_combo","level"]); w.writerows(rows)
    # Order score records: all-time highest PP, today's highest PP (Berlin local date),
    # then all remaining scores by acquisition time. Each score appears only once.
    scores=conn.execute("SELECT id,kind,ended_at,beatmap_id,title,pp,accuracy,combo,rank,mods,misses FROM scores").fetchall()
    berlin = ZoneInfo("Europe/Berlin")
    today_local = datetime.now(berlin).date().isoformat()

    def score_datetime(value):
        if not value:
            return datetime.min.replace(tzinfo=timezone.utc)
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except (ValueError, TypeError):
            return datetime.min.replace(tzinfo=timezone.utc)

    def local_score_date(score):
        return score_datetime(score[2]).astimezone(berlin).date().isoformat()

    dated_scores = sorted(scores, key=lambda r: score_datetime(r[2]))
    highest_all_time = max(
        (r for r in scores if r[5] is not None),
        key=lambda r: float(r[5]),
        default=None
    )
    todays_scores = [r for r in scores if r[5] is not None and local_score_date(r) == today_local]
    highest_today = max(todays_scores, key=lambda r: float(r[5]), default=None)

    ordered_scores = []
    used_ids = set()
    for featured in (highest_all_time, highest_today):
        if featured is not None and featured[0] not in used_ids:
            ordered_scores.append(featured)
            used_ids.add(featured[0])
    ordered_scores.extend(r for r in dated_scores if r[0] not in used_ids)

    with open("reports/scores.csv","w",newline="",encoding="utf-8") as f:
        w=csv.writer(f)
        w.writerow(["id","kind","ended_at","beatmap_id","title","pp","accuracy","combo","rank","mods","misses"])
        w.writerows(ordered_scores)
    dates=[r[0][:10] for r in rows]
    if rows:
        plt.figure(figsize=(9,4)); plt.plot(dates,[r[2] for r in rows],marker="o"); plt.title("EmptyMiyabi — PP"); plt.xticks(rotation=45); plt.tight_layout(); plt.savefig("reports/pp_history.png",dpi=140); plt.close()
        valid=[(r[0][:10],r[3]) for r in rows if r[3] is not None]
        if valid:
            plt.figure(figsize=(9,4)); plt.plot([x[0] for x in valid],[x[1] for x in valid],marker="o"); plt.gca().invert_yaxis(); plt.title("EmptyMiyabi — global rank (lower is better)"); plt.xticks(rotation=45); plt.tight_layout(); plt.savefig("reports/rank_history.png",dpi=140); plt.close()
    def delta(i,fmt):
        if not prev or rows[-1][i] is None or prev[i-2] is None: return "нет предыдущего снимка"
        return fmt(rows[-1][i]-prev[i-2])
    report=f"""# Ежедневный отчёт osu! — {user.get('username')}

- Проверено (UTC): `{now}`
- Источник: [официальный профиль](https://osu.ppy.sh/users/{UID}) · [API v2 docs](https://osu.ppy.sh/docs/)
- PP: **{st.get('pp','н/д')}** ({delta(2,lambda x:f'{x:+.2f}')})
- Глобальный ранг: **{st.get('global_rank','н/д')}** ({delta(3,lambda x:f'{-x:+.0f} мест улучшения')})
- Ранг страны: **{st.get('country_rank','н/д')}**
- Точность: **{st.get('hit_accuracy','н/д')}%**
- Игры: **{st.get('play_count','н/д')}**
- Время игры: **{(st['play_time']//3600)} ч {(st['play_time']%3600)//60} мин**""" if st.get("play_time") is not None else f"""# Ежедневный отчёт osu! — {user.get('username')}

- Проверено (UTC): `{now}`
- Источник: [официальный профиль](https://osu.ppy.sh/users/{UID}) · [API v2 docs](https://osu.ppy.sh/docs/)
- PP: **{st.get('pp','н/д')}** ({delta(2,lambda x:f'{x:+.2f}')})
- Глобальный ранг: **{st.get('global_rank','н/д')}**
- Ранг страны: **{st.get('country_rank','н/д')}**
- Точность: **{st.get('hit_accuracy','н/д')}%**
- Игры: **{st.get('play_count','н/д')}**
- Время игры: **н/д**"""
    report+=f"""
- Максимальное комбо: **{st.get('maximum_combo','н/д')}**
- Уровень: **{level}**
- Новые уникальные записи score ID в этом запуске: **{added}** (best/recent могут пересекаться)
- Всего снимков: **{len(rows)}**

## История
- `snapshots.csv` — история профиля
- `scores.csv` — сначала рекорд с максимальным PP за всё время, затем лучший результат за сегодня (если это другой score), затем остальные результаты по времени получения
- `pp_history.png`, `rank_history.png` — графики

> Значения берутся из API во время запуска. API выдаёт ограниченный список best/recent, поэтому при большом количестве игр между запусками часть недавних результатов может быть пропущена.
"""
    Path("reports/latest.md").write_text(report,encoding="utf-8")

    # Build the Miyabi/Frost HTML dashboard from the current snapshot and saved history.
    dashboard_template = Path("dashboard_template.html")
    if dashboard_template.exists():
        dashboard_stats = {
            "pp": st.get("pp"),
            "global_rank": st.get("global_rank"),
            "country_rank": st.get("country_rank"),
            "accuracy": st.get("hit_accuracy"),
            "playcount": st.get("play_count"),
            "playtime_hours": round(st.get("play_time") / 3600, 1) if st.get("play_time") is not None else None,
            "max_combo": st.get("maximum_combo"),
            "level": (level or {}).get("current") if isinstance(level, dict) else level,
            "country_code": country_code,
        }
        dashboard_snapshots = [
            {"ts": r[0], "pp": r[2], "global_rank": r[3], "accuracy": r[5]}
            for r in rows
        ]
        dashboard_scores = [
            {"id": r[0], "kind": r[1], "ended_at": r[2], "beatmap_id": r[3],
             "title": r[4], "pp": r[5], "accuracy": r[6], "combo": r[7],
             "rank": r[8], "mods": r[9], "misses": r[10]}
            for r in ordered_scores
        ]
        dashboard_data = {
            "updated": now,
            "stats": dashboard_stats,
            "snapshots": dashboard_snapshots,
            "scores": dashboard_scores,
            "region": region_info,
        }
        dashboard_html = dashboard_template.read_text(encoding="utf-8").replace(
            "__DASHBOARD_DATA__", json.dumps(dashboard_data, ensure_ascii=False, separators=(",", ":"))
        )
        Path("reports/dashboard.html").write_text(dashboard_html, encoding="utf-8")
        print("Generated reports/dashboard.html")

    print(report); conn.close()

if __name__=="__main__": main()
