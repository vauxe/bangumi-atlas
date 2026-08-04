"""Independently verify the baked SiteRelease against parquet.

设计契约见 docs/STRUCTURAL_SITE_DATA_DESIGN.md §8。本脚本不复用
烘焙器的装配逻辑:自行读取 parquet 重推期望值,自行解码 site/data
字节,再做重复敏感、顺序无关的对账。任何不符以非零状态退出,
阻断发布。共享的只有 scripts/site_release.py 中的格式契约本身。
"""

from __future__ import annotations

import gzip
import hashlib
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import pyarrow.parquet as pq
import site_release as sr
from content_fingerprint import RowFingerprint

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "parquet"
SITE = ROOT / "site" / "data"
SITE_ROOT = ROOT / "site"

failures: list[str] = []
artifact_files: dict[str, list[Any]] = {}
member_spans: dict[str, set[tuple[int, int]]] = defaultdict(set)


def log(msg: str) -> None:
    print(msg, flush=True)


def check(label: str, ok: bool, detail: str = "") -> None:
    if not ok:
        failures.append(label)
    log(f"  {'ok' if ok else 'MISMATCH':8s} {label}"
        f"{': ' + detail if detail else ''}")


def reconcile(label: str, expected: Any, actual: Any) -> None:
    check(label, expected == actual,
          f"expected {expected}, got {actual}")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def site_file(logical_name: str) -> Path:
    meta = artifact_files.get(logical_name)
    if meta is None or len(meta) != 3:
        raise ValueError(
            f"manifest missing physical object for {logical_name}"
        )
    return SITE / meta[2]


def load_member(logical_name: str, off: int, length: int) -> Any:
    path = site_file(logical_name)
    if length > sr.MEMBER_CAP:
        check(
            f"{logical_name} 成员硬上限",
            False,
            f"offset {off:,}, length {length:,}",
        )
    member_spans[logical_name].add((off, length))
    with open(path, "rb") as f:
        f.seek(off)
        raw = f.read(length)
    if len(raw) != length:
        raise ValueError(f"{path.name}: truncated member at {off}")
    return orjson.loads(gzip.decompress(raw))


def load_idx(name: str) -> Any:
    return orjson.loads(gzip.decompress(site_file(name).read_bytes()))


def quantile(sizes: list[int], q: float) -> int:
    if not sizes:
        return 0
    arr = sorted(sizes)
    return arr[min(len(arr) - 1, int(q * len(arr)))]


def main() -> None:  # noqa: PLR0915
    global artifact_files
    t0 = time.time()
    manifest = orjson.loads((SITE / "manifest.json").read_bytes())
    artifact_files = manifest["files"]

    # ---- manifest 自身:版本、schema、文件摘要 ----
    log("[1] manifest 与文件摘要")
    body = {k: v for k, v in manifest.items() if k != "version"}
    reconcile(
        "manifest.version = 除自身外内容的 SHA-256",
        sr.manifest_version(body),
        manifest["version"],
    )
    reconcile("schema", sr.SCHEMA, manifest["schema"])
    reconcile("profile", sr.PROFILE, manifest["profile"])
    reconcile("schema_digest", sr.schema_digest(), manifest["schema_digest"])
    reconcile("field_policy", sr.FIELD_POLICY, manifest["field_policy"])
    listed = {meta[2] for meta in artifact_files.values()}
    on_disk = {
        p.name for p in SITE.iterdir()
        if p.is_file() and p.name != "manifest.json"
    }
    reconcile("manifest.files 覆盖全部数据文件", on_disk, listed)
    total = 0
    for fname, (size, digest, physical_name) in sorted(
        artifact_files.items()
    ):
        reconcile(
            f"{fname} 内容寻址物理名",
            sr.published_object_name(fname, digest),
            physical_name,
        )
        p = SITE / physical_name
        ok = p.stat().st_size == size and sha256_of(p) == digest
        if not ok:
            check(f"{fname} 字节数与 SHA-256", False)
        total += size
        if fname.endswith(".pack") and size > sr.PACK_CAP:
            check(f"{fname} <= 80MB pack 上限", False, f"{size:,}")
    check("files 字节数与摘要全部一致", total == manifest["total_bytes"],
          f"sum {total:,} vs total_bytes {manifest['total_bytes']:,}")
    staging_total = sum(
        p.stat().st_size for p in SITE_ROOT.rglob("*") if p.is_file()
    )
    log(f"  staging site/ 全部普通文件 {staging_total:,} B"
        f"(发布门禁 <= 1,000,000,000)")
    check("staging site/ <= 1GB", staging_total <= 1_000_000_000)

    # ---- 几何与 rank-by-key ----
    log("[2] 几何与反向索引")
    n = manifest["n_nodes"]
    key_r = np.fromfile(site_file("key.bin"), dtype="<u4")
    reconcile("key.bin 记录数", n, len(key_r))
    check("key.bin 无重复键", len(np.unique(key_r)) == n)
    seg_meta = manifest["rank_index"]["segments"]
    raw = np.frombuffer(site_file("rank-by-key.bin").read_bytes(), np.uint8)
    decoded: dict[int, np.ndarray] = {}
    for kind in sr.KINDS:
        seg = seg_meta[str(kind)]
        b = raw[seg["offset"] : seg["offset"] + seg["count"] * 3]
        u32 = (
            b[0::3].astype(np.uint32)
            | (b[1::3].astype(np.uint32) << 8)
            | (b[2::3].astype(np.uint32) << 16)
        )
        decoded[kind] = u32
    non_sentinel = sum(
        int((v != sr.RANK_SENTINEL).sum()) for v in decoded.values()
    )
    reconcile("rank-by-key 覆盖数 = 节点数", n, non_sentinel)
    ok_rank = True
    for rank, key in enumerate(key_r):
        k = int(key)
        if decoded[k >> 24][k & sr.MAX_SOURCE_ID] != rank:
            ok_rank = False
            break
    check("rank-by-key[key] = rank(全量)", ok_rank)

    # ---- 词表 ----
    log("[3] 词表")
    vocab_dir = load_idx("vocab.idx")["members"]
    vocab: dict[str, list[str]] = {}
    for fam, members in vocab_dir.items():
        out: list[str] = []
        for off, length in members:
            out.extend(load_member("vocab.pack", off, length))
        vocab[fam] = out
        reconcile(
            f"vocab.{fam} 摘要",
            manifest["vocab_digests"][fam],
            sr.sha256_hex(sr.canonical_json(out)),
        )
        check(
            f"vocab.{fam} UTF-8 字节序",
            all(
                out[i].encode() < out[i + 1].encode()
                for i in range(len(out) - 1)
            ),
        )

    # ---- 实体结构 + 名称:与 parquet 的重复敏感指纹对账 ----
    log("[4] 实体结构与名称")
    name_idx = np.fromfile(site_file("names.idx"), dtype="<u4")
    block = manifest["name_block_size"]
    names_by_rank: list[list[Any]] = []
    name_sizes: list[int] = []
    for bi in range(len(name_idx) - 1):
        off, end = int(name_idx[bi]), int(name_idx[bi + 1])
        name_sizes.append(end - off)
        names_by_rank.extend(
            load_member("names.pack", off, end - off)
        )
    reconcile("names 行数", n, len(names_by_rank))
    check(
        "名称成员 P99 体验门禁",
        quantile(name_sizes, 0.99) <= sr.NAME_P99_CAP,
    )
    check("名称成员硬上限", max(name_sizes) <= sr.MEMBER_CAP)
    reconcile("names 块宽声明", block, manifest["name_block_size"])

    ent_idx = load_idx("entities.idx")
    site_ent_fp = RowFingerprint()
    ent_counts: dict[int, int] = {k: 0 for k in sr.KINDS}
    ent_sizes: list[int] = []
    rank_of_key = {int(k): i for i, k in enumerate(key_r)}
    presence: dict[str, dict[int, tuple[int, int]]] = {
        "1": {}, "2": {}, "3": {}
    }
    for kind_s, ranges in ent_idx["k"].items():
        kind = int(kind_s)
        seen_ids: set[int] = set()
        for row in ranges:
            start, end, off, length = row
            ent_sizes.append(length)
            member = load_member("entities.pack", off, length)
            for sid, tup in zip(member["i"], member["r"], strict=True):
                if sid < start or sid > end or sid in seen_ids:
                    check(f"entities kind={kind} 身份唯一且在范围内",
                          False, str(sid))
                seen_ids.add(sid)
                key = (kind << 24) | sid
                nm = names_by_rank[rank_of_key[key]]
                if kind == sr.KIND_SUBJECT:
                    (styp, plat, date, score, brank, nsfw, wish, done,
                     doing, hold, drop, series, sd, mts, tags,
                     hs, hi) = tup
                    site_ent_fp.add([
                        kind, sid, nm[0], nm[1] or "", styp, plat, date,
                        score, brank, nsfw, wish, done, doing, hold,
                        drop, series, sd,
                        [vocab["meta_tags"][t] for t in mts],
                        [[vocab["tags"][t], c] for t, c in tags],
                    ])
                elif kind == sr.KIND_PERSON:
                    ptyp, careers, comments, collects, hs, hi = tup
                    site_ent_fp.add([
                        kind, sid, nm[0], ptyp,
                        [vocab["career"][c] for c in careers],
                        comments, collects,
                    ])
                else:
                    role, comments, collects, hs, hi = tup
                    site_ent_fp.add([kind, sid, nm[0], role,
                                     comments, collects])
                presence[kind_s][sid] = (hs, hi)
                ent_counts[kind] += 1
    for kind_name, kind in (("subject", 1), ("person", 2),
                            ("character", 3)):
        reconcile(
            f"实体计数 {kind_name}",
            manifest["counts"]["entities"][kind_name],
            ent_counts[kind],
        )
    check("实体成员硬上限", max(ent_sizes) <= sr.MEMBER_CAP)

    pq_ent_fp = RowFingerprint()
    sub = pq.read_table(PARQUET / "subject.parquet").to_pydict()
    for i in range(len(sub["id"])):
        pq_ent_fp.add([
            1, sub["id"][i], sub["name"][i], sub["name_cn"][i],
            sub["type"][i], sub["platform_code"][i], sub["date"][i],
            sub["score"][i], sub["rank"][i], int(sub["nsfw"][i]),
            sub["wish"][i], sub["done"][i], sub["doing"][i],
            sub["on_hold"][i], sub["dropped"][i], int(sub["series"][i]),
            sub["score_details"][i], sub["meta_tags"][i],
            [[t["name"], t["count"]] for t in sub["tags"][i]],
        ])
    per = pq.read_table(PARQUET / "person.parquet").to_pydict()
    for i in range(len(per["id"])):
        pq_ent_fp.add([
            2, per["id"][i], per["name"][i], per["type"][i],
            per["career"][i], per["comments"][i], per["collects"][i],
        ])
    cha = pq.read_table(PARQUET / "character.parquet").to_pydict()
    for i in range(len(cha["id"])):
        pq_ent_fp.add([
            3, cha["id"][i], cha["name"][i], cha["role"][i],
            cha["comments"][i], cha["collects"][i],
        ])
    check(
        "实体结构内容指纹 = parquet",
        site_ent_fp.snapshot() == pq_ent_fp.snapshot(),
    )

    # ---- 文本侧车:非空/空计数、字节数、指纹、存在位 ----
    log("[5] 文本侧车")
    text_idx = load_idx("text.idx")["families"]

    def verify_entity_text(family: str, column: str, bit: int) -> None:
        fam = text_idx[family]
        fp_site = RowFingerprint()
        sizes: list[int] = []
        seen_count = 0
        raw_bytes = 0
        seen_by_kind: dict[str, set[int]] = {"1": set(), "2": set(),
                                             "3": set()}
        for kind_s, ranges in fam["ranges"].items():
            for start, end, fidx, off, length in ranges:
                sizes.append(length)
                m = load_member(fam["files"][fidx], off, length)
                for sid, text in zip(m["i"], m["t"], strict=True):
                    if (sid < start or sid > end
                            or sid in seen_by_kind[kind_s] or not text):
                        check(f"{family} 身份唯一且非空", False, str(sid))
                    seen_by_kind[kind_s].add(sid)
                    fp_site.add([int(kind_s), sid, text])
                    raw_bytes += len(text.encode())
                    seen_count += 1
        fp_pq = RowFingerprint()
        pq_non_empty = 0
        pq_empty = 0
        for kind, table in ((1, "subject"), (2, "person"),
                            (3, "character")):
            t = pq.read_table(
                PARQUET / f"{table}.parquet", columns=["id", column]
            ).to_pydict()
            for i in range(len(t["id"])):
                text = t[column][i]
                if text:
                    fp_pq.add([kind, t["id"][i], text])
                    pq_non_empty += 1
                else:
                    pq_empty += 1
                bits = presence[str(kind)][t["id"][i]]
                if bits[bit] != int(bool(text)):
                    check(f"{family} 存在位一致", False,
                          f"{kind}:{t['id'][i]}")
        check(f"{family} 内容指纹 = parquet",
              fp_site.snapshot() == fp_pq.snapshot())
        reconcile(f"{family} 非空计数",
                  manifest["counts"]["text"][family]["non_empty"],
                  seen_count)
        reconcile(f"{family} 非空计数 = parquet", pq_non_empty, seen_count)
        reconcile(f"{family} 空计数",
                  manifest["counts"]["text"][family]["empty"], pq_empty)
        reconcile(f"{family} UTF-8 字节数",
                  manifest["text_bytes"][family]["raw"], raw_bytes)
        check(f"{family} 成员硬上限",
              not sizes or max(sizes) <= sr.MEMBER_CAP)
        check(f"{family} P99 体验门禁",
              quantile(sizes, 0.99) <= sr.TEXT_P99_CAP)
        reconcile(f"{family} 成员大小分布 = manifest",
                  manifest["text_layout"][family]["max"],
                  max(sizes) if sizes else 0)

    verify_entity_text("entity-summary", "summary", 0)
    verify_entity_text("entity-infobox", "infobox", 1)

    # episode-description:识别 (subject, episode) 唯一定位
    fam = text_idx["episode-description"]
    desc_site: dict[tuple[int, int], bool] = {}
    fp_site = RowFingerprint()
    sizes = []
    desc_raw = 0
    for row in fam["ranges"]:
        start, end, fidx, off, length = row[:5]
        sizes.append(length)
        m = load_member(fam["files"][fidx], off, length)
        for sid, pairs in zip(m["i"], m["t"], strict=True):
            for epid, text in pairs:
                if (sid, epid) in desc_site or not text:
                    check("episode-description 身份唯一且非空", False,
                          f"{sid}:{epid}")
                if len(row) == 7 and not (row[5] <= epid <= row[6]):
                    check("episode-description 分集边界", False, str(epid))
                desc_site[(sid, epid)] = True
                fp_site.add([sid, epid, text])
                desc_raw += len(text.encode())
    ep_t = pq.read_table(
        PARQUET / "episode.parquet",
        columns=["id", "subject_id", "description"],
    ).to_pydict()
    fp_pq = RowFingerprint()
    pq_non_empty = 0
    pq_empty = 0
    desc_bit_by_ep: dict[int, int] = {}
    for i in range(len(ep_t["id"])):
        text = ep_t["description"][i]
        desc_bit_by_ep[ep_t["id"][i]] = int(bool(text))
        if text:
            fp_pq.add([ep_t["subject_id"][i], ep_t["id"][i], text])
            pq_non_empty += 1
        else:
            pq_empty += 1
    check("episode-description 内容指纹 = parquet",
          fp_site.snapshot() == fp_pq.snapshot())
    reconcile("episode-description 非空计数", pq_non_empty, len(desc_site))
    reconcile("episode-description 空计数",
              manifest["counts"]["text"]["episode-description"]["empty"],
              pq_empty)
    reconcile("episode-description UTF-8 字节数",
              manifest["text_bytes"]["episode-description"]["raw"],
              desc_raw)
    check("episode-description 成员硬上限",
          not sizes or max(sizes) <= sr.MEMBER_CAP)
    check("episode-description P99 体验门禁",
          quantile(sizes, 0.99) <= sr.TEXT_P99_CAP)

    # fact-summary:当前全空快照必须产生零负载 + 规范空目录
    fam = text_idx["fact-summary"]
    fact_summary: dict[int, str] = {}
    for _start, _end, fidx, off, length in fam["ranges"]:
        m = load_member(fam["files"][fidx], off, length)
        for ref, text in zip(m["i"], m["t"], strict=True):
            fact_summary[ref] = text
    check("fact-summary 目录与 pack 存在",
          all(site_file(f).exists() for f in fam["files"]))
    vo = pq.read_table(
        PARQUET / "voiced.parquet",
        columns=["summary"],
    ).to_pydict()
    reconcile(
        "fact-summary 非空值 = parquet",
        sum(1 for s in vo["summary"] if s),
        len(fact_summary),
    )

    # ---- 分集结构 ----
    log("[6] 分集结构")
    eps_idx = load_idx("episodes.idx")
    pages_path = "pages.pack"
    site_ep_fp = RowFingerprint()
    ep_rows_seen = 0
    orphan_groups = 0
    subject_ids = set(sub["id"])
    eps_sizes: list[int] = []
    seen_sids: set[int] = set()
    for start, end, off, length in eps_idx["ranges"]:
        eps_sizes.append(length)
        m = load_member("episodes.pack", off, length)
        for sid, entry in zip(m["i"], m["g"], strict=True):
            if sid < start or sid > end or sid in seen_sids:
                check("episodes 分组键唯一且在范围内", False, str(sid))
            seen_sids.add(sid)
            if sid not in subject_ids:
                orphan_groups += 1
            rows = list(entry["e"])
            for poff, plen in entry.get("op", []):
                rows.extend(load_member(pages_path, poff, plen))
            reconcile_ok = len(rows) == entry["n"]
            if not reconcile_ok:
                check("episodes 分页总数 = n", False, str(sid))
            prev_key = None
            for r in rows:
                epid, name, cn, air, disc, dur, sort, typ, hd = r
                if hd != desc_bit_by_ep.get(epid, -1):
                    check("episodes 描述存在位", False, str(epid))
                site_ep_fp.add([sid, epid, name, cn, air, disc, dur,
                                sort, typ])
                order_key = (
                    typ, disc,
                    float("inf") if sort is None else sort, epid,
                )
                if prev_key is not None and order_key < prev_key:
                    check("episodes 组内有序", False, str(epid))
                prev_key = order_key
                ep_rows_seen += 1
    ep_full = pq.read_table(
        PARQUET / "episode.parquet",
        columns=["id", "subject_id", "name", "name_cn", "airdate",
                 "disc", "duration", "sort", "type"],
    ).to_pydict()
    pq_ep_fp = RowFingerprint()
    for i in range(len(ep_full["id"])):
        pq_ep_fp.add([
            ep_full["subject_id"][i], ep_full["id"][i],
            ep_full["name"][i], ep_full["name_cn"][i],
            ep_full["airdate"][i], ep_full["disc"][i],
            ep_full["duration"][i], ep_full["sort"][i],
            ep_full["type"][i],
        ])
    check("分集内容指纹 = parquet",
          site_ep_fp.snapshot() == pq_ep_fp.snapshot())
    reconcile("分集行数", manifest["counts"]["episodes"], ep_rows_seen)
    reconcile("孤儿分组数",
              manifest["counts"]["episode_orphan_groups"], orphan_groups)
    check("分集成员硬上限", max(eps_sizes) <= sr.MEMBER_CAP)

    # ---- 事实:incidence 还原 FactRef、multiplicity 对账 ----
    log("[7] 事实与 incidence")
    expected: dict[bytes, tuple[int, int]] = {}
    fact_source_rows = 0
    mult_count: dict[bytes, int] = defaultdict(int)

    def add_rows(kind: str, parts_attrs: Any) -> None:
        nonlocal fact_source_rows
        for parts, attrs in parts_attrs:
            mult_count[sr.canonical_fact(kind, parts, attrs)] += 1
            fact_source_rows += 1

    rel = pq.read_table(PARQUET / "relates_to.parquet").to_pydict()
    add_rows("RELATES_TO", (
        (((1 << 24) | rel["from_id"][i], (1 << 24) | rel["to_id"][i]),
         (rel["relation_type"][i], rel["sort_order"][i]))
        for i in range(len(rel["from_id"]))
    ))
    wo = pq.read_table(PARQUET / "worked_on.parquet").to_pydict()
    add_rows("WORKED_ON", (
        (((2 << 24) | wo["from_id"][i], (1 << 24) | wo["to_id"][i]),
         (wo["position"][i], wo["appear_eps"][i]))
        for i in range(len(wo["from_id"]))
    ))
    ap = pq.read_table(PARQUET / "appears_in.parquet").to_pydict()
    add_rows("APPEARS_IN", (
        (((3 << 24) | ap["from_id"][i], (1 << 24) | ap["to_id"][i]),
         (ap["type"][i], ap["sort_order"][i]))
        for i in range(len(ap["from_id"]))
    ))
    vo_full = pq.read_table(PARQUET / "voiced.parquet").to_pydict()
    add_rows("VOICE_CREDIT", (
        (((2 << 24) | vo_full["from_id"][i],
          (3 << 24) | vo_full["to_id"][i],
          (1 << 24) | vo_full["subject_id"][i]),
         (vo_full["type"][i], vo_full["summary"][i]))
        for i in range(len(vo_full["from_id"]))
    ))
    pr = pq.read_table(PARQUET / "person_rel.parquet").to_pydict()
    add_rows("PERSON_REL", (
        (((2 << 24) | pr["from_id"][i], (2 << 24) | pr["to_id"][i]),
         (pr["relation_type"][i], int(pr["spoiler"][i]),
          int(pr["ended"][i])))
        for i in range(len(pr["from_id"]))
    ))
    cr = pq.read_table(PARQUET / "character_rel.parquet").to_pydict()
    add_rows("CHARACTER_REL", (
        (((3 << 24) | cr["from_id"][i], (3 << 24) | cr["to_id"][i]),
         (cr["relation_type"][i], int(cr["spoiler"][i]),
          int(cr["ended"][i])))
        for i in range(len(cr["from_id"]))
    ))
    for i, enc in enumerate(sorted(mult_count)):
        expected[enc] = (i, mult_count[enc])
    n_facts = len(expected)
    reconcile("事实计数", manifest["counts"]["facts"], n_facts)
    reconcile("事实源行数",
              manifest["counts"]["fact_source_rows"], fact_source_rows)
    reconcile("multiplicity 总和 = 源行数",
              fact_source_rows, sum(mult_count.values()))
    del rel, wo, ap, pr, cr

    tag_to_kind = {v: k for k, v in sr.FACT_TAGS.items()}
    facts_idx = load_idx("facts.idx")
    seen_incidence = np.zeros(n_facts, dtype=np.uint8)
    expected_incidence = np.zeros(n_facts, dtype=np.uint8)
    for enc, (ref, _) in expected.items():
        kind, parts, _attrs = orjson.loads(enc)
        expected_incidence[ref] = len(set(parts))
    n_inc_seen = 0
    fact_sizes: list[int] = []
    ok_incidence = True
    for bucket_i, members in enumerate(facts_idx["b"]):
        for off, length, _last_key in members:
            fact_sizes.append(length)
            member = load_member("facts.pack", off, length)
            for key_s, entry in member.items():
                key = int(key_s)
                if key % sr.FACT_BUCKETS != bucket_i:
                    check("事实桶键归属", False, key_s)
                items: list[tuple[str, list[Any]]] = []
                for tag, tuples in entry["g"].items():
                    items.extend((tag, t) for t in tuples)
                for poff, plen in entry.get("op", []):
                    for page_item in load_member(pages_path, poff, plen):
                        items.append((page_item[0], page_item[1:]))
                totals = Counter(tag for tag, _ in items)
                if dict(totals) != entry["n"]:
                    check("事实条目分组计数", False, key_s)
                for tag, tup in items:
                    f_kind = tag_to_kind[tag]
                    ref, mult, role_bits, others, *attrs = tup
                    parts = sr.participants_from_incidence(
                        f_kind, key, role_bits, others
                    )
                    if f_kind == "VOICE_CREDIT":
                        text = fact_summary.get(ref, "")
                        if bool(text) != bool(attrs[1]):
                            ok_incidence = False
                        attrs = [attrs[0], text]
                    enc = sr.canonical_fact(f_kind, parts, tuple(attrs))
                    exp = expected.get(enc)
                    if exp is None or exp[0] != ref or exp[1] != mult:
                        ok_incidence = False
                    else:
                        seen_incidence[ref] += 1
                    n_inc_seen += 1
    check("每条 incidence 还原为同一规范事实与 FactRef", ok_incidence)
    check(
        "每个事实在每个参与者下恰好一条 incidence",
        bool((seen_incidence == expected_incidence).all()),
    )
    reconcile("incidence 总数", manifest["counts"]["incidence"], n_inc_seen)
    check("事实成员硬上限", max(fact_sizes) <= sr.MEMBER_CAP)

    # ---- 搜索:自适应前缀树与全量排序一致 ----
    log("[8] 搜索索引")
    charmap = orjson.loads(site_file("charmap.json").read_bytes())

    def fold(text: str) -> str:
        t = text.strip().lower()
        return "".join(charmap.get(ch, ch) for ch in t)

    entries: list[tuple[str, str, int]] = []
    for rank in range(n):
        nm = names_by_rank[rank]
        for text in dict.fromkeys(t for t in (nm[0], nm[1] or "") if t):
            nk = fold(text)
            if nk:
                entries.append((nk, text, rank))
    entries.sort(key=lambda e: e[2])
    search_dir = orjson.loads(site_file("search.idx.json").read_bytes())
    by_prefix: dict[str, list[list[Any]]] = defaultdict(list)
    for nk, text, rank in entries:
        for plen in range(1, len(nk) + 1):
            p = nk[:plen]
            if p in search_dir:
                by_prefix[p].append([nk, text, rank])
            else:
                break
    ok_search = True
    search_max = 0
    for prefix, node in search_dir.items():
        exp_items = by_prefix.get(prefix, [])
        if "l" in node:
            if set(node) != {"l"}:
                ok_search = False
            off, length = node["l"]
            search_max = max(search_max, length)
            got = load_member("search.pack", off, length)
            if got != exp_items:
                ok_search = False
        else:
            if set(node) != {"t"}:
                ok_search = False
            off, length = node["t"]
            search_max = max(search_max, length)
            got = load_member("search.pack", off, length)
            if got != exp_items[: sr.SEARCH_TOP]:
                ok_search = False
    check("搜索叶与内部 top-12 与全量排序一致", ok_search)
    check("搜索成员 <= 64,000", search_max <= sr.SEARCH_LEAF_CAP,
          f"max {search_max:,}")
    covered = set()
    for nk, _text, _rank in entries:
        p = None
        for plen in range(len(nk), 0, -1):
            if nk[:plen] in search_dir:
                p = nk[:plen]
                break
        if p is None:
            check("搜索目录覆盖全部条目", False, nk[:8])
            break
        covered.add(p)

    for logical_name, (size, _digest, _physical_name) in (
        artifact_files.items()
    ):
        if not logical_name.endswith(".pack"):
            continue
        cursor = 0
        contiguous = True
        for off, length in sorted(member_spans.get(logical_name, set())):
            if off != cursor or length <= 0:
                contiguous = False
                break
            cursor += length
        check(
            f"{logical_name} 成员边界完整覆盖 pack",
            contiguous and cursor == size,
            f"covered {cursor:,} / {size:,}",
        )

    # ---- 显示映射 ----
    log("[9] 显示映射")
    mappings = orjson.loads(site_file("mappings.json").read_bytes())
    reconcile(
        "mappings.json 摘要",
        manifest["mapping_digests"]["mappings.json"],
        sr.sha256_hex(sr.canonical_json(mappings)),
    )
    for kind_name, table, code_col, name_col in (
        ("RELATES_TO", "relates_to", "relation_type", "relation"),
        ("WORKED_ON", "worked_on", "position", "position_cn"),
        ("APPEARS_IN", "appears_in", "type", "role_cn"),
        ("PERSON_REL", "person_rel", "relation_type", "relation"),
        ("CHARACTER_REL", "character_rel", "relation_type", "relation"),
    ):
        t = pq.read_table(
            PARQUET / f"{table}.parquet", columns=[code_col, name_col]
        ).to_pydict()
        table_map = mappings["fact_labels"][kind_name]
        ok_map = all(
            (not name and str(code) not in table_map)
            or table_map.get(str(code)) == name
            for code, name in zip(t[code_col], t[name_col], strict=True)
        )
        check(f"mappings.{kind_name} 与 parquet 解码一致", ok_map)

    elapsed = time.time() - t0
    if failures:
        log(f"FAILED: {len(failures)} 处不符 ({elapsed:,.0f}s): "
            f"{failures[:10]}")
        sys.exit(1)
    log(f"verify_site: all checks passed in {elapsed:,.0f}s")


if __name__ == "__main__":
    main()
