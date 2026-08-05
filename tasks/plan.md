# Implementation Plan: Hierarchical 3D Community Islands

## Overview

Replace the single embedding of every non-isolated component with a
component-aware hierarchy while preserving the published coordinate contract.
The highest-risk piece is deterministic collision-free island packing, so it
is implemented and tested before the full-data orchestration.

## Architecture Decisions

- Detect connected components before embedding; never ask UMAP to arrange
  unrelated components in the same topology volume.
- Use coarse Leiden communities only inside the giant component.
- Layout each macro community locally with UMAP, establish stable full-sphere
  centers, then spread local nodes and repack their 95%-core spheres according
  to the weighted community supergraph.
- Layout all small components together for efficiency, recenter each component,
  and place their islands on a satellite sphere.
- Preserve the existing isolated Fibonacci shell outside every connected node.
- Keep `positions.bin` and frontend behavior unchanged.

## Task List

### Phase 1: Geometry Primitives

- [x] Add failing tests for deterministic non-overlapping island centers.
- [x] Implement island packing and component-aware shaping primitives.

### Checkpoint: Geometry

- [x] Focused layout tests pass.
- [x] Existing shell and 3D-depth tests still pass.

### Phase 2: Hierarchical Layout

- [x] Add failing tests for community/satellite orchestration.
- [x] Implement giant-component community partitioning and supergraph layout.
- [x] Implement small-component satellite placement and report metrics.

### Checkpoint: Pipeline

- [x] Full Python tests, Ruff, formatting, and mypy pass.
- [x] Architecture documentation matches the implementation.

### Phase 3: Real-Data Rebuild

- [x] Rebuild `data/layout` from the current Parquet snapshot.
- [x] Bake and independently verify `site/data`.
- [x] Run client tests, type check, build, smoke test, and browser inspection.

### Checkpoint: Complete

- [x] All spec success criteria are measured and satisfied.
- [x] Generated output remains ignored and source changes are reviewable.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Full layout exceeds CI time | High | Partition UMAP work; keep satellites in one small embedding |
| Community islands overlap after packing | High | Unit-test bounding-sphere gap and publish the measured minimum |
| Fine Leiden count drifts | Medium | Merge fine groups into a fixed number of deterministic large anchors |
| Huge communities dominate world scale | Medium | Robust local quantile scaling plus collision-aware radii |
| Shell no longer clears satellites | High | Derive shell radius from the final connected extent and test it |

### Phase 4: Compactness Tuning

- [x] Repack macro communities around their dense cores.
- [x] Increase local node spacing independently of island-center spacing.
- [ ] Rebuild and compare real-data browser output against the first island layout.

## Open Questions

None.
