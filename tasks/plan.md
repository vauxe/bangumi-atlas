# Clustered layout implementation plan

## Task 1 — Freeze the contract and baseline

- Deliverables: approved layout specification, measurable acceptance criteria, implementation checklist.
- Files: `docs/CLUSTERED_LAYOUT_SPEC.md`, `tasks/plan.md`, `tasks/todo.md`.
- Verification: spec contains context, users, requirements, non-functional requirements, boundaries, and acceptance criteria.

## Task 2 — Build the pure clustered geometry

- Deliverables: deterministic circle packing and clustered coordinate shaping.
- Files: `scripts/layout.py`, `tests/test_layout_geometry.py`.
- Verification: observe new tests fail before implementation, then pass tests for non-overlap, determinism, local cohesion, islands, halo, and depth.

## Task 3 — Integrate the CLI and report

- Deliverables: `clustered` algorithm option, independent output directory, compatible Parquet output, layout quality metrics.
- Files: `scripts/layout.py`, `tests/test_layout_geometry.py`.
- Verification: focused tests and a stub CLI run produce `coords.parquet` and `report.json` without altering the default output path.

## Task 4 — Validate on full data and document

- Deliverables: measured UMAP/clustered comparison and updated explorer architecture.
- Files: `docs/EXPLORER_ARCHITECTURE.md`, `README.md`, `tasks/todo.md`.
- Verification: full test suite, Ruff, mypy, full-data layout report, metric comparison, clean Git status after commits.

