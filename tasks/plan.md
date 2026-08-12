# Implementation Plan: Frontend Query Performance

## Overview

Profile every user-visible query path against the current SiteRelease, then
land only optimizations whose gains exceed measurement noise and whose output
is byte-for-byte or semantically identical to the existing exact query result.
The work stays inside the static-site client and does not change the query
contract or published data semantics.

## Architecture Decisions

- Treat `QueryDocument` output, evidence, ordering, totals, and graph highlights
  as the correctness boundary; performance changes must preserve all of them.
- Measure cold and warm behavior separately. Compare before and after under the
  same cache, network, CPU, query, and result-size conditions.
- Optimize in independent slices: Worker execution/I/O first, result rendering
  second, then regression budgets and documentation.
- Keep broad scans memory-bounded. Concurrent or cached execution is allowed
  only when analysis proves it cannot turn an unbounded query into an
  unbounded in-memory buffer.
- Record kept and rejected experiments in `docs/QUERY_PERFORMANCE.md` so neutral
  ideas are not retried later.

## Query Scenario Matrix

1. Canvas name suggestions for Subject, Person, and Character.
2. Episode name suggestions through the query Worker.
3. Single-owner and multi-owner structural name lookup.
4. Attribute-only scan/filter, including ordered Top-N and unbounded results.
5. Name plus full-text intersection (`exists`).
6. Relationship `exists` / `notExists` and reverse Episode ownership.
7. Aggregate and group-by queries.
8. Global full-text query across entity and fact sections.
9. Comparison queries using union, intersect, and except.
10. Bounded shortest-path queries.
11. Initial result transfer, buffered “show more”, and later Worker pages.
12. Cancellation, stale-query replacement, exact totals, and graph highlights.

## Task List

### Phase 1: Baseline and correctness oracle

- [x] Task 1: Add a repeatable scenario benchmark and capture cold/warm baselines.
- [x] Task 2: Document request, byte, latency, main-thread, and memory findings.

### Checkpoint: Baseline

- [x] Every scenario has a correctness assertion and at least one measured run.
- [x] Bottlenecks are ranked by user impact rather than code appearance.

### Phase 2: Worker and data-path slices

- [x] Task 3: Optimize the highest-impact indexed-query bottleneck with a failing
      concurrency/I/O regression test, then remeasure it.
- [x] Task 4: Audit scans, relations, aggregates, sets, paths, pagination, and
      highlight resolution; keep only independently measured improvements.

### Checkpoint: Query execution

- [x] Query rows, evidence, totals, ordering, coverage, and highlights match the
      baseline oracle for all affected scenarios.
- [x] Broad scans remain bounded by the existing security and cache budgets.

### Phase 3: Main-thread result presentation

- [x] Task 5: Profile first render and repeated “show more” interactions.
- [x] Task 6: Remove proven redundant DOM work while preserving focus,
      accessibility, and result order.

### Checkpoint: Browser runtime

- [x] Fast 4G plus 4x CPU query interaction recorded INP 187 ms and CLS 0.
- [x] The accessibility tree retains one labeled, focused “show more” control.

### Phase 4: Guard and review

- [x] Task 7: Add deterministic performance-contract tests or budgets for each
      retained optimization.
- [x] Task 8: Run full frontend and data verification, complete the five-axis
      review, and update the performance ledger.

### Checkpoint: Complete

- [x] All retained changes have before/after evidence outside measurement noise.
- [x] Full test, type-check, build, smoke, and browser verification pass.
- [x] Each implementation slice is independently committed and rollback-safe.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Parallel branch execution raises peak memory | High | Restrict concurrency to proven bounded/indexed branches and test broad-scan fallback |
| Pagination cache changes exact semantics | High | Compare rows, evidence, totals, order, coverage, and release identity before reuse |
| Rendering reuse leaves stale nodes or handlers | Medium | Require monotonic prefix identity; otherwise fall back to a full render |
| Local HTTP/1.1 exaggerates request cost | Medium | Report request/byte deltas separately and validate CPU/INP under throttling |
| Timing tests become flaky | Medium | Keep timing out of unit gates; use deterministic scheduling and work-count contracts |

## Open Questions

- Production RUM/CrUX data is not available locally, so synthetic browser traces
  and deterministic work-count tests are the current evidence source.
- CDN protocol and cache headers must be verified in deployment before treating
  local HTTP/1.1 waterfall latency as a production latency prediction.

## Whole-frontend continuation

The query audit above is complete. The follow-up audit covers the rest of the
desktop explorer without weakening the existing query correctness boundary.

### Phase 5: Initial load and interaction baseline

- [x] Task 9: Measure the production bundle by module family and record initial
      script, CSS, geometry, parse, and startup costs.
- [x] Task 10: Benchmark camera anchoring, nearby labels, selection rendering,
      drawer opening, and name/tag suggestions against the 996,459-node release.

### Phase 6: Main-thread and data-path slices

- [x] Task 11: Remove proven allocation or sorting work from camera/label hot
      paths while preserving exact rank selection and visual behavior.
- [x] Task 12: Avoid entity-type-inapplicable vocabulary reads and other proven
      drawer/search data over-fetch while preserving decoded entity values.

### Phase 7: Delivery and bundle slices

- [x] Task 13: Evaluate query-UI code splitting against the current 953 KiB
      production app bundle; retain it only if initial bytes/parse improve
      without delaying the documented query interaction contract.
- [x] Task 14: Add stable bundle/work-count guards and record both retained and
      rejected experiments in a whole-frontend performance ledger.

### Checkpoint: Whole frontend complete

- [x] Every retained change has same-condition before/after measurements.
- [x] Camera picks, labels, drawer values, search order, query output, focus, and
      accessibility remain correct.
- [x] Full tests, type-check, production build, real-release smoke, browser
      console/network/accessibility, and representative traces pass.
