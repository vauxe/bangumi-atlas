"""Verify db/bangumi.lb against the source dump.

Independent row-level reconciliation: recounts source lines and dangling
references straight from data/dump/ (not trusting the build's own
output), asserts every row is either in the database or accounted for
as a dangling reference, then runs smoke queries. Exits non-zero on any
mismatch.
"""

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import ladybug as lb
import orjson

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "data" / "dump"
DB_PATH = ROOT / "db" / "bangumi.lb"

failures: list[str] = []


def check(label: str, expected: int, actual: int) -> None:
    ok = expected == actual
    if not ok:
        failures.append(label)
    print(
        f"  {'ok' if ok else 'MISMATCH':8s} {label}: "
        f"expected {expected:,}, got {actual:,}"
    )


def ids_of(name: str) -> set[int]:
    return {r["id"] for r in rows(name)}


def rows(name: str) -> Iterator[dict[str, Any]]:
    with open(DUMP / f"{name}.jsonlines", "rb") as f:
        for line in f:
            yield orjson.loads(line)


def main() -> None:
    db = lb.Database(str(DB_PATH), read_only=True)
    conn = lb.Connection(db)

    def count(query: str) -> int:
        res = conn.execute(query)
        assert isinstance(res, lb.QueryResult)
        # stub says get_next() yields a dict; at runtime it is a list
        return cast("list[Any]", res.get_next())[0]

    print("[1/3] entity counts")
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
    check(
        "Episode",
        sum(1 for _ in rows("episode")),
        count("MATCH (n:Episode) RETURN count(n)"),
    )

    print(
        "[2/3] edge counts (source rows minus dangling, recounted "
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
        live("episode", "subject_id"),
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
    check(
        "PERSON_REL + CHARACTER_REL",
        sum(1 for _ in rows("person-relations")),
        count("MATCH ()-[e:PERSON_REL]->() RETURN count(e)")
        + count("MATCH ()-[e:CHARACTER_REL]->() RETURN count(e)"),
    )

    print("[3/3] smoke queries")
    undecoded = count(
        "MATCH ()-[r:RELATES_TO]->() WHERE r.relation = '' RETURN count(r)"
    )
    print(
        f"  info     RELATES_TO with empty relation: {undecoded} "
        f"(baseline 6; growth means stale mappings)"
    )
    collab = count(
        "MATCH (:Person {name:'宮崎駿'})-[:WORKED_ON]->(s:Subject)"
        "<-[:WORKED_ON]-(:Person {name:'久石譲'}) "
        "RETURN count(DISTINCT s.id)"
    )
    check("宮崎駿 x 久石譲 collaborations > 0", True, collab > 0)

    conn.close()
    db.close()
    if failures:
        sys.exit(f"FAILED: {len(failures)} mismatch(es): {failures}")
    print("all checks passed")


if __name__ == "__main__":
    main()
