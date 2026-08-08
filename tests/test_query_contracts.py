from __future__ import annotations

import copy
import unittest

from scripts import site_release as sr
from scripts.query_contracts import (
    load_query_contract,
    query_schema_digest,
    validate_query_contract,
)


class QueryContractTests(unittest.TestCase):
    def test_contract_is_self_consistent_and_matches_site_fact_roles(
        self,
    ) -> None:
        contract = load_query_contract()

        validate_query_contract(contract, sr.FACT_ROLES, sr.FACT_ATTRS)

        self.assertEqual(contract["schema"], "atlas-query-v2")
        self.assertEqual(len(query_schema_digest()), 64)
        self.assertNotEqual(
            query_schema_digest(),
            sr.schema_digest(),
            "query and physical schema digests are independent contracts",
        )

    def test_rejects_operators_the_runtime_cannot_execute(self) -> None:
        contract = copy.deepcopy(load_query_contract())
        contract["operatorSets"]["ordered"].append("explode")

        with self.assertRaisesRegex(ValueError, "unsupported operator"):
            validate_query_contract(contract, sr.FACT_ROLES, sr.FACT_ATTRS)

    def test_reconciles_query_fact_fields_with_site_fact_attributes(
        self,
    ) -> None:
        contract = copy.deepcopy(load_query_contract())
        contract["facts"]["RELATES_TO"]["fields"]["ghost"] = {
            "type": "integer",
            "exposure": "evidence",
            "capabilities": ["evidence"],
        }

        with self.assertRaisesRegex(ValueError, "not materialized"):
            validate_query_contract(contract, sr.FACT_ROLES, sr.FACT_ATTRS)

        contract = copy.deepcopy(load_query_contract())
        del contract["facts"]["RELATES_TO"]["fields"]["sortOrder"]
        with self.assertRaisesRegex(ValueError, "uncovered attributes"):
            validate_query_contract(contract, sr.FACT_ROLES, sr.FACT_ATTRS)

    def test_every_field_declares_one_exposure_and_valid_capabilities(
        self,
    ) -> None:
        contract = load_query_contract()
        operator_sets = set(contract["operatorSets"])
        capabilities = set(contract["capabilities"])

        field_groups = [
            *(owner["fields"] for owner in contract["owners"].values()),
            contract["factFields"],
            *(fact["fields"] for fact in contract["facts"].values()),
        ]
        for fields in field_groups:
            for field in fields.values():
                self.assertIn(
                    field["exposure"],
                    {"query", "evidence", "private"},
                )
                self.assertTrue(set(field["capabilities"]) <= capabilities)
                if "operators" in field:
                    self.assertIn(field["operators"], operator_sets)
                    self.assertIn("filter", field["capabilities"])
                if field["exposure"] == "evidence":
                    self.assertEqual(field["capabilities"], ["evidence"])
                if field["exposure"] == "private":
                    self.assertEqual(field["capabilities"], [])

    def test_long_text_infobox_and_structured_values_keep_product_semantics(
        self,
    ) -> None:
        contract = load_query_contract()
        subject = contract["owners"]["subject"]["fields"]

        self.assertEqual(
            subject["summary"]["capabilities"],
            ["fullText", "evidence"],
        )
        self.assertNotIn("operators", subject["summary"])
        self.assertEqual(subject["infobox"]["exposure"], "evidence")
        self.assertEqual(subject["infobox"]["capabilities"], ["evidence"])
        self.assertEqual(subject["tags"]["type"], "tag[]")
        self.assertEqual(
            subject["nameVariant"]["source"],
            "derived:scriptVariant",
        )
        self.assertEqual(subject["hasSummary"]["exposure"], "private")
        self.assertEqual(subject["year"]["source"], "derived:date")
        self.assertTrue(subject["year"]["nullable"])
        self.assertEqual(
            contract["owners"]["episode"]["fields"]["year"]["source"],
            "derived:airdate",
        )
        self.assertEqual(
            subject["summaryState"]["capabilities"],
            ["project", "filter", "group"],
        )

    def test_only_authoritative_chinese_names_are_query_fields(self) -> None:
        owners = load_query_contract()["owners"]

        self.assertIn("nameCn", owners["subject"]["fields"])
        self.assertIn("nameCn", owners["episode"]["fields"])
        self.assertNotIn("nameCn", owners["person"]["fields"])
        self.assertNotIn("nameCn", owners["character"]["fields"])

    def test_common_fact_fields_are_part_of_the_shared_contract(self) -> None:
        fields = load_query_contract()["factFields"]

        self.assertEqual(fields["ref"]["type"], "fact-ref")
        self.assertEqual(
            fields["ref"]["capabilities"], ["project", "evidence"]
        )
        self.assertEqual(fields["multiplicity"]["type"], "integer")
        self.assertEqual(fields["multiplicity"]["exposure"], "evidence")
        self.assertEqual(fields["multiplicity"]["capabilities"], ["evidence"])

    def test_search_constraints_are_public_semantics(self) -> None:
        search = load_query_contract()["search"]

        self.assertEqual(search["lookup"]["minNormalizedCharacters"], 2)
        self.assertEqual(search["fullText"]["minNormalizedCharacters"], 2)

    def test_every_numeric_domain_value_declares_its_enum_namespace(
        self,
    ) -> None:
        contract = load_query_contract()
        owners = contract["owners"]
        facts = contract["facts"]

        self.assertEqual(
            owners["subject"]["fields"]["type"]["enum"], "subject_type"
        )
        self.assertEqual(
            owners["person"]["fields"]["type"]["enum"], "person_type"
        )
        self.assertTrue(owners["person"]["fields"]["type"]["nullable"])
        self.assertEqual(
            owners["person"]["fields"]["type"]["source"],
            "derived:officialPersonType",
        )
        self.assertEqual(
            owners["character"]["fields"]["role"]["enum"],
            "character_role",
        )
        self.assertEqual(
            owners["episode"]["fields"]["type"]["enum"], "episode_type"
        )
        self.assertEqual(
            facts["WORKED_ON"]["fields"]["position"]["enum"],
            "fact_labels.WORKED_ON",
        )
        self.assertEqual(
            facts["VOICE_CREDIT"]["fields"]["type"]["enum"],
            "fact_labels.VOICE_CREDIT",
        )

    def test_provenance_structures_are_evidence_not_query_dimensions(
        self,
    ) -> None:
        contract = load_query_contract()

        score_details = contract["owners"]["subject"]["fields"]["scoreDetails"]
        self.assertEqual(score_details["exposure"], "evidence")
        self.assertEqual(score_details["capabilities"], ["evidence"])

    def test_platform_is_a_decoded_query_value(self) -> None:
        fields = load_query_contract()["owners"]["subject"]["fields"]

        self.assertEqual(fields["platform"]["type"], "string")
        self.assertTrue(fields["platform"]["nullable"])
        self.assertNotIn("platformCode", fields)


if __name__ == "__main__":
    unittest.main()
