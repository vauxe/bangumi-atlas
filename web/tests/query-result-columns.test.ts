import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultResultColumnSelection,
  defaultResultProjection,
  normalizeResultColumnSelection,
  resultColumnChoices,
  resultProjection,
} from "../src/query/result-columns";

test("keeps one authoritative default projection for each entity type", () => {
  assert.deepEqual(defaultResultProjection("subject"), [
    "ref", "name", "nameCn", "type", "date", "score", "rank",
  ]);
  assert.deepEqual(defaultResultColumnSelection(["subject"]), [
    "type", "date", "score", "rank",
  ]);
  assert.deepEqual(defaultResultColumnSelection([
    "subject", "person", "character",
  ]), ["entityType"]);
});

test("offers every displayable column without exposing identity internals", () => {
  const choices = resultColumnChoices(["subject", "person", "character"]);

  assert.deepEqual(choices.find(({ field }) => field === "entityType"), {
    field: "entityType",
    owners: ["subject", "person", "character"],
  });
  assert.deepEqual(choices.find(({ field }) => field === "score"), {
    field: "score",
    owners: ["subject"],
  });
  assert.deepEqual(choices.find(({ field }) => field === "comments"), {
    field: "comments",
    owners: ["person", "character"],
  });
  assert.equal(choices.some(({ field }) => field === "ref"), false);
  assert.equal(choices.some(({ field }) => field === "name"), false);
  assert.equal(choices.some(({ field }) => field === "nameCn"), false);
  assert.equal(choices.some(({ field }) => field === "id"), false);
  assert.equal(choices.some(({ field }) => field === "subjectRef"), false);
});

test("turns a column selection into an identity-safe projection", () => {
  assert.deepEqual(resultProjection(["subject"], ["score", "date"]), [
    "ref", "name", "nameCn", "score", "date",
  ]);
  assert.deepEqual(resultProjection([
    "subject", "person", "character",
  ], ["score", "comments"]), [
    "ref", "name", "nameCn", "score", "comments",
  ]);
  assert.deepEqual(resultProjection([
    "subject", "person", "character",
  ], ["entityType", "score"]), [
    "ref", "name", "nameCn", "entityType", "score",
  ]);
  assert.deepEqual(resultProjection(["person"], []), ["ref", "name"]);
});

test("keeps compatible choices when the entity scope changes", () => {
  assert.deepEqual(normalizeResultColumnSelection(
    ["person", "character"],
    ["entityType", "score", "comments", "ref", "name"],
  ), ["entityType", "comments"]);
  assert.deepEqual(normalizeResultColumnSelection(
    ["person"],
    ["entityType", "score"],
  ), []);
});
