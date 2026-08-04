"""structural-site-v1 SiteRelease 的格式契约。

烘焙器、独立验证器和契约测试共享本模块中的常量与规范编码;
磁盘元组布局的任何变更都必须同步更新 TUPLE_SCHEMAS(参与
manifest.schema_digest),否则跨端解码将失配。
设计文档:docs/STRUCTURAL_SITE_DATA_DESIGN.md。
"""

from __future__ import annotations

import gzip
import hashlib
from typing import Any

import orjson

SCHEMA = "structural-site-v1"
PROFILE = "explorer-v1"

# ---- EntityKey:kind << 24 | source_id ----
KIND_SUBJECT = 1
KIND_PERSON = 2
KIND_CHARACTER = 3
KINDS = (KIND_SUBJECT, KIND_PERSON, KIND_CHARACTER)
KIND_NAMES = {KIND_SUBJECT: "subject", KIND_PERSON: "person",
              KIND_CHARACTER: "character"}
MAX_SOURCE_ID = (1 << 24) - 1

# ---- u24 反向索引(VisualRank by EntityKey)----
RANK_SENTINEL = 0xFFFFFF
RANK_ENCODING = "u24le"

# ---- 成员与 pack 门禁(§9.4;256,000 是唯一自动细分触发值)----
MEMBER_CAP = 256_000
PACK_CAP = 80_000_000
SEARCH_LEAF_CAP = 64_000
SEARCH_TOP = 12
TEXT_P99_CAP = 75_000
NAME_P99_CAP = 64_000

# ---- explorer-v1 声明的初始分块与内联/分页参数(§5)----
NAME_BLOCK_SIZE = 2048
ENTITY_BLOCK_IDS = 256
EPISODE_BLOCK_SUBJECTS = 128
FACT_BUCKETS = 8192
FACT_INLINE = 200
EPISODE_INLINE = 200
PAGE_SIZE = 500
TEXT_BLOCK_IDS = {
    "entity-summary": 128,
    "entity-infobox": 256,
    "episode-description": 128,
    "fact-summary": 256,
}
GZIP_LEVELS = {
    "names": 6,
    "entities": 9,
    "episodes": 9,
    "facts": 6,
    "pages": 6,
    "search": 6,
    "vocab": 9,
    "entity-summary": 9,
    "entity-infobox": 9,
    "episode-description": 6,
    "fact-summary": 9,
}
TEXT_FAMILIES = (
    "entity-summary",
    "entity-infobox",
    "episode-description",
    "fact-summary",
)

# ---- 事实种类:角色顺序即参与者的规范顺序 ----
FACT_KINDS = (
    "RELATES_TO",
    "WORKED_ON",
    "APPEARS_IN",
    "VOICE_CREDIT",
    "PERSON_REL",
    "CHARACTER_REL",
)
FACT_TAGS = {
    "RELATES_TO": "R",
    "WORKED_ON": "W",
    "APPEARS_IN": "A",
    "VOICE_CREDIT": "V",
    "PERSON_REL": "P",
    "CHARACTER_REL": "C",
}
FACT_ROLES: dict[str, tuple[str, ...]] = {
    "RELATES_TO": ("source", "target"),
    "WORKED_ON": ("person", "subject"),
    "APPEARS_IN": ("character", "subject"),
    "VOICE_CREDIT": ("person", "character", "subject_context"),
    "PERSON_REL": ("source", "target"),
    "CHARACTER_REL": ("source", "target"),
}
# 属性顺序 = 磁盘元组尾部字段顺序;文本侧车字段以存在位表示
FACT_ATTRS: dict[str, tuple[str, ...]] = {
    "RELATES_TO": ("relation_type", "sort_order"),
    "WORKED_ON": ("position", "appear_eps"),
    "APPEARS_IN": ("type", "sort_order"),
    "VOICE_CREDIT": ("type", "has_summary"),
    "PERSON_REL": ("relation_type", "spoiler", "ended"),
    "CHARACTER_REL": ("relation_type", "spoiler", "ended"),
}

# 磁盘元组布局(参与 schema_digest;两端解码器的唯一权威)
TUPLE_SCHEMAS: dict[str, Any] = {
    "file": ["bytes", "sha256", "content_addressed_name"],
    "name": ["name", "name_cn|null"],
    "entity": {
        "subject": [
            "type", "platform_code|null", "date", "score|null",
            "bgm_rank|null", "nsfw01", "wish", "done", "doing",
            "on_hold", "dropped", "series01", "score_details[10]",
            "meta_tags[vocab]", "tags[[vocab,count]]",
            "has_summary01", "has_infobox01",
        ],
        "person": [
            "type", "career[vocab]", "comments", "collects",
            "has_summary01", "has_infobox01",
        ],
        "character": [
            "role", "comments", "collects",
            "has_summary01", "has_infobox01",
        ],
    },
    "episode": [
        "id", "name", "name_cn", "airdate", "disc", "duration",
        "sort|null", "type", "has_description01",
    ],
    "incidence": [
        "fact_ref", "multiplicity", "role_bits", "others[key]",
        "*attrs(FACT_ATTRS)",
    ],
    "fact_page_item": ["kind_tag", "*incidence"],
    "episode_group": {"e": "inline rows", "n": "total",
                      "op": "[offset,len] pages"},
    "fact_entry": {"g": "kind_tag -> inline incidences",
                   "n": "kind_tag -> total", "op": "[offset,len] pages"},
    "text_member": {"i": "identities", "t": "texts"},
    "episode_text_member": {"i": "subject_ids",
                            "t": "[[episode_id, text]]"},
    "search_entry": ["norm", "display", "rank"],
    "search_node": {
        "leaf": ["offset", "length"],
        "internal": ["top_offset", "top_length"],
    },
}


def canonical_json(value: Any) -> bytes:
    return orjson.dumps(
        value, option=orjson.OPT_NON_STR_KEYS | orjson.OPT_SORT_KEYS
    )


def gzip_member(value: Any, level: int) -> bytes:
    """可复现的独立 gzip 成员(mtime=0,键序规范)。"""
    return gzip.compress(canonical_json(value), compresslevel=level, mtime=0)


def require_member_size(
    member: bytes, label: str, cap: int = MEMBER_CAP
) -> None:
    """所有 gzip 成员共用的硬门禁；调用方可用更严格的族上限。"""
    if len(member) > cap:
        raise ValueError(
            f"{label}: gzip member {len(member):,} exceeds member cap "
            f"{cap:,}"
        )


def gzip_pages(
    rows: list[Any],
    level: int,
    max_rows: int,
    cap: int = MEMBER_CAP,
) -> list[bytes]:
    """按固定行数起步，超限时在行边界确定性二分 gzip 页。"""
    if max_rows <= 0 or cap <= 0:
        raise ValueError("gzip page limits must be positive")
    members: list[bytes] = []

    def emit(chunk: list[Any]) -> None:
        member = gzip_member(chunk, level)
        if len(member) > cap and len(chunk) > 1:
            mid = len(chunk) // 2
            emit(chunk[:mid])
            emit(chunk[mid:])
            return
        require_member_size(member, "paged rows", cap)
        members.append(member)

    for start in range(0, len(rows), max_rows):
        emit(rows[start : start + max_rows])
    return members


def published_object_name(logical_name: str, digest: str) -> str:
    """把逻辑产物名映射为不可变的完整 SHA-256 物理文件名。"""
    if "/" in logical_name or "\\" in logical_name:
        raise ValueError(
            "published artifacts must use a top-level logical name"
        )
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("published artifact digest must be lowercase SHA-256")
    return f"{digest}-{logical_name}"


def entity_key(kind: int, source_id: int) -> int:
    """EntityKey = kind << 24 | source_id;越界即格式升级,不截断。"""
    if kind not in KINDS:
        raise ValueError(f"unknown entity kind {kind}")
    if not 0 <= source_id <= MAX_SOURCE_ID:
        raise ValueError(
            f"source id {source_id} exceeds 24-bit EntityKey; "
            "upgrade the key format instead of truncating"
        )
    return (kind << 24) | source_id


def canonical_fact(
    kind: str, participants: tuple[int, ...], attrs: tuple[Any, ...]
) -> bytes:
    """事实的规范编码:种类 + 角色序参与者 + 全部语义属性。

    文本属性(如 VOICE_CREDIT.summary)也参与编码——仅文本不同
    的两行是两个事实,不能因侧车另存而合并。
    """
    if kind not in FACT_KINDS:
        raise ValueError(f"unknown fact kind {kind}")
    if len(participants) != len(FACT_ROLES[kind]):
        raise ValueError(f"{kind}: wrong participant count")
    return canonical_json([kind, list(participants), list(attrs)])


def incidence_tuple(
    fact_ref: int,
    multiplicity: int,
    key: int,
    participants: tuple[int, ...],
    attrs: tuple[Any, ...],
) -> list[Any]:
    """某参与者视角的 incidence 元组。

    role_bits 是该实体占据的角色位图(自环只存一条);others 按
    角色顺序保存其余参与者。补回桶键即可无损还原参与者序列:
    对每个置位角色放 key,未置位角色按序取 others。
    """
    role_bits = 0
    others: list[int] = []
    for i, p in enumerate(participants):
        if p == key:
            role_bits |= 1 << i
        else:
            others.append(p)
    if role_bits == 0:
        raise ValueError("incidence key is not a participant")
    return [fact_ref, multiplicity, role_bits, others, *attrs]


def participants_from_incidence(
    kind: str, key: int, role_bits: int, others: list[int]
) -> tuple[int, ...]:
    """还原角色序参与者(验证器与浏览器 Data 的共同解码规则)。"""
    n_roles = len(FACT_ROLES[kind])
    out: list[int] = []
    queue = list(others)
    for i in range(n_roles):
        if role_bits & (1 << i):
            out.append(key)
        else:
            if not queue:
                raise ValueError(f"{kind}: incidence others exhausted")
            out.append(queue.pop(0))
    if queue:
        raise ValueError(f"{kind}: incidence others overflow")
    return tuple(out)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest_version(manifest_sans_version: dict[str, Any]) -> str:
    """内容身份:对除 version 外的规范 manifest 内容求 SHA-256。"""
    if "version" in manifest_sans_version:
        raise ValueError("manifest version input must not contain itself")
    return sha256_hex(canonical_json(manifest_sans_version))


def schema_digest() -> str:
    """实体、事实、文本引用和磁盘元组定义的摘要。"""
    return sha256_hex(
        canonical_json(
            {
                "schema": SCHEMA,
                "tuples": TUPLE_SCHEMAS,
                "fact_roles": FACT_ROLES,
                "fact_attrs": FACT_ATTRS,
                "rank_encoding": RANK_ENCODING,
            }
        )
    )


# explorer-v1 字段策略:每个源字段必须显式声明(§3)
FIELD_POLICY: dict[str, dict[str, str]] = {
    "subject": {
        "id": "core", "type": "core", "name": "core", "name_cn": "core",
        "platform": "core", "date": "core", "score": "core",
        "score_details": "core", "rank": "core", "nsfw": "core",
        "favorite": "core", "series": "core", "tags": "core",
        "meta_tags": "core", "summary": "sidecar", "infobox": "sidecar",
    },
    "person": {
        "id": "core", "name": "core", "type": "core", "career": "core",
        "comments": "core", "collects": "core",
        "summary": "sidecar", "infobox": "sidecar",
    },
    "character": {
        "id": "core", "name": "core", "role": "core", "comments": "core",
        "collects": "core", "summary": "sidecar", "infobox": "sidecar",
    },
    "episode": {
        "id": "core", "name": "core", "name_cn": "core", "airdate": "core",
        "disc": "core", "duration": "core", "sort": "core", "type": "core",
        "subject_id": "core", "description": "sidecar",
    },
    "subject-relations": {
        "subject_id": "core", "relation_type": "core",
        "related_subject_id": "core", "order": "core",
    },
    "subject-persons": {
        "person_id": "core", "subject_id": "core", "position": "core",
        "appear_eps": "core",
    },
    "subject-characters": {
        "character_id": "core", "subject_id": "core", "type": "core",
        "order": "core",
    },
    "person-characters": {
        "person_id": "core", "subject_id": "core", "character_id": "core",
        "type": "core", "summary": "sidecar",
    },
    "person-relations": {
        "person_type": "core", "person_id": "core",
        "related_person_id": "core", "relation_type": "core",
        "spoiler": "core", "ended": "core",
    },
}
