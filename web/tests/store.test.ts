import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginSelection,
  clearPinnedSelections,
  removePinnedSelection,
  state,
  togglePinnedSelection,
} from "../src/store";

test("begins a selection without exposing the previous node's relation fan", () => {
  const previous = {
    selection: state.selection,
    selectionKey: state.selectionKey,
    neighbors: state.neighbors,
    neighborLabels: state.neighborLabels,
  };
  try {
    state.selection = 7;
    state.selectionKey = 70;
    state.neighbors = [8, 9];
    state.neighborLabels = ["旧关系甲", "旧关系乙"];
    const oldNeighbors = state.neighbors;
    const oldLabels = state.neighborLabels;

    beginSelection(12, 120);

    assert.equal(state.selection, 12);
    assert.equal(state.selectionKey, 120);
    assert.deepEqual(state.neighbors, []);
    assert.deepEqual(state.neighborLabels, []);
    assert.notEqual(state.neighbors, oldNeighbors);
    assert.notEqual(state.neighborLabels, oldLabels);
  } finally {
    Object.assign(state, previous);
  }
});

test("toggles multiple pinned nodes without coupling them to current selection", () => {
  const previousSelection = state.selection;
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  const previousNeighbors = state.neighbors;
  const previousLabels = state.neighborLabels;
  try {
    state.selection = 99;
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.neighbors = [7, 8];
    state.neighborLabels = ["关系甲", "关系乙"];

    assert.equal(togglePinnedSelection(99), true);
    assert.deepEqual(state.pinnedWorkingSets.get(99), {
      ranks: [7, 8],
      labels: ["关系甲", "关系乙"],
    });
    state.neighbors.push(10);
    assert.deepEqual(
      state.pinnedWorkingSets.get(99)?.ranks,
      [7, 8],
      "a retained fan must be an immutable snapshot of the current expansion",
    );

    assert.equal(togglePinnedSelection(7), true);
    assert.equal(togglePinnedSelection(9), true);
    assert.deepEqual([...state.pinnedSelections], [99, 7, 9]);
    assert.equal(state.selection, 99);

    assert.equal(togglePinnedSelection(7), false);
    assert.deepEqual([...state.pinnedSelections], [99, 9]);
    assert.equal(state.pinnedWorkingSets.has(7), false);
    assert.equal(state.selection, 99);
  } finally {
    state.selection = previousSelection;
    state.neighbors = previousNeighbors;
    state.neighborLabels = previousLabels;
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("removes one or all retained nodes without changing the current focus", () => {
  const previousSelection = state.selection;
  const previousPinned = new Set(state.pinnedSelections);
  const previousWorkingSets = new Map(state.pinnedWorkingSets);
  try {
    state.selection = 99;
    state.pinnedSelections.clear();
    state.pinnedWorkingSets.clear();
    state.pinnedSelections.add(7);
    state.pinnedSelections.add(9);
    state.pinnedWorkingSets.set(7, { ranks: [8], labels: ["关联"] });
    state.pinnedWorkingSets.set(9, { ranks: [10], labels: ["关联"] });

    assert.equal(removePinnedSelection(7), true);
    assert.deepEqual([...state.pinnedSelections], [9]);
    assert.equal(state.pinnedWorkingSets.has(7), false);
    assert.equal(removePinnedSelection(7), false);
    assert.equal(state.selection, 99);

    assert.equal(clearPinnedSelections(), true);
    assert.deepEqual([...state.pinnedSelections], []);
    assert.equal(state.pinnedWorkingSets.size, 0);
    assert.equal(clearPinnedSelections(), false);
    assert.equal(state.selection, 99);
  } finally {
    state.selection = previousSelection;
    state.pinnedSelections.clear();
    for (const rank of previousPinned) state.pinnedSelections.add(rank);
    state.pinnedWorkingSets.clear();
    for (const [rank, workingSet] of previousWorkingSets)
      state.pinnedWorkingSets.set(rank, workingSet);
  }
});

test("publishes immutable retained-node snapshots for render-cache invalidation", () => {
  const previous = {
    selection: state.selection,
    pinnedSelections: state.pinnedSelections,
    pinnedWorkingSets: state.pinnedWorkingSets,
    neighbors: state.neighbors,
    neighborLabels: state.neighborLabels,
  };
  try {
    state.selection = 7;
    state.pinnedSelections = new Set();
    state.pinnedWorkingSets = new Map();
    state.neighbors = [8];
    state.neighborLabels = ["关联"];
    const emptySelections = state.pinnedSelections;
    const emptyWorkingSets = state.pinnedWorkingSets;

    togglePinnedSelection(7);

    assert.notEqual(state.pinnedSelections, emptySelections);
    assert.notEqual(state.pinnedWorkingSets, emptyWorkingSets);
    const pinnedSelections = state.pinnedSelections;
    const pinnedWorkingSets = state.pinnedWorkingSets;
    assert.equal(removePinnedSelection(99), false);
    assert.equal(state.pinnedSelections, pinnedSelections);
    assert.equal(state.pinnedWorkingSets, pinnedWorkingSets);

    assert.equal(clearPinnedSelections(), true);
    assert.notEqual(state.pinnedSelections, pinnedSelections);
    assert.notEqual(state.pinnedWorkingSets, pinnedWorkingSets);
  } finally {
    Object.assign(state, previous);
  }
});
