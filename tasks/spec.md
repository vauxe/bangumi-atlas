# Spec: Hierarchical 3D Community-Island Layout

## Objective

Rebuild the global Bangumi atlas so graph structure is readable at a glance
without removing the isolated-node shell. The giant connected component is
split into visibly separated 3D community islands, smaller connected
components become satellite islands, and every degree-zero node remains on the
outer Fibonacci sphere.

## Tech Stack

- Python 3.12, NumPy, python-igraph, SciPy, PyArrow
- Offline layout in `scripts/layout.py`
- Existing Parquet layout and SiteRelease binary contracts
- deck.gl client remains unchanged

## Commands

```bash
uv run python -m unittest tests.test_layout_geometry
uv run python -m unittest discover -s tests
uv run ruff check scripts tests
uv run ruff format --check scripts tests
uv run mypy scripts
uv run python scripts/layout.py
uv run python scripts/bake_site.py
uv run python scripts/verify_site.py
npm --prefix web run test
npm --prefix web run check
npm --prefix web run build
```

## Project Structure

- `scripts/layout.py`: component partitioning, community islands, satellites,
  outer shell, and geometry report
- `tests/test_layout_geometry.py`: deterministic geometry behavior
- `docs/EXPLORER_ARCHITECTURE.md`: stable layout architecture
- `tasks/`: implementation specification and checkpoints

## Code Style

Keep layout operations as deterministic, typed NumPy transformations:

```python
centers = pack_island_centers(desired_centers, radii, ISLAND_GAP)
coords[members] = local_coords + centers[community]
```

Use snake_case, explicit array shapes, seeded igraph randomness, Ruff's
79-column limit, and no new dependencies.

## Testing Strategy

- Unit-test community island separation, shell preservation, component
  placement, determinism, and shape identity.
- Run the full Python quality gate after focused tests pass.
- Rebuild the real 985k-node layout and verify quantitative report metrics.
- Re-bake and independently verify SiteRelease, then inspect the real WebGL
  result in an isolated local browser.

## Boundaries

- Always: keep all isolated nodes, preserve 3D depth, preserve binary geometry
  contracts, seed all stochastic algorithms, and report measured geometry.
- Ask first: add a dependency, change SiteRelease binary formats, remove nodes,
  flatten the graph to 2D, or change client interaction behavior.
- Never: overwrite unrelated worktree changes, publish generated data, or make
  visual claims without a real-data browser check.

## Success Criteria

- Every degree-zero node lies on one outer sphere beyond all connected nodes.
- The largest component is partitioned into 30-80 macro communities on the
  current snapshot.
- Macro-community bounding spheres do not overlap and have a positive gap.
- Non-giant connected components lie outside the giant body and inside the
  isolated shell.
- Output is deterministic for identical input and remains genuinely 3D.
- Layout, bake, independent verification, client tests/build, and browser
  inspection complete successfully.

## Open Questions

None. The user explicitly approved preserving the shell and rebuilding the
global view with hierarchical 3D community islands.
