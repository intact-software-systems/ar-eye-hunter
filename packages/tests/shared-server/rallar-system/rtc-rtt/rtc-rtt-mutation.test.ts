import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { validateRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-mutation.ts';
import { writeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/write-rtc-rtt-mutation.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { AuditStamp, GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';

const RTT_COMMAND_HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_RTT_COMMAND_HASH = `sha256:${'b'.repeat(64)}`;

describe('RTC RTT mutation phases', () => {
    it('keeps phases explicit while AppInbox exclusively owns retries and transactions', () => {
        const executeUrl = new URL(
            '../../../../shared-server/rallar-system/rtc-rtt/mutation/execute-rtc-rtt-mutation.ts',
            import.meta.url
        );
        const writeUrl = new URL(
            '../../../../shared-server/rallar-system/rtc-rtt/mutation/write-rtc-rtt-mutation.ts',
            import.meta.url
        );

        expect(existsSync(executeUrl)).toBe(true);
        expect(existsSync(writeUrl)).toBe(true);
        if (!existsSync(executeUrl) || !existsSync(writeUrl)) {
            return;
        }
        const executeSource = readFileSync(executeUrl, 'utf8');
        const phases = [
            executeSource.indexOf('await readRtcRttMutation('),
            executeSource.indexOf('computeRtcRttMutation('),
            executeSource.indexOf('validateRtcRttMutation('),
            executeSource.indexOf('await writeRtcRttMutation(')
        ];
        expect(phases).toEqual([...new Set(phases)].toSorted((left, right) => left - right));
        expect(phases[0]).toBeGreaterThanOrEqual(0);
        expect(executeSource).not.toMatch(/\.begin\s*\(/);
        expect(executeSource).not.toMatch(/waitForRuntimeStateWriteRetry|\bfor\s*\([^)]*attempt/);
        expect(executeSource).not.toMatch(/\bsleep\??\s*:/);

        const writeSource = readFileSync(writeUrl, 'utf8');
        expect(writeSource).toMatch(/transaction:\s*PSqlTransactionSql/);
        expect(writeSource).not.toMatch(/RuntimeStateOptimisticTransactionalRepositoryLike/);
    });
    it('computes stale RTT rejection deterministically without mutating frozen reads', () => {
        const incoming = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const input = deepFreeze({
            command: {
                rtt: incoming,
                alSenderId: 'session-a',
                candidateGroups: [],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            },
            read: {
                receipt: null,
                expiredMeasurementEntry: null,
                measurement: {
                    entry: {
                        key: 'pair=session-a%3A%3Asession-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4
                    },
                    value: { ...incoming, version: 3 }
                },
                endpointAdmissions: [],
                expiredEndpointAdmissionEntries: [],
                measurements: [
                    {
                        entry: {
                            key: 'from=session-a:to=session-b',
                            value: JSON.stringify({ ...incoming, version: 3 }),
                            expireAtTimestamp: 10_000,
                            updatedTimestamp: '1970-01-01T00:00:00.000Z',
                            revision: 4
                        },
                        value: { ...incoming, version: 3 }
                    }
                ]
            },
            facts: {
                purgeAfterEpochMs: 10_000,
                requestedAtEpochMs: 2,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });

        const first = computeAndValidateRttTwice(input);
        const second = computeRtcRttMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({ outcome: 'rejected', reason: 'stale' });
    });

    it('computes policy rejection, endpoint-cap rejection, and accepted RTT intents', () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        };
        const group = rttGroupSnapshot(['session-a', 'session-b']);
        const base = {
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            },
            facts: {
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        };
        const emptyRead = {
            receipt: null,
            expiredMeasurementEntry: null,
            measurement: null,
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        };
        expect(
            computeAndValidateRttTwice(
                deepFreeze({
                    ...base,
                    command: { ...base.command, candidateGroups: [] },
                    read: emptyRead
                })
            )
        ).toMatchObject({
            outcome: 'rejected',
            reason: 'no-shared-active-group'
        });
        expect(
            computeAndValidateRttTwice(
                deepFreeze({
                    ...base,
                    read: {
                        ...emptyRead,
                        endpointAdmissions: [
                            {
                                entry: {
                                    key: 'endpoint=session-a',
                                    value: '',
                                    expireAtTimestamp: 60_001,
                                    updatedTimestamp: 'now',
                                    revision: 0
                                },
                                value: {
                                    endpointId: 'session-a',
                                    peers: [
                                        {
                                            peerSessionId: 'session-c',
                                            expiresAtEpochMs: 60_001
                                        }
                                    ],
                                    version: 1,
                                    updatedAtEpochMs: 0
                                }
                            }
                        ]
                    }
                })
            )
        ).toMatchObject({ outcome: 'rejected', reason: 'over-degree' });
        const acceptedInput = deepFreeze({ ...base, read: emptyRead });
        const accepted = computeAndValidateRttTwice(acceptedInput);
        expect(accepted).toMatchObject({
            outcome: 'write',
            receipt: { outcome: 'accepted', measurementVersion: 1 },
            affectedGroups: [group],
            senderId: 'session-a'
        });
        if (accepted.outcome !== 'write') {
            throw new Error('Expected RTT write');
        }
        expect(accepted.endpointGuards.map(({ endpointId }) => endpointId)).toEqual([
            'session-a',
            'session-b'
        ]);
        const tampered = {
            ...accepted,
            endpointGuards: [...accepted.endpointGuards].reverse()
        };
        expect(() => validateRtcRttMutation({ ...acceptedInput, computed: tampered })).toThrow(
            'differs from canonical'
        );
        expect(() => validateRtcRttMutation({ ...acceptedInput, computed: tampered })).toThrow(
            'differs from canonical'
        );
    });

    // The composition resolves the limit per shared group (the group's
    // effective topology config under the server reporting default) before the
    // command is enqueued; the compute honors the resolved value as-is.
    it('admits reports against the composition-resolved degree limit', () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        };
        const group = rttGroupSnapshot(['session-a', 'session-b', 'session-c']);
        const overlay: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 0 },
            state: 'active',
            overlayId: 'overlay-1',
            groupRef: group.group,
            name: 'room-1',
            topology: 'mesh',
            activeSessionIds: ['session-a', 'session-b', 'session-c'],
            nextHopsBySessionId: {
                'session-a': ['session-b', 'session-c'],
                'session-b': ['session-a'],
                'session-c': ['session-a']
            },
            degreeLimit: 3,
            version: 1,
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1
        };
        // Endpoint session-a already carries one admitted peer; under the server
        // default limit of 1 this report would reject over-degree — exactly the
        // starvation that left planned edges unobservable at burst scale.
        const accepted = computeAndValidateRttTwice(
            deepFreeze({
                command: {
                    rtt,
                    alSenderId: 'session-a',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map([[toWebRtcGroupKey(group.group), overlay]]),
                    degreeLimit: 3
                },
                facts: {
                    requestedAtEpochMs: 1,
                    purgeAfterEpochMs: 60_001,
                    commandHash: RTT_COMMAND_HASH,
                    attemptCount: 1
                },
                read: {
                    receipt: null,
                    expiredMeasurementEntry: null,
                    measurement: null,
                    endpointAdmissions: [
                        {
                            entry: {
                                key: 'endpoint=session-a',
                                value: '',
                                expireAtTimestamp: 60_001,
                                updatedTimestamp: 'now',
                                revision: 0
                            },
                            value: {
                                endpointId: 'session-a',
                                peers: [
                                    {
                                        peerSessionId: 'session-c',
                                        expiresAtEpochMs: 60_001
                                    }
                                ],
                                version: 1,
                                updatedAtEpochMs: 0
                            }
                        }
                    ],
                    expiredEndpointAdmissionEntries: [],
                    measurements: []
                }
            })
        );
        expect(accepted).toMatchObject({
            outcome: 'write',
            receipt: { outcome: 'accepted', measurementVersion: 1 }
        });
    });

    it('rejects a malformed complete RTT write candidate before opening a transaction', async () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        };
        const group = rttGroupSnapshot(['session-a', 'session-b']);
        const computed = computeRtcRttMutation({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1
            },
            read: {
                receipt: null,
                expiredMeasurementEntry: null,
                measurement: null,
                endpointAdmissions: [],
                expiredEndpointAdmissionEntries: [],
                measurements: []
            },
            facts: {
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });
        if (computed.outcome !== 'write') {
            throw new Error('Expected RTT write');
        }
        const malformed = structuredClone(computed) as typeof computed;
        delete (
            malformed.affectedGroups[0] as unknown as {
                causalRevision?: unknown;
            }
        ).causalRevision;
        const queries: string[] = [];
        const transaction = createUnopenedTransactionSql(queries);
        const begin = vi.spyOn(transaction, 'begin');

        await expect(
            writeRtcRttMutation(transaction, { ttlMs: 60_000, now: () => 1 }, malformed)
        ).rejects.toThrow();
        expect(begin).not.toHaveBeenCalled();
        expect(queries).toEqual([]);
    });

    it('requires both RTT endpoint sessions to cover the full active interval at acceptance time', () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        };
        const baseGroup = rttGroupSnapshot(['session-a', 'session-b']);
        const withBounds = (connectedAtEpochMs: number, expiresAtEpochMs: number): GroupSnapshot => ({
            ...baseGroup,
            activeSessions: baseGroup.activeSessions.map((session) => ({
                ...session,
                connectedAtEpochMs,
                lastHeartbeatAtEpochMs: Math.max(session.lastHeartbeatAtEpochMs, connectedAtEpochMs),
                expiresAtEpochMs
            }))
        });
        const computeAt = (requestedAtEpochMs: number, group: GroupSnapshot) =>
            computeRtcRttMutation({
                command: {
                    rtt,
                    alSenderId: 'session-a',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1
                },
                read: {
                    receipt: null,
                    expiredMeasurementEntry: null,
                    measurement: null,
                    endpointAdmissions: [],
                    expiredEndpointAdmissionEntries: [],
                    measurements: []
                },
                facts: {
                    requestedAtEpochMs,
                    purgeAfterEpochMs: requestedAtEpochMs + 60_000,
                    commandHash: RTT_COMMAND_HASH,
                    attemptCount: 1
                }
            });

        expect(computeAt(1, withBounds(2, 10))).toMatchObject({
            outcome: 'rejected',
            reason: 'no-shared-active-group'
        });
        expect(computeAt(2, withBounds(2, 10))).toMatchObject({
            outcome: 'write'
        });
        expect(computeAt(10, withBounds(2, 10))).toMatchObject({
            outcome: 'rejected',
            reason: 'no-shared-active-group'
        });
    });

    it('computes every RTT policy rejection family twice from frozen authority', () => {
        const group = rttGroupSnapshot(['session-a', 'session-b', 'session-c']);
        const validRtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        };
        const emptyRead = {
            receipt: null,
            expiredMeasurementEntry: null,
            measurement: null,
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        };
        const reportingOverlay = {
            ...topologySnapshot(group.group, 1),
            activeSessionIds: ['session-a', 'session-b', 'session-c'],
            nextHopsBySessionId: {
                'session-a': ['session-c'],
                'session-b': ['session-c'],
                'session-c': ['session-a']
            },
            degreeLimit: 1
        };
        const cases = [
            {
                reason: 'invalid-rtt',
                command: {
                    rtt: { ...validRtt, rttMs: 0 },
                    alSenderId: 'session-a',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1
                }
            },
            {
                reason: 'self-pair',
                command: {
                    rtt: { ...validRtt, sessionIdTo: 'session-a' },
                    alSenderId: 'session-a',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1
                }
            },
            {
                reason: 'sender-mismatch',
                command: {
                    rtt: validRtt,
                    alSenderId: 'session-c',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1
                }
            },
            {
                reason: 'no-shared-active-group',
                command: {
                    rtt: validRtt,
                    alSenderId: 'session-a',
                    candidateGroups: [],
                    overlaySnapshotsByGroupKey: new Map(),
                    degreeLimit: 1
                }
            },
            {
                reason: 'not-reporting-edge',
                command: {
                    rtt: validRtt,
                    alSenderId: 'session-a',
                    candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map([[toWebRtcGroupKey(group.group), reportingOverlay]]),
                    degreeLimit: 1
                }
            }
        ] as const;
        for (const testCase of cases) {
            const input = deepFreeze({
                command: testCase.command,
                read: emptyRead,
                facts: {
                    requestedAtEpochMs: 1,
                    purgeAfterEpochMs: 60_001,
                    commandHash: RTT_COMMAND_HASH,
                    attemptCount: 1
                }
            });
            expect(computeAndValidateRttTwice(input)).toMatchObject({
                outcome: 'rejected',
                reason: testCase.reason
            });
        }
    });

    it('accepts equal RTT version only when the canonical measurement is exact', () => {
        const incoming = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const readFor = (value: typeof incoming) => ({
            receipt: null,
            expiredMeasurementEntry: null,
            measurement: {
                entry: {
                    key: 'from=session-a:to=session-b',
                    value: JSON.stringify(value),
                    expireAtTimestamp: 10_000,
                    updatedTimestamp: 'now',
                    revision: 4
                },
                value
            },
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        });
        const command = {
            rtt: incoming,
            alSenderId: 'session-a',
            candidateGroups: [],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1
        };
        const facts = {
            purgeAfterEpochMs: 10_000,
            requestedAtEpochMs: 2,
            commandHash: RTT_COMMAND_HASH,
            attemptCount: 1
        };
        expect(
            computeAndValidateRttTwice(
                deepFreeze({
                    command,
                    read: readFor(incoming),
                    facts
                })
            )
        ).toMatchObject({ outcome: 'rejected', reason: 'stale' });

        const conflicting = deepFreeze({
            command,
            read: readFor({ ...incoming, rttMs: 99 }),
            facts
        });
        expect(() => computeRtcRttMutation(conflicting)).toThrow(
            'equal version differs from durable measurement'
        );
        expect(() => computeRtcRttMutation(conflicting)).toThrow(
            'equal version differs from durable measurement'
        );
    });

    it('computes an exact receipt replay twice from frozen immutable authority', () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        const receipt = {
            receiptId,
            commandId: receiptId,
            requestId: receiptId,
            sessionIdFrom: rtt.sessionIdFrom,
            sessionIdTo: rtt.sessionIdTo,
            aggregateRef: {
                sessionIdFrom: rtt.sessionIdFrom,
                sessionIdTo: rtt.sessionIdTo
            },
            measurementVersion: rtt.version,
            affectedGroupRefs: [],
            acceptedAtEpochMs: 1,
            outcome: 'accepted' as const,
            attemptCount: 1,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [],
            commandHash: RTT_COMMAND_HASH
        };
        const input = deepFreeze({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null
            },
            read: {
                receipt: {
                    entry: {
                        key: receiptId,
                        value: JSON.stringify(receipt),
                        expireAtTimestamp: 86_400_001,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 0
                    },
                    value: receipt
                }
            },
            facts: {
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });

        expect(computeAndValidateRttTwice(input)).toEqual({
            outcome: 'replay',
            reason: 'accepted',
            affectedGroups: [],
            receipt
        });
    });

    it('rejects divergent pair/version reuse from frozen receipt authority twice', () => {
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        const receipt = {
            receiptId,
            commandId: receiptId,
            requestId: receiptId,
            sessionIdFrom: rtt.sessionIdFrom,
            sessionIdTo: rtt.sessionIdTo,
            aggregateRef: {
                sessionIdFrom: rtt.sessionIdFrom,
                sessionIdTo: rtt.sessionIdTo
            },
            measurementVersion: rtt.version,
            affectedGroupRefs: [],
            acceptedAtEpochMs: 1,
            outcome: 'accepted' as const,
            attemptCount: 1,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [],
            commandHash: OTHER_RTT_COMMAND_HASH
        };
        const input = deepFreeze({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null
            },
            read: {
                receipt: {
                    entry: {
                        key: receiptId,
                        value: JSON.stringify(receipt),
                        expireAtTimestamp: 86_400_001,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 0
                    },
                    value: receipt
                }
            },
            facts: {
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });

        expect(() => computeRtcRttMutation(input)).toThrowError(
            expect.objectContaining({
                code: 'rtc-rtt-idempotency-conflict'
            })
        );
        expect(() => computeRtcRttMutation(input)).toThrowError(
            expect.objectContaining({
                code: 'rtc-rtt-idempotency-conflict'
            })
        );
    });

    it('emits canonical unique affected refs and one topology outbox id per ref', () => {
        const refA = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-a'
        };
        const refB = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-a'
        };
        const groupA = rttGroupSnapshot(['session-a', 'session-b'], refA);
        const groupB = rttGroupSnapshot(['session-a', 'session-b'], refB);
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2
        };
        const computed = computeRtcRttMutation({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: [groupB, groupA, groupA],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 2
            },
            read: {
                receipt: null,
                expiredMeasurementEntry: null,
                measurement: null,
                endpointAdmissions: [],
                expiredEndpointAdmissionEntries: [],
                measurements: []
            },
            facts: {
                requestedAtEpochMs: 2,
                purgeAfterEpochMs: 60_002,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') {
            throw new Error('Expected write');
        }
        expect(computed.receipt.affectedGroupRefs).toEqual([refB, refA]);
        expect(computed.affectedGroups.map(({ group }) => group)).toEqual([
            expect.objectContaining(refB),
            expect.objectContaining(refA)
        ]);
        expect(computed.receipt.outboxIds).toHaveLength(2);
    });
});

function topologySnapshot(groupRef: GroupRef, version: number): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: version,
            presenceRevision: version
        },
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2
    } as const;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        if (value instanceof Map) {
            for (const [key, child] of value.entries()) {
                deepFreeze(key);
                deepFreeze(child);
            }
        }
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

function computeAndValidateRttTwice(input: Parameters<typeof computeRtcRttMutation>[0]) {
    const first = computeRtcRttMutation(input);
    const second = computeRtcRttMutation(input);
    expect(second).toEqual(first);
    expect(() => validateRtcRttMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateRtcRttMutation({ ...input, computed: first })).not.toThrow();
    return first;
}

function rttGroupSnapshot(
    sessionIds: readonly string[],
    groupRef: GroupRef = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    }
): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0];
    if (!ownerPrincipalId) {
        throw new Error('Expected at least one session fixture');
    }
    const stamp: AuditStamp = {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            ...groupRef,
            displayName: 'Room 1',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
            created: stamp,
            updated: stamp
        }),
        members: sessionIds.map<GroupMember>((sessionId, index) => ({
            ...groupRef,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: stamp,
            updated: stamp
        })),
        activeSessions: sessionIds.map<GroupPresenceSession>((sessionId) => ({
            ...groupRef,
            sessionId,
            principalId: sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function createUnopenedTransactionSql(queries: string[]): PSqlTransactionSql {
    return Object.assign(
        () => {
            queries.push('query');
            throw new Error('RTT write must not query the transaction');
        },
        {
            begin: () => {
                throw new Error('RTT write must not open a transaction');
            }
        }
    );
}
