# Client-state PR B persistence provenance

PR B moves persisted client-state behavior from the exact PR A resulting-main
tree `2fdba024bb347622727d337eb06fc13d2fe129fc`. Each machine record binds the
named predecessor region, the moved target region, and the complete target
file. The region hashes distinguish mixed-source files; the full-file hash
fails closed if later code adds unrelated semantic behavior.

Only the named target regions are mechanically moved behavior. Imports,
exports, constructor hierarchy, adapter wiring, and any code outside those
regions are new PR B code with no inherited-warning capacity.

PR C changes the persistence-codec target only to pass its existing allowed,
required, and label values through one named input contract. The updated target
region and file hashes below include that behavior-neutral alignment; the PR B
source region hash remains fixed and grants no additional style capacity.

Fix round 1 also removes the snapshot repository's private `toSnapshot`
pass-through and calls the canonical snapshot assembler directly. The updated
snapshot-read target regions and file hash include that behavior-neutral
alignment; its PR B source regions and hash remain fixed.

Task 6 fix round 3 records the human-authorized, behavior-neutral multiline
formatting of the direct `ClientStateRepositoryInvariantCorruptionError` import
as a resolved width warning, not retained debt. The binding, canonical module
path, and `snapshot-assembly` behavior region are unchanged. The region moved
from lines `25-60` to `28-63` and retains its prior hash; only the full-file
hash changed. No inherited warning capacity was used.

The storage-key and persistence-contract targets have mixed predecessor
sources, so this document retains their complete region and full-file proof.
They are deliberately absent from the structural lineage manifest: that
manifest grants changed-style capacity only to unique target-to-source
mappings. The provenance test invokes the active changed-style gate and
asserts that neither target is present in its structural-capacity map.

Issue #120 intentionally changes target semantics: workspace storage keys now
use injective canonical encoding, and persisted records with omitted workspace
identity fail closed. The updated target proof grants no inherited-warning
capacity.

## Machine evidence

```text
presence|packages/shared-server/rallar-system/client-presence-state.ts|1-13|313054037da652cdb036bf545c20da0bb44248792bd6910f4849b4d36607f19b|packages/shared-server/rallar-system/client-state/client-presence-state.ts|3-7|ceefccbb1ea20963abea667758cf84ff0e5f1b37988830a7572994b1ac3c6e5d|cc9c3db7e46aa1d6a18b2610b42b256628bbcd191f46f80f0d1c8b20e0d87b06
storage-key-builders|packages/shared-server/rallar-system/client-state-storage-keys.ts|7-56|40f9c2e746d6604478f2df084e90236e91cbc18188ecd3c5cff9f3dee3cbfc3f|packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts|8-57|9b612a90360b0de9033c50f0c1b3f4fac330c69989ba690c6a4c9e9969b7c71c|6d9cab4ecc54f269a7e17aa48aaebfb113dd5c4da7d4175f9a77eb71721613ee
storage-key-decoders|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|729-835|11f4bd53d1f3ddede66d6f33f37b54e0f92c0e7958a8394d3e60a85452168a68|packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts|60-157|f9e444f4393be572a8e150788c3fafd41364c01b816c215205f67997b395fc60|6d9cab4ecc54f269a7e17aa48aaebfb113dd5c4da7d4175f9a77eb71721613ee
runtime-namespaces|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|63-66|0cd45938e25ca984be2392a5157739a49014c79b02e470c9a14145eedff8262e|packages/shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts|1-4|8ccff134e75132bdf76b025b943fba6aa13a9d81c8f89a8de67fd5b365190026|fee02494a6fe1aa2556157ab33d92fdaed2575f30a884088caa358ceb9817733
repository-reads|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|138-172,200-208,275-289,316-323,351-379,398-464,550-688|0b1504daf10949e7bf5aab098de99743fc2935ee0acc6f25f3b02ba2fab87aef|packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts|59-313|4bde9b7f661848dbd2dded0032c7696a45b1140a5db09b49b01631d5672772e5|42235ec4b0bc59c68618ed3441bf83546c948fda6937981f4944da37c1b1e5f6
snapshot-assembly|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|526-548,690-698|643246917e2cb7ac78432e24b2dd4bcd6f04a4e58c831673c8e3fbe82c1f130a|packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts|28-63|e919bf88d02369c7331c7ccc162a920b7e53604b3e77560f80471672c2272de2|dbc142d5125d9f4a07eb0a523dcc7e57561761ce86d008b3bddf9f8e91de6586
snapshot-reads|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|210-262,466-524|d455f565ba2d9206804ad2c2ed20cb705dd0d66df397e698fbf9ef05ee3c0a91|packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts|35-127,138-148|5c261bc09f1be8347b12ddc4fb5d177ceb20859c777a8cebc053631ffb9ac9bf|71c769d0dc5ab8fdadb24282bbbe0e26dd9ea616c00523d1633e412f4cf14021
repository-writes|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|77-84,123-136,175-198,264-273,291-315,325-348,381-396,420-434|a7dddf5e820b728831be0d176085470ceeafe2c96fae81080363b94c66decfd2|packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts|66-73,80-201|69661f7c02ad450864ae0ff8fc801b98aa350a933d7cb287dd5dd19c905e4ca1|32d7686ed680946ec2dd9b91f9dcda95c3cd7af64a6e13b3ca5bd7325d5ca4d6
persistence-codec|packages/shared-server/rallar-system/services/client-state-mutations.ts|82-248,305-399|550d9ed1e9a963fa983c8ee463513ab2bb2111223de8157d2997cafd83575ea3|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts|29-329|4458df7b6e849fe20a6245607ed48f9b8cea193adce79d53a33f69e2cbb96f8e|fd02575dbd9d92851f4096914e3a5f725b7e2da8d287a601f0f324abc28e934a
persistence-validation|packages/shared-server/rallar-system/services/client-state-mutations.ts|250-303|d02d870ba3627e19188f2c70584bf5fb30de34550c6754fee0a226e2892686f6|packages/shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts|25-78|c2038a7e02ffe668115fcefc893454a9e4048c917fd7b11dd66157d5224eecee|eacda2e36a24850af797e390c423d8446b6660da9a1b7530243547173e7aee5a
snapshot-contracts|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|68-75|197394a826f8abd74341b997346985ed302629d2605856ce3c0bfc9c0444f0a9|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|7-14|df25c7d7ce2e85f2c890e4182741cad92fac0db10fc5c1412f7eb828dcc69ef0|b53c4f693ff4b8971cefbd3de8b4e2b0d0d256619af385c69474ec02b57bbecf
receipt-contracts|packages/shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts|191-210|835cf42a672ba2230086f859ec955e163ce0b0d5aeb8449058ce470a0000cf63|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|16-35|97799547a0f89e14bc4526ca5e7f00fa47d3704badac6395b962b97ecfff212d|b53c4f693ff4b8971cefbd3de8b4e2b0d0d256619af385c69474ec02b57bbecf
invariant-contracts|packages/shared-server/rallar-system/repositories/ClientStateRepository.ts|86-121,674-688|daf9bd94d7405cd0265d6e9379674becd9366a609d12100ed4a5018d72663a1b|packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts|37-83|1c27a5a10fcacbfbb86eeb8cf91060f4b49583697b0c3e56ae4025922f848b36|b53c4f693ff4b8971cefbd3de8b4e2b0d0d256619af385c69474ec02b57bbecf
```

## PR C supplementary-ratchet decisions

The temporary source/style ratchet remains intentionally unregistered. The
client-state server child owns it until the separate later ledger removes it
after PR C's resulting-main workflow and the semantic ownership evidence below
are both published. It is supplementary to, never a substitute for, the
semantic and active-import tests.

The human-authorized Task 6 fix-round-3 disposition resolves the two unmapped
width warnings for the `validateClientExpiredSessionAuthority` and
`ClientStateRepositoryInvariantCorruptionError` imports through multiline
formatting. Their temporary ratchet exceptions are removed; neither warning is
retained debt. The direct bindings, canonical module paths, and ordering remain
unchanged.

| Supplementary evidence                                              | PR C decision                                                      | Owner until removal or replacement               | Removal or replacement condition                                                                                                                                                 | Primary evidence retained                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `client-state-server-source-ratchet.test.ts` source/style inventory | Retain temporarily, then remove                                    | Client-state server child; later ledger executor | Remove after the later ledger records the PR C resulting-main workflow and the active navigation, ownership, compatibility, and semantic mutation suites for the canonical tree. | Navigation-map integrity, ownership, public compatibility, transaction/outbox, concurrency, and cache behavior tests. |
| PR A structural-lineage manifest and provenance                     | Retain as historical move audit, then remove exact-tree assertions | Client-state server child; later ledger executor | Replace exact target/hash assertions with the durable semantic ownership tests after the ledger records all three implementation envelopes.                                      | Canonical-owner, compatibility, and mutation behavior suites.                                                         |
| PR B persistence provenance manifest and this provenance record     | Retain as historical move audit, then remove exact-tree assertions | Client-state server child; later ledger executor | Replace exact target/hash assertions with persistence/read/snapshot semantic coverage after the ledger records all three implementation envelopes.                               | Persistence corruption, stable-read, key, snapshot, and API compatibility suites.                                     |
| Client-state test-owner fixed inventory hashes                      | Replace in the later ledger                                        | Client-state server child; later ledger executor | Remove the exact changed-file hash after the ledger confirms behavior-named owner tests and the persistent semantic test tree cover the moved cases.                             | Behavior-named client-state tests plus test-ownership existence and function-size checks.                             |

No controlled human navigation-time sample exists for this child. The README
records only code-derived construction and runtime traces; this evidence does
not imply a repeated human timing comparison.

## Reproduction chronology

1. RED — `npx vitest run packages/tests/repo/client-state-server-ownership.test.ts` exited 1 with the three intended failures: legacy importer ownership, abstract callback inversion, and missing ratchet owner.
2. GREEN — the same command exited 0 with 10 passing tests after the canonical import and ownership corrections.
3. RED — `npx vitest run packages/tests/repo/client-state-server-persistence-lineage-provenance.test.ts` exited 1 before this evidence existed: the manifest omitted mixed-source ownership and the provenance file was absent.

4. RED — `npx tsc -p packages/shared-server/tsconfig.json --noEmit` exited 1 with TS4113 at the four read methods. The move made those methods direct `RuntimeStateJsonStore` members, so their old `override` markers no longer described a base declaration.
5. GREEN — the same TypeScript command exited 0 after removing only those four stale markers.
6. GREEN — `npx vitest run packages/tests/repo/client-state-server-ownership.test.ts packages/tests/repo/client-state-server-persistence-lineage-provenance.test.ts packages/tests/repo/client-state-server-lineage-provenance.test.ts packages/tests/repo/client-state-server-source-ratchet.test.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts packages/tests/api-v1/client-and-group-state-repositories.test.ts packages/tests/repo/client-state-navigation-map-integrity.test.ts` exited 0: 9 files and 92 tests passed.
7. GREEN — `npm run check:repo-style` exited 0. Its default broad scan reported 4,585 non-blocking existing warnings; the checker confirms `unapproved-mod=0`.
8. GREEN — `npx prettier --check packages/shared-server/rallar-system/client-state/persistence/client-state-repository-reads.ts packages/shared-server/rallar-system/client-state/persistence/client-state-snapshot-repository.ts packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts packages/shared-server/rallar-system/client-state/persistence/assemble-client-state-snapshot.ts packages/tests/repo/client-state-server-ownership.test.ts packages/tests/repo/client-state-server-lineage-provenance.test.ts packages/tests/repo/client-state-server-persistence-lineage-provenance.test.ts packages/tests/repo/client-state-server-source-ratchet.test.ts plans/repo-style-lineages/client-state-server-persistence.json plans/repo-style-lineages/client-state-server-persistence-provenance.md plans/repo-style-lineages/client-state-server-structure-provenance.md` exited 0. Import-only callers are intentionally excluded so their established formatting remains unchanged.
9. RED — the same exact format checker exited 1 after the final unused-import cleanup, reporting only `client-state-repository.ts`.
10. GREEN — the same exact format checker exited 0 after formatting that file. The final TypeScript check also exited 0, and the final focused Vitest command in step 6 exited 0 with 9 files and 92 tests passing.
