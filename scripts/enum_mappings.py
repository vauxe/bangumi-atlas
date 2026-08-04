"""Fetch and validate versioned enum snapshots from bangumi/common."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

import yaml

MAPPING_FILES = (
    "subject_relations",
    "subject_staffs",
    "person_relations",
    "subject_platforms",
)
MAPPING_FILENAMES = tuple(f"{name}.yml" for name in MAPPING_FILES)
MAPPING_SOURCE = "https://github.com/bangumi/common"
MAPPING_REVISION_URL = (
    "https://api.github.com/repos/bangumi/common/commits/master"
)
MAPPING_URL = (
    "https://raw.githubusercontent.com/bangumi/common/{revision}/{name}.yml"
)
MAPPING_MANIFEST = "manifest.json"
MAPPING_ROOT_KEYS = {
    "subject_relations": "relations",
    "subject_staffs": "staffs",
    "person_relations": "relations",
    "subject_platforms": "platforms",
}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")

EnumNamespace = dict[Any, dict[str, Any]]
EnumMap = dict[Any, EnumNamespace]
MappingTables = tuple[EnumMap, EnumMap, EnumMap, EnumMap, EnumNamespace]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_mapping(name: str, data: bytes) -> dict[str, Any]:
    try:
        document = yaml.safe_load(data)
    except yaml.YAMLError as error:
        raise ValueError(f"{name}.yml is invalid YAML: {error}") from error
    root = MAPPING_ROOT_KEYS[name]
    if not isinstance(document, dict) or not isinstance(
        document.get(root), dict
    ):
        raise ValueError(f"{name}.yml must contain an object at {root!r}")
    return document


def _download(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "bangumi-atlas enum snapshot builder"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def _mapping_manifest(
    revision: str, files: dict[str, bytes]
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "source": MAPPING_SOURCE,
        "revision": revision,
        "files": {name: _sha256(data) for name, data in sorted(files.items())},
    }


def validate_mapping_snapshot(mappings: Path) -> str:
    """Validate snapshot provenance and content; return the upstream commit."""

    manifest_path = mappings / MAPPING_MANIFEST
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {MAPPING_MANIFEST}: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError(f"{MAPPING_MANIFEST} has unsupported schema")
    if manifest.get("source") != MAPPING_SOURCE:
        raise ValueError(f"{MAPPING_MANIFEST} has unexpected source")
    revision = manifest.get("revision")
    if (
        not isinstance(revision, str)
        or SHA_PATTERN.fullmatch(revision) is None
    ):
        raise ValueError(f"{MAPPING_MANIFEST} has invalid revision")
    digests = manifest.get("files")
    if not isinstance(digests, dict) or set(digests) != set(MAPPING_FILENAMES):
        raise ValueError(
            f"{MAPPING_MANIFEST} does not list the exact mapping set"
        )
    for name in MAPPING_FILES:
        filename = f"{name}.yml"
        expected = digests[filename]
        if (
            not isinstance(expected, str)
            or SHA256_PATTERN.fullmatch(expected) is None
        ):
            raise ValueError(
                f"{filename} has invalid digest in {MAPPING_MANIFEST}"
            )
        try:
            data = (mappings / filename).read_bytes()
        except OSError as error:
            raise ValueError(f"cannot read {filename}: {error}") from error
        if _sha256(data) != expected:
            raise ValueError(f"{filename} digest mismatch")
        _parse_mapping(name, data)
    return revision


def fetch_mappings(mappings: Path) -> str:
    """Atomically refresh a commit-consistent bangumi/common snapshot.

    If the network is unavailable, only a locally verified snapshot may be
    reused. The manifest is replaced last so an interrupted refresh cannot be
    mistaken for a valid snapshot.
    """

    mappings.mkdir(parents=True, exist_ok=True)
    try:
        revision_document = json.loads(_download(MAPPING_REVISION_URL))
        if not isinstance(revision_document, dict):
            raise ValueError("bangumi/common returned an invalid response")
        revision = revision_document.get("sha")
        if (
            not isinstance(revision, str)
            or SHA_PATTERN.fullmatch(revision) is None
        ):
            raise ValueError("bangumi/common returned an invalid revision")
        files = {}
        for name in MAPPING_FILES:
            data = _download(MAPPING_URL.format(revision=revision, name=name))
            _parse_mapping(name, data)
            files[f"{name}.yml"] = data
    except (OSError, json.JSONDecodeError, ValueError) as error:
        try:
            local_revision = validate_mapping_snapshot(mappings)
        except ValueError as local_error:
            sys.exit(
                "mapping refresh failed and the local snapshot is invalid: "
                f"{error}; {local_error}"
            )
        print(
            "  mapping refresh failed "
            f"({error}), using verified revision {local_revision}"
        )
        return local_revision

    changed = {
        name: not (mappings / name).exists()
        or (mappings / name).read_bytes() != data
        for name, data in files.items()
    }
    manifest = _mapping_manifest(revision, files)
    with tempfile.TemporaryDirectory(
        prefix=".mapping-refresh-", dir=mappings
    ) as directory:
        staging = Path(directory)
        for name, data in files.items():
            (staging / name).write_bytes(data)
        (staging / MAPPING_MANIFEST).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        for name in MAPPING_FILENAMES:
            (staging / name).replace(mappings / name)
        (staging / MAPPING_MANIFEST).replace(mappings / MAPPING_MANIFEST)
    for name in MAPPING_FILENAMES:
        print(f"  {name}: {'updated' if changed[name] else 'unchanged'}")
    print(f"  verified bangumi/common revision: {revision}")
    return revision


def load_mappings(mappings: Path) -> MappingTables:
    validate_mapping_snapshot(mappings)

    def load(name: str) -> dict[str, Any]:
        return _parse_mapping(name, (mappings / f"{name}.yml").read_bytes())

    relations = load("subject_relations")["relations"]
    staffs = load("subject_staffs")["staffs"]
    platforms = load("subject_platforms")["platforms"]
    person_relations = load("person_relations")["relations"]
    voice_roles = person_relations["prsn_cv"]
    # Cross-media edges can carry codes from the target type's namespace.
    relations["*"] = {
        key: value
        for mapping in relations.values()
        for key, value in mapping.items()
    }
    staffs["*"] = {
        key: value
        for mapping in staffs.values()
        for key, value in mapping.items()
    }
    return relations, staffs, platforms, person_relations, voice_roles
