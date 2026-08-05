# Hierarchical 3D Community-Island Layout Tasks

## Task 1: Deterministic island packing

**Acceptance criteria:**
- [ ] Island bounding spheres have at least the configured gap.
- [ ] Packing is deterministic and remains three-dimensional.

**Verification:**
- [ ] `uv run python -m unittest tests.test_layout_geometry`

**Dependencies:** None

**Files likely touched:**
- `scripts/layout.py`
- `tests/test_layout_geometry.py`

## Task 2: Component-aware hierarchy

**Acceptance criteria:**
- [ ] Giant-component communities become separated islands.
- [ ] Small components are satellites and isolated nodes remain the outer shell.
- [ ] Shape identity includes every new geometry operation and constant.

**Verification:**
- [ ] Focused tests pass.
- [ ] Full Python quality gate passes.

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/layout.py`
- `tests/test_layout_geometry.py`
- `docs/EXPLORER_ARCHITECTURE.md`

## Task 3: Real-data rebuild and runtime verification

**Acceptance criteria:**
- [ ] Layout report records component, island, gap, and compactness metrics.
- [ ] SiteRelease verification passes.
- [ ] Real browser view visibly separates the connected-body communities while
  retaining the shell.

**Verification:**
- [ ] Run the layout, bake, verify, client, smoke, and browser commands from
  `tasks/spec.md`.

**Dependencies:** Task 2

**Files likely touched:**
- Generated ignored files under `data/layout/` and `site/data/`
