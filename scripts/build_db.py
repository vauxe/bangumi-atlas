"""Build a LadybugDB graph database from a bangumi/Archive dump.

Reads data/dump/*.jsonlines, decodes enum codes via data/mappings/*.yml,
writes intermediate Parquet to data/parquet/, then bulk-loads everything
into db/bangumi.lb with COPY FROM. Full rebuild on every run.
"""

import argparse
import shutil
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import enum_mappings
import orjson
import pyarrow as pa
import pyarrow.parquet as pq

if TYPE_CHECKING:
    from build_lock import PARQUET_BUILD_MARKER, parquet_layout_lock
elif __package__:
    from scripts.build_lock import PARQUET_BUILD_MARKER, parquet_layout_lock
else:
    from build_lock import PARQUET_BUILD_MARKER, parquet_layout_lock

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
MAPPINGS = ROOT / "data" / "mappings"
PARQUET = ROOT / "data" / "parquet"
DB_PATH = ROOT / "db" / "bangumi.lb"

SUBJECT_TYPES = {1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元"}
# Source: https://bangumi.github.io/api/dist.json
PERSON_TYPES = {1, 2, 3}
CHARACTER_ROLES = {1, 2, 3, 4}
# Source: https://github.com/bangumi/Archive/blob/master/README.md
EPISODE_TYPES = set(range(7))
# 4-6 未见于 Archive README,经公开 API 实测确认(api.bgm.tv relation 字段)
CHARACTER_APPEAR_TYPES = {
    1: "主角",
    2: "配角",
    3: "客串",
    4: "闲角",
    5: "旁白",
    6: "声库",
}

# Audited exceptions in the current Archive snapshot. Any new key or increase
# is schema/mapping drift and must stop the build before database loading.
ENUM_ANOMALY_BASELINES: dict[tuple[str, int | str, int | None], int] = {
    ("Person.type", "*", 0): 1,  # Archive historical dirty row: id=22
    ("RELATES_TO", 4, 4013): 6,  # upstream-deleted historical relation code
}

# Enum codes outside the current contract, keyed by (scope, namespace, code).
unknown_codes: Counter[tuple[str, int | str, int | None]] = Counter()


def validate_mapping_snapshot() -> str:
    return enum_mappings.validate_mapping_snapshot(MAPPINGS)


def fetch_mappings() -> str:
    return enum_mappings.fetch_mappings(MAPPINGS)


def load_mappings() -> enum_mappings.MappingTables:
    return enum_mappings.load_mappings(MAPPINGS)


# Fields this script imports, per source file. Anything beyond this contract
# would be dropped by the typed projection, so schema drift stops the build.
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
SUBJECT_OBJECT_FIELDS = {
    "favorite": {"wish", "done", "doing", "on_hold", "dropped"},
    "score_details": {str(score) for score in range(1, 11)},
}
SUBJECT_TAG_FIELDS = {"name", "count"}
PERSON_RELATION_TYPES = {"prsn", "crt"}


def _validate_object_fields(
    source: str,
    field: str,
    value: Any,
    expected: set[str],
) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"{source}.{field} must be an object")
    unknown = sorted(value.keys() - expected)
    if unknown:
        raise ValueError(
            f"{source}.{field} has unknown source field(s): "
            f"{', '.join(unknown)}"
        )


def _validate_source_record(name: str, record: dict[str, Any]) -> None:
    unknown = sorted(record.keys() - EXPECTED_FIELDS[name])
    if unknown:
        raise ValueError(
            f"{name} has unknown source field(s): {', '.join(unknown)}"
        )
    if name == "subject":
        for field, expected in SUBJECT_OBJECT_FIELDS.items():
            _validate_object_fields(name, field, record.get(field), expected)
        tags = record.get("tags")
        if tags is not None:
            if not isinstance(tags, list):
                raise ValueError("subject.tags must be an array")
            for index, tag in enumerate(tags):
                _validate_object_fields(
                    name,
                    f"tags[{index}]",
                    tag,
                    SUBJECT_TAG_FIELDS,
                )
    if name == "person-relations":
        kind = record.get("person_type")
        if kind not in PERSON_RELATION_TYPES:
            raise ValueError(
                f"person-relations.person_type has unsupported value {kind!r}"
            )


def iter_jsonl(name: str) -> Iterator[dict[str, Any]]:
    with open(DUMP / f"{name}.jsonlines", "rb") as f:
        for line in f:
            r = orjson.loads(line)
            _validate_source_record(name, r)
            yield r


PARQUET_BATCH_ROWS = 10_000


def write_parquet_rows(
    name: str,
    schema: pa.Schema,
    rows: Iterable[tuple[Any, ...]],
    *,
    batch_rows: int = PARQUET_BATCH_ROWS,
) -> int:
    """Write rows in bounded batches and publish only a complete file."""

    if batch_rows <= 0:
        raise ValueError("batch_rows must be positive")

    target = PARQUET / f"{name}.parquet"
    staging = PARQUET / f".{name}.parquet.build"
    staging.unlink(missing_ok=True)
    columns: dict[str, list[Any]] = {field.name: [] for field in schema}
    buffers = list(columns.values())
    count = 0
    writer = pq.ParquetWriter(staging, schema)

    def flush() -> None:
        if not columns[schema.names[0]]:
            return
        writer.write_table(pa.table(columns, schema=schema))
        for column in columns.values():
            column.clear()

    try:
        for row in rows:
            for buffer, value in zip(buffers, row, strict=True):
                buffer.append(value)
            count += 1
            if count % batch_rows == 0:
                flush()
        flush()
        writer.close()
        staging.replace(target)
    except BaseException:
        with suppress(Exception):
            writer.close()
        staging.unlink(missing_ok=True)
        raise
    return count


def _build_parquet_unlocked() -> dict[str, int]:
    unknown_codes.clear()
    relations, staffs, platforms, person_relations, voice_roles = (
        load_mappings()
    )
    PARQUET.mkdir(parents=True, exist_ok=True)
    stats: dict[str, int] = {}

    # ---- nodes ----
    # id -> type, reused for edge decoding and FK checks
    subject_type: dict[int, int] = {}
    subject_schema = pa.schema(
        [
            ("id", pa.int64()),
            ("type", pa.int64()),
            ("type_name", pa.string()),
            ("name", pa.string()),
            ("name_cn", pa.string()),
            ("platform_code", pa.int64()),
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

    def subject_rows() -> Iterator[tuple[Any, ...]]:
        for r in iter_jsonl("subject"):
            sid, stype = r["id"], r["type"]
            if sid in subject_type:
                continue
            subject_type[sid] = stype
            fav = r.get("favorite") or {}
            # platform 解码:命名空间整体缺失(音乐 type 3)是上游事实,
            # 不算失配;命名空间存在但码查不到才计入 unknown_codes
            plat_ns = platforms.get(stype)
            plat = (plat_ns or {}).get(r.get("platform")) or {}
            if plat_ns is not None and r.get("platform") and not plat:
                unknown_codes[("Subject.platform", stype, r["platform"])] += 1
            if stype not in SUBJECT_TYPES:
                unknown_codes[("Subject.type", "*", stype)] += 1
            score_details = r.get("score_details") or {}
            yield (
                sid,
                stype,
                SUBJECT_TYPES.get(stype, str(stype)),
                r.get("name") or "",
                r.get("name_cn") or "",
                r.get("platform"),
                plat.get("type_cn") or plat.get("type") or "",
                r.get("date") or "",
                r.get("score"),
                r.get("rank"),
                bool(r.get("nsfw")),
                fav.get("wish", 0),
                fav.get("done", 0),
                fav.get("doing", 0),
                fav.get("on_hold", 0),
                fav.get("dropped", 0),
                bool(r.get("series")),
                [score_details.get(str(i), 0) for i in range(1, 11)],
                r.get("meta_tags") or [],
                r.get("tags") or [],
                r.get("summary") or "",
                r.get("infobox") or "",
            )

    stats["Subject"] = write_parquet_rows(
        "subject", subject_schema, subject_rows()
    )

    person_ids: set[int] = set()
    person_schema = pa.schema(
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

    def person_rows() -> Iterator[tuple[Any, ...]]:
        for r in iter_jsonl("person"):
            if r["id"] in person_ids:
                continue
            person_ids.add(r["id"])
            person_type = r.get("type")
            if person_type not in PERSON_TYPES:
                unknown_codes[("Person.type", "*", person_type)] += 1
            yield (
                r["id"],
                r.get("name") or "",
                person_type,
                r.get("career") or [],
                r.get("comments", 0),
                r.get("collects", 0),
                r.get("summary") or "",
                r.get("infobox") or "",
            )

    stats["Person"] = write_parquet_rows(
        "person", person_schema, person_rows()
    )

    character_ids: set[int] = set()
    character_schema = pa.schema(
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

    def character_rows() -> Iterator[tuple[Any, ...]]:
        for r in iter_jsonl("character"):
            if r["id"] in character_ids:
                continue
            character_ids.add(r["id"])
            role = r.get("role")
            if role not in CHARACTER_ROLES:
                unknown_codes[("Character.role", "*", role)] += 1
            yield (
                r["id"],
                r.get("name") or "",
                role,
                r.get("comments", 0),
                r.get("collects", 0),
                r.get("summary") or "",
                r.get("infobox") or "",
            )

    stats["Character"] = write_parquet_rows(
        "character", character_schema, character_rows()
    )

    episode_ids: set[int] = set()
    episode_schema = pa.schema(
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
    episode_dropped = 0

    def episode_rows() -> Iterator[tuple[Any, ...]]:
        nonlocal episode_dropped
        for r in iter_jsonl("episode"):
            if r["id"] in episode_ids:
                continue
            episode_ids.add(r["id"])
            episode_type = r.get("type")
            if episode_type not in EPISODE_TYPES:
                unknown_codes[("Episode.type", "*", episode_type)] += 1
            if r["subject_id"] not in subject_type:
                episode_dropped += 1
            sort = r.get("sort")
            yield (
                r["id"],
                r.get("name") or "",
                r.get("name_cn") or "",
                r.get("description") or "",
                r.get("airdate") or "",
                r.get("disc", 0),
                r.get("duration") or "",
                float(sort) if sort is not None else None,
                episode_type,
                # Kept on the node too: for orphan episodes (subject deleted)
                # the edge below is skipped and this records ownership.
                r["subject_id"],
            )

    stats["Episode"] = write_parquet_rows(
        "episode", episode_schema, episode_rows()
    )
    if episode_dropped:
        print(
            f"  episode: {episode_dropped} orphan nodes kept, "
            f"EPISODE_OF edges "
            f"skipped (subject deleted)"
        )

    edge_schema = pa.schema([("from_id", pa.int64()), ("to_id", pa.int64())])

    def episode_edge_rows() -> Iterator[tuple[Any, ...]]:
        batches = pq.ParquetFile(PARQUET / "episode.parquet").iter_batches(
            batch_size=PARQUET_BATCH_ROWS,
            columns=["id", "subject_id"],
        )
        for batch in batches:
            episode_column = batch.column(0).to_pylist()
            subject_column = batch.column(1).to_pylist()
            for episode_id, subject_id in zip(
                episode_column, subject_column, strict=True
            ):
                if subject_id in subject_type:
                    yield (episode_id, subject_id)

    stats["EPISODE_OF"] = write_parquet_rows(
        "episode_of", edge_schema, episode_edge_rows()
    )

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
        dangling = 0

        def kept_rows() -> Iterator[tuple[Any, ...]]:
            nonlocal dangling
            for row in rows:
                if row is None:
                    dangling += 1
                    continue
                yield row

        kept = write_parquet_rows(name, schema, kept_rows())
        if dangling:
            print(
                f"  {name}: {dangling:,} dangling rows filtered "
                f"(endpoint deleted upstream)"
            )
        stats[name.upper()] = kept
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

    # subject_id 是 VOICED 的作品上下文属性而非端点；悬空值保留但显式计数。
    voiced_dangling_subject = 0

    def voiced_rows() -> Iterator[tuple[Any, ...] | None]:
        nonlocal voiced_dangling_subject
        for r in iter_jsonl("person-characters"):
            pid, cid = r["person_id"], r["character_id"]
            if pid not in person_ids or cid not in character_ids:
                yield None
                continue
            if r["subject_id"] not in subject_type:
                voiced_dangling_subject += 1
            voice_type = r.get("type", 0)
            if voice_type not in voice_roles:
                unknown_codes[("VOICED.type", "prsn_cv", voice_type)] += 1
            yield (
                pid,
                cid,
                r["subject_id"],
                voice_type,
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
    if voiced_dangling_subject:
        print(
            f"  VOICED: {voiced_dangling_subject:,} rows carry a dangling "
            f"subject_id attribute (kept as-is, edge endpoints are valid)"
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
                table = "PERSON_REL" if kind == "prsn" else "CHARACTER_REL"
                unknown_codes[(table, kind, r["relation_type"])] += 1
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
    return stats


def build_parquet() -> dict[str, int]:
    """Build one complete Parquet generation while layout readers wait."""
    with parquet_layout_lock(PARQUET):
        PARQUET.mkdir(parents=True, exist_ok=True)
        marker = PARQUET / PARQUET_BUILD_MARKER
        marker.write_text("Parquet publication did not complete.\n")
        stats = _build_parquet_unlocked()
        marker.unlink()
        return stats


DDL = """
CREATE NODE TABLE Subject(id INT64 PRIMARY KEY, type INT64, type_name STRING,
    name STRING, name_cn STRING, platform_code INT64, platform STRING,
    date STRING, score DOUBLE,
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


def _database_artifacts(path: Path) -> list[Path]:
    return sorted(path.parent.glob(f"{path.name}*"))


def _remove_database_artifacts(path: Path) -> None:
    for artifact in _database_artifacts(path):
        if artifact.is_dir():
            shutil.rmtree(artifact)
        else:
            artifact.unlink()


def replace_database(
    target: Path,
    populate: Callable[[Path], None],
) -> None:
    """Build beside target and replace it only after a complete close."""

    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(f".{target.name}.build")
    _remove_database_artifacts(staging)

    sidecars = [path for path in _database_artifacts(target) if path != target]
    if sidecars:
        names = ", ".join(path.name for path in sidecars)
        raise RuntimeError(
            f"refusing to replace {target.name} with live sidecars: {names}"
        )

    try:
        populate(staging)
        artifacts = _database_artifacts(staging)
        if artifacts != [staging] or not staging.is_file():
            names = ", ".join(path.name for path in artifacts) or "none"
            raise RuntimeError(
                f"database build did not produce one closed file: {names}"
            )
        staging.replace(target)
    finally:
        _remove_database_artifacts(staging)


def _populate_database(path: Path) -> None:
    import ladybug as lb

    db = lb.Database(str(path))
    try:
        conn = lb.Connection(db)
        try:
            for stmt in DDL.strip().split(";"):
                if stmt.strip():
                    conn.execute(stmt)
            for table, fname in COPIES:
                t0 = time.time()
                conn.execute(f'COPY {table} FROM "{PARQUET / fname}.parquet"')
                print(f"  COPY {table}: {time.time() - t0:.1f}s")
            for table, _ in COPIES:
                pattern = (
                    f"()-[r:{table}]->()"
                    if table.isupper()
                    else f"(n:{table})"
                )
                var = "r" if table.isupper() else "n"
                res = cast(
                    "lb.QueryResult",
                    conn.execute(f"MATCH {pattern} RETURN count({var})"),
                )
                # stub says get_next() yields a dict; at runtime it is a list
                row = cast("list[Any]", res.get_next())
                print(f"  {table}: {row[0]:,}")
        finally:
            conn.close()
    finally:
        db.close()


def build_db() -> None:
    replace_database(DB_PATH, _populate_database)


def report_unknown_codes() -> None:
    if not unknown_codes:
        print("  all enum codes decoded")
        return
    total = sum(unknown_codes.values())
    print(f"  {total:,} records with enum codes outside the current contract:")
    entries = sorted(
        unknown_codes.items(),
        key=lambda item: tuple(str(part) for part in item[0]),
    )
    growth: list[str] = []
    for key, count in entries:
        scope, namespace, code = key
        baseline = ENUM_ANOMALY_BASELINES.get(key, 0)
        status = "info" if count <= baseline else "MISMATCH"
        print(
            f"    {status:8s} {scope} namespace={namespace} code={code}: "
            f"{count:,} records (baseline {baseline:,})"
        )
        if count > baseline:
            growth.append(
                f"{scope}[namespace={namespace},code={code}] "
                f"+{count - baseline}"
            )
    if growth:
        raise RuntimeError(
            "enum anomaly baseline exceeded: " + ", ".join(growth)
        )


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
            try:
                revision = validate_mapping_snapshot()
            except ValueError as error:
                sys.exit(
                    "--offline requires a verified mapping snapshot: "
                    f"{error}; run once without --offline to refresh it"
                )
            print(
                "[阶段 0] mappings: --offline, using verified "
                f"bangumi/common revision {revision}"
            )
        else:
            print("[阶段 0] refresh enum mappings from bangumi/common")
            fetch_mappings()
        print("[阶段 1] jsonlines -> parquet")
        for name, n in build_parquet().items():
            print(f"  {name}: {n:,} rows")
        report_unknown_codes()
        # parquet 记录来源 dump 版本,供 --skip-parquet 护栏比对
        dump_ver = DUMP / "VERSION"
        if dump_ver.exists():
            (PARQUET / "VERSION").write_text(dump_ver.read_text())
    else:
        # 护栏:--skip-parquet 复用旧 parquet,版本与当前 dump 不一致
        # 会建出口径漂移的库
        dump_ver = DUMP / "VERSION"
        pq_ver = PARQUET / "VERSION"
        if dump_ver.exists() and pq_ver.exists():
            if dump_ver.read_text() != pq_ver.read_text():
                sys.exit(
                    f"--skip-parquet 版本不匹配:dump="
                    f"{dump_ver.read_text().strip()} vs parquet="
                    f"{pq_ver.read_text().strip()};去掉 --skip-parquet 重建"
                )
        else:
            sys.exit(
                "--skip-parquet 缺 VERSION 标记,无法核对 parquet 与 dump "
                "是否同版本;去掉 --skip-parquet 重建"
            )
    print("[阶段 2] parquet -> ladybug db")
    build_db()
    print(f"done in {time.time() - t0:.0f}s -> {DB_PATH}")
