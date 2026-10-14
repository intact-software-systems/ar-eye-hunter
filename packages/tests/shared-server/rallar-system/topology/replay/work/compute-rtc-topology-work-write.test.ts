import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { decodeTopologyPromotionWork } from '@shared-server/rallar-system/group-state/topology-promotion-outbox-entry.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { decodeRtcTopologySnapshot } from '@shared-server/rallar-system/topology/persistence/decode-rtc-topology-snapshot.ts';
import { toStoredRtcTopologySnapshotRow } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyExecutionReceipt } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { validateRtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/validate-rtc-topology-publication.ts';
import {
    computeRtcTopologyReplayWrite,
    computeRtcTopologyWorkWrite,
    validateRtcTopologyReplayWrite,
    validateRtcTopologyWorkWrite,
    type AcceptedRtcTopologyWork,
    type ComputeRtcTopologyWorkWriteInput
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work-write.ts';
import {
    computeRtcTopologyWork,
    validateRtcTopologyWork,
    type ComputeRtcTopologyWorkInput
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { readRtcTopologyWorkEnvelope, toRtcTopologyExecutionId } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { toCanonicalGroupRef, type GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    createGroupRef,
    createPublication,
    createTopologySnapshot
} from '../../rtc-topology-repository-test-fixtures.ts';
import { createRtcTopologyGroupSnapshot } from '../../rtc-topology-test-fixtures.ts';

describe('RTC topology complete write computation', () => {
    it.each(['matching', 'absent'] as const)(
        'prepares latest presence coverage after a coalesced same-session return with %s stored fingerprint',
        async (fingerprint) => {
            const fixture = createCompleteWorkInput();
            const initial = createRtcTopologyGroupSnapshot('group-1', ['session-1', 'session-2', 'session-3']);
            const initialGroup = {
                ...initial,
                causalRevision: { groupRevision: 43, presenceRevision: 35 },
                group: {
                    ...initial.group,
                    snapshotVersion: 43,
                    presenceVersion: 35,
                    formationElectorate: ['session-1', 'session-2', 'session-3'],
                    acceptedLayoutIdentity: { groupRevision: 43, presenceRevision: 35, version: 34, state: 'active' }
                }
            } as const;
            const initialSnapshot: RallarOverlayTopologySnapshot = {
                ...createCandidateSnapshot(initialGroup),
                activeSessionIds: ['session-1', 'session-2', 'session-3'],
                nextHopsBySessionId: {
                    'session-1': ['session-2', 'session-3'],
                    'session-2': ['session-1', 'session-3'],
                    'session-3': ['session-1', 'session-2']
                },
                createdByClientId: 'owner',
                version: 34
            };
            const departed = {
                ...initialGroup,
                causalRevision: { groupRevision: 43, presenceRevision: 36 },
                group: { ...initialGroup.group, presenceVersion: 36 },
                activeSessions: initialGroup.activeSessions.filter((session) => session.sessionId !== 'session-2'),
                onlineMemberCount: 2
            };
            const returned = {
                ...initialGroup,
                causalRevision: { groupRevision: 43, presenceRevision: 37 },
                group: { ...initialGroup.group, presenceVersion: 37 }
            };
            const queued = createCoalescedReturnEntry(departed, returned);
            const entry = { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };
            const workEnvelope = readRtcTopologyWorkEnvelope(
                decodePersistedALMessage(entry.resource),
                AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
            );
            expect(workEnvelope.data).toMatchObject({
                kind: 'group-revision',
                sourceGroupStateCausalRevision: { groupRevision: 43, presenceRevision: 37 }
            });
            const initialAuthority = { ...fixture.read.authority, group: initialGroup };
            const input: ComputeRtcTopologyWorkInput = {
                ...fixture,
                facts: {
                    workEnvelope,
                    workId: toRtcTopologyExecutionId(workEnvelope),
                    attemptCount: entry.dequeueAudit.attempts,
                    expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds
                },
                entry,
                reservationFinish: { ...fixture.reservationFinish, key: entry.key, expectedAttempts: 1, completedAt: new Date(2_000) },
                publicationExpireAtTimestamp: 10_000,
                read: {
                    mutation: {
                        snapshot: {
                            value: initialSnapshot,
                            entry: {
                                ...toStoredRtcTopologySnapshotRow(initialSnapshot),
                                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                                updatedTimestamp: '2026-01-02T03:04:05.000Z',
                                revision: 1
                            }
                        },
                        publicationClaim: null
                    },
                    authority: { ...initialAuthority, group: returned, nowEpochMs: 2_000 },
                    promotion: { group: returned.group, policy: { status: 'present', policy: createDefaultGroupLifecyclePolicy() } },
                    storedInputFingerprint: fingerprint === 'matching'
                        ? await computeAuthorityTopologyInputFingerprint(initialAuthority)
                        : null
                }
            };

            const computed = await computePreparedTopologyWork(input);
            const transaction = computed.write.kind === 'transaction' ? computed.write.transaction : null;
            expect(transaction?.mutation).toMatchObject({
                snapshotGuard: { candidate: { sourceGroupStateCausalRevision: { groupRevision: 43, presenceRevision: 37 } } }
            });
            if (transaction?.mutation?.outcome !== 'write') {
                throw new Error('Latest presence coverage requires a prepared durable topology snapshot');
            }
            const stored = decodeRtcTopologySnapshot(
                decodeJsonWireValue(JSON.parse(transaction.mutation.persistence.snapshot.value), 'Prepared topology snapshot'),
                returned.group
            );
            expect(stored).toMatchObject({
                sourceGroupStateCausalRevision: { groupRevision: 43, presenceRevision: 37 },
                state: 'active',
                name: 'group-1',
                topology: 'star',
                degreeLimit: 5,
                activeSessionIds: ['session-1', 'session-2', 'session-3'],
                nextHopsBySessionId: {
                    'session-1': ['session-2', 'session-3'],
                    'session-2': ['session-1', 'session-3'],
                    'session-3': ['session-1', 'session-2']
                }
            });
            if (transaction.mutation.persistence.publication === null || transaction.delivery === null || transaction.promotionWrite === null) {
                throw new Error('Latest presence coverage requires publication, delivery and promotion');
            }
            const publication = decodeJsonWireValue(
                JSON.parse(transaction.mutation.persistence.publication.value),
                'Prepared topology publication'
            );
            validateRtcTopologyPublication(publication, returned.group);
            expect(publication.sourceGroupStateCausalRevision).toEqual({ groupRevision: 43, presenceRevision: 37 });
            expect(publication.snapshot).toEqual(stored);
            const pages = transaction.delivery.outboxWrites.map((write) =>
                decodeStateSnapshotPage(decodePersistedALMessage(write.entry.resource), returned.group).fold(
                    (issue) => {
                        throw new Error(issue.message);
                    },
                    (page) => page
                )
            );
            expect(pages.length).toBeGreaterThan(0);
            const delivered = decodeRtcTopologySnapshot(
                decodeJsonWireValue(JSON.parse(pages.map((page) => page.chunk).join('')), 'Prepared topology delivery'),
                returned.group
            );
            expect(delivered).toEqual(stored);
            expect(decodeTopologyPromotionWork(transaction.promotionWrite.entry.resource)).toEqual({
                groupRef: stored.groupRef,
                formationEpoch: 0,
                expectedLayout: { groupRevision: 43, presenceRevision: 37, version: stored.version, state: 'active' }
            });
        }
    );

    it('returns incomparable causal revisions as retry data without preparing a write', async () => {
        const fixture = createCompleteWorkInput();
        const base = fixture.read.authority.group;
        const group = {
            ...base,
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
            group: { ...base.group, snapshotVersion: 1, presenceVersion: 2 }
        };
        const snapshot = {
            ...createCandidateSnapshot(base),
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 1 }
        };
        const input = {
            ...fixture,
            facts: {
                ...fixture.facts,
                workEnvelope: {
                    ...fixture.facts.workEnvelope,
                    data: {
                        ...fixture.facts.workEnvelope.data,
                        kind: 'group-revision' as const,
                        origin: 'automatic' as const,
                        groupSnapshot: group,
                        sourceGroupStateCausalRevision: group.causalRevision
                    }
                }
            },
            read: {
                ...fixture.read,
                authority: { ...fixture.read.authority, group },
                mutation: {
                    publicationClaim: null,
                    snapshot: {
                        value: snapshot,
                        entry: {
                            ...toStoredRtcTopologySnapshotRow(snapshot),
                            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                            updatedTimestamp: '2026-01-02T03:04:05.000Z',
                            revision: 1
                        }
                    }
                }
            }
        };

        const computed = await computeRtcTopologyWork(input);
        expect(computed.fold((retry) => retry, () => null)).toEqual({
            outcome: 'retry',
            reason: 'incomparable-causal-revision'
        });
        await expect(validateRtcTopologyWork(input, computed)).resolves.toEqual([]);
        expect(
            await validateRtcTopologyWork(
                input,
                Either.ofLeft({
                    outcome: 'retry',
                    reason: 'publication-ahead-of-snapshot'
                })
            )
        ).not.toEqual([]);
    });

    it('rejects a changed persistence-ready publication proof before transaction entry', async () => {
        const fixture = createCompleteWorkInput();
        const input = {
            ...fixture,
            publicationExpireAtTimestamp: 10_000,
            facts: { ...fixture.facts, workEnvelope: { ...fixture.facts.workEnvelope, data: { ...fixture.facts.workEnvelope.data, publish: true } } }
        };
        const computed = await computePreparedTopologyWork(input);
        if (computed.write.kind !== 'transaction' || !computed.write.transaction.delivery) {
            throw new Error('Expected publication delivery');
        }
        expect(computed.write.transaction.delivery.provenanceWrites).toHaveLength(1);
        const altered = {
            ...computed,
            write: {
                ...computed.write,
                transaction: {
                    ...computed.write.transaction,
                    delivery: { ...computed.write.transaction.delivery, provenanceWrites: [] }
                }
            }
        };
        expect(await validateRtcTopologyWork(input, Either.ofRight(altered))).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: expect.stringContaining('provenanceWrites') })
        ]));
    });

    it('recomputes the complete decision and persistence-ready write from explicit input', async () => {
        const input = createCompleteWorkInput();
        const computed = await computePreparedTopologyWork(input);
        if (computed.write.kind !== 'transaction') {
            throw new Error('Expected a topology transaction fixture');
        }
        const altered = {
            ...computed,
            write: {
                ...computed.write,
                transaction: {
                    ...computed.write.transaction,
                    promotionWrite: null
                }
            }
        } as const;

        expect(await validateRtcTopologyWork(input, Either.ofRight(altered))).not.toEqual([]);
        await expect(computePreparedTopologyWork(input)).resolves.toEqual(computed);
    });

    it('rejects a write whose precomputed promotion request was removed', async () => {
        const input = createWriteInput();
        const computed = await computeRtcTopologyWorkWrite(input);
        if (computed.kind !== 'transaction' || computed.transaction.promotionWrite === null) {
            throw new Error('Expected a promotion transaction fixture');
        }
        const altered = {
            ...computed,
            transaction: {
                ...computed.transaction,
                promotionWrite: null
            }
        } as const;

        expect(await validateRtcTopologyWorkWrite(input, altered)).not.toEqual([]);
        expect(await computeRtcTopologyWorkWrite(input)).toEqual(computed);
    });

    it('gives each coalesced source generation a distinct publication wake identity', async () => {
        const firstInput = {
            ...createWriteInput(),
            sourceWorkId: 'rtc-topology:group-1:coalesced-work:1',
            formationAutomationEnabled: true
        };
        const secondInput = {
            ...firstInput,
            sourceWorkId: 'rtc-topology:group-1:coalesced-work:2'
        };

        const first = await computeRtcTopologyWorkWrite(firstInput);
        const second = await computeRtcTopologyWorkWrite(secondInput);
        if (first.kind !== 'transaction' || second.kind !== 'transaction') {
            throw new Error('Expected topology transaction fixtures');
        }

        expect(first.transaction.connectWrites).toHaveLength(1);
        expect(second.transaction.connectWrites).toHaveLength(1);
        expect(first.transaction.connectWrites[0]!.entry.key.resourceId).not.toBe(
            second.transaction.connectWrites[0]!.entry.key.resourceId
        );
    });

    it('gives each coalesced source generation a distinct promotion request identity', async () => {
        const firstInput = {
            ...createWriteInput(),
            sourceWorkId: 'rtc-topology:group-1:coalesced-work:1'
        };
        const secondInput = {
            ...firstInput,
            sourceWorkId: 'rtc-topology:group-1:coalesced-work:2'
        };

        const first = await computeRtcTopologyWorkWrite(firstInput);
        const second = await computeRtcTopologyWorkWrite(secondInput);
        if (
            first.kind !== 'transaction' ||
            second.kind !== 'transaction' ||
            first.transaction.promotionWrite === null ||
            second.transaction.promotionWrite === null
        ) {
            throw new Error('Expected topology promotion transaction fixtures');
        }

        expect(first.transaction.promotionWrite.entry.key.resourceId).not.toBe(
            second.transaction.promotionWrite.entry.key.resourceId
        );
    });

    it('leaves durable replay checks to validation', () => {
        const snapshot = createTopologySnapshot(createGroupRef(), 1);
        const publication = createPublication(snapshot, 'work-1');
        const input = {
            read: {
                mutation: {
                    snapshot: {
                        entry: {
                            key: 'snapshot',
                            value: JSON.stringify(snapshot),
                            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                            updatedTimestamp: 'now',
                            revision: 1
                        },
                        value: snapshot
                    },
                    publicationClaim: {
                        receipt: createRtcTopologyExecutionReceipt(publication, {
                            commandHash: `sha256:${'a'.repeat(64)}`,
                            attemptCount: 1,
                            acceptedStorageRevision: 1
                        }),
                        publication
                    }
                },
                outbox: [createReservedEntry()],
                delivery: null
            },
            reservationFinish: {
                key: createReservedEntry().key,
                expectedAttempts: 2,
                status: EntityStatus.COMPLETED,
                completedAt: new Date('2026-01-02T03:05:00.000Z')
            },
            publisherStreamId: undefined
        } as const;

        const computed = computeRtcTopologyReplayWrite(input);

        expect(validateRtcTopologyReplayWrite(input, computed)).toEqual([
            expect.objectContaining({ message: expect.stringContaining('has a conflicting durable outbox') })
        ]);
    });
});

function createCompleteWorkInput(): ComputeRtcTopologyWorkInput {
    const group = createRtcTopologyGroupSnapshot('group-1', ['session-1']);
    const entry = createReservedEntry();
    const work = {
        kind: 'group-revision',
        overlayId: toScopedOverlayId(group.group),
        groupSnapshot: group,
        sourceGroupStateCausalRevision: group.causalRevision,
        requestedAtEpochMs: 1,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        origin: 'automatic',
        publish: false
    } as const;
    return {
        facts: {
            workEnvelope: {
                type: 'RTC_TOPOLOGY_RECOMPUTE',
                topicId: entry.key.topicId,
                resourceId: entry.key.resourceId,
                contextId: entry.key.contextId,
                senderId: entry.audit.createdBy,
                data: work
            },
            workId: 'work-1',
            attemptCount: entry.dequeueAudit.attempts,
            expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds
        },
        read: {
            mutation: { snapshot: null, publicationClaim: null },
            authority: {
                group,
                config: resolveGroupTopologyConfig({}),
                kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
                rttReportingDegreeLimit: 5,
                rttMeasurements: [],
                replanning: 'auto',
                nowEpochMs: 1
            },
            promotion: { group: group.group, policy: { status: 'absent' } },
            storedInputFingerprint: null
        },
        publicationExpireAtTimestamp: null,
        entry,
        reservationFinish: {
            key: entry.key,
            expectedAttempts: entry.dequeueAudit.attempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date('2026-01-02T03:05:00.000Z')
        },
        formationAutomationEnabled: false,
        serviceId: 'topology-service',
        publisherStreamId: undefined
    };
}

function createWriteInput(): ComputeRtcTopologyWorkWriteInput {
    const group = createRtcTopologyGroupSnapshot('group-1', ['session-1']);
    const candidate = createCandidateSnapshot(group);
    const mutationInput = {
        read: { snapshot: null, publicationClaim: null },
        candidate,
        publication: null,
        facts: {
            publicationExpireAtTimestamp: null,
            commandHash: null,
            attemptCount: null
        }
    } as const;
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome === 'loaded' || computed.outcome === 'retry') {
        throw new Error('Expected an accepted topology mutation fixture');
    }
    const entry = createReservedEntry();
    const accepted: AcceptedRtcTopologyWork = {
        decision: 'accepted',
        work: {
            kind: 'group-revision',
            overlayId: candidate.overlayId,
            groupSnapshot: group,
            sourceGroupStateCausalRevision: group.causalRevision,
            requestedAtEpochMs: 1,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            origin: 'automatic',
            publish: false
        },
        group,
        computed,
        mutationInput,
        publication: null,
        inputFingerprint: `sha256:${'a'.repeat(64)}`,
        promotionRead: { group: group.group, policy: { status: 'absent' } },
        criterionPetition: null,
        planningObservation: null
    };
    return {
        accepted,
        entry,
        sourceWorkId: 'rtc-topology:group-1:work-1:0',
        reservationFinish: {
            key: entry.key,
            expectedAttempts: entry.dequeueAudit.attempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date('2026-01-02T03:05:00.000Z')
        },
        formationAutomationEnabled: false,
        serviceId: 'topology-service',
        publisherStreamId: undefined
    };
}

function createCandidateSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: toCanonicalGroupRef(group.group),
        name: 'group-1',
        topology: 'star',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 5,
        version: 1,
        createdByClientId: 'session-1',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

function createReservedEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-01-02T03:04:05');
    return {
        key: {
            topicId: 'rtc-topology',
            resourceId: 'work-1',
            contextId: 'group-1'
        },
        resource: '{"work":1}',
        typeId: 'APP_OUTBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'topology-service',
            createdTs,
            expiryTs: Temporal.Instant.from('2026-01-02T04:04:05Z')
        },
        dequeueAudit: { attempts: 2 }
    };
}

function createCoalescedReturnEntry(
    departed: GroupSnapshot,
    returned: GroupSnapshot
): ResourceEntry {
    const common = {
        aggregateRef: returned.group,
        expireAtEpochMs: 10_000,
        timing: { window: { debounceMs: 500, maxWaitMs: 5_000 }, replanNotBeforeEpochMs: null },
        senderId: 'topology-service',
        origin: 'automatic'
    } as const;
    const departure = computeCoalescedRtcTopologyGroupRevisionWork({
        ...common,
        groupSnapshot: departed,
        requestedAtEpochMs: 100,
        previousEntry: null
    });
    return computeCoalescedRtcTopologyGroupRevisionWork({
        ...common,
        groupSnapshot: returned,
        requestedAtEpochMs: 200,
        previousEntry: departure.entryWrite.entry
    }).entryWrite.entry;
}

async function computePreparedTopologyWork(input: ComputeRtcTopologyWorkInput) {
    const computed = await computeRtcTopologyWork(input);
    return computed.fold(
        (retry) => {
            throw new Error(`Expected prepared topology work, received ${retry.reason}`);
        },
        (prepared) => prepared
    );
}
