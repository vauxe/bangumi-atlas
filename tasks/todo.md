# Frontend Query Performance Checklist

- [x] Inventory every query scenario and its execution path.
- [x] Capture repeatable cold/warm baseline measurements.
- [x] Assert baseline result digests, rows, totals, order, and highlights.
- [x] Optimize measured Worker/data-path bottlenecks one at a time.
- [x] Remeasure each experiment and revert neutral or slower changes.
- [x] Profile and optimize initial/result-pagination DOM work.
- [x] Verify cancellation and stale-result behavior.
- [x] Run frontend tests, type-check, build, and smoke test.
- [x] Verify real browser network, accessibility, INP, and CLS.
- [x] Complete five-axis review and record the performance ledger.
- [x] Commit each retained slice atomically.

## Whole-frontend continuation

- [ ] Capture bundle and real-release startup/interaction baselines.
- [ ] Optimize measured camera and label main-thread hotspots.
- [ ] Eliminate measured drawer/search data over-fetch.
- [ ] Measure a query-UI bundle split and keep or revert it.
- [ ] Add performance guards and a whole-frontend ledger.
- [ ] Run full automated, real-data, and browser verification.
- [ ] Complete five-axis review and commit each retained slice atomically.
