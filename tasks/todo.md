# Hierarchical 3D Community-Island Layout Tasks

## Task 1: Deterministic island packing

**Acceptance criteria:**
- [x] Initial island bounding spheres have at least the configured gap.
- [x] Packing is deterministic and remains three-dimensional.

**Verification:**
- [x] `uv run python -m unittest tests.test_layout_geometry`

**Dependencies:** None

**Files likely touched:**
- `scripts/layout.py`
- `tests/test_layout_geometry.py`

## Task 2: Component-aware hierarchy

**Acceptance criteria:**
- [x] Giant-component communities become separated islands.
- [x] Small components are satellites and isolated nodes remain the outer shell.
- [x] Shape identity includes every new geometry operation and constant.

**Verification:**
- [x] Focused tests pass.
- [x] Full Python quality gate passes.

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/layout.py`
- `tests/test_layout_geometry.py`
- `docs/EXPLORER_ARCHITECTURE.md`

## Task 3: Real-data rebuild and runtime verification

**Acceptance criteria:**
- [x] Layout report records component, island, gap, and compactness metrics.
- [x] SiteRelease verification passes.
- [x] Real browser view visibly separates the connected-body communities while
  retaining the shell.

**Verification:**
- [x] Run the layout, bake, verify, client, smoke, and browser commands from
  `tasks/spec.md`.

**Dependencies:** Task 2

**Files likely touched:**
- Generated ignored files under `data/layout/` and `site/data/`

## Task 4: Tighten islands and spread their nodes

**Acceptance criteria:**
- [ ] Macro-community centers are visibly closer than the first rebuild.
- [ ] Island-local nearest-neighbor distance increases.
- [ ] The 95% community cores retain a measured positive gap.
- [ ] Satellites remain inside the complete isolated-node shell.

**Verification:**
- [ ] Focused and full quality gates pass.
- [ ] Rebuild the real layout and compare browser screenshots.

**Dependencies:** Task 3
