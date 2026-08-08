# Rallar group topology server PR-A lineage provenance

Base: `8b1ebf542d12c05a5ac226d3d07e543a171a2626`

The fail-closed structured evidence is
[`rallar-group-topology-server-pr-a-provenance.jsonc`](rallar-group-topology-server-pr-a-provenance.jsonc).
Its permanent repository test pins the whole document, recomputes every base
and candidate blob, extracts every named AST owner and exact span, hashes every
recorded region, and separately proves that changing any recorded leaf fails
with that exact field path.

Semantically new code receives zero historical capacity. The structural
lineage manifest maps the deleted mutation source to the one genuine owner of
its source-derived untrusted boundaries:
`topology-config-mutation-boundary.ts`. It does not map capacity
to aliases, typed continuation modules, or newly introduced helper boundaries.

## Exact source regions

- Mutation module declarations: lines 35–1379 in
  `group-topology-config-mutations.ts`. The structured extraction row includes
  contracts, idempotency, compute, input validation, boundary normalization,
  stored-record validation, receipt validation, final deterministic
  validation, and result reconstruction destinations.
- Config resolution: `resolveGroupTopologyConfig`, lines 136–165 in
  `group-topology-config-service.ts`.
- Authority proof: `createTopologyMutationAuthorityProof`, lines 15–48 in
  `topology-mutation-authority-proof.ts`.

## Eligible unknown-boundary regions

The base mutation blob has exactly fourteen `unknown`-bearing source lines.
Each row has magnitude one and is tied to its exact source and target region
hash. The source regions are:

| Source symbol                                    | Base span |
| ------------------------------------------------ | --------: |
| `validateGroupTopologyConfigGeneration`          |   847–868 |
| `validateGroupTopologyConfigInvariantGeneration` |   870–895 |
| `validateStoredGroupTopologyConfig`              |   921–950 |
| `validateStoredGroupTopologyOverride`            |   952–977 |
| `validateGroupTopologyConfigMutationRecord`      |  979–1023 |
| `validateTopologyConfigReceipt`                  | 1025–1209 |
| `validateAcceptedTopologyConfig`                 | 1270–1304 |
| `validateGroupRef`                               | 1314–1321 |
| `validateCausalRevision`                         | 1323–1336 |
| `validateExactKeys`                              | 1344–1354 |
| `validatePositiveInteger`                        | 1356–1363 |
| `validateStorageRevision`                        | 1365–1369 |
| `requireString`                                  | 1371–1375 |
| `isRecord`                                       | 1377–1379 |

The six composite validators preserve their exact initial record-normalization
errors in the boundary owner, then continue through typed record/receipt
owners. The remaining eight helpers moved wholly into the boundary owner.
`validate-topology-config-records.ts` and
`validate-topology-config-receipt.ts` therefore introduce zero new literal
`unknown` boundaries while preserving the original validation and error order.
