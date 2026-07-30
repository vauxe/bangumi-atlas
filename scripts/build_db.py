"""Build a LadybugDB graph database from a bangumi/Archive dump.

Reads data/dump/*.jsonlines, decodes enum codes via data/mappings/*.yml,
writes intermediate Parquet to data/parquet/, then bulk-loads everything
into db/bangumi.lb with COPY FROM. Full rebuild on every run.
"""

import argparse
import shutil
import sys
import time
import urllib.request
from collections import Counter
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any, cast

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
MAPPINGS = ROOT / "data" / "mappings"
PARQUET = ROOT / "data" / "parquet"
DB_PATH = ROOT / "db" / "bangumi.lb"

SUBJECT_TYPES = {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}
# 4-6 未见于 Archive README,经公开 API 实测确认(api.bgm.tv relation 字段)
CHARACTER_APPEAR_TYPES = {
    1: "主角",
    2: "配角",
    3: "客串",
    4: "闲角",
    5: "旁白",
    6: "声库",
}

MAPPING_FILES = (
    "subject_relations",
    "subject_staffs",
    "person_relations",
    "subject_platforms",
)
MAPPING_URL = "https://raw.githubusercontent.com/bangumi/common/master/{}.yml"

# enum codes that fail to decode, keyed by (edge_table, subject_type, code);
# reported at the end of the parquet stage so mapping staleness is loud
unknown_codes: Counter[tuple[str, int | str, int]] = Counter()

# subject_type (or '*' / prsn / crt) -> enum code -> {cn/en/...}
EnumMap = dict[Any, dict[Any, dict[str, Any]]]


def fetch_mappings() -> None:
    """Refresh enum mapping snapshots from bangumi/common.

    A failed or invalid download keeps the existing snapshot, so offline
    builds still work — but never silently: every outcome is printed.
    """
    MAPPINGS.mkdir(parents=True, exist_ok=True)
    for name in MAPPING_FILES:
        path = MAPPINGS / f"{name}.yml"
        try:
            with urllib.request.urlopen(
                MAPPING_URL.format(name), timeout=15
            ) as resp:
                data = resp.read()
            yaml.safe_load(data)  # reject truncated/invalid downloads
            changed = not path.exists() or path.read_bytes() != data
            path.write_bytes(data)
            print(f"  {name}.yml: {'updated' if changed else 'unchanged'}")
        except (OSError, yaml.YAMLError) as e:
            if not path.exists():
                sys.exit(
                    f"  {name}.yml: download failed and no local "
                    f"snapshot exists: {e}"
                )
            print(f"  {name}.yml: fetch failed ({e}), using local snapshot")


def load_mappings() -> tuple[EnumMap, EnumMap, EnumMap, EnumMap]:
    def load(name: str) -> dict[str, Any]:
        return yaml.safe_load((MAPPINGS / f"{name}.yml").read_text())

    relations = load("subject_relations")["relations"]
    staffs = load("subject_staffs")["staffs"]
    platforms = load("subject_platforms")["platforms"]
    person_relations = load("person_relations")["relations"]
    # codes are namespaced by subject type, but cross-media edges (e.g.
    # anime -> artbook) carry codes from the target type's namespace, so
    # keep a merged table as fallback
    relations["*"] = {k: v for m in relations.values() for k, v in m.items()}
    staffs["*"] = {k: v for m in staffs.values() for k, v in m.items()}
    return relations, staffs, platforms, person_relations


# fields this script knows how to import, per source file; anything beyond
# these would be silently dropped, so iter_jsonl warns when they appear
EXPECTED_FIELDS: dict[str, set[str]] = {
    "subject": {
        "id",
        "type",
        "name",
        "name_cn",
        "infobox",
        "platform",
        "summary",
        "nsfw",
        "tags",
        "meta_tags",
        "score",
        "score_details",
        "rank",
        "date",
        "favorite",
        "series",
    },
    "person": {
        "id",
        "name",
        "type",
        "career",
        "infobox",
        "summary",
        "comments",
        "collects",
    },
    "character": {
        "id",
        "role",
        "name",
        "infobox",
        "summary",
        "comments",
        "collects",
    },
    "episode": {
        "id",
        "name",
        "name_cn",
        "description",
        "airdate",
        "disc",
        "duration",
        "subject_id",
        "sort",
        "type",
    },
    "subject-relations": {
        "subject_id",
        "relation_type",
        "related_subject_id",
        "order",
    },
    "subject-persons": {"person_id", "subject_id", "position", "appear_eps"},
    "subject-characters": {"character_id", "subject_id", "type", "order"},
    "person-characters": {
        "person_id",
        "subject_id",
        "character_id",
        "type",
        "summary",
    },
    "person-relations": {
        "person_type",
        "person_id",
        "related_person_id",
        "relation_type",
        "spoiler",
        "ended",
    },
}
_field_drift_warned: set[tuple[str, str]] = set()


def iter_jsonl(name: str) -> Iterator[dict[str, Any]]:
    expected = EXPECTED_FIELDS[name]
    with open(DUMP / f"{name}.jsonlines", "rb") as f:
        for i, line in enumerate(f):
            r = orjson.loads(line)
            if i % 500 == 0:
                for k in r.keys() - expected:
                    if (name, k) not in _field_drift_warned:
                        _field_drift_warned.add((name, k))
                        print(
                            f"  WARNING: {name} has unknown field '{k}' "
                            f"- not imported, schema needs updating"
                        )
            yield r


def write_parquet(
    name: str, schema: pa.Schema, columns: dict[str, list[Any]]
) -> int:
    table = pa.table(columns, schema=schema)
    pq.write_table(table, PARQUET / f"{name}.parquet")
    return table.num_rows


def build_parquet() -> dict[str, int]:
    relations, staffs, platforms, person_relations = load_mappings()
    PARQUET.mkdir(parents=True, exist_ok=True)
    stats: dict[str, int] = {}

    # ---- nodes ----
    # id -> type, reused for edge decoding and FK checks
    subject_type: dict[int, int] = {}
    cols: dict[str, list[Any]] = {
        k: []
        for k in (
            "id",
            "type",
            "type_name",
            "name",
            "name_cn",
            "platform",
            "date",
            "score",
            "rank",
            "nsfw",
            "wish",
            "done",
            "doing",
            "on_hold",
            "dropped",
            "series",
            "score_details",
            "meta_tags",
            "tags",
            "summary",
            "infobox",
        )
    }
    for r in iter_jsonl("subject"):
        sid, stype = r["id"], r["type"]
        if sid in subject_type:
            continue
        subject_type[sid] = stype
        fav = r.get("favorite") or {}
        plat = (platforms.get(stype) or {}).get(r.get("platform")) or {}
        cols["id"].append(sid)
        cols["type"].append(stype)
        cols["type_name"].append(SUBJECT_TYPES.get(stype, str(stype)))
        cols["name"].append(r.get("name") or "")
        cols["name_cn"].append(r.get("name_cn") or "")
        cols["platform"].append(plat.get("type_cn") or plat.get("type") or "")
        cols["date"].append(r.get("date") or "")
        cols["score"].append(r.get("score"))
        cols["rank"].append(r.get("rank"))
        cols["nsfw"].append(bool(r.get("nsfw")))
        for k in ("wish", "done", "doing", "on_hold", "dropped"):
            cols[k].append(fav.get(k, 0))
        cols["series"].append(bool(r.get("series")))
        sd = r.get("score_details") or {}
        cols["score_details"].append([sd.get(str(i), 0) for i in range(1, 11)])
        cols["meta_tags"].append(r.get("meta_tags") or [])
        cols["tags"].append(r.get("tags") or [])
        cols["summary"].append(r.get("summary") or "")
        cols["infobox"].append(r.get("infobox") or "")
    schema = pa.schema(
        [
            ("id", pa.int64()),
            ("type", pa.int64()),
            ("type_name", pa.string()),
            ("name", pa.string()),
            ("name_cn", pa.string()),
            ("platform", pa.string()),
            ("date", pa.string()),
            ("score", pa.float64()),
            ("rank", pa.int64()),
            ("nsfw", pa.bool_()),
            ("wish", pa.int64()),
            ("done", pa.int64()),
            ("doing", pa.int64()),
            ("on_hold", pa.int64()),
            ("dropped", pa.int64()),
            ("series", pa.bool_()),
            ("score_details", pa.list_(pa.int64())),
            ("meta_tags", pa.list_(pa.string())),
            (
                "tags",
                pa.list_(
                    pa.struct([("name", pa.string()), ("count", pa.int64())])
                ),
            ),
            ("summary", pa.string()),
            ("infobox", pa.string()),
        ]
    )
    stats["Subject"] = write_parquet("subject", schema, cols)

    person_ids: set[int] = set()
    cols = {
        k: []
        for k in (
            "id",
            "name",
            "type",
            "career",
            "comments",
            "collects",
            "summary",
            "infobox",
        )
    }
    for r in iter_jsonl("person"):
        if r["id"] in person_ids:
            continue
        person_ids.add(r["id"])
        cols["id"].append(r["id"])
        cols["name"].append(r.get("name") or "")
        cols["type"].append(r.get("type"))
        cols["career"].append(r.get("career") or [])
        cols["comments"].append(r.get("comments", 0))
        cols["collects"].append(r.get("collects", 0))
        cols["summary"].append(r.get("summary") or "")
        cols["infobox"].append(r.get("infobox") or "")
    schema = pa.schema(
        [
            ("id", pa.int64()),
            ("name", pa.string()),
            ("type", pa.int64()),
            ("career", pa.list_(pa.string())),
            ("comments", pa.int64()),
            ("collects", pa.int64()),
            ("summary", pa.string()),
            ("infobox", pa.string()),
        ]
    )
    stats["Person"] = write_parquet("person", schema, cols)

    character_ids: set[int] = set()
    cols = {
        k: []
        for k in (
            "id",
            "name",
            "role",
            "comments",
            "collects",
            "summary",
            "infobox",
        )
    }
    for r in iter_jsonl("character"):
        if r["id"] in character_ids:
            continue
        character_ids.add(r["id"])
        cols["id"].append(r["id"])
        cols["name"].append(r.get("name") or "")
        cols["role"].append(r.get("role"))
        cols["comments"].append(r.get("comments", 0))
        cols["collects"].append(r.get("collects", 0))
        cols["summary"].append(r.get("summary") or "")
        cols["infobox"].append(r.get("infobox") or "")
    schema = pa.schema(
        [
            ("id", pa.int64()),
            ("name", pa.string()),
            ("role", pa.int64()),
            ("comments", pa.int64()),
            ("collects", pa.int64()),
            ("summary", pa.string()),
            ("infobox", pa.string()),
        ]
    )
    stats["Character"] = write_parquet("character", schema, cols)

    episode_ids: set[int] = set()
    cols = {
        k: []
        for k in (
            "id",
            "name",
            "name_cn",
            "description",
            "airdate",
            "disc",
            "duration",
            "sort",
            "type",
            "subject_id",
        )
    }
    ep_edges: dict[str, list[int]] = {"from_id": [], "to_id": []}
    dropped = 0
    for r in iter_jsonl("episode"):
        if r["id"] in episode_ids:
            continue
        episode_ids.add(r["id"])
        cols["id"].append(r["id"])
        cols["name"].append(r.get("name") or "")
        cols["name_cn"].append(r.get("name_cn") or "")
        cols["description"].append(r.get("description") or "")
        cols["airdate"].append(r.get("airdate") or "")
        cols["disc"].append(r.get("disc", 0))
        cols["duration"].append(r.get("duration") or "")
        sort = r.get("sort")
        cols["sort"].append(float(sort) if sort is not None else None)
        cols["type"].append(r.get("type"))
        # kept on the node too: for orphan episodes (subject deleted) the
        # edge below is skipped and this is the only record of ownership
        cols["subject_id"].append(r["subject_id"])
        if r["subject_id"] in subject_type:
            ep_edges["from_id"].append(r["id"])
            ep_edges["to_id"].append(r["subject_id"])
        else:
            dropped += 1
    schema = pa.schema(
        [
            ("id", pa.int64()),
            ("name", pa.string()),
            ("name_cn", pa.string()),
            ("description", pa.string()),
            ("airdate", pa.string()),
            ("disc", pa.int64()),
            ("duration", pa.string()),
            ("sort", pa.float64()),
            ("type", pa.int64()),
            ("subject_id", pa.int64()),
        ]
    )
    stats["Episode"] = write_parquet("episode", schema, cols)
    if dropped:
        print(
            f"  episode: {dropped} orphan nodes kept, EPISODE_OF edges "
            f"skipped (subject deleted)"
        )

    edge_schema = pa.schema([("from_id", pa.int64()), ("to_id", pa.int64())])
    stats["EPISODE_OF"] = write_parquet("episode_of", edge_schema, ep_edges)

    # ---- edges ----
    def edge_file(
        name: str,
        spec: list[tuple[str, pa.DataType]],
        rows: Iterable[tuple[Any, ...] | None],
    ) -> int:
        schema = pa.schema(
            [("from_id", pa.int64()), ("to_id", pa.int64())]
            + [(n, t) for n, t in spec]
        )
        cols: dict[str, list[Any]] = {f.name: [] for f in schema}
        kept = dangling = 0
        for row in rows:
            if row is None:
                dangling += 1
                continue
            for f, v in zip(schema, row, strict=True):
                cols[f.name].append(v)
            kept += 1
        if dangling:
            print(
                f"  {name}: {dangling:,} dangling rows filtered "
                f"(endpoint deleted upstream)"
            )
        stats[name.upper()] = write_parquet(name, schema, cols)
        return kept

    def subject_relation_rows() -> Iterator[tuple[Any, ...] | None]:
        for r in iter_jsonl("subject-relations"):
            src, dst = r["subject_id"], r["related_subject_id"]
            if src not in subject_type or dst not in subject_type:
                yield None
                continue
            rel = (
                (relations.get(subject_type[src]) or {}).get(
                    r["relation_type"]
                )
                or relations["*"].get(r["relation_type"])
                or {}
            )
            name = rel.get("cn") or rel.get("en") or ""
            if not name:
                unknown_codes[
                    ("RELATES_TO", subject_type[src], r["relation_type"])
                ] += 1
            yield (src, dst, r["relation_type"], name, r.get("order", 0))

    edge_file(
        "relates_to",
        [
            ("relation_type", pa.int64()),
            ("relation", pa.string()),
            ("sort_order", pa.int64()),
        ],
        subject_relation_rows(),
    )

    def worked_on_rows() -> Iterator[tuple[Any, ...] | None]:
        for r in iter_jsonl("subject-persons"):
            pid, sid = r["person_id"], r["subject_id"]
            if pid not in person_ids or sid not in subject_type:
                yield None
                continue
            pos = (
                (staffs.get(subject_type[sid]) or {}).get(r["position"])
                or staffs["*"].get(r["position"])
                or {}
            )
            name = pos.get("cn") or pos.get("en") or ""
            if not name:
                unknown_codes[
                    ("WORKED_ON", subject_type[sid], r["position"])
                ] += 1
            yield (pid, sid, r["position"], name, r.get("appear_eps") or "")

    edge_file(
        "worked_on",
        [
            ("position", pa.int64()),
            ("position_cn", pa.string()),
            ("appear_eps", pa.string()),
        ],
        worked_on_rows(),
    )

    def appears_in_rows() -> Iterator[tuple[Any, ...] | None]:
        for r in iter_jsonl("subject-characters"):
            cid, sid = r["character_id"], r["subject_id"]
            if cid not in character_ids or sid not in subject_type:
                yield None
                continue
            name = CHARACTER_APPEAR_TYPES.get(r["type"], "")
            if not name:
                unknown_codes[
                    ("APPEARS_IN", subject_type[sid], r["type"])
                ] += 1
            yield (cid, sid, r["type"], name, r.get("order", 0))

    edge_file(
        "appears_in",
        [
            ("type", pa.int64()),
            ("role_cn", pa.string()),
            ("sort_order", pa.int64()),
        ],
        appears_in_rows(),
    )

    def voiced_rows() -> Iterator[tuple[Any, ...] | None]:
        for r in iter_jsonl("person-characters"):
            pid, cid = r["person_id"], r["character_id"]
            if pid not in person_ids or cid not in character_ids:
                yield None
                continue
            yield (
                pid,
                cid,
                r["subject_id"],
                r.get("type", 0),
                r.get("summary") or "",
            )

    edge_file(
        "voiced",
        [
            ("subject_id", pa.int64()),
            ("type", pa.int64()),
            ("summary", pa.string()),
        ],
        voiced_rows(),
    )

    def person_rel_rows(
        kind: str, ids: set[int]
    ) -> Iterator[tuple[Any, ...] | None]:
        for r in iter_jsonl("person-relations"):
            if r["person_type"] != kind:
                continue
            src, dst = r["person_id"], r["related_person_id"]
            if src not in ids or dst not in ids:
                yield None
                continue
            rel = (person_relations.get(kind) or {}).get(
                r["relation_type"]
            ) or {}
            name = rel.get("cn") or ""
            if not name:
                unknown_codes[
                    (f"{kind.upper()}_REL", kind, r["relation_type"])
                ] += 1
            yield (
                src,
                dst,
                r["relation_type"],
                name,
                bool(r.get("spoiler")),
                bool(r.get("ended")),
            )

    rel_spec = [
        ("relation_type", pa.int64()),
        ("relation", pa.string()),
        ("spoiler", pa.bool_()),
        ("ended", pa.bool_()),
    ]
    edge_file("person_rel", rel_spec, person_rel_rows("prsn", person_ids))
    edge_file("character_rel", rel_spec, person_rel_rows("crt", character_ids))
    kinds = Counter(r["person_type"] for r in iter_jsonl("person-relations"))
    for kind, n in kinds.items():
        if kind not in ("prsn", "crt"):
            print(
                f"  WARNING: person-relations has {n:,} rows with "
                f"unhandled person_type '{kind}' - silently skipped, "
                f"schema needs a new rel table"
            )
    return stats


DDL = """
CREATE NODE TABLE Subject(id INT64 PRIMARY KEY, type INT64, type_name STRING,
    name STRING, name_cn STRING, platform STRING, date STRING, score DOUBLE,
    rank INT64, nsfw BOOLEAN, wish INT64, done INT64, doing INT64,
    on_hold INT64, dropped INT64, series BOOLEAN, score_details INT64[],
    meta_tags STRING[], tags STRUCT(name STRING, count INT64)[],
    summary STRING, infobox STRING);
CREATE NODE TABLE Person(id INT64 PRIMARY KEY, name STRING, type INT64,
    career STRING[], comments INT64, collects INT64, summary STRING,
    infobox STRING);
CREATE NODE TABLE Character(id INT64 PRIMARY KEY, name STRING, role INT64,
    comments INT64, collects INT64, summary STRING, infobox STRING);
CREATE NODE TABLE Episode(id INT64 PRIMARY KEY, name STRING, name_cn STRING,
    description STRING, airdate STRING, disc INT64, duration STRING,
    sort DOUBLE, type INT64, subject_id INT64);
CREATE REL TABLE RELATES_TO(FROM Subject TO Subject, relation_type INT64,
    relation STRING, sort_order INT64);
CREATE REL TABLE WORKED_ON(FROM Person TO Subject, position INT64,
    position_cn STRING, appear_eps STRING);
CREATE REL TABLE APPEARS_IN(FROM Character TO Subject, type INT64,
    role_cn STRING, sort_order INT64);
CREATE REL TABLE VOICED(FROM Person TO Character, subject_id INT64,
    type INT64, summary STRING);
CREATE REL TABLE EPISODE_OF(FROM Episode TO Subject);
CREATE REL TABLE PERSON_REL(FROM Person TO Person, relation_type INT64,
    relation STRING, spoiler BOOLEAN, ended BOOLEAN);
CREATE REL TABLE CHARACTER_REL(FROM Character TO Character,
    relation_type INT64, relation STRING, spoiler BOOLEAN, ended BOOLEAN);
"""

COPIES = [
    ("Subject", "subject"),
    ("Person", "person"),
    ("Character", "character"),
    ("Episode", "episode"),
    ("RELATES_TO", "relates_to"),
    ("WORKED_ON", "worked_on"),
    ("APPEARS_IN", "appears_in"),
    ("VOICED", "voiced"),
    ("EPISODE_OF", "episode_of"),
    ("PERSON_REL", "person_rel"),
    ("CHARACTER_REL", "character_rel"),
]


def build_db() -> None:
    import ladybug as lb

    if DB_PATH.exists():
        if DB_PATH.is_dir():
            shutil.rmtree(DB_PATH)
        else:
            DB_PATH.unlink()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = lb.Database(str(DB_PATH))
    conn = lb.Connection(db)
    for stmt in DDL.strip().split(";"):
        if stmt.strip():
            conn.execute(stmt)
    for table, fname in COPIES:
        t0 = time.time()
        conn.execute(f'COPY {table} FROM "{PARQUET / fname}.parquet"')
        print(f"  COPY {table}: {time.time() - t0:.1f}s")
    for table, _ in COPIES:
        pattern = f"()-[r:{table}]->()" if table.isupper() else f"(n:{table})"
        var = "r" if table.isupper() else "n"
        res = conn.execute(f"MATCH {pattern} RETURN count({var})")
        assert isinstance(res, lb.QueryResult)
        # stub says get_next() yields a dict; at runtime it is a list
        row = cast("list[Any]", res.get_next())
        print(f"  {table}: {row[0]:,}")
    conn.close()
    db.close()


def report_unknown_codes() -> None:
    if not unknown_codes:
        print("  all enum codes decoded")
        return
    total = sum(unknown_codes.values())
    print(
        f"  WARNING: {total:,} edges with undecodable enum codes "
        f"(stale data/mappings/ snapshot or legacy dirty data):"
    )
    for (table, stype, code), n in sorted(unknown_codes.items()):
        print(f"    {table} subject_type={stype} code={code}: {n:,} edges")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Rebuild db/bangumi.lb from data/dump/*.jsonlines"
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip refreshing enum mappings, use the "
        "local snapshot in data/mappings/",
    )
    parser.add_argument(
        "--skip-parquet",
        action="store_true",
        help="reuse existing data/parquet/, only rerun "
        "the database load stage",
    )
    cli = parser.parse_args()

    t0 = time.time()
    if not cli.skip_parquet:
        if cli.offline:
            print("[1/3] mappings: --offline, using local snapshot")
        else:
            print("[1/3] refresh enum mappings from bangumi/common")
            fetch_mappings()
        print("[2/3] jsonlines -> parquet")
        for name, n in build_parquet().items():
            print(f"  {name}: {n:,} rows")
        report_unknown_codes()
    print("[3/3] parquet -> ladybug db")
    build_db()
    print(f"done in {time.time() - t0:.0f}s -> {DB_PATH}")
