"""Shared, versioned query field and fact-role contract."""

from __future__ import annotations

import hashlib
import re
from functools import cache
from pathlib import Path
from typing import Any

import orjson

QUERY_CONTRACT_PATH = Path(__file__).with_name("query-contract.json")
QUERY_OWNERS = ("subject", "person", "character", "episode")
QUERY_FIELD_TYPES = {
    "boolean",
    "integer",
    "number",
    "number[]",
    "string",
    "string[]",
    "tag[]",
    "fact-ref",
    *(f"entity:{owner}" for owner in QUERY_OWNERS),
}
QUERY_EXPOSURES = {"query", "evidence", "private"}
QUERY_SEARCH_KINDS = ("lookup", "fullText")
QUERY_FIELD_OPERATORS = {
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "in",
    "isNull",
}
FACT_DERIVED_FIELDS = {
    "VOICE_CREDIT": {
        "summaryState": "has_summary",
        "summary": "has_summary",
    }
}


@cache
def load_query_contract() -> dict[str, Any]:
    value = orjson.loads(QUERY_CONTRACT_PATH.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("query contract must be an object")
    return value


def query_schema_digest() -> str:
    canonical = orjson.dumps(
        load_query_contract(), option=orjson.OPT_SORT_KEYS
    )
    return hashlib.sha256(canonical).hexdigest()


def _snake_case(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def validate_query_contract(
    contract: dict[str, Any],
    site_fact_roles: dict[str, tuple[str, ...]],
    site_fact_attrs: dict[str, tuple[str, ...]],
) -> None:
    """Reject a registry that cannot drive both builder and data runtime."""

    if contract.get("schema") != "atlas-query-v1":
        raise ValueError("unsupported query contract schema")
    owners = contract.get("owners")
    if not isinstance(owners, dict) or tuple(owners) != QUERY_OWNERS:
        raise ValueError("query owners must use the canonical order")
    operator_sets = contract.get("operatorSets")
    if not isinstance(operator_sets, dict) or any(
        not isinstance(name, str)
        or not isinstance(operators, list)
        or not operators
        or any(not isinstance(operator, str) for operator in operators)
        for name, operators in operator_sets.items()
    ):
        raise ValueError("query operator sets are invalid")
    unsupported_operators = sorted(
        {
            operator
            for operators in operator_sets.values()
            for operator in operators
        }
        - QUERY_FIELD_OPERATORS
    )
    if unsupported_operators:
        raise ValueError(
            "query contract has unsupported operator(s): "
            + ", ".join(unsupported_operators)
        )
    capabilities = contract.get("capabilities")
    if (
        not isinstance(capabilities, list)
        or not capabilities
        or len(capabilities) != len(set(capabilities))
        or any(not isinstance(capability, str) for capability in capabilities)
    ):
        raise ValueError("query capabilities are invalid")
    capability_set = set(capabilities)
    search = contract.get("search")
    if not isinstance(search, dict) or tuple(search) != QUERY_SEARCH_KINDS:
        raise ValueError("query search semantics are invalid")
    for kind, semantics in search.items():
        if (
            not isinstance(semantics, dict)
            or tuple(semantics) != ("minNormalizedCharacters",)
            or not isinstance(semantics["minNormalizedCharacters"], int)
            or isinstance(semantics["minNormalizedCharacters"], bool)
            or semantics["minNormalizedCharacters"] < 1
        ):
            raise ValueError(f"query {kind} semantics are invalid")

    enum_namespaces = {
        "subject_type",
        "person_type",
        "character_role",
        "episode_type",
        *(f"fact_labels.{kind}" for kind in site_fact_roles),
    }

    def validate_field(
        field: object,
        label: str,
        *,
        require_source: bool,
    ) -> None:
        if not isinstance(field, dict):
            raise ValueError(f"{label} is invalid")
        if field.get("type") not in QUERY_FIELD_TYPES:
            raise ValueError(f"{label} has invalid type")
        enum = field.get("enum")
        if enum is not None and (
            field.get("type") != "integer" or enum not in enum_namespaces
        ):
            raise ValueError(f"{label} has invalid enum namespace")
        exposure = field.get("exposure")
        if exposure not in QUERY_EXPOSURES:
            raise ValueError(f"{label} has invalid exposure")
        declared = field.get("capabilities")
        if (
            not isinstance(declared, list)
            or len(declared) != len(set(declared))
            or any(capability not in capability_set for capability in declared)
        ):
            raise ValueError(f"{label} has invalid capabilities")
        if exposure == "evidence" and declared != ["evidence"]:
            raise ValueError(f"{label} evidence field has public capabilities")
        if exposure == "private" and declared:
            raise ValueError(f"{label} private field has public capabilities")
        operators = field.get("operators")
        if operators is not None:
            if operators not in operator_sets:
                raise ValueError(f"{label} has unknown operators")
            if "filter" not in declared:
                raise ValueError(f"{label} has operators without filter")
        if "filter" in declared and operators is None:
            raise ValueError(f"{label} filter has no operators")
        if require_source and not isinstance(field.get("source"), str):
            raise ValueError(f"{label} has no source")

    for owner_name, owner in owners.items():
        fields = owner.get("fields") if isinstance(owner, dict) else None
        if not isinstance(fields, dict) or not fields:
            raise ValueError(f"{owner_name} has no query fields")
        for field_name, field in fields.items():
            validate_field(
                field,
                f"{owner_name}.{field_name}",
                require_source=True,
            )

    fact_fields = contract.get("factFields")
    if not isinstance(fact_fields, dict) or tuple(fact_fields) != (
        "ref",
        "multiplicity",
    ):
        raise ValueError("common query fact fields are invalid")
    for field_name, field in fact_fields.items():
        validate_field(
            field,
            f"fact.{field_name}",
            require_source=True,
        )

    facts = contract.get("facts")
    if (
        not isinstance(facts, dict)
        or set(facts) != set(site_fact_roles)
        or set(site_fact_attrs) != set(site_fact_roles)
    ):
        raise ValueError("query fact kinds do not match SiteRelease")
    for kind, expected_roles in site_fact_roles.items():
        fact = facts[kind]
        roles = fact.get("roles") if isinstance(fact, dict) else None
        if not isinstance(roles, dict) or any(
            owner not in owners for owner in roles.values()
        ):
            raise ValueError(f"{kind} query roles are invalid")
        actual_roles = tuple(_snake_case(role) for role in roles)
        if actual_roles != expected_roles:
            raise ValueError(
                f"{kind} query roles {actual_roles} != {expected_roles}"
            )
        fields = fact.get("fields")
        if not isinstance(fields, dict):
            raise ValueError(f"{kind} query fields are invalid")
        materialized = set(site_fact_attrs[kind])
        covered: set[str] = set()
        for field_name, field in fields.items():
            validate_field(
                field,
                f"{kind}.{field_name}",
                require_source=False,
            )
            source = _snake_case(field_name)
            if source in materialized:
                covered.add(source)
            elif field_name in FACT_DERIVED_FIELDS.get(kind, {}):
                derived_from = FACT_DERIVED_FIELDS[kind][field_name]
                if derived_from not in materialized:
                    raise ValueError(
                        f"{kind}.{field_name} has an invalid derived source"
                    )
            else:
                raise ValueError(
                    f"{kind}.{field_name} is not materialized by SiteRelease"
                )
        uncovered = sorted(materialized - covered)
        if uncovered:
            raise ValueError(
                f"{kind} query fields leave uncovered attributes: "
                + ", ".join(uncovered)
            )
