import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUERY_CONTRACT,
  assertFieldCapability,
  factFieldDefinition,
  fieldDefinition,
  parseEntityRef,
  parseFactRef,
} from "../src/query/contract";

test("declares every public owner and complete canonical fact roles", () => {
  assert.deepEqual(Object.keys(QUERY_CONTRACT.owners), [
    "subject",
    "person",
    "character",
    "episode",
  ]);
  assert.deepEqual(QUERY_CONTRACT.facts.VOICE_CREDIT.roles, {
    person: "person",
    character: "character",
    subjectContext: "subject",
  });
  assert.deepEqual(QUERY_CONTRACT.facts.WORKED_ON.roles, {
    person: "person",
    subject: "subject",
  });
});

test("resolves fields only through their owner registry", () => {
  assert.equal(fieldDefinition("subject", "score").type, "number");
  assert.equal(fieldDefinition("person", "career").type, "string[]");
  assert.throws(() => fieldDefinition("person", "score"), /person.score/);
});

test("resolves common fact fields through the published contract", () => {
  assert.equal(QUERY_CONTRACT.factFields.ref.type, "fact-ref");
  assert.equal(factFieldDefinition("WORKED_ON", "ref"), QUERY_CONTRACT.factFields.ref);
  assert.equal(
    factFieldDefinition("VOICE_CREDIT", "multiplicity"),
    QUERY_CONTRACT.factFields.multiplicity,
  );
});

test("publishes search semantics and every numeric enum namespace", () => {
  assert.equal(QUERY_CONTRACT.search.lookup.minNormalizedCharacters, 2);
  assert.equal(QUERY_CONTRACT.search.fullText.minNormalizedCharacters, 2);
  assert.equal(fieldDefinition("subject", "type").enum, "subject_type");
  assert.equal(fieldDefinition("person", "type").enum, "person_type");
  assert.equal(fieldDefinition("character", "role").enum, "character_role");
  assert.equal(fieldDefinition("episode", "type").enum, "episode_type");
  assert.equal(
    factFieldDefinition("WORKED_ON", "position").enum,
    "fact_labels.WORKED_ON",
  );
});

test("keeps provenance values as evidence instead of query dimensions", () => {
  assert.deepEqual(fieldDefinition("subject", "scoreDetails").capabilities, ["evidence"]);
  assert.equal(fieldDefinition("subject", "scoreDetails").exposure, "evidence");
  assert.deepEqual(QUERY_CONTRACT.factFields.multiplicity.capabilities, ["evidence"]);
  assert.equal(QUERY_CONTRACT.factFields.multiplicity.exposure, "evidence");
});

test("separates lookup, full text, evidence, and private field behavior", () => {
  assert.equal(QUERY_CONTRACT.schema, "atlas-query-v2");
  assert.deepEqual(fieldDefinition("subject", "summary").capabilities, [
    "fullText",
    "evidence",
  ]);
  assert.equal(fieldDefinition("subject", "infobox").exposure, "evidence");
  assert.equal(fieldDefinition("subject", "tags").type, "tag[]");
  assert.doesNotThrow(() =>
    assertFieldCapability("subject", "summary", "fullText"),
  );
  assert.throws(
    () => assertFieldCapability("subject", "summary", "filter"),
    /does not support filter/,
  );
  assert.throws(
    () => assertFieldCapability("subject", "hasSummary", "project"),
    /private/,
  );
});

test("exposes long-text presence as a logical state without exposing storage bits", () => {
  assert.equal(fieldDefinition("subject", "hasSummary").exposure, "private");
  assert.deepEqual(fieldDefinition("subject", "summaryState").capabilities, [
    "project",
    "filter",
    "group",
  ]);
  assert.equal(fieldDefinition("episode", "descriptionState").source, "derived:hasDescription");
});

test("does not invent Chinese-name fields absent from Person and Character", () => {
  assert.equal(QUERY_CONTRACT.owners.person.fields.nameCn, undefined);
  assert.equal(QUERY_CONTRACT.owners.character.fields.nameCn, undefined);
  assert.equal(fieldDefinition("subject", "nameCn").source, "name");
  assert.equal(fieldDefinition("episode", "nameCn").source, "core");
});

test("names generated script variants without claiming archive aliases", () => {
  assert.equal(
    fieldDefinition("subject", "nameVariant").source,
    "derived:scriptVariant",
  );
  assert.equal(QUERY_CONTRACT.owners.subject.fields.alias, undefined);
});

test("exposes a decoded platform instead of its ambiguous raw code", () => {
  assert.equal(fieldDefinition("subject", "platform").type, "string");
  assert.equal(fieldDefinition("subject", "platform").nullable, true);
  assert.equal(QUERY_CONTRACT.owners.subject.fields.platformCode, undefined);
});

test("accepts only canonical public entity and release-local fact refs", () => {
  assert.deepEqual(parseEntityRef("subject:0"), {
    owner: "subject",
    archiveId: 0,
  });
  assert.deepEqual(parseEntityRef("character:42"), {
    owner: "character",
    archiveId: 42,
  });
  assert.equal(parseFactRef("fact:7"), 7);

  for (const invalid of [
    "subject:01",
    "subject:-1",
    "fact:01",
    "unknown:1",
    "episode:1.5",
  ]) {
    assert.throws(
      () =>
        invalid.startsWith("fact:")
          ? parseFactRef(invalid)
          : parseEntityRef(invalid),
      /canonical|reference/,
    );
  }
});
