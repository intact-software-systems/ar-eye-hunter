# PR #59 Group-State Server Structural-Lineage Provenance

This independent audit covers the 17 source rows and 48 unique targets in
`rallar-group-state-server-structure.json`. Each source object was read from approved base
`52d973bb71dda2100455e8585a0a8f98d177bd13`; its object ID was compared with the manifest,
and each current target was inspected at the PR A base tree
`25facef7df020b8021495449805d54429b45dc1e`. Symbol and line spans came from parsed Git
objects and current files, with copy-aware blame and focused diffs used as corroboration.

“Mechanical extraction” includes behavior-preserving renames, imports, and splits. “Mixed”
means only the named source-derived regions may inherit historical capacity. Imports, new
contracts, owner wiring, helper boundaries, or behavior added during PR #59 receive no
inherited capacity. This document is human evidence, not checker input. Automating
symbol/span enforcement would require a separate, unapproved governance proposal.

## Source: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`

Source blob: `b7525b31bd38e24a883c69bdf97d0ef0a5232448`
Source symbol or line span: `toTopologyAppInboxCommand lines 345-378; enqueueRtcRtt source-derived statements 522-562; toAuthenticatedTopologyEnqueue lines 650-665; topology handlers lines 667-761; verifyRtcRttAuthority lines 828-872; topology authority/session verification lines 881-955; group handler/result lines 957-1144; authority-shape predicates lines 1180-1196; topology command helpers lines 1210-1453 and 1526-1568; topology authority readers lines 1455-1475 and 1502-1524; RTC RTT authority reader lines 1477-1500; constant-time proof comparison lines 1570-1577; descriptor mapping lines 1579-1753`
Source changed regions: `The target sections partition those non-overlapping spans. Facade entry lines 632-648, RTC handler lines 763-825, dependency setter/lookup lines 496-520 and 874-879, imports, payload contracts, and registration are not claimed by these targets.`
Compatibility status/path: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts remains the public composition facade; extracted owners are direct internal imports, not another compatibility hop.`

### Target: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts`

Target symbol or line span: `GroupStateInboxHandler lines 68-134; readGroupMutationPreparation lines 136-170; authority predicates lines 172-185; descriptor translators lines 187-399`
Target changed regions: `Whole added module lines 1-399; source-derived processMutation 957-985, commit control 987-1011 and 1070-1077, preparation 1107-1144, predicates 1180-1196, descriptor 1579-1753.`
Mechanical-move classification: `Mixed behavior-preserving extraction: handler phase control and descriptor cases moved; class/dependency boundaries and split translator names are new structure.`
Semantic additions excluded from inherited capacity: `Imports lines 1-50, interfaces 52-66, constructor/wiring, and newly named split boundaries receive zero capacity; only mapped source bodies may inherit.`
Human disposition: `Accepted for lineage capacity only on the listed source-derived bodies; no capacity for the new owner surface.`

### Target: `packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts`

Target symbol or line span: `readGroupStateInboxResult lines 30-50; isPresenceOperation lines 52-60; readReceiptEvent lines 62-73; result translators lines 75-112`
Target changed regions: `Whole added module lines 1-112; source-derived commit result assembly 1012-1069 and helpers 1080-1105.`
Mechanical-move classification: `Mixed extraction of the durable-result branch from commitMutation into named result readers/translators.`
Semantic additions excluded from inherited capacity: `Imports and result/input contracts lines 1-28 plus the new function boundaries receive zero capacity.`
Human disposition: `Accepted only for the mapped result-assembly statements and unchanged helpers; new contracts do not inherit debt.`

### Target: `packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts`

Target symbol or line span: `createRtcRttDurableEnqueue lines 38-79; readRtcRttAppInboxAuthority lines 81-102; verifyRtcRttAppInboxAuthority lines 104-131; verifyRtcRttCommandHashes lines 133-149`
Target changed regions: `Whole added module lines 1-149; source enqueueRtcRtt statements 522-562, verifyRtcRttAuthority 828-872, and readRtcRttAuthority 1477-1500.`
Mechanical-move classification: `Mixed behavior-preserving extraction of RTC durable command construction, decoding, and authority verification.`
Semantic additions excluded from inherited capacity: `Imports/interfaces lines 1-36, the enqueue-return rewrite at target lines 65-79, and newly separated verifyRtcRttCommandHashes boundary receive zero capacity; source RTC handler lines 763-825 and dependency lookup 874-879 are expressly excluded.`
Human disposition: `Accepted for mapped RTC statements only; the new authority-owner surface receives no historical allowance.`

### Target: `packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts`

Target symbol or line span: `createAuthenticatedTopologyEnqueue lines 36-52; read/verify authority lines 54-125; constantTimeTopologyProofEqual lines 127-134; session helpers lines 136-181`
Target changed regions: `Whole added module lines 1-183; source authenticated enqueue 650-665, topology authority/session verification 881-955, topology authority readers 1455-1475 and 1502-1524, and constant-time comparison 1570-1577. Source RTC RTT authority reader 1477-1500 belongs only to the RTC RTT authority target.`
Mechanical-move classification: `Mixed behavior-preserving extraction into the topology authority owner.`
Semantic additions excluded from inherited capacity: `Imports/interfaces and renamed helper boundaries receive zero capacity; only mapped proof/session logic may inherit.`
Human disposition: `Accepted with capacity restricted to source-derived authority logic.`

### Target: `packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts`

Target symbol or line span: `toTopologyAppInboxCommand lines 33-66; authenticated/durable readers lines 68-129; config conversion lines 131-166; payload predicates/canonicalization lines 168-341`
Target changed regions: `Whole added module lines 1-341; source functions 345-378, 1210-1453, and 1526-1568.`
Mechanical-move classification: `Mixed extraction of command conversion and exact decoding; helper names were narrowed around topology records.`
Semantic additions excluded from inherited capacity: `Imports/contracts lines 1-31 and new requireExactTopologyKeys, isTopologyRecord, and hasValidTopologyCommandIdentity boundaries receive zero capacity.`
Human disposition: `Accepted only for equivalent command parsing/conversion spans; new boundary code is capacity-ineligible.`

### Target: `packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts`

Target symbol or line span: `TopologyAppInboxHandler lines 49-151; requireTopologyManagementService lines 153-158`
Target changed regions: `Whole added module lines 1-158; source topology config/reconfigure processing methods 667-761.`
Mechanical-move classification: `Mixed extraction of topology execution into a stateless handler while retaining the facade setter compatibility surface.`
Semantic additions excluded from inherited capacity: `Imports, dependency/result contracts lines 1-47, class construction, createAuthenticatedEnqueue lines 52-62, and requireTopologyManagementService lines 153-158 receive zero capacity; source setter/property and toAuthenticatedTopologyEnqueue spans remain outside this target.`
Human disposition: `Accepted only for the mapped processing statements; the required-service behavior and new handler shape have no inherited debt.`

## Source: `packages/shared-server/rallar-system/services/group-state-service.ts`

Source blob: `3c8356ee088d2963d6f8f0f3b688bc0954d4745b`
Source symbol or line span: `GroupMutationAuthorizationError lines 229-237; GroupMutationIdempotencyConflictError lines 239-251; runtime/service regions 253-269, 331-413, and 444-483; prepareMutation lines 270-329; prepared-authority revalidation lines 414-443; authority/descriptor functions lines 485-661; resolveCommandJoinCode/joinCodeVerifier lines 1193-1213; timing lines 1215-1283`
Source changed regions: `The authority target owns 229-237, 270-329, 414-443, 485-661, and 1193-1213. The service target owns 239-269, 331-413, 444-483, and 1215-1283. Old toDescriptorCommand and command-family converters lines 663-1191 moved to undeclared command targets and are not claimed here.`
Compatibility status/path: `packages/shared-server/rallar-system/services/group-state-service.ts is a direct named re-export-only compatibility path to both canonical targets.`

### Target: `packages/shared-server/rallar-system/group-state/group-mutation-authority.ts`

Target symbol or line span: `GroupMutationAuthorizationError lines 59-67; prepare/verify authority lines 69-161 and 193-347; mutationDescriptor lines 163-172; toDescriptorCommand lines 174-191`
Target changed regions: `Whole added module lines 1-347; source authorization error 229-237, prepareMutation 270-329, prepared-authority revalidation 414-443, authority/descriptor functions 485-661, and join-code resolution 1193-1213.`
Mechanical-move classification: `Mixed extraction of authentication, preparation, and descriptor authority; the current operation-family router is a behavior-preserving rewrite.`
Semantic additions excluded from inherited capacity: `Imports/interfaces lines 1-57, new function boundaries, and toDescriptorCommand target lines 174-191 receive zero capacity; source command converters lines 663-1191 are expressly excluded.`
Human disposition: `Accepted for source-derived authority algorithms only; new owner contracts are ineligible.`

### Target: `packages/shared-server/rallar-system/group-state/group-state-service.ts`

Target symbol or line span: `GroupMutationIdempotencyConflictError lines 42-54; createGroupStateRuntime lines 56-89; owner/composition functions lines 91-269; createGroupStateService lines 271-275; timing functions/contracts lines 277-378`
Target changed regions: `Whole added module lines 1-378; source error 239-251, runtime/service regions 253-269, 331-413, and 444-483, plus timing 1215-1283.`
Mechanical-move classification: `Mixed behavior-preserving extraction and decomposition of the service composition and timing shell.`
Semantic additions excluded from inherited capacity: `Imports, owner interfaces, named composition phases, timing detail contracts, and resolveGroupStateTimingInvocation receive zero capacity.`
Human disposition: `Accepted only for equivalent runtime operations and timing behavior copied from the source; new composition structure gets no capacity.`

## Source: `packages/shared-server/rallar-system/services/group-state-mutations.ts`

Source blob: `66a5a6fcbd86a1d144a2e0a1394ee80eca2fb520`
Source symbol or line span: `mutation contracts 97-292 and 316-400; presence-summary contracts 294-314; request shell 402-419, operation-request branches 420-512, presence request 515-604, command shell 606-645; compute/probe 647-720; read validation 774-1002 and 1062-1085; persisted-group validation 1004-1060, 1106-1153, 1398-1410, 3750-3781, and 3847-3895; persisted-presence validation 1155-1207, 1412-1488, and 3305-3405; persistence normalization 1209-1396 and 3783-3845; idempotency/receipt/hash validation 1490-1527 and 3897-4026; computed validation 1529-1795; presence summary 1850-2015 and 3608-3622; aggregate compute 2112-2264, 2356-2381, 2757-2776, 3136-3153, 3474-3496, 3561-3566, and 3578-3606; actor helpers 3466-3472; fact/authority validation 3626-3748; command input validation 4037-4165; request keys 4167-4202; command keys 4204-4233`
Source changed regions: `The target sections partition those non-overlapping spans. Presence-summary contracts 294-314 and mutation families moved to undeclared exact-rename targets are not claimed by the mutation-contract target.`
Compatibility status/path: `packages/shared-server/rallar-system/services/group-state-mutations.ts remains a direct named re-export-only compatibility path for the affected public symbols.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-group-aggregate-mutation.ts`

Target symbol or line span: `computeCreate/update/director/rotate lines 53-220; groupWrite and authority/lifecycle helpers lines 222-312`
Target changed regions: `Whole added module lines 1-312; source aggregate functions 2112-2264, 2356-2381, 2757-2776, 3136-3153, 3474-3496, 3561-3566, and 3578-3606. Source materializedRotateJoinCode 2383-2396 and member/event helpers 3498-3559 and 3568-3576 belong to other target owners and are excluded.`
Mechanical-move classification: `Mixed extraction with a named GroupWriteInput boundary.`
Semantic additions excluded from inherited capacity: `Imports and GroupWriteInput lines 1-51 receive zero capacity.`
Human disposition: `Accepted for the listed aggregate symbols only.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts`

Target symbol or line span: `computeGroupMutation lines 40-87; probeGroupMutationIdempotency lines 89-109; fact/authority validators lines 111-244`
Target changed regions: `Whole added module lines 1-244; source compute/probe 647-720 and fact/authority validation 3626-3748.`
Mechanical-move classification: `Mixed extraction; two validation decisions were named as separate helpers.`
Semantic additions excluded from inherited capacity: `Imports and new validateAuthenticatedAuthority/validateResolvedJoinCodePair boundaries lines 1-39 and 151-182 receive zero capacity.`
Human disposition: `Accepted for mapped compute/probe/fact statements; new helper structure gets no allowance.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts`

Target symbol or line span: `NullableActorInput through GroupMutationRejectedError lines 25-325`
Target changed regions: `Whole added module lines 1-325; source mutation contracts/error lines 97-292 and 316-400 map to target lines 25-325.`
Mechanical-move classification: `Mechanical contract extraction with import/export relocation only.`
Semantic additions excluded from inherited capacity: `Imports lines 1-23 receive zero capacity; source presence-summary contracts lines 294-314 are explicitly excluded from this target.`
Human disposition: `Accepted for the exact contract/error symbols; imports are excluded.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts`

Target symbol or line span: `request validators lines 21-140; request key inventories lines 142-227`
Target changed regions: `Whole added module lines 1-227; source request shell 402-419, presence request validation 515-604, and request-key inventories 4167-4202.`
Mechanical-move classification: `Mixed extraction; presence timestamp ordering received a named helper boundary.`
Semantic additions excluded from inherited capacity: `Imports and validatePresenceTimestampOrder function boundary receive zero capacity; source operation-specific request branches 420-512 belong only to the operation-input target.`
Human disposition: `Accepted for source-derived validation statements and key inventories only.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation-write.ts`

Target symbol or line span: `validateComputedWrite and split validators lines 43-277; expected members/outbox/actor helpers lines 279-338`
Target changed regions: `Whole added module lines 1-338; source validateComputedWrite 1583-1740, expected/outbox 1742-1795, and actor helpers 3466-3472.`
Mechanical-move classification: `Mixed extraction of one large validator into cohesive named phases.`
Semantic additions excluded from inherited capacity: `Imports/input interface and new phase function boundaries receive zero capacity; moved validation statements alone may inherit.`
Human disposition: `Accepted with capacity constrained to the mapped validation statements.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation.ts`

Target symbol or line span: `ValidateComputedMutationShapeInput and validateComputedMutationShape lines 11-39; outcome validators lines 41-98`
Target changed regions: `Whole added module lines 1-102; source validateComputedMutationShape lines 1529-1581.`
Mechanical-move classification: `Mixed extraction and named decomposition of outcome-key branches.`
Semantic additions excluded from inherited capacity: `Imports, interfaces, and new helper boundaries receive zero capacity.`
Human disposition: `Accepted only for validation statements demonstrably derived from source lines 1529-1581.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts`

Target symbol or line span: `validateGroupMutationCommand lines 13-59; operation validators lines 61-191; operation/key inventories lines 193-314`
Target changed regions: `Whole added module lines 1-314; source command shell 606-645, command-input validation 4037-4165, and command-key inventory 4204-4233.`
Mechanical-move classification: `Mixed extraction and split of aggregate, membership, presence, and nullable-field validation.`
Semantic additions excluded from inherited capacity: `Imports, newly named split helpers, and AGGREGATE_GROUP_MUTATION_OPERATIONS receive zero capacity; request-key inventory 4167-4202 is excluded.`
Human disposition: `Accepted for mapped command-validation branches and inventories only.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts`

Target symbol or line span: `validateGroupMutationOperationInput lines 14-24; aggregate/membership validators and predicates lines 26-166`
Target changed regions: `Whole added module lines 1-166; source optional-field helpers and operation-specific request branches lines 420-512.`
Mechanical-move classification: `Mixed extraction of operation input checks into a dedicated owner.`
Semantic additions excluded from inherited capacity: `Imports/input/type contracts and newly named predicate/function boundaries receive zero capacity; source presence request 515-604 and command validation 4037-4233 are excluded.`
Human disposition: `Accepted only for the source-derived checks; the target owner surface has no inherited allowance.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation-read.ts`

Target symbol or line span: `validateGroupMutationRead and split read validators lines 44-309; validateRuntimeEntryValue lines 311-354; validateMemberReadPair lines 356-387`
Target changed regions: `Whole added module lines 1-387; source validateGroupMutationRead 774-960, validateRuntimeEntryValue 962-1002, and validateMemberReadPair 1062-1085.`
Mechanical-move classification: `Mixed extraction and named decomposition of read-state validation.`
Semantic additions excluded from inherited capacity: `Imports, interfaces, key inventory, and new helper boundaries receive zero capacity.`
Human disposition: `Accepted for mapped validation statements only.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-group-mutation-result.ts`

Target symbol or line span: `receipt key inventory lines 24-40; idempotency/receipt/hash validators lines 42-242`
Target changed regions: `Whole added module lines 1-242; source idempotency validator 1490-1527 and receipt/hash validators 3897-4026.`
Mechanical-move classification: `Mixed extraction and named decomposition of receipt outcomes.`
Semantic additions excluded from inherited capacity: `Imports, new key inventory/input interface, and split helper boundaries receive zero capacity.`
Human disposition: `Accepted for source-derived idempotency, receipt, and hash checks only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-state-persistence-codec.ts`

Target symbol or line span: `persisted key inventory lines 25-51; normalizePersisted functions and audit/actor helpers lines 53-311`
Target changed regions: `Whole added module lines 1-311; source normalizers 1209-1396 and persisted/audit/actor helpers 3783-3845.`
Mechanical-move classification: `Mixed extraction of persistence normalization into the codec owner.`
Semantic additions excluded from inherited capacity: `Imports and PERSISTED_GROUP_KEYS lines 1-51 receive zero capacity.`
Human disposition: `Accepted for the mapped normalizer/helper bodies only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/validate-persisted-group-presence.ts`

Target symbol or line span: `presence key inventories lines 23-66; persisted presence/session/summary/admission validators lines 68-274`
Target changed regions: `Whole added module lines 1-274; source presence validation 1155-1207, 1412-1488, and 3305-3405.`
Mechanical-move classification: `Mechanical extraction with key inventories made local to the validator owner.`
Semantic additions excluded from inherited capacity: `Imports and the four local key inventories receive zero capacity.`
Human disposition: `Accepted for the listed source validator bodies only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/validate-persisted-group.ts`

Target symbol or line span: `stored key inventories lines 22-64; group/member/scoped/audit/actor/causal validators lines 66-233`
Target changed regions: `Whole added module lines 1-233; source validateStoredGroup 1004-1060, validateStoredMember 1106-1153, persisted group/member validation 1398-1410, scoped validation 3750-3781, and audit/actor/causal validation 3847-3895. Source validateMemberReadPair 1062-1085 belongs to validate-group-mutation-read; mutation-target helpers 1087-1104 belong to their declared renamed owners; normalization helpers 3783-3845 belong to group-state-persistence-codec.`
Mechanical-move classification: `Mechanical extraction with local key inventories.`
Semantic additions excluded from inherited capacity: `Imports and STORED_GROUP_KEYS/STORED_MEMBER_KEYS receive zero capacity.`
Human disposition: `Accepted for the exact source-derived validators only.`

### Target: `packages/shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts`

Target symbol or line span: `summary contracts lines 37-67; compute/validate and split validators lines 69-234; content helpers lines 236-299`
Target changed regions: `Whole added module lines 1-301; source summary contracts 294-314, compute/validate 1850-2015, and summaryContent 3608-3622.`
Mechanical-move classification: `Mixed extraction and named decomposition of summary validation.`
Semantic additions excluded from inherited capacity: `Imports, GroupPresenceSummaryValidation, and new split helper boundaries receive zero capacity.`
Human disposition: `Accepted only for source-derived summary computations/checks.`

## Source: `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts`

Source blob: `ade6c012f1ea17ff3b3604f1bac05c6764b4f7a0`
Source symbol or line span: `contracts/error 82-84 and 95-113; reads 126-163, 198-233, 293-329, 534-541, 552-580, 601-618, 663-693, 720-739, 747-755; shared entry conversion 165-180; aggregate writes 182-196, 235-257, 265-291, 543-545, 782-808; snapshots 331-532 and 810-888; membership writes 547-550 and 582-586; presence writes 588-599, 620-661, 695-718, 741-745, 757-780; helpers 923-1244 partitioned exactly below`
Source changed regions: `The target sections partition all claimed operation/helper spans once. Constructor/event property and key-helper regions outside these spans are not claimed.`
Compatibility status/path: `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts remains a direct named re-export-only compatibility path.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-aggregate-repository.ts`

Target symbol or line span: `GroupAggregateRepository lines 43-140; aggregate guard/idempotency helpers lines 142-292`
Target changed regions: `Whole added module lines 1-292; source aggregate methods 182-196, 235-257, 265-291, 543-545, 782-808 and helpers 923-935, 954-1056, 1169-1204.`
Mechanical-move classification: `Mixed class extraction with unchanged aggregate repository operations.`
Semantic additions excluded from inherited capacity: `Imports, renamed class/constructor, and owner wiring receive zero capacity.`
Human disposition: `Accepted for mapped methods/helpers only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-membership-repository.ts`

Target symbol or line span: `GroupMembershipRepository lines 22-35; canonicalStoredMember lines 37-58`
Target changed regions: `Whole added module lines 1-58; source member writes 547-550 and 582-586 plus canonicalStoredMember 1058-1081.`
Mechanical-move classification: `Mixed class extraction of membership writes and decoding.`
Semantic additions excluded from inherited capacity: `Imports, class/constructor, and renamed owner surface receive zero capacity.`
Human disposition: `Accepted for the mapped method/helper bodies only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-presence-repository.ts`

Target symbol or line span: `GroupPresenceRepository lines 49-152; canonical presence helpers lines 154-221`
Target changed regions: `Whole added module lines 1-221; source presence writes 588-599, 620-661, 695-718, 741-745, 757-780 and canonical helpers 1083-1150.`
Mechanical-move classification: `Mixed class extraction of presence persistence operations.`
Semantic additions excluded from inherited capacity: `Imports, class/constructor, and new owner wiring receive zero capacity.`
Human disposition: `Accepted for mapped presence methods/helpers only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts`

Target symbol or line span: `repository contracts/error lines 6-31; entry and identity helpers lines 33-128`
Target changed regions: `Whole added module lines 1-128; source contracts/error 82-84 and 95-113, sole inherited toLiveEntryValue owner 165-180, and helpers 937-952, 1152-1167, 1206-1244.`
Mechanical-move classification: `Mixed extraction with descriptive renames for generic repository helpers.`
Semantic additions excluded from inherited capacity: `Imports and renamed function boundaries receive zero capacity; equivalent bodies alone may inherit.`
Human disposition: `Accepted only for the mapped contract and helper behavior.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts`

Target symbol or line span: `GroupStateRepositoryReads methods lines 47-261`
Target changed regions: `Whole added module lines 1-261; source read methods 126-163, 198-233, 293-329, 534-541, 552-580, 601-618, 663-693, 720-739, and 747-755. Aggregate, membership, and presence writes interleaved at 543-550, 582-599, 620-661, 695-718, and 741-745 belong only to their owning targets.`
Mechanical-move classification: `Mixed class extraction of exact read operations from GroupStateRepository.`
Semantic additions excluded from inherited capacity: `Imports, class inheritance/owner surface, and method declarations newly required by the split receive zero capacity.`
Human disposition: `Accepted for the listed predecessor method bodies only.`

### Target: `packages/shared-server/rallar-system/group-state/persistence/group-state-snapshot-repository.ts`

Target symbol or line span: `GroupStateSnapshotRepository lines 56-302`
Target changed regions: `Whole added module lines 1-302; source snapshot/list/page methods 331-532 and 810-888.`
Mechanical-move classification: `Mixed extraction and decomposition of snapshot assembly/page reads.`
Semantic additions excluded from inherited capacity: `Imports, abstract owner surface, declared dependency methods, new split helper boundaries, and target toLiveEntryValue lines 287-293 receive zero capacity; source 165-180 belongs only to persistence-contracts.`
Human disposition: `Accepted for mapped snapshot algorithms only.`

## Source: `packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts`

Source blob: `837714f6dc40c6572c4114490c6b366f5dec122e`
Source symbol or line span: `WriteMutation and presence lifecycle functions lines 25-194`
Source changed regions: `All executable source symbols map to the single target; the payload contract moved to a separate complete-renamed lineage and is not claimed here.`
Compatibility status/path: `packages/shared-server/rallar-system/services/app-group-ws-session-lifecycle.ts remains a direct named re-export-only compatibility path.`

### Target: `packages/shared-server/rallar-system/group-state/presence/group-presence-service.ts`

Target symbol or line span: `WriteMutation and result contracts lines 21-35; enqueue/process/helper functions lines 37-200`
Target changed regions: `Whole added module lines 1-200; source functions lines 25-194 map to target lines 37-200.`
Mechanical-move classification: `Mechanical extraction with explicit result type names.`
Semantic additions excluded from inherited capacity: `Imports and result type aliases/interfaces lines 1-35 receive zero capacity.`
Human disposition: `Accepted for mapped lifecycle functions only.`

## Source: `packages/shared-server/rallar-system/services/group-snapshot-validation.ts`

Source blob: `94e8f14c8753aca5236b7c0f968e6c945b0406e3`
Source symbol or line span: `validatePersistedGroupSnapshot and private helpers lines 11-138`
Source changed regions: `The single validator was split into named revision, roster, and presence phases; private decoding helpers retained their roles.`
Compatibility status/path: `packages/shared-server/rallar-system/services/group-snapshot-validation.ts remains a direct named re-export-only compatibility path.`

### Target: `packages/shared-server/rallar-system/group-state/snapshot/validate-persisted-group-snapshot.ts`

Target symbol or line span: `snapshot contracts lines 13-19; validatePersistedGroupSnapshot and split phases lines 22-125; private helpers lines 127-162`
Target changed regions: `Whole added module lines 1-162; source validator/helpers lines 11-138.`
Mechanical-move classification: `Mixed extraction and decomposition of the source validator.`
Semantic additions excluded from inherited capacity: `Imports/contracts and newly named phase boundaries receive zero capacity.`
Human disposition: `Accepted only for validation statements derived from the source validator/helper spans.`

## Source: `packages/shared-server/rallar-system/services/group-state-validation-primitives.ts`

Source blob: `71860577dc37f2c8fb8cf4025559a6cf0cff6bb4`
Source symbol or line span: `all ten exported validation primitives lines 1-109`
Source changed regions: `Eight primitives at source lines 20-109 map mechanically. Source assertExactKeys lines 1-9 and assertRequiredKeys lines 11-18 were rewritten with wider object parameters and are capacity-ineligible.`
Compatibility status/path: `The old path was removed; internal consumers import the canonical feature-root owner directly, so no public compatibility path was required.`

### Target: `packages/shared-server/rallar-system/group-state/group-state-validation-primitives.ts`

Target symbol or line span: `validation primitive surface lines 3-93; validateGroupRef lines 95-101`
Target changed regions: `Whole added module lines 1-101; eight mechanically source-derived primitives map to target lines 18-93. The widened assertExactKeys/assertRequiredKeys rewrites occupy target lines 3-16, and cross-source validateGroupRef occupies lines 95-101.`
Mechanical-move classification: `Mixed: eight primitives moved mechanically; the first two parameter contracts widened from Readonly<Record<string, unknown>> to object, and validateGroupRef came from a different source.`
Semantic additions excluded from inherited capacity: `Import line 1, assertExactKeys target lines 3-7, assertRequiredKeys target lines 9-16, and validateGroupRef lines 95-101 receive zero capacity.`
Human disposition: `Accepted only for the eight source-derived primitives at target lines 18-93; deny capacity to both widened functions and validateGroupRef.`

## Source: `packages/shared-server/rallar-system/services/group-state-crypto.ts`

Source blob: `5e804aaa083a2ca1a9f46a7ff378d33aab26ca79`
Source symbol or line span: `all six crypto/canonicalization functions lines 1-69`
Source changed regions: `All source functions map one-for-one to target lines 1-66 with formatting-only signature compaction.`
Compatibility status/path: `The old internal path was removed; consumers import the canonical mutation owner directly.`

### Target: `packages/shared-server/rallar-system/group-state/mutation/group-state-crypto.ts`

Target symbol or line span: `hmacSha256Hex through bytesToHex lines 1-66`
Target changed regions: `Whole added module lines 1-66, wholly source-derived.`
Mechanical-move classification: `Mechanical move and formatting only.`
Semantic additions excluded from inherited capacity: `none; no semantically new region was identified.`
Human disposition: `Accepted for whole-target source lineage.`

## Source: `packages/shared-server/rallar-system/services/group-expired-state-authority.ts`

Source blob: `dd7adf62ec3e1e907af5133481aea04f94acfd0c`
Source symbol or line span: `validateGroupExpiredStateAuthority lines 9-35; toExpiredAwareInsertCandidate lines 37-45`
Source changed regions: `Both exported functions map to target lines 12-51.`
Compatibility status/path: `The old internal path was removed; consumers import the canonical presence owner directly.`

### Target: `packages/shared-server/rallar-system/group-state/presence/group-expired-state-authority.ts`

Target symbol or line span: `validateGroupExpiredStateAuthority lines 12-40; toExpiredAwareInsertCandidate lines 42-51`
Target changed regions: `Whole added module lines 1-51; executable lines 12-51 are source-derived.`
Mechanical-move classification: `Mechanical move with dependency import relocation.`
Semantic additions excluded from inherited capacity: `Imports lines 1-10 receive zero capacity.`
Human disposition: `Accepted for both function bodies only.`

## Source: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`

Source blob: `baaadae42ebe02e4d6cdd9a856f77dd8afc77c45`
Source symbol or line span: `readiness input 17-37; log-tail contracts/constants 39-47 and 69; server contracts 49-60; redaction constants 70-74; process functions 319-390 and 754-777; readiness/diagnostics 392-574 and 648-715; log-tail functions 575-646`
Source changed regions: `The target sections partition those spans once. Source sleep lines 717-742 and managed Postgres run-database behavior receive zero capacity because no uniquely mechanical target mapping is accepted.`
Compatibility status/path: `api-v1-black-box-run.mts remains the active orchestrator and directly re-exports moved readiness names; log-tail names remain available through the readiness compatibility export.`

### Target: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-readiness.mts`

Target symbol or line span: `WaitForManagedApiReadyInput lines 17-39; readiness state/operations lines 41-294; diagnostic/abort/sleep helpers lines 296-393`
Target changed regions: `Whole added module lines 1-393; source readiness input 17-37 and readiness/diagnostic spans 392-574 and 648-715.`
Mechanical-move classification: `Mixed extraction and explicit state-machine decomposition of waitForManagedApiReady.`
Semantic additions excluded from inherited capacity: `Imports, new readiness state/contracts, newly named decomposition boundaries, and target sleep lines 368-393 receive zero capacity; source log-tail 575-646 and sleep 717-742 are excluded.`
Human disposition: `Accepted for source-derived readiness/diagnostic statements only.`

### Target: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-redaction-patterns.mts`

Target symbol or line span: `five exported redaction constants lines 1-23`
Target changed regions: `Whole added module lines 1-23; source constants lines 70-74.`
Mechanical-move classification: `Mixed: URL_USERINFO_PASSWORD and BEARER_CREDENTIAL moved mechanically; three long regex literals were rewritten as RegExp construction.`
Semantic additions excluded from inherited capacity: `MANAGED_SECRET_ENV_KEY target lines 1-7, SENSITIVE_QUERY_VALUE lines 10-16, and SENSITIVE_ASSIGNMENT lines 17-23 receive zero capacity despite behavior preservation.`
Human disposition: `Accept inherited capacity only for the unchanged regex literals at target lines 8-9; rewritten construction receives none.`

### Target: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-log-tail.mts`

Target symbol or line span: `log-tail contracts lines 3-18; read/resolve helpers lines 20-86`
Target changed regions: `Whole added module lines 1-86; source contracts/constants 39-47 and 69, functions 575-646.`
Mechanical-move classification: `Mixed extraction with a named ManagedLogTailInput contract.`
Semantic additions excluded from inherited capacity: `Import and ManagedLogTailInput lines 1 and 13-16 receive zero capacity.`
Human disposition: `Accepted for mapped contracts and helper bodies only.`

### Target: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-postgres-run-database.mts`

Target symbol or line span: `ManagedPostgresRunSelector and all run-database functions lines 3-79`
Target changed regions: `Whole added module lines 1-79; no symbol or span exists in the declared approved-base source.`
Mechanical-move classification: `Semantic-new target, not a mechanical move from this lineage source.`
Semantic additions excluded from inherited capacity: `Entire target lines 1-79 receive zero inherited capacity.`
Human disposition: `Target existence is audited, but historical capacity is denied for the whole file.`

### Target: `packages/shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts`

Target symbol or line span: `server contracts lines 1-38; PGlite storage lines 40-85; start/stop/stream/sleep operations lines 87-185`
Target changed regions: `Whole added module lines 1-185; source server contracts 49-60, start/append 319-390, and stop 754-777.`
Mechanical-move classification: `Mixed: server process lifecycle moved; PGlite storage lifecycle is semantic-new relative to the source.`
Semantic additions excluded from inherited capacity: `Managed child/file/runtime contracts, PGlite storage lines 13-85, renamed owner boundaries, and target sleep lines 183-185 receive zero capacity; source sleep 717-742 is unclaimed.`
Human disposition: `Accepted only for source-derived server start/stop/stream statements; target sleep is excluded.`

## Source: `packages/shared-test/black-box-runner/api-v1-state-write-evidence.ts`

Source blob: `90f1497f1636ea8685dba92b7757f9f94e5d6088`
Source symbol or line span: `evidence contracts 15-82; DEFAULT_DATABASE_URL 84; parse/effect/derive 86-265; SQL reads/fixture 267-364; old collector SQL body 370-373 and 376-395; old collector connection lifecycle 374-375 and 396-398`
Source changed regions: `The target sections partition the old collector statements: SQL validation/collection belongs to the SQL target, while connection creation/finalization belongs to the source adapter. The old declaration/signature lines 366-369, new dispatcher, source selection, and PGlite protocol receive zero capacity.`
Compatibility status/path: `api-v1-state-write-evidence.ts remains a direct named re-export-only compatibility path.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts`

Target symbol or line span: `evidence SQL/spec contracts lines 3-31; row/evidence contracts lines 33-97`
Target changed regions: `Whole added module lines 1-97; source EvidenceSpec and row contracts lines 15-82.`
Mechanical-move classification: `Mixed contract extraction with an explicit generalized SQL port.`
Semantic additions excluded from inherited capacity: `ApiV1StateWriteEvidence and SQL query/service contracts lines 3-31 receive zero capacity except fields directly traceable to EvidenceSpec.`
Human disposition: `Accepted for mapped row/spec fields only; new SQL abstraction is excluded.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts`

Target symbol or line span: `parse/effect helpers lines 20-155; derive and split selection/linking helpers lines 157-332`
Target changed regions: `Whole added module lines 1-332; source parseRow/effect/derive lines 86-265.`
Mechanical-move classification: `Mixed extraction and decomposition of evidence derivation.`
Semantic additions excluded from inherited capacity: `Imports, contracts, and newly named result/selection/linking boundaries receive zero capacity.`
Human disposition: `Accepted only for source-derived parsing/effect/derivation statements.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts`

Target symbol or line span: `source-selection contracts/functions lines 13-132; PGlite snapshot protocol lines 134-394`
Target changed regions: `Whole added module lines 1-394; only DEFAULT_DATABASE_URL source line 84 and old collector connection lifecycle statements 374-375 and 396-398 map to target lines 13 and 75-85.`
Mechanical-move classification: `Predominantly semantic-new source-selection/PGlite target with mechanically extracted PostgreSQL connection lifecycle.`
Semantic additions excluded from inherited capacity: `New source selection, dispatcher collectApiV1StateWriteEvidence lines 100-115, SQL port translation, and the entire PGlite snapshot protocol receive zero capacity; old collector signature 366-369 is unclaimed.`
Human disposition: `Accept only the constant and exact connection lifecycle statements; deny capacity to the dispatcher and all new source/PGlite behavior.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-sql.ts`

Target symbol or line span: `SQL read/fixture helpers lines 19-134; collectApiV1StateWriteEvidenceFromSql lines 136-178`
Target changed regions: `Whole added module lines 1-178; source SQL reads/fixture lines 267-364 and old collector SQL body statements 370-373 and 376-395.`
Mechanical-move classification: `Mixed extraction of the source's SQL-backed evidence collection.`
Semantic additions excluded from inherited capacity: `Imports, renamed SQL spec, and new collection-owner boundary receive zero capacity.`
Human disposition: `Accepted for source-derived SQL query/fixture statements only.`

## Source: `packages/shared-test/black-box-runner/api-v1-state-write-group-causal-evidence.ts`

Source blob: `9be5158ab51c0106cf73a2f855cf97ad4eadd24b`
Source symbol or line span: `all contracts, policy, and validation helpers lines 8-186`
Source changed regions: `All source symbols map one-for-one to target lines 8-204 with formatting only.`
Compatibility status/path: `The old internal path was removed; callers use the canonical state-write-evidence owner.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-group-causal-evidence.ts`

Target symbol or line span: `all declarations lines 8-204`
Target changed regions: `Whole added module lines 1-204; executable/contracts lines 8-204 are source-derived.`
Mechanical-move classification: `Mechanical move and formatting only.`
Semantic additions excluded from inherited capacity: `Imports lines 1-6 receive zero capacity.`
Human disposition: `Accepted for all mapped declarations.`

## Source: `packages/shared-test/black-box-runner/api-v1-state-write-json-evidence.ts`

Source blob: `9dfbd2c6a5c350ee14ba56088b3c56d62ce9ba24`
Source symbol or line span: `all three exported functions lines 1-35`
Source changed regions: `All source functions map one-for-one to target lines 1-36.`
Compatibility status/path: `The old internal path was removed; callers use the canonical state-write-evidence owner.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-json-evidence.ts`

Target symbol or line span: `parseEvidenceJson, nestedEvidenceJson, collectEvidenceNamedStrings lines 1-36`
Target changed regions: `Whole added module lines 1-36, wholly source-derived.`
Mechanical-move classification: `Mechanical move and formatting only.`
Semantic additions excluded from inherited capacity: `none.`
Human disposition: `Accepted for whole-target source lineage.`

## Source: `packages/shared-test/black-box-runner/api-v1-state-write-match.ts`

Source blob: `30af6a2b9de18b3215700b89fb0166af466fa9d3`
Source symbol or line span: `toExactPersistedEvidenceMatches lines 4-9`
Source changed regions: `The sole function maps to target lines 3-10.`
Compatibility status/path: `The old internal path was removed; callers use the descriptive canonical owner.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/to-exact-persisted-evidence-matches.ts`

Target symbol or line span: `toExactPersistedEvidenceMatches lines 3-10`
Target changed regions: `Whole added module lines 1-10; function lines 3-10 are source-derived.`
Mechanical-move classification: `Mechanical move and signature formatting.`
Semantic additions excluded from inherited capacity: `Import line 1 receives zero capacity.`
Human disposition: `Accepted for the function body only.`

## Source: `packages/shared-test/black-box-runner/api-v1-state-write-topology-result-evidence.ts`

Source blob: `c88f184577dfad6af825f8caa2643a0ca6dc2d9c`
Source symbol or line span: `all declarations lines 4-107`
Source changed regions: `All source declarations map one-for-one to target lines 3-132 with formatting expansion.`
Compatibility status/path: `The old internal path was removed; callers use the descriptive canonical owner.`

### Target: `packages/shared-test/black-box-runner/state-write-evidence/validate-topology-mutation-result-payload.ts`

Target symbol or line span: `all declarations lines 3-132`
Target changed regions: `Whole added module lines 1-132; declarations lines 3-132 are source-derived.`
Mechanical-move classification: `Mechanical move and formatting only.`
Semantic additions excluded from inherited capacity: `Imports lines 1-2 receive zero capacity.`
Human disposition: `Accepted for all mapped declarations.`

## Source: `packages/shared-test/black-box-runner/artifact-report-bounds.ts`

Source blob: `2bf9ee11bb835ab44706d964a5caff9d0dae2f1c`
Source symbol or line span: `all declarations lines 1-37`
Source changed regions: `All declarations map one-for-one to target lines 1-38.`
Compatibility status/path: `The old internal path was removed; callers use the canonical artifacts owner.`

### Target: `packages/shared-test/black-box-runner/artifacts/with-bounded-artifact-report-results.ts`

Target symbol or line span: `all declarations lines 1-38`
Target changed regions: `Whole added module lines 1-38, wholly source-derived.`
Mechanical-move classification: `Mechanical move and formatting only.`
Semantic additions excluded from inherited capacity: `none.`
Human disposition: `Accepted for whole-target source lineage.`

## Source: `packages/shared-test/black-box-runner/live-preflight-variables.ts`

Source blob: `2ede5ae0110654cc4cae9f1e80cfe37f6b670933`
Source symbol or line span: `JsonRecord and resolveBlackBoxRunnerLivePreflightVariableByEnv/resolveVariable/helpers lines 1-79`
Source changed regions: `The public function was renamed and its body plus all private helpers map to target lines 1-74.`
Compatibility status/path: `The old internal path was removed; callers use the canonical preflight owner.`

### Target: `packages/shared-test/black-box-runner/preflight/resolve-variable-by-env.ts`

Target symbol or line span: `JsonRecord and resolveVariableByEnv/resolveVariable/helpers lines 1-74`
Target changed regions: `Whole added module lines 1-74; all declarations map to the source public function and helpers.`
Mechanical-move classification: `Mechanical move with the public function shortened to match the descriptive filename.`
Semantic additions excluded from inherited capacity: `The renamed exported boundary itself receives no capacity; its unchanged body and private helpers may inherit.`
Human disposition: `Accepted for mapped function bodies only.`
