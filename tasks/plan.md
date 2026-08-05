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
- Layout each macro community locally with UMAP, then place collision-free
  bounding spheres according to a weighted community supergraph.
- Layout all small components together for efficiency, recenter each component,
  and place their islands on a satellite sphere.
- Preserve the existing isolated Fibonacci shell outside every connected node.
- Keep `positions.bin` and frontend behavior unchanged.

## Task List

### Phase 1: Geometry Primitives

- [ ] Add failing tests for deterministic non-overlapping island centers.
- [ ] Implement island packing and component-aware shaping primitives.

### Checkpoint: Geometry

- [ ] Focused layout tests pass.
- [ ] Existing shell and 3D-depth tests still pass.

### Phase 2: Hierarchical Layout

- [ ] Add failing tests for community/satellite orchestration.
- [ ] Implement giant-component community partitioning and supergraph layout.
- [ ] Implement small-component satellite placement and report metrics.

### Checkpoint: Pipeline

- [ ] Full Python tests, Ruff, formatting, and mypy pass.
- [ ] Architecture documentation matches the implementation.

### Phase 3: Real-Data Rebuild

- [ ] Rebuild `data/layout` from the current Parquet snapshot.
- [ ] Bake and independently verify `site/data`.
- [ ] Run client tests, type check, build, smoke test, and browser inspection.

### Checkpoint: Complete

- [ ] All spec success criteria are measured and satisfied.
- [ ] Generated output remains ignored and source changes are reviewable.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Full layout exceeds CI time | High | Partition UMAP work; keep satellites in one small embedding |
| Community islands overlap after packing | High | Unit-test bounding-sphere gap and publish the measured minimum |
| Coarse Leiden count drifts | Medium | Deterministically search a bounded resolution ladder |
| Huge communities dominate world scale | Medium | Robust local quantile scaling plus collision-aware radii |
| Shell no longer clears satellites | High | Derive shell radius from the final connected extent and test it |

## Open Questions

None.
