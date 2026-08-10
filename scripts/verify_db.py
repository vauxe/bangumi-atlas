"""Verify db/bangumi.lb against the source dump and import artifacts.

The source pass independently recounts live rows and dangling references.
The content pass then streams every Parquet and LadybugDB row through an
order-independent, duplicate-sensitive fingerprint, so equal counts cannot
hide changed properties, duplicated rows, or wrong endpoints. Any mismatch
exits non-zero.
"""

import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import ladybug as lb
import orjson
import pyarrow.parquet as pq

from . import parquet_provenance, source_projection
from .build_lock import parquet_layout_lock
from .content_fingerprint import RowFingerprint

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
DUMP_ZIP = ROOT / "data" / "dump.zip"
MAPPINGS = ROOT / "data" / "mappings"
DB_PATH = ROOT / "db" / "bangumi.lb"
PARQUET = ROOT / "data" / "parquet"

NODE_TABLES = {
    "Subject": "subject",
    "Person": "person",
    "Character": "character",
    "Episode": "episode",
}
EDGE_TABLES = {
    "RELATES_TO": ("relates_to", "Subject", "Subject"),
    "WORKED_ON": ("worked_on", "Person", "Subject"),
    "APPEARS_IN": ("appears_in", "Character", "Subject"),
    "VOICED": ("voiced", "Person", "Character"),
    "EPISODE_OF": ("episode_of", "Episode", "Subject"),
    "PERSON_REL": ("person_rel", "Person", "Person"),
    "CHARACTER_REL": ("character_rel", "Character", "Character"),
}

failures: list[str] = []

# Official node/episode contracts:
# https://bangumi.github.io/api/dist.json
# https://github.com/bangumi/Archive/blob/master/README.md
# Relationship contracts:
# https://github.com/bangumi/common/blob/master/person_relations.yml
SOURCE_ENUM_CONTRACTS = (
    ("subject", "type", "Subject.type", frozenset({1, 2, 3, 4, 6})),
    ("person", "type", "Person.type", frozenset({1, 2, 3})),
    ("character", "role", "Character.role", frozenset({1, 2, 3, 4})),
    ("episode", "type", "Episode.type", frozenset(range(7))),
    (
        "subject-characters",
        "type",
        "APPEARS_IN.type",
        frozenset(range(1, 7)),
    ),
    ("person-characters", "type", "VOICED.type", frozenset(range(7))),
)
ENUM_ANOMALY_BASELINES: dict[tuple[str, int | None], int] = {
    # Archive 中保留的历史脏记录 id=22, type=0. 预算绑定具体码，
    # 不能让一个已消失的旧码替另一个新码腾出名额。
    ("Person.type", 0): 1,
}


def check(label: str, expected: int, actual: int) -> None:
    ok = expected == actual
    if not ok:
        failures.append(label)
    print(
        f"  {'ok' if ok else 'MISMATCH':8s} {label}: "
        f"expected {expected:,}, got {actual:,}"
    )


def check_true(label: str, ok: bool) -> None:
    if not ok:
        failures.append(label)
    print(f"  {'ok' if ok else 'MISMATCH':8s} {label}")


def ids_of(name: str) -> set[int]:
    return {r["id"] for r in rows(name)}


def rows(name: str) -> Iterator[dict[str, Any]]:
    with open(DUMP / f"{name}.jsonlines", "rb") as f:
        for line in f:
            yield orjson.loads(line)


def source_enum_anomalies() -> dict[str, Counter[int | None]]:
    anomalies: dict[str, Counter[int | None]] = {}
    for source, field, label, allowed in SOURCE_ENUM_CONTRACTS:
        counts = Counter(
            record.get(field)
            for record in rows(source)
            if record.get(field) not in allowed
        )
        if counts:
            anomalies[label] = counts
    return anomalies


def enum_anomaly_growth(
    anomalies: dict[str, Counter[int | None]],
) -> dict[str, int]:
    return {
        f"{label} code={code}": count
        - ENUM_ANOMALY_BASELINES.get((label, code), 0)
        for label, counts in anomalies.items()
        for code, count in counts.items()
        if count > ENUM_ANOMALY_BASELINES.get((label, code), 0)
    }


def query_fingerprint(conn: lb.Connection, query: str) -> RowFingerprint:
    result = cast(lb.QueryResult, conn.execute(query))
    fingerprint = RowFingerprint()
    while result.has_next():
        # stub says get_next() yields a dict; at runtime it is a list
        fingerprint.add(cast("list[Any]", result.get_next()))
    return fingerprint


def content_queries() -> Iterator[tuple[str, str, str]]:
    """Yield (database table, parquet file, projection query)."""

    for table, parquet_name in NODE_TABLES.items():
        columns = pq.read_schema(PARQUET / f"{parquet_name}.parquet").names
        projection = ",".join(f"n.{column}" for column in columns)
        yield table, parquet_name, f"MATCH (n:{table}) RETURN {projection}"
    for table, (parquet_name, source, target) in EDGE_TABLES.items():
        columns = pq.read_schema(PARQUET / f"{parquet_name}.parquet").names
        if columns[:2] != ["from_id", "to_id"]:
            raise ValueError(
                f"{parquet_name}.parquet must start with from_id,to_id"
            )
        properties = ",".join(f"r.{column}" for column in columns[2:])
        projection = "a.id,b.id" + (f",{properties}" if properties else "")
        yield (
            table,
            parquet_name,
            f"MATCH (a:{source})-[r:{table}]->(b:{target}) "
            f"RETURN {projection}",
        )


def _verify() -> None:
    failures.clear()
    print("[1/5] exact generation + raw-to-Parquet semantics")
    generation = parquet_provenance.require_valid_generation(
        dump=DUMP,
        dump_zip=DUMP_ZIP,
        mappings=MAPPINGS,
        parquet=PARQUET,
    )
    projection_fingerprints = source_projection.require_projection_matches(
        dump=DUMP,
        mappings=MAPPINGS,
        parquet=PARQUET,
    )
    recorded_fingerprints = generation["semantic"]["raw_projection"]
    for table in source_projection.PROJECTED_FILES:
        check_true(
            f"{table} generation semantic fingerprint",
            tuple(recorded_fingerprints[table])
            == projection_fingerprints[table],
        )

    db = lb.Database(str(DB_PATH), read_only=True)
    conn = lb.Connection(db)

    def count(query: str) -> int:
        res = cast(lb.QueryResult, conn.execute(query))
        # stub says get_next() yields a dict; at runtime it is a list
        return cast("list[Any]", res.get_next())[0]

    print("[2/5] entity counts")
    subject_ids = ids_of("subject")
    person_ids = ids_of("person")
    character_ids = ids_of("character")
    check(
        "Subject", len(subject_ids), count("MATCH (n:Subject) RETURN count(n)")
    )
    check("Person", len(person_ids), count("MATCH (n:Person) RETURN count(n)"))
    check(
        "Character",
        len(character_ids),
        count("MATCH (n:Character) RETURN count(n)"),
    )
    # Episode 与 build 同口径:主键去重后计数(上游重复 id 只入库一条)
    episode_seen: set[int] = set()
    episode_of_live = 0
    for r in rows("episode"):
        if r["id"] in episode_seen:
            continue
        episode_seen.add(r["id"])
        if r["subject_id"] in subject_ids:
            episode_of_live += 1
    check(
        "Episode",
        len(episode_seen),
        count("MATCH (n:Episode) RETURN count(n)"),
    )

    print(
        "[3/5] edge counts (source rows minus dangling, recounted "
        "independently)"
    )

    def live(name: str, *id_fields: str) -> int:
        pools: dict[str, set[int]] = {
            "subject_id": subject_ids,
            "related_subject_id": subject_ids,
            "person_id": person_ids,
            "character_id": character_ids,
        }
        return sum(
            1 for r in rows(name) if all(r[f] in pools[f] for f in id_fields)
        )

    check(
        "EPISODE_OF",
        episode_of_live,
        count("MATCH ()-[e:EPISODE_OF]->() RETURN count(e)"),
    )
    check(
        "RELATES_TO",
        live("subject-relations", "subject_id", "related_subject_id"),
        count("MATCH ()-[e:RELATES_TO]->() RETURN count(e)"),
    )
    check(
        "WORKED_ON",
        live("subject-persons", "person_id", "subject_id"),
        count("MATCH ()-[e:WORKED_ON]->() RETURN count(e)"),
    )
    check(
        "APPEARS_IN",
        live("subject-characters", "character_id", "subject_id"),
        count("MATCH ()-[e:APPEARS_IN]->() RETURN count(e)"),
    )
    check(
        "VOICED",
        live("person-characters", "person_id", "character_id"),
        count("MATCH ()-[e:VOICED]->() RETURN count(e)"),
    )
    # person-relations 按 person_type 分池减悬空；未知类型无法映射到
    # 固定端点表，必须阻断而不是生成不完整投影。
    rel_live = {"prsn": 0, "crt": 0}
    rel_skipped = 0
    unsupported_kinds: set[str] = set()
    for r in rows("person-relations"):
        kind = r["person_type"]
        pool = {"prsn": person_ids, "crt": character_ids}.get(kind)
        if pool is None:
            rel_skipped += 1
            unsupported_kinds.add(str(kind))
            continue
        if r["person_id"] in pool and r["related_person_id"] in pool:
            rel_live[kind] += 1
    if rel_skipped:
        failures.append("person-relations unsupported person_type")
        print(
            f"  MISMATCH person-relations: {rel_skipped:,} rows have "
            "unsupported person_type "
            f"({', '.join(sorted(unsupported_kinds))})"
        )
    check(
        "PERSON_REL",
        rel_live["prsn"],
        count("MATCH ()-[e:PERSON_REL]->() RETURN count(e)"),
    )
    check(
        "CHARACTER_REL",
        rel_live["crt"],
        count("MATCH ()-[e:CHARACTER_REL]->() RETURN count(e)"),
    )

    print("[4/5] decode coverage + smoke queries")
    enum_anomalies = source_enum_anomalies()
    enum_growth = enum_anomaly_growth(enum_anomalies)
    for _, _, label, _ in SOURCE_ENUM_CONTRACTS:
        counts = enum_anomalies.get(label, Counter())
        total = sum(counts.values())
        baseline = sum(
            count
            for (baseline_label, _code), count in (
                ENUM_ANOMALY_BASELINES.items()
            )
            if baseline_label == label
        )
        label_growth = {
            key: count
            for key, count in enum_growth.items()
            if key.startswith(f"{label} code=")
        }
        if total == 0:
            level = "ok"
        elif not label_growth:
            level = "info"
        else:
            level = "MISMATCH"
            failures.extend(
                f"{key} enum anomaly growth" for key in label_growth
            )
        details = ", ".join(
            f"{code}={count:,}"
            for code, count in sorted(
                counts.items(), key=lambda item: str(item[0])
            )
        )
        suffix = f"; codes {details}" if details else ""
        print(
            f"  {level:8s} {label} outside contract: {total:,} "
            f"(baseline {baseline}{suffix})"
        )
    # 全部解码列的失配量；超过显式基线说明映射表可能陈旧。
    baselines = {
        ("RELATES_TO", "relation"): 6,  # 上游已删的历史码
        ("WORKED_ON", "position_cn"): 0,
        ("APPEARS_IN", "role_cn"): 0,
        ("PERSON_REL", "relation"): 0,
        ("CHARACTER_REL", "relation"): 0,
    }
    for (table, col), baseline in baselines.items():
        undecoded = count(
            f"MATCH ()-[r:{table}]->() WHERE r.{col} = '' RETURN count(r)"
        )
        if undecoded <= baseline:
            level = "info"
        else:
            level = "MISMATCH"
            failures.append(f"{table}.{col} undecoded growth")
        print(
            f"  {level:8s} {table}.{col} undecoded: {undecoded:,} "
            f"(baseline {baseline}; growth means stale mappings)"
        )
    collab = count(
        "MATCH (:Person {name:'宮崎駿'})-[:WORKED_ON]->(s:Subject)"
        "<-[:WORKED_ON]-(:Person {name:'久石譲'}) "
        "RETURN count(DISTINCT s.id)"
    )
    check_true("宮崎駿 x 久石譲 collaborations > 0", collab > 0)

    print("[5/5] full-content fingerprints (Parquet -> LadybugDB)")
    for table, _parquet_name, query in content_queries():
        expected = projection_fingerprints[table]
        actual = query_fingerprint(conn, query).snapshot()
        ok = expected == actual
        if not ok:
            failures.append(f"{table} content")
        print(
            f"  {'ok' if ok else 'MISMATCH':8s} {table}: "
            f"rows={actual[0]:,}, sum={actual[1][:12]}, xor={actual[2][:12]}"
        )
        if not ok:
            print(
                f"           expected rows={expected[0]:,}, "
                f"sum={expected[1]}, xor={expected[2]}"
            )
            print(
                f"           actual   rows={actual[0]:,}, "
                f"sum={actual[1]}, xor={actual[2]}"
            )

    conn.close()
    db.close()
    if failures:
        sys.exit(f"FAILED: {len(failures)} mismatch(es): {failures}")
    print("all checks passed")


def main() -> None:
    with parquet_layout_lock(PARQUET):
        _verify()


if __name__ == "__main__":
    main()
