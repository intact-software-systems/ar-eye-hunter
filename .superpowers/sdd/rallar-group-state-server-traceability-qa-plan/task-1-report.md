# Task 1 — PR A RED inventory report

## Status and scope

This report records the Task 1 RED milestone for the group-state server traceability guidance plan. It changes only PR A integrity-test ownership, the governance-test registration, and directly affected plan wording. It intentionally does **not** add the guidance, provenance document, checker behavior, production changes, or test-suite renames required by later tasks.

The authorized seven-owner split replaces the two mixed integrity suites while preserving their cases, fixtures, literals, expectation sites, and assertions in exactly one target owner. All eight newly created integrity tests are at most 400 physical lines.

| Owner | Lines |
| --- | ---: |
| `rallar-authoritative-mutation-guidance-integrity.test.ts` | 396 |
| `rallar-group-state-owner-integrity.test.ts` | 213 |
| `rallar-skill-app-examples-integrity.test.ts` | 267 |
| `rallar-skill-plugin-publication-integrity.test.ts` | 224 |
| `repo-code-style-authority-integrity.test.ts` | 300 |
| `repo-code-style-checker-integrity.test.ts` | 151 |
| `repo-code-style-review-evidence-integrity.test.ts` | 53 |
| `repo-style-structural-lineage-provenance.test.ts` | 222 |

## Structural-lineage inventory

The immutable manifest contains 17 rows and 48 unique targets. The focused provenance integrity test hard-codes this complete mapping and also verifies that each target currently exists. The approved merge base for every row is `52d973bb71dda2100455e8585a0a8f98d177bd13`.

| Row | Approved-base source | Blob | Targets |
| ---: | --- | --- | ---: |
| 1 | `packages/shared-server/rallar-system/services/AppGroupInboxService.ts` | `b7525b31bd38e24a883c69bdf97d0ef0a5232448` | 6 |
| 2 | `packages/shared-server/rallar-system/services/group-state-service.ts` | `3c8356ee088d2963d6f8f0f3b688bc0954d4745b` | 2 |
| 3 | `packages/shared-server/rallar-system/services/group-state-mutations.ts` | `66a5a6fcbd86a1d144a2e0a1394ee80eca2fb520` | 14 |
| 4 | `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts` | `ade6c012f1ea17ff3b3604f1bac05c6764b4f7a0` | 6 |
| 5 | `packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts` | `837714f6dc40c6572c4114490c6b366f5dec122e` | 1 |
| 6 | `packages/shared-server/rallar-system/services/group-snapshot-validation.ts` | `94e8f14c8753aca5236b7c0f968e6c945b0406e3` | 1 |
| 7 | `packages/shared-server/rallar-system/services/group-state-validation-primitives.ts` | `71860577dc37f2c8fb8cf4025559a6cf0cff6bb4` | 1 |
| 8 | `packages/shared-server/rallar-system/services/group-state-crypto.ts` | `5e804aaa083a2ca1a9f46a7ff378d33aab26ca79` | 1 |
| 9 | `packages/shared-server/rallar-system/services/group-expired-state-authority.ts` | `dd7adf62ec3e1e907af5133481aea04f94acfd0c` | 1 |
| 10 | `packages/shared-test/black-box-runner/api-v1-black-box-run.mts` | `baaadae42ebe02e4d6cdd9a856f77dd8afc77c45` | 5 |
| 11 | `packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts` | `90f1497f1636ea8685dba92b7757f9f94e5d6088` | 4 |
| 12 | `packages/shared-test/black-box-runner/api-v1-state-write-group-causal-evidence.ts` | `9be5158ab51c0106cf73a2f855cf97ad4eadd24b` | 1 |
| 13 | `packages/shared-test/black-box-runner/api-v1-state-write-json-evidence.ts` | `9dfbd2c6a5c350ee14ba56088b3c56d62ce9ba24` | 1 |
| 14 | `packages/shared-test/black-box-runner/api-v1-state-write-match.ts` | `30af6a2b9de18b3215700b89fb0166af466fa9d3` | 1 |
| 15 | `packages/shared-test/black-box-runner/api-v1-state-write-topology-result-evidence.ts` | `c88f184577dfad6af825f8caa2643a0ca6dc2d9c` | 1 |
| 16 | `packages/shared-test/black-box-runner/artifact-report-bounds.ts` | `2bf9ee11bb835ab44706d964a5caff9d0dae2f1c` | 1 |
| 17 | `packages/shared-test/black-box-runner/live-preflight-variables.ts` | `2ede5ae0110654cc4cae9f1e80cfe37f6b670933` | 1 |

The active compatibility-only source paths recorded by the focused test are:

- `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- `packages/shared-server/rallar-system/services/group-state-service.ts`
- `packages/shared-server/rallar-system/services/group-state-mutations.ts`
- `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts`
- `packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts`
- `packages/shared-server/rallar-system/services/group-snapshot-validation.ts`
- `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- `packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts`

## Historical route-owner inventory

This is the exact 19-module inventory for the planned Task 4 descriptive moves. For each current module it records its current `describe(...)` owner, every named case, an order-sensitive inventory of independently written lexical literals, and every `expect(...)` line. The SHA-256 records make the full source and literal sequence reproducible without normalizing its body before the move.

### `task10-route-closure-correction.test.ts` → `mutation-route-owner-analysis.test.ts`

- Current source SHA-256: `cc8192bd460c3d45645dc18b00f5d090c58402445de78dd92f088f090985e0b2`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-analysis.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction contracts@13`.
- Named cases (5): `uses one named readonly input object for each authorised websocket enqueue helper@14`, `requires the admin mutation gateway and contains no direct-write fallback@46`, `exports a syntax-aware analyzer for named, default, namespace, dynamic, and alias evasions@65`, `maps all 50 entrypoints and 46 types to real registrations and owners@95`, `rejects representative route, type, owner, and path inventory mutations@104`.
- Independently written literal inventory: 56 lexical literals; ordered literal sequence SHA-256 `380be378da0673f616538497dc295a7a266839ca30d0ef00eafb1abe89024e50`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (13): 33, 38, 41, 49, 50, 51, 61, 73, 88, 99, 100, 101, 118.

### `task10-route-closure-correction-2.test.ts` → `mutation-route-owner-boundary-traversal.test.ts`

- Current source SHA-256: `1eb6b2942b10596120c1ac518f6b21c547062a2c1d3529153def5d86b7631552`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 2 contracts@15`.
- Named cases (7): `finds forbidden mutations in recursively imported helpers without listing them@16`, `resolves mutable repository capabilities through the shared-server barrel@35`, `always rejects incomplete and duplicate inventories@53`, `uses the canonical inventory in the original routing contract test@68`, `rejects a dead correct marker when the registered handler is rerouted@77`, `binds authorised websocket types to their real owner methods@104`, `rejects route, type, owner, handoff method, and source mutations@115`.
- Independently written literal inventory: 52 lexical literals; ordered literal sequence SHA-256 `c4303c8d7b898c7591317d04d80b38fa877b23bbfbf5ab55e65748dc64be863d`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (14): 23, 27, 40, 48, 54, 57, 59, 73, 74, 82, 97, 107, 110, 130.

### `task10-route-closure-correction-4.test.ts` → `mutation-route-owner-provenance.test.ts`

- Current source SHA-256: `410d6c9ab41da00401bcea352011465369a23e0b6a64460ad7332f556749237e`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-provenance.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 4 contracts@14`.
- Named cases (6): `follows mutable capability provenance through production receiver shapes@15`, `rejects a dead correct type after an HTTP handler is given the wrong handoff type@38`, `rejects a rerouted websocket callback even when dead markers remain@59`, `rejects a lifecycle type dispatched to the wrong owner with a dead correct call@77`, `rejects a cross-file admin handoff with the wrong type and dead correct evidence@95`, `rejects a cross-file auth handoff discriminator and owner reroute@111`.
- Independently written literal inventory: 58 lexical literals; ordered literal sequence SHA-256 `b88229ae15ae35e108f97ef32fdd5d80c9cf56966829b334b3d3aff95ab3a463`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (9): 26, 33, 54, 72, 88, 90, 106, 122, 125.

### `task10-route-closure-correction-5.test.ts` → `mutation-route-owner-registration-collections.test.ts`

- Current source SHA-256: `e4e9ceabced39922a36be24e36c70dd7dd4ccaf56f23d0833d0c782322c8f961`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 5 contracts@19`.
- Named cases (6): `retains read-only provenance without flagging ordinary domain objects@38`, `rejects GROUP_CREATE removed from the imported live group registration collection@45`, `rejects an auth registration loop replaced with an empty iterable@57`, `rejects a CRDT type removed from its imported live registration collection@69`, `binds topology loops to their live types@84`, `binds direct client registrations to their live types@95`.
- Independently written literal inventory: 52 lexical literals; ordered literal sequence SHA-256 `2b56c9f937fd9b09a290fa14319fa61c849cfbd4f23bf268b15c928ce4aa73cc`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (10): 30, 39, 48, 50, 60, 62, 72, 74, 88, 102.

### `task10-route-closure-correction-6.test.ts` → `mutation-route-owner-registration-predicates.test.ts`

- Current source SHA-256: `624b12c02977d1367e6ee341936e1d3646ab6bb7ed9ed12c259f8add1bfd9509`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 6 contracts@15`.
- Named cases (7): `keeps shadowed domain values and read-only member references clean@31`, `narrows the group registration array with an exact equality filter@37`, `rejects a group registration filter that is always false@50`, `narrows the auth registration array with an exact equality filter@63`, `narrows the imported CRDT collection with an exact equality filter@76`, `fails closed for an opaque registration predicate@89`, `evaluates safe logical includes and identity map chains exactly@102`.
- Independently written literal inventory: 51 lexical literals; ordered literal sequence SHA-256 `9086a98ac7519e2b499cfc9a90a10a59eda4a691d35463056628eef7dbdf7556`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (15): 23, 32, 43, 45, 56, 58, 69, 71, 82, 84, 95, 97, 110, 113, 117.

### `task10-route-closure-correction-7.test.ts` → `mutation-route-owner-logical-predicates.test.ts`

- Current source SHA-256: `2840e841655e9910adf2d364f4e74d40cf75b3a55be4635dac944576a1194f47`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-logical-predicates.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 7 contracts@15`.
- Named cases (5): `keeps a proven read-only overwrite clean when it precedes the only call@32`, `fails closed when negated includes reads an unknown function collection@38`, `proves negated includes over a known empty collection@48`, `narrows negated includes over a known nonempty collection exactly@52`, `propagates unknown through logical predicates without losing proven true branches@64`.
- Independently written literal inventory: 44 lexical literals; ordered literal sequence SHA-256 `5fa45528cbcba3169ed043b50f44ce1837849d0b3359f6f6513a22a5bfeddd59`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (10): 24, 33, 43, 49, 56, 59, 69, 72, 88, 100.

### `task10-route-closure-correction-8.test.ts` → `mutation-route-owner-call-effects.test.ts`

- Current source SHA-256: `9cb1cebf277719fb7d3d641cd5d40853e4cd5306cb5a169f0f3aade8c1c4e47e`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-call-effects.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 8 contracts@17`.
- Named cases (4): `ignores never-executed writes and accepts an invoked read-only overwrite@34`, `filters every guaranteed member out of an unknown collection@40`, `maps guaranteed members of an unknown collection to an exact constant@50`, `propagates unknown lower bounds through chained logical filter and map@62`.
- Independently written literal inventory: 33 lexical literals; ordered literal sequence SHA-256 `6fa6da9e1cef77592217ffbdcf997c64b49ebbd0492bf1b475341b10a018761b`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (7): 26, 35, 44, 54, 57, 68, 78.

### `task10-route-closure-correction-9.test.ts` → `mutation-route-owner-object-projections.test.ts`

- Current source SHA-256: `cb7bbc1befb618ee8246653123f626b952a7123bd6a3d308d76a9fd65d26cddc`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-object-projections.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 9 contracts@16`.
- Named cases (4): `projects Object.values without crediting object keys@42`, `projects computed Object.keys without crediting object values@50`, `projects the key from exactly modeled Object.entries consumers@58`, `projects the value from exactly modeled Object.entries consumers@67`.
- Independently written literal inventory: 49 lexical literals; ordered literal sequence SHA-256 `d7e366a45028b21917e777b7dacd8eb66f3136e3652d12b6224308b4f457f59b`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (5): 26, 39, 96, 103, 109.

### `task10-route-closure-correction-10.test.ts` → `mutation-route-owner-map-projections.test.ts`

- Current source SHA-256: `ef701c695b275f9ac4a9a42a3fe88914f69d82fa1a161ee6f5f63d0164fcc454`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-map-projections.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 10 contracts@16`.
- Named cases (10): `projects only keys from a Map@61`, `projects only values from a Map@69`, `projects a Map entry key through exact destructuring@77`, `projects a Map entry value through exact destructuring@86`, `resolves an aliased Map before projecting keys@95`, `resolves a provable computed Map projection method@106`, `uses the final value for duplicate Map keys@118`, `retains a common key guarantee across conditional Map entries@129`, `does not establish ownership from an unknown Map shape@140`, `does not merge an unprojected Map key and value into scalar ownership@149`.
- Independently written literal inventory: 85 lexical literals; ordered literal sequence SHA-256 `38ba4b780276eb0a4e38f9037fb1d3b210b0bba1b590717e317f071effe14d5d`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (6): 41, 58, 160, 174, 181, 187.

### `task10-route-closure-correction-11.test.ts` → `mutation-route-owner-lexical-resolution.test.ts`

- Current source SHA-256: `22b7e62a82f4e1e6512f18ebc812fccd987817d42c02c19e1d67a64f740a971e`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-lexical-resolution.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 11 contracts@22`.
- Named cases (10): `uses a local keys shadow instead of a top-level values binding@62`, `uses a local values shadow instead of a top-level keys binding@71`, `resolves a nested block shadow at the projection call@80`, `resolves a nested function shadow at the projection call@90`, `resolves a defaulted parameter shadow at the projection call@100`, `uses the last unconditional method assignment before the call@110`, `does not use a method assignment after the call@119`, `keeps an ambiguous conditional method unknown@129`, `preserves projection through a lexical alias composition@139`, `uses the same lexical method rules for Object projections@148`.
- Independently written literal inventory: 107 lexical literals; ordered literal sequence SHA-256 `cec453050c2c7014c4c007c5d58eca33d68bfe92e7797e6653df646fa465d482`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (6): 37, 59, 162, 181, 197, 203.

### `task10-route-closure-correction-12.test.ts` → `mutation-route-owner-call-aliases.test.ts`

- Current source SHA-256: `3ec3925dd8bdf21d4bd372d1ea0ef7ca3a45cff5533065796dabac61ed450acc`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-call-aliases.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 12 contracts@25`.
- Named cases (20): `resolves a namespace factory through member, computed, bind, and call aliases@43`, `normalizes factory call, apply, and later-invoked bind shapes@49`, `fails closed for a reachable unresolved local factory alternative@57`, `preserves shared array and object heap mutations through aliases@76`, `does not execute a bound callable until the bound value is called@83`, `uses an explicit invocation argument instead of the parameter default@87`, `uses the parameter default when the invocation omits the argument@92`, `uses the parameter default for an explicit undefined argument@97`, `propagates invocation arguments through a local callable alias@102`, `combines registrations from multiple concrete invocations@109`, `keeps a conditional invocation argument unknown@117`, `does not trust an imported Object shadow@146`, `does not trust an Object parameter shadow@156`, `does not trust a local Map constructor shadow@167`, `resolves an alias of the proven global Object keys function@177`, `resolves globalThis.Object values@186`, `resolves Object entries through a proven global alias and map projection@195`, `resolves new Map keys through a proven global alias@204`, `resolves new globalThis.Map values@213`, `keeps a conditional global/custom Object identity unknown@222`.
- Independently written literal inventory: 156 lexical literals; ordered literal sequence SHA-256 `122f2ea8f760c5af55a0ef85886a0ca3d13615326bf1c0523a56d60d77543a6e`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (5): 235, 244, 272, 288, 296.

### `task10-route-closure-correction-13.test.ts` → `mutation-route-owner-control-flow-alternatives.test.ts`

- Current source SHA-256: `9d9fbc05d6ecaec33506c9ffeaa76d712894dd5505c97aae903b1c3dda58554a`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-control-flow-alternatives.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 13 contracts@22`.
- Named cases (14): `collapses equivalent computed capability and factory member alternatives@23`, `shares recursive heap members through every exact alias form@31`, `keeps never-invoked and overwritten nested heap writers clean@39`, `preserves absent, undefined, exact, spread, and bound argument slots@43`, `does not execute a callable merely because its argument slots were bound@51`, `skips statically unreachable nested boundary selections@55`, `keeps reachable and unknown boundary selections conservative@59`, `uses only the reachable arm of an exact conditional registration@83`, `uses only the matching case of an exact switch registration@92`, `resolves literal-exact for-of registration values@104`, `intersects different registrations across unknown alternatives@111`, `retains a common registration across unknown alternatives@120`, `does not infer ownership from an unknown external callback flow@129`, `keeps equivalent direct, alias, and call-family registrations metamorphic@156`.
- Independently written literal inventory: 104 lexical literals; ordered literal sequence SHA-256 `ffc0cc360bf9723f16700b4fc2a381b9a2b9fd43bb73a35e96204a138b21f73d`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (7): 165, 166, 172, 178, 199, 231, 235.

### `task10-route-closure-correction-14.test.ts` → `mutation-route-owner-loop-and-switch-flow.test.ts`

- Current source SHA-256: `1a5141ba0563fcbbe9d68faeb300c40f9672414884ae365c91c1aef059fd6122`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-loop-and-switch-flow.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 14 contracts@22`.
- Named cases (16): `uses the heap alias state at a writer call before a later rebind@23`, `uses ordered rebinds for direct, nested, and destructured heap aliases@29`, `joins branch and loop heap states conservatively@36`, `snapshots a captured outer heap alias at its invocation@43`, `does not let a later writer rebind rewrite an earlier read-only call@50`, `retains known capability factories across partially unknown computed keys@54`, `keeps partially known keys on unrelated namespaces clean@62`, `executes boundary switch cases through reachable fallthrough@66`, `stops boundary switch fallthrough on break, return, and throw@74`, `unions registrations from a matched case and its fallthrough case@78`, `skips a default before an exact later match@89`, `falls through from an exact match into a later default@101`, `starts at default when no case matches@112`, `continues through multiple cases until break@123`, `stops exact routing fallthrough at break@136`, `intersects registrations across unknown fallthrough alternatives@147`.
- Independently written literal inventory: 79 lexical literals; ordered literal sequence SHA-256 `a523611de8996102085b5d1ac8d1f2de04822a744ec4317288620ca9299f9ada`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (5): 166, 172, 196, 221, 225.

### `task10-route-closure-correction-15-executor.test.ts` → `mutation-route-owner-execution-state.test.ts`

- Current source SHA-256: `082be7ea5e81987f2e97c7dca66a6880d2026e40e100e7f2c2cdc9978521680e`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-execution-state.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 15 executor contracts@7`.
- Named cases (3): `coalesces equivalent states at every nested logical junction@8`, `does not coalesce normal and abrupt alternatives@27`, `retains distinct routing-like state values when coalescing is disabled@52`.
- Independently written literal inventory: 36 lexical literals; ordered literal sequence SHA-256 `3f120a55809bb5772504ea8b0adfde0799e2f64bab0ccaa3e27402fd822688ee`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (5): 23, 24, 45, 46, 69.

### `task10-route-closure-correction-15.test.ts` → `mutation-route-owner-abrupt-completion.test.ts`

- Current source SHA-256: `d910dae4afb746f0439ed7b743b1d1e5a96844ce695ea91c578fb2a298f27627`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-abrupt-completion.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 15 contracts@22`.
- Named cases (7): `makes nested guaranteed boundary abrupt completion equivalent to direct completion@23`, `retains writers reachable after an unknown break, return, or throw branch@30`, `intersects a later registration out of an unknown break path@74`, `runs finally on every path while retaining an earlier return completion@106`, `consumes a matching break but retains return and throw beyond a switch@121`, `consumes continue at an exact loop boundary@139`, `consumes matching labeled break and continue completions@150`.
- Independently written literal inventory: 83 lexical literals; ordered literal sequence SHA-256 `205e9fb9169d66f47e53a3be2c4b5dd138e289a13259a9f0e20a7eae92cd07e8`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (7): 26, 27, 70, 181, 198, 218, 227.

### `task10-route-closure-correction-16.test.ts` → `mutation-route-owner-loop-completion.test.ts`

- Current source SHA-256: `06d7eb61721735e9dbbd8fd4eac1bca19f94293d8b9aa1718124eb7642e13999`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-loop-completion.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 16 contracts@24`.
- Named cases (11): `skips boundary for-update and do-test writers after break, return, or throw@25`, `retains boundary update, test, and post-loop writers that are reachable@29`, `skips a classic-for update after break and reaches post-loop registration@37`, `skips a classic-for update after a matching labeled outer break@45`, `lets a break escape to a label outside the loop without running the update@55`, `skips a do-while test after break and reaches post-loop registration@65`, `intersects the update out of a conditional break path@94`, `runs continue phases and preserves the unknown do-test exit@109`, `retains return and throw beyond update, test, and post-loop statements@123`, `preserves while, for-of, and for-in post-loop reachability@137`, `runs abrupt update and test phases only after normal or continue outcomes@151`.
- Independently written literal inventory: 102 lexical literals; ordered literal sequence SHA-256 `a07052dc4377db7285aa0e6977fd039e86ab7d4b5b832e5fe3b301f91b167dd9`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (11): 26, 90, 152, 153, 154, 155, 165, 182, 195, 231, 240.

### `task10-route-closure-correction-17.test.ts` → `mutation-route-owner-loop-divergence.test.ts`

- Current source SHA-256: `0222b4830a9212b15187633602f7db104e352d23641544cf5a95ee58aefd4294`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-loop-divergence.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 17 contracts@25`.
- Named cases (15): `keeps writers after statically non-terminating loops unreachable@26`, `retains required update and test phases before divergence@30`, `retains post-loop writers on conditional, owned, and exact-false exits@37`, `executes the classic-for update and do-while test before divergence@60`, `keeps exact-false and unknown tests on their supported normal exit paths@72`, `keeps direct and matching labeled breaks as normal post-loop exits@83`, `keeps conditional break as a normal exit plus a divergent alternative@97`, `preserves return, throw, and non-owned labeled escape completions@106`, `propagates inner divergence and preserves inner versus outer break ownership@119`, `preserves divergence through switches, labels, branch joins, and finally@144`, `keeps nested conditional exploration bounded before divergence@168`, `does not treat a dead post-loop registration as owned@178`, `includes a divergent path when intersecting conditional-break ownership@192`, `keeps phase registration and owned-break post registration distinct@203`, `distinguishes nested divergence, inner break, and outer break in routing@217`.
- Independently written literal inventory: 144 lexical literals; ordered literal sequence SHA-256 `f221213ce7489cf8977b5ec837b876970a2374aedfa7afd7c1fb5c1512607589`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (30): 27, 56, 57, 62, 63, 68, 69, 73, 77, 90, 102, 103, 107, 108, 111, 120, 127, 135, 145, 156, 160, 163, 174, 175, 273, 290, 297, 298, 311, 320.

### `task10-route-closure-correction-18.test.ts` → `mutation-route-owner-loop-fixed-point.test.ts`

- Current source SHA-256: `aa13aefc4b9c15d8064655270f6cce200572e39cce367d57098aecff6ccb135a`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-loop-fixed-point.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 18 contracts@36`.
- Named cases (7): `keeps boundary writes reachable after per-path false next tests@37`, `keeps zero-iteration exit plus entered divergence when an unknown test becomes true@64`, `guarantees the post-loop registration when an unknown test becomes false@77`, `uses each continuing candidate state for its own next-test truth@90`, `keeps literal, no-test, break, continue, and do-while controls exact@154`, `keeps unsupported executed writes conservative and bounded@178`, `does not coalesce different lexical candidate multisets@201`.
- Independently written literal inventory: 130 lexical literals; ordered literal sequence SHA-256 `c6f8b51d8a7ae3322cba48bd2a32e3e0603da7fab831a3de01b2ef8ea1af9a69`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (16): 39, 151, 155, 159, 163, 167, 170, 173, 179, 184, 197, 198, 224, 277, 293, 302.

### `task10-route-closure-correction-19.test.ts` → `mutation-route-owner-state-coalescing.test.ts`

- Current source SHA-256: `986614d329b34c2092eaa9112bac5abb3e3568ccee83cb92f5e4056f615babf8`; planned descriptive owner: `packages/tests/shared-server/mutation-route-owner-state-coalescing.test.ts`.
- `describe(...)` owners: `Task 10 route-closure correction 19 contracts@51`.
- Named cases (9): `bounds 14 identical binary branches through the public route analyzer@52`, `coalesces 14 identical binary branches to one routing state@63`, `keeps 24 identical branches bounded without truncating analyzer paths@67`, `coalesces identical registration values from identical alternatives@79`, `treats registration insertion order as irrelevant but matches duplicates one-to-one@86`, `keeps different registration values distinct and ownership intersection safe@105`, `keeps known, unknown, and different unknown lower bounds distinct@119`, `keeps true and false executed lexical overlays distinct@134`, `keeps normal, divergent, abrupt, labeled, and branch contexts distinct@142`.
- Independently written literal inventory: 103 lexical literals; ordered literal sequence SHA-256 `458f0bc72f183edba3833d55e866e225c104204d4b94e5b5c4b3e2b9f1b9bbed`. The current-source SHA above is the reproducible full-value record.
- `expect(...)` sites (13): 60, 64, 75, 76, 135, 143, 144, 167, 168, 191, 251, 266, 271.
## RED evidence

The focused integrity run has 71 tests: 66 pass and exactly five fail, all because a later planned deliverable is deliberately absent.

1. The authoritative mutation trace guidance is absent (Task 2).
2. The large-PR review-pressure guidance is absent (Task 2).
3. The human traceability/construction-warning disposition guidance is absent (Task 2).
4. The structural-lineage provenance document is absent (Task 3).
5. The behavior-named route-owner and semantic mutation assertion guidance is absent (Task 2).

No preservation or split test failed. The seven-owner registration is included in `test:repo-governance` in deterministic path order.

## Self-review and follow-up

The changed-file review found no production code, checker/parser/lineage-consumer behavior, schema, dependency, lockfile, workflow, TypeScript configuration, PR B, ledger, or API-v1 changes. The former two mixed test owners are deleted; each original case is present exactly once in the new owner set. The plan changes are limited to the authorized Task 1/Task 2, current/target tree, validation, evidence, and acceptance wording.

Task 2 should make the four guidance tests green. Task 3 should add the human-reviewed provenance document and make the remaining provenance failure green. Task 4 should perform the 19 descriptive suite moves while preserving the inventory recorded above. Full plan completion gates are not run for this intentionally RED, intermediate milestone.

<details>
<summary>Commands executed and what they taught us</summary>

- `git status --short`, `git diff --check`, and line-count checks were used to confirm that only authorized Task 1 files were changed, no whitespace errors were introduced, and every split owner stays within the 400-line limit.
- The focused Vitest command over the PR A integrity suites was used to establish the expected RED baseline: 66 passing tests and five deliberate failures tied only to Task 2 and Task 3 deliverables. This distinguishes intended missing guidance/provenance from accidental preservation regressions.
- `npm run test:repo-governance` exercised the updated deterministic registration. It ran 186 tests: 181 passed and the same five intentional Task 2/Task 3 failures remained; no unrelated registered governance suite regressed.
- The manifest and route-owner inventories were read with Node inspection so source paths, approved blobs, target counts, test titles, literal sequences, and assertion locations remain reproducible before the future descriptive moves.
- Formatting was applied to changed source and plan files with Prettier, then rechecked. Formatting does not replace the semantic preservation inventory; it only keeps the new split owners readable.
</details>
