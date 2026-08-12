# Frontend Query Performance Checklist

- [ ] Inventory every query scenario and its execution path.
- [ ] Capture repeatable cold/warm baseline measurements.
- [ ] Assert baseline result digests, rows, totals, order, and highlights.
- [ ] Optimize measured Worker/data-path bottlenecks one at a time.
- [ ] Remeasure each experiment and revert neutral or slower changes.
- [ ] Profile and optimize initial/result-pagination DOM work.
- [ ] Verify cancellation and stale-result behavior.
- [ ] Run frontend tests, type-check, build, and smoke test.
- [ ] Verify real browser network, console, accessibility, INP, and CLS.
- [ ] Complete five-axis review and record the performance ledger.
- [ ] Commit each retained slice atomically.
