# ADR-001: Enforce global node separation in published coordinates

## Status

Accepted

## Date

2026-08-05

## Context

The 985,328-node layout contained physically overlapping positions. In the
current raw layout, 850,288 nodes had a nearest neighbor closer than the 0.28
world-unit center distance needed by focused 18-pixel nodes; after publishing,
there were about 37.4 million pairs within 0.2801. This is a coordinate problem,
not a selection or zoom effect.

The frontend uses the release bbox to frame the whole graph, while focused node
sizes and camera levels assume a stable nominal world scale. A collision pass
before the final scale conversion would be unsafe because a later shrink could
reintroduce overlaps.

## Decision

`bake_site.py` first maps the arbitrary layout scale to the nominal 600-unit
world span, then runs a deterministic, vectorized global separation pass on
VisualRank-ordered coordinates. Published points occupy unique cells on a
lightly jittered three-dimensional lattice. The lattice has a conservative
0.29 theoretical clearance, so float32 `positions.bin` must satisfy the public
0.28 minimum center-distance contract.

The separation pass may expand the final bbox and no scaling is allowed after
it. The manifest records the contract and displacement statistics.
`verify_site.py` independently scans final float32 positions with chunked
nearest-neighbor queries and fails on the first violation.

## Alternatives Considered

### Selection-only screen-space spreading

Rejected because it hides overlap only for the current working set. The user
observed physically coincident coordinates and requires all nodes to be
non-overlapping.

### Materialize all close pairs

Rejected because the current release has about 37.4 million close pairs. Pair
materialization would consume hundreds of megabytes in addition to the layout.

### Sequential Python spatial hash

Rejected after a real-data benchmark exceeded 50 seconds for only 100,000
nodes. It bounded memory but made the build unacceptably slow.

### Iterative nearest-neighbor repulsion

Rejected because the number of violating nodes decreased too slowly and the
method did not provide a simple deterministic convergence bound.

### Remove the 600-unit normalization

Rejected as the overlap fix. The current raw span is 557.91, so normalization
actually enlarges distances by about 7.5%; 850,288 raw nodes still violate the
0.28 contract. The 600 value remains a nominal pre-separation display scale,
not a final bounding-box constraint.

## Consequences

- Every published float32 node pair has a verifiable center distance of at
  least 0.28, independent of selection and zoom.
- The pass uses O(n) storage and does not construct the close-pair set.
- All nodes are quantized slightly; dense regions expand more. On the current
  data, median displacement is 0.464, P99 is 5.914, and maximum displacement is
  8.447 world units.
- The current full-data benchmark takes about 9.3 seconds for separation and
  1.6 seconds for independent verification, with a process peak around 330 MiB
  when both run in one process.
- The final bbox can be slightly larger than 600 and must be taken from the
  actual published coordinates.
