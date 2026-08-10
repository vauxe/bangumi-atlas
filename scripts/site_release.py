"""structural-site-v1 SiteRelease 的格式契约。

烘焙器、独立验证器和契约测试共享本模块中的常量与规范编码;
磁盘元组布局的任何变更都必须同步更新 TUPLE_SCHEMAS(参与
manifest.schema_digest),否则跨端解码将失配。
设计文档:docs/STRUCTURAL_SITE_DATA_DESIGN.md。
"""

from __future__ import annotations

import gzip
import hashlib
from functools import cache
from pathlib import Path
from typing import Any, Final

import orjson
from opencc import OpenCC

from . import entity_key as _entity_key

SITE_CONTRACT_PATH = Path(__file__).with_name("site-contract.json")
SITE_CONTRACT: dict[str, Any] = orjson.loads(SITE_CONTRACT_PATH.read_bytes())
SITE_LIMITS: dict[str, Any] = SITE_CONTRACT["limits"]

SCHEMA = str(SITE_CONTRACT["schema"])
PROFILE = str(SITE_CONTRACT["profile"])

ENTITY_KEY_FORMAT = _entity_key.ENTITY_KEY_FORMAT
KIND_SUBJECT = _entity_key.KIND_SUBJECT
KIND_PERSON = _entity_key.KIND_PERSON
KIND_CHARACTER = _entity_key.KIND_CHARACTER
KINDS = _entity_key.KINDS
KIND_NAMES = _entity_key.KIND_NAMES
MAX_SOURCE_ID = _entity_key.MAX_SOURCE_ID
is_entity_kind = _entity_key.is_entity_kind
entity_key = _entity_key.entity_key
entity_keys = _entity_key.entity_keys

EPISODE_SUBJECT_SENTINEL = (1 << 32) - 1

# ---- u24 反向索引(VisualRank by EntityKey)----
RANK_SENTINEL = int(SITE_CONTRACT["rank"]["sentinel"])
RANK_ENCODING = str(SITE_CONTRACT["rank"]["encoding"])

# ---- 成员与 pack 门禁(压缩字节约束传输,解压字节约束内存)----
MEMBER_CAP = int(SITE_LIMITS["member_cap"])
MEMBER_RAW_CAP = int(SITE_LIMITS["member_raw_cap"])
PACK_CAP = int(SITE_LIMITS["pack_cap"])
SEARCH_LEAF_CAP = int(SITE_LIMITS["search_leaf_cap"])
SEARCH_TOP = int(SITE_LIMITS["search_top"])
SEARCH_UNICODE_VERSION = "15.0.0"
SEARCH_FOLD = str(SITE_LIMITS["search_fold"])
SEARCH_FOLD_MAX_EXPANSION = int(SITE_LIMITS["search_fold_max_expansion"])
SEARCH_CASEFOLD_PATH = Path(__file__).with_name(
    f"unicode-casefold-{SEARCH_UNICODE_VERSION}.json"
)
SEARCH_TRIM_CHARS: Final = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
SEARCH_NGRAM_WIDTH = int(SITE_LIMITS["search_ngram_width"])
SEARCH_NGRAM_BUCKETS = int(SITE_LIMITS["search_ngram_buckets"])
SEARCH_NGRAM_MEMBER_RANKS = int(SITE_LIMITS["search_ngram_member_ranks"])
# 发布可确定性缩小该值，客户端将它视为编译期上限。
SEARCH_ALIAS_BLOCK_RANKS_MAX = int(SITE_LIMITS["search_alias_block_ranks_max"])
TEXT_P99_CAP = 75_000
NAME_P99_CAP = 64_000

# ---- explorer-v1 声明的初始分块与内联/分页参数(§5)----
NAME_BLOCK_SIZE = 2048
ENTITY_BLOCK_IDS = 4096
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


def release_limits(
    *, search_alias_block_ranks: int = SEARCH_ALIAS_BLOCK_RANKS_MAX
) -> dict[str, Any]:
    """Return the complete manifest limits contract for this profile."""

    return {
        "member_cap": MEMBER_CAP,
        "member_raw_cap": MEMBER_RAW_CAP,
        "pack_cap": PACK_CAP,
        "fact_buckets": FACT_BUCKETS,
        "fact_inline": FACT_INLINE,
        "episode_inline": EPISODE_INLINE,
        "page_size": PAGE_SIZE,
        "entity_block_ids": ENTITY_BLOCK_IDS,
        "episode_block_subjects": EPISODE_BLOCK_SUBJECTS,
        "search_leaf_cap": SEARCH_LEAF_CAP,
        "search_top": SEARCH_TOP,
        "search_fold": SEARCH_FOLD,
        "search_ngram_width": SEARCH_NGRAM_WIDTH,
        "search_ngram_buckets": SEARCH_NGRAM_BUCKETS,
        "search_ngram_member_ranks": SEARCH_NGRAM_MEMBER_RANKS,
        "search_alias_block_ranks": search_alias_block_ranks,
        "cache_budget": {
            "total": 64_000_000,
            "names": 12_000_000,
            "structure": 24_000_000,
            "search": 8_000_000,
            "text": 20_000_000,
        },
    }


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
    "name": ["name", "name_cn|null", "entity_kind"],
    "entity": {
        "subject": [
            "name",
            "name_cn|null",
            "type",
            "platform_code|null",
            "date",
            "score|null",
            "bgm_rank|null",
            "nsfw01",
            "wish",
            "done",
            "doing",
            "on_hold",
            "dropped",
            "series01",
            "score_details[10]",
            "meta_tags[vocab]",
            "tags[[vocab,count]]",
            "has_summary01",
            "has_infobox01",
        ],
        "person": [
            "name",
            "type",
            "career[vocab]",
            "comments",
            "collects",
            "has_summary01",
            "has_infobox01",
        ],
        "character": [
            "name",
            "role",
            "comments",
            "collects",
            "has_summary01",
            "has_infobox01",
        ],
    },
    "episode": [
        "id",
        "name",
        "name_cn",
        "airdate",
        "disc",
        "duration",
        "sort|null",
        "type",
        "has_description01",
    ],
    "incidence": [
        "fact_ref",
        "multiplicity",
        "role_bits",
        "others[key]",
        "*attrs(FACT_ATTRS)",
    ],
    "fact_page_item": ["kind_tag", "*incidence"],
    "episode_group": {
        "e": "inline rows",
        "n": "total",
        "op": "[offset,len] pages",
    },
    "fact_entry": {
        "g": "kind_tag -> inline incidences",
        "n": "kind_tag -> total",
        "op": "[offset,len] pages",
    },
    "text_member": {"i": "identities", "t": "texts"},
    "episode_text_member": {"i": "subject_ids", "t": "[[episode_id, text]]"},
    "search_entry": ["norm", "matched", "rank", "display", "entity_kind"],
    "search_alias": {
        "row": ["aliases[[norm,matched]]", "display", "entity_kind"],
        "block_ranks": SEARCH_ALIAS_BLOCK_RANKS_MAX,
    },
    "search_node": {
        "leaf": ["offset", "length"],
        "internal": ["top_offset", "top_length"],
    },
    "search_ngram": {
        "hash": "fnv1a32-codepoint",
        "width": SEARCH_NGRAM_WIDTH,
        "buckets": SEARCH_NGRAM_BUCKETS,
        "index": (
            "u32le bucket member starts, member byte offsets, "
            "member first/last ranks, then bucket posting counts"
        ),
        "postings": (
            "gzip members of at most "
            f"{SEARCH_NGRAM_MEMBER_RANKS} u24le VisualRanks"
        ),
    },
    "text_search": {
        "member": [
            "text_family",
            "entity_kind|0",
            "file_index",
            "offset",
            "length",
        ],
        "hash": "fnv1a32-codepoint",
        "width": SEARCH_NGRAM_WIDTH,
        "buckets": SEARCH_NGRAM_BUCKETS,
        "postings": (
            "gzip members of unsigned varint first id and positive deltas"
        ),
    },
}


def canonical_json(value: Any) -> bytes:
    return orjson.dumps(
        value, option=orjson.OPT_NON_STR_KEYS | orjson.OPT_SORT_KEYS
    )


def gzip_member(value: Any, level: int) -> bytes:
    """可复现的独立 gzip 成员(mtime=0,键序规范)。"""
    return gzip.compress(canonical_json(value), compresslevel=level, mtime=0)


def member_raw_size(member: bytes) -> int:
    """Read gzip ISIZE; baker-created members are always below 4 GiB."""

    if len(member) < 18 or member[:2] != b"\x1f\x8b":
        raise ValueError("payload is not a gzip member")
    return int.from_bytes(member[-4:], "little")


def member_fits(
    member: bytes,
    *,
    cap: int = MEMBER_CAP,
    raw_cap: int = MEMBER_RAW_CAP,
) -> bool:
    return len(member) <= cap and member_raw_size(member) <= raw_cap


def require_member_size(
    member: bytes,
    label: str,
    cap: int = MEMBER_CAP,
    raw_cap: int = MEMBER_RAW_CAP,
) -> None:
    """所有 gzip 成员共用压缩与解压硬门禁。"""
    if len(member) > cap:
        raise ValueError(
            f"{label}: gzip member {len(member):,} exceeds member cap {cap:,}"
        )
    raw_size = member_raw_size(member)
    if raw_size > raw_cap:
        raise ValueError(
            f"{label}: decoded gzip member {raw_size:,} exceeds "
            f"decoded member cap {raw_cap:,}"
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
        if not member_fits(member, cap=cap) and len(chunk) > 1:
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


def search_gram_bucket(gram: str) -> int:
    """Map one Unicode-codepoint bigram to its deterministic posting bucket."""
    if len(gram) != SEARCH_NGRAM_WIDTH:
        raise ValueError(
            f"search gram must contain {SEARCH_NGRAM_WIDTH} code points"
        )
    value = (2166136261 ^ SEARCH_NGRAM_WIDTH) & 0xFFFFFFFF
    for char in gram:
        value ^= ord(char)
        value = (value * 16777619) & 0xFFFFFFFF
    return value & (SEARCH_NGRAM_BUCKETS - 1)


@cache
def search_charmap() -> dict[str, str]:
    """Load the complete, versioned Unicode case-fold table.

    The query alphabet is not limited to characters already present in the
    current dump: a user may type an uppercase or compatibility form that the
    source names never contain. The checked-in table makes weekly artifacts
    independent from the producer's Python and Unicode database versions.
    """

    value = orjson.loads(SEARCH_CASEFOLD_PATH.read_bytes())
    if not isinstance(value, dict) or any(
        not isinstance(key, str)
        or len(key) != 1
        or not isinstance(folded, str)
        or not folded
        for key, folded in value.items()
    ):
        raise ValueError(f"invalid case-fold table: {SEARCH_CASEFOLD_PATH}")
    mappings: dict[str, str] = value
    if any(
        len(folded) > SEARCH_FOLD_MAX_EXPANSION for folded in mappings.values()
    ):
        raise ValueError(
            "case-fold expansion exceeds "
            f"{SEARCH_FOLD_MAX_EXPANSION} code points"
        )
    if any(
        "".join(mappings.get(char, char) for char in folded) != folded
        for folded in mappings.values()
    ):
        raise ValueError(
            f"non-idempotent case-fold table: {SEARCH_CASEFOLD_PATH}"
        )
    return mappings


def search_fold(text: str) -> str:
    """Apply the total, deterministic and idempotent query fold."""

    charmap = search_charmap()
    trimmed = text.strip(SEARCH_TRIM_CHARS)
    return "".join(charmap.get(char, char) for char in trimmed)


@cache
def _opencc(config: str) -> OpenCC:
    return OpenCC(config)


_JAPANESE_RANGES: Final = (
    (0x3040, 0x30FF),  # Hiragana and Katakana
    (0x31F0, 0x31FF),  # Katakana phonetic extensions
    (0xFF66, 0xFF9D),  # Half-width Katakana
)


def _has_japanese_script(text: str) -> bool:
    return any(
        start <= ord(char) <= end
        for char in text
        for start, end in _JAPANESE_RANGES
    )


def search_aliases(name: str, name_cn: str) -> list[tuple[str, str]]:
    """Derive indexed aliases without treating language rules as equality.

    Chinese simplified/traditional and Japanese old/new forms are independent
    whole-string recall aliases. Japanese conversion is only enabled when the
    source contains Japanese script, avoiding ambiguous Han-only conversions
    such as 沪 -> 濾. The original spelling always remains indexed.
    """

    aliases: list[tuple[str, str]] = []
    seen_keys: set[str] = set()
    sources = dict.fromkeys(text for text in (name_cn, name) if text)
    for source in sources:
        variants = [
            source,
            _opencc("t2s").convert(source),
            _opencc("s2t").convert(source),
        ]
        if _has_japanese_script(source):
            variants.extend(
                (
                    _opencc("jp2t").convert(source),
                    _opencc("t2jp").convert(source),
                )
            )
        for matched in dict.fromkeys(variants):
            key = search_fold(matched)
            if key and key not in seen_keys:
                seen_keys.add(key)
                aliases.append((key, matched))
    return aliases


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
    digest = sha256_hex(
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
    expected = str(SITE_CONTRACT["schema_digest"])
    if digest != expected:
        raise ValueError(
            f"{SITE_CONTRACT_PATH} schema_digest is stale: {digest}"
        )
    return digest


# explorer-v1 字段策略:每个源字段必须显式声明(§3)
FIELD_POLICY: dict[str, dict[str, str]] = {
    "subject": {
        "id": "core",
        "type": "core",
        "name": "core",
        "name_cn": "core",
        "platform": "core",
        "date": "core",
        "score": "core",
        "score_details": "core",
        "rank": "core",
        "nsfw": "core",
        "favorite": "core",
        "series": "core",
        "tags": "core",
        "meta_tags": "core",
        "summary": "sidecar",
        "infobox": "sidecar",
    },
    "person": {
        "id": "core",
        "name": "core",
        "type": "core",
        "career": "core",
        "comments": "core",
        "collects": "core",
        "summary": "sidecar",
        "infobox": "sidecar",
    },
    "character": {
        "id": "core",
        "name": "core",
        "role": "core",
        "comments": "core",
        "collects": "core",
        "summary": "sidecar",
        "infobox": "sidecar",
    },
    "episode": {
        "id": "core",
        "name": "core",
        "name_cn": "core",
        "airdate": "core",
        "disc": "core",
        "duration": "core",
        "sort": "core",
        "type": "core",
        "subject_id": "core",
        "description": "sidecar",
    },
    "subject-relations": {
        "subject_id": "core",
        "relation_type": "core",
        "related_subject_id": "core",
        "order": "core",
    },
    "subject-persons": {
        "person_id": "core",
        "subject_id": "core",
        "position": "core",
        "appear_eps": "core",
    },
    "subject-characters": {
        "character_id": "core",
        "subject_id": "core",
        "type": "core",
        "order": "core",
    },
    "person-characters": {
        "person_id": "core",
        "subject_id": "core",
        "character_id": "core",
        "type": "core",
        "summary": "sidecar",
    },
    "person-relations": {
        "person_type": "core",
        "person_id": "core",
        "related_person_id": "core",
        "relation_type": "core",
        "spoiler": "core",
        "ended": "core",
    },
}
