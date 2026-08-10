"""Content-bound identity for one complete Parquet projection generation."""

from __future__ import annotations

import hashlib
import platform
import sys
import zipfile
from pathlib import Path
from typing import IO, Any

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import yaml

from . import entity_key as ek
from .build_lock import PARQUET_BUILD_MARKER
from .enum_mappings import MAPPING_FILENAMES, validate_mapping_snapshot

GENERATION_MANIFEST = "generation.json"
GENERATION_FORMAT = "parquet-generation-v1"
PROJECTION_ORACLE_FORMAT = "raw-projection-oracle-v1"
PROJECTION_ORACLE_PATH = Path(__file__).with_name("source_projection.py")
PROJECTION_ORACLE_DEPENDENCIES = {
    "content_fingerprint.py": Path(__file__).with_name(
        "content_fingerprint.py"
    ),
    "entity_key.py": Path(ek.__file__),
    "enum_mappings.py": Path(__file__).with_name("enum_mappings.py"),
}

JSONL_NAMES = (
    "subject",
    "person",
    "character",
    "episode",
    "subject-relations",
    "subject-persons",
    "subject-characters",
    "person-characters",
    "person-relations",
)

PARQUET_TABLES = {
    "Subject": "subject",
    "Person": "person",
    "Character": "character",
    "Episode": "episode",
    "RELATES_TO": "relates_to",
    "WORKED_ON": "worked_on",
    "APPEARS_IN": "appears_in",
    "VOICED": "voiced",
    "EPISODE_OF": "episode_of",
    "PERSON_REL": "person_rel",
    "CHARACTER_REL": "character_rel",
}


def _require_exact_jsonl_set(dump: Path) -> None:
    expected = {f"{name}.jsonlines" for name in JSONL_NAMES}
    actual = {path.name for path in dump.glob("*.jsonlines")}
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise ValueError(
            "dump must contain the exact modelled JSONL set; "
            f"missing={missing}, unexpected JSONL={unexpected}"
        )


def _canonical_json(value: Any) -> bytes:
    return orjson.dumps(value, option=orjson.OPT_SORT_KEYS)


def _manifest_version(body: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(body)).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            while chunk := stream.read(1 << 20):
                digest.update(chunk)
    except OSError as error:
        raise ValueError(
            f"cannot read required artifact {path}: {error}"
        ) from error
    return digest.hexdigest()


def _file_identity(path: Path) -> dict[str, int | str]:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise ValueError(
            f"cannot stat required artifact {path}: {error}"
        ) from error
    return {"bytes": size, "sha256": _sha256_file(path)}


def _stream_jsonl_identity(
    stream: IO[bytes],
    *,
    label: str,
    expected_bytes: int | None = None,
) -> dict[str, int | str]:
    digest = hashlib.sha256()
    size = 0
    rows = 0
    for line in stream:
        digest.update(line)
        size += len(line)
        rows += 1
        if expected_bytes is not None and size > expected_bytes:
            raise ValueError(
                f"{label} expands beyond the extracted JSONL size"
            )
    return {"bytes": size, "sha256": digest.hexdigest(), "rows": rows}


def _jsonl_identity(path: Path) -> dict[str, int | str]:
    try:
        with path.open("rb") as stream:
            return _stream_jsonl_identity(stream, label=str(path))
    except OSError as error:
        raise ValueError(
            f"cannot read required JSONL {path}: {error}"
        ) from error


def _require_archive_matches_jsonl(
    dump_zip: Path,
    extracted: dict[str, dict[str, int | str]],
) -> None:
    """Prove that every extracted JSONL byte came from this exact archive."""

    expected_names = {f"{name}.jsonlines" for name in JSONL_NAMES}
    try:
        with zipfile.ZipFile(dump_zip) as archive:
            members = archive.infolist()
            names = [member.filename for member in members]
            if (
                len(names) != len(expected_names)
                or set(names) != expected_names
            ):
                raise ValueError(
                    "dump.zip archive JSONL set must be exactly the nine "
                    f"modelled files; got {names}"
                )
            for member in members:
                expected = extracted[member.filename]
                expected_size = int(expected["bytes"])
                if member.is_dir() or member.file_size != expected_size:
                    raise ValueError(
                        f"{member.filename} does not match dump.zip"
                    )
                with archive.open(member) as stream:
                    actual = _stream_jsonl_identity(
                        stream,
                        label=f"dump.zip:{member.filename}",
                        expected_bytes=expected_size,
                    )
                if actual != expected:
                    raise ValueError(
                        f"{member.filename} does not match dump.zip"
                    )
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        raise ValueError(f"cannot verify dump.zip members: {error}") from error


def _schema_identity(schema: pa.Schema) -> dict[str, Any]:
    fields = [
        {
            "name": field.name,
            "type": str(field.type),
            "nullable": field.nullable,
        }
        for field in schema
    ]
    return {
        "fields": fields,
        "sha256": hashlib.sha256(schema.serialize().to_pybytes()).hexdigest(),
    }


def _parquet_identity(
    path: Path,
    file_identity: dict[str, int | str] | None = None,
) -> dict[str, Any]:
    identity = file_identity or _file_identity(path)
    try:
        parquet = pq.ParquetFile(path)
    except (OSError, ValueError) as error:
        raise ValueError(
            f"cannot read required Parquet {path}: {error}"
        ) from error
    return {
        **identity,
        "rows": parquet.metadata.num_rows,
        "schema": _schema_identity(parquet.schema_arrow),
    }


def _dump_version(dump: Path) -> str:
    path = dump / "VERSION"
    try:
        version = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ValueError(
            f"cannot read required dump VERSION: {error}"
        ) from error
    if not version:
        raise ValueError("dump VERSION is missing or empty")
    return version


def _mapping_identity(mappings: Path) -> dict[str, Any]:
    revision = validate_mapping_snapshot(mappings)
    return {
        "revision": revision,
        "manifest": _file_identity(mappings / "manifest.json"),
        "files": {
            name: _file_identity(mappings / name) for name in MAPPING_FILENAMES
        },
    }


def _projection_oracle_identity() -> dict[str, Any]:
    body = {
        "format": PROJECTION_ORACLE_FORMAT,
        "files": {
            "source_projection.py": _sha256_file(PROJECTION_ORACLE_PATH),
            **{
                name: _sha256_file(path)
                for name, path in sorted(
                    PROJECTION_ORACLE_DEPENDENCIES.items()
                )
            },
        },
        "runtime": {
            "python": platform.python_implementation()
            + " "
            + ".".join(str(part) for part in sys.version_info[:3]),
            "orjson": orjson.__version__,
            "pyarrow": pa.__version__,
            "pyyaml": yaml.__version__,
        },
        "entity_key": {
            "format": ek.ENTITY_KEY_FORMAT,
            "kinds": list(ek.KINDS),
            "max_source_id": ek.MAX_SOURCE_ID,
        },
    }
    return {
        **body,
        "sha256": hashlib.sha256(_canonical_json(body)).hexdigest(),
    }


def _validated_projected_rows(
    projected_rows: dict[str, int],
) -> dict[str, int]:
    if set(projected_rows) != set(PARQUET_TABLES):
        missing = sorted(set(PARQUET_TABLES) - set(projected_rows))
        extra = sorted(set(projected_rows) - set(PARQUET_TABLES))
        raise ValueError(
            "projected row counts must cover the exact Parquet table set; "
            f"missing={missing}, extra={extra}"
        )
    if any(
        type(count) is not int or count < 0
        for count in projected_rows.values()
    ):
        raise ValueError("projected row counts must be non-negative integers")
    return {table: projected_rows[table] for table in PARQUET_TABLES}


def _row_accounting(
    raw_rows: dict[str, int], projected: dict[str, int]
) -> dict[str, dict[str, int]]:
    duplicates = {
        "subject": raw_rows["subject"] - projected["Subject"],
        "person": raw_rows["person"] - projected["Person"],
        "character": raw_rows["character"] - projected["Character"],
        "episode": raw_rows["episode"] - projected["Episode"],
    }
    filtered = {
        "subject-relations": (
            raw_rows["subject-relations"] - projected["RELATES_TO"]
        ),
        "subject-persons": (
            raw_rows["subject-persons"] - projected["WORKED_ON"]
        ),
        "subject-characters": (
            raw_rows["subject-characters"] - projected["APPEARS_IN"]
        ),
        "person-characters": (
            raw_rows["person-characters"] - projected["VOICED"]
        ),
        "person-relations": (
            raw_rows["person-relations"]
            - projected["PERSON_REL"]
            - projected["CHARACTER_REL"]
        ),
    }
    retained = {
        "orphan_episode_nodes": (
            projected["Episode"] - projected["EPISODE_OF"]
        )
    }
    all_deltas = (*duplicates.values(), *filtered.values(), *retained.values())
    if any(value < 0 for value in all_deltas):
        raise ValueError(
            "projected row counts are inconsistent with raw row accounting"
        )
    return {
        "duplicates": duplicates,
        "filtered": filtered,
        "retained": retained,
    }


def _validated_projection_fingerprints(
    value: Any,
    projected: dict[str, int],
) -> dict[str, list[int | str]]:
    if not isinstance(value, dict) or set(value) != set(PARQUET_TABLES):
        raise ValueError(
            "semantic fingerprints must cover the exact Parquet table set"
        )
    validated: dict[str, list[int | str]] = {}
    for table in PARQUET_TABLES:
        fingerprint = value[table]
        if not isinstance(fingerprint, (list, tuple)) or len(fingerprint) != 3:
            raise ValueError(f"{table}: invalid semantic fingerprint")
        count, total, xor = fingerprint
        if type(count) is not int or count != projected[table]:
            raise ValueError(f"{table}: semantic fingerprint row mismatch")
        if any(
            not isinstance(digest, str)
            or len(digest) != 32
            or any(char not in "0123456789abcdef" for char in digest)
            for digest in (total, xor)
        ):
            raise ValueError(f"{table}: invalid semantic fingerprint digest")
        validated[table] = [count, total, xor]
    return validated


def _generation_body(
    *,
    dump: Path,
    dump_zip: Path,
    mappings: Path,
    parquet: Path,
    projected_rows: dict[str, int],
    projection_fingerprints: dict[str, tuple[int, str, str]],
) -> dict[str, Any]:
    projected = _validated_projected_rows(projected_rows)
    _require_exact_jsonl_set(dump)
    jsonl = {
        f"{name}.jsonlines": _jsonl_identity(dump / f"{name}.jsonlines")
        for name in JSONL_NAMES
    }
    _require_archive_matches_jsonl(dump_zip, jsonl)
    raw_rows = {
        name: int(jsonl[f"{name}.jsonlines"]["rows"]) for name in JSONL_NAMES
    }
    parquet_files = {
        f"{stem}.parquet": _parquet_identity(parquet / f"{stem}.parquet")
        for stem in PARQUET_TABLES.values()
    }
    actual_rows = {
        table: int(parquet_files[f"{stem}.parquet"]["rows"])
        for table, stem in PARQUET_TABLES.items()
    }
    if actual_rows != projected:
        raise ValueError(
            "reported projected row counts do not match Parquet metadata"
        )
    return {
        "format": GENERATION_FORMAT,
        "source": {
            "dump_version": _dump_version(dump),
            "archive": _file_identity(dump_zip),
            "jsonl": jsonl,
        },
        "mappings": _mapping_identity(mappings),
        "parquet": parquet_files,
        "rows": {
            "raw": raw_rows,
            "projected": projected,
            "accounting": _row_accounting(raw_rows, projected),
        },
        "semantic": {
            "oracle": _projection_oracle_identity(),
            "raw_projection": _validated_projection_fingerprints(
                projection_fingerprints, projected
            ),
        },
    }


def publish_generation(
    *,
    dump: Path,
    dump_zip: Path,
    mappings: Path,
    parquet: Path,
    projected_rows: dict[str, int],
    projection_fingerprints: dict[str, tuple[int, str, str]],
) -> dict[str, Any]:
    """Publish VERSION then the manifest; callers remove the marker last."""

    body = _generation_body(
        dump=dump,
        dump_zip=dump_zip,
        mappings=mappings,
        parquet=parquet,
        projected_rows=projected_rows,
        projection_fingerprints=projection_fingerprints,
    )
    manifest = {"version": _manifest_version(body), **body}
    parquet.mkdir(parents=True, exist_ok=True)
    version_staging = parquet / ".VERSION.build"
    manifest_staging = parquet / f".{GENERATION_MANIFEST}.build"
    version_staging.unlink(missing_ok=True)
    manifest_staging.unlink(missing_ok=True)
    try:
        version_staging.write_text(
            f"{body['source']['dump_version']}\n", encoding="utf-8"
        )
        manifest_staging.write_bytes(_canonical_json(manifest))
        version_staging.replace(parquet / "VERSION")
        manifest_staging.replace(parquet / GENERATION_MANIFEST)
    finally:
        version_staging.unlink(missing_ok=True)
        manifest_staging.unlink(missing_ok=True)
    return manifest


def _require_identity(
    label: str,
    expected: Any,
    actual: Any,
) -> None:
    if not isinstance(expected, dict):
        raise ValueError(f"{label}: invalid identity in generation manifest")
    if expected.get("sha256") != actual.get("sha256"):
        raise ValueError(f"{label}: digest mismatch; rebuild Parquet")
    if expected != actual:
        raise ValueError(f"{label}: metadata mismatch; rebuild Parquet")


def require_valid_generation(
    *,
    dump: Path,
    dump_zip: Path,
    mappings: Path,
    parquet: Path,
) -> dict[str, Any]:
    """Require current archive, mappings, and Parquet from one generation."""

    marker = parquet / PARQUET_BUILD_MARKER
    if marker.exists():
        raise RuntimeError(
            f"Parquet generation is incomplete ({marker}); rerun build_db.py"
        )
    manifest_path = parquet / GENERATION_MANIFEST
    try:
        manifest = orjson.loads(manifest_path.read_bytes())
    except (OSError, orjson.JSONDecodeError) as error:
        raise ValueError(
            f"cannot read {GENERATION_MANIFEST}: {error}; rerun build_db.py"
        ) from error
    if not isinstance(manifest, dict):
        raise ValueError(f"{GENERATION_MANIFEST} must be an object")
    body = {key: value for key, value in manifest.items() if key != "version"}
    if manifest.get("version") != _manifest_version(body):
        raise ValueError(f"{GENERATION_MANIFEST}: version digest mismatch")
    if body.get("format") != GENERATION_FORMAT:
        raise ValueError(f"{GENERATION_MANIFEST}: unsupported format")

    source = body.get("source")
    if not isinstance(source, dict):
        raise ValueError(f"{GENERATION_MANIFEST}: invalid source section")
    current_version = _dump_version(dump)
    if source.get("dump_version") != current_version:
        raise ValueError(
            "Parquet dump version does not match the current dump; rebuild "
            "Parquet"
        )
    _require_identity(
        "dump.zip", source.get("archive"), _file_identity(dump_zip)
    )
    jsonl = source.get("jsonl")
    if not isinstance(jsonl, dict) or set(jsonl) != {
        f"{name}.jsonlines" for name in JSONL_NAMES
    }:
        raise ValueError(f"{GENERATION_MANIFEST}: invalid JSONL set")
    for filename, identity in jsonl.items():
        if (
            not isinstance(identity, dict)
            or set(identity) != {"bytes", "sha256", "rows"}
            or type(identity["bytes"]) is not int
            or identity["bytes"] < 0
            or type(identity["rows"]) is not int
            or identity["rows"] < 0
            or not isinstance(identity["sha256"], str)
            or len(identity["sha256"]) != 64
            or any(
                char not in "0123456789abcdef" for char in identity["sha256"]
            )
        ):
            raise ValueError(f"{filename}: invalid identity in generation")

    current_mappings = _mapping_identity(mappings)
    if body.get("mappings") != current_mappings:
        raise ValueError("mapping snapshot identity mismatch; rebuild Parquet")

    parquet_section = body.get("parquet")
    expected_files = {f"{stem}.parquet" for stem in PARQUET_TABLES.values()}
    if (
        not isinstance(parquet_section, dict)
        or set(parquet_section) != expected_files
    ):
        raise ValueError(f"{GENERATION_MANIFEST}: invalid Parquet file set")
    current_parquet: dict[str, dict[str, Any]] = {}
    for stem in PARQUET_TABLES.values():
        filename = f"{stem}.parquet"
        expected = parquet_section.get(filename)
        current_file = _file_identity(parquet / filename)
        if not isinstance(expected, dict):
            raise ValueError(
                f"{filename}: invalid identity in generation manifest"
            )
        if expected.get("sha256") != current_file["sha256"]:
            raise ValueError(f"{filename}: digest mismatch; rebuild Parquet")
        current = _parquet_identity(parquet / filename, current_file)
        current_parquet[filename] = current
        _require_identity(filename, expected, current)

    rows = body.get("rows")
    if not isinstance(rows, dict):
        raise ValueError(f"{GENERATION_MANIFEST}: invalid rows section")
    projected = _validated_projected_rows(rows.get("projected", {}))
    actual_projected = {
        table: int(current_parquet[f"{stem}.parquet"]["rows"])
        for table, stem in PARQUET_TABLES.items()
    }
    if projected != actual_projected:
        raise ValueError("Parquet row counts differ from generation manifest")
    raw_rows = {
        name: int(jsonl[f"{name}.jsonlines"]["rows"]) for name in JSONL_NAMES
    }
    if rows.get("raw") != raw_rows:
        raise ValueError("raw row counts differ from generation manifest")
    if rows.get("accounting") != _row_accounting(raw_rows, projected):
        raise ValueError("row accounting differs from generation manifest")
    semantic = body.get("semantic")
    if not isinstance(semantic, dict):
        raise ValueError(f"{GENERATION_MANIFEST}: invalid semantic section")
    if semantic.get("oracle") != _projection_oracle_identity():
        raise ValueError(
            "semantic oracle identity mismatch; rebuild and reverify Parquet"
        )
    _validated_projection_fingerprints(
        semantic.get("raw_projection"), projected
    )

    parquet_version = _dump_version(parquet)
    if parquet_version != current_version:
        raise ValueError("Parquet VERSION differs from generation manifest")
    return manifest
