import { deriveApiV1StateWriteEvidence } from '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import type { PersistedCommandEvidence } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts';
import { describe, expect, it } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const command = {
    ri_row_id: 1,
    ri_resource_id: 'command-1',
    ri_topic_id: 'app-inbox',
    fk_ext_bank_id: 'scope',
    ri_status: 'COMPLETED',
    ri_attempts: 1,
    start_ts: new Date(1),
    end_ts: new Date(2),
    next_ts: null,
    result_status: 'COMPLETED',
    result_resource: '{}',
    ri_resource: '{}'
};

function createCanonicalNewerPresenceEvidence() {
    const resourceId = 'physical-group-row-contract';
    const logicalId = 'group-command-contract';
    const groupRef = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    };
    const fixture = createGroupSnapshotFixture({
        ...groupRef,
        sessionIds: ['owner-session', 'member-session']
    });
    const snapshot = {
        ...fixture,
        stateRevision: 10,
        causalRevision: { groupRevision: 8, presenceRevision: 2 },
        group: { ...fixture.group, snapshotVersion: 8, presenceVersion: 2 }
    };
    const event = {
        ...groupRef,
        eventId: 'group-event-contract',
        eventType: 'member-joined',
        snapshotVersion: 8,
        causalRevision: { groupRevision: 8, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'api-v1' },
        reason: null,
        traceId: null,
        requestId: logicalId,
        payload: {}
    };
    const authoritative: readonly PersistedCommandEvidence[] = [{
        appInboxResourceId: resourceId,
        valid: true,
        commandType: 'GROUP_MEMBER_UPSERT',
        commandIds: [logicalId],
        receipt: {
            appInboxResourceId: resourceId,
            commandId: logicalId,
            commandHash: `sha256:${'f'.repeat(64)}`,
            outcome: 'applied',
            outboxIds: [],
            identityKind: 'physical-resource-id',
            requestId: logicalId,
            aggregateRef: groupRef,
            stateRevision: 9,
            causalRevision: { groupRevision: 8, presenceRevision: 1 },
            snapshotVersion: 8,
            eventId: event.eventId
        }
    }];
    const evidence = (candidateSnapshot: unknown, candidateEvent: unknown) => {
        const result = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_MEMBER_UPSERT',
                    resource: JSON.stringify({
                        commandId: logicalId
                    })
                }
            }),
            result_resource: JSON.stringify({
                status: 'ok',
                result: {
                    right: {
                        snapshot: candidateSnapshot,
                        event: candidateEvent
                    }
                }
            })
        };
        return deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_MEMBER_UPSERT'] },
            [result],
            [],
            [],
            undefined,
            authoritative
        );
    };
    return { snapshot, event, evidence };
}

describe('durable AppInbox public result evidence', () => {
    it('requires the public client response shape without inventing outbox ids', () => {
        const client = {
            ...command,
            ri_resource_id: 'client-command-1',
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'CLIENT_INSTANCE_UPSERT',
                    resource: '{"requestId":"client-command-1"}'
                }
            }),
            result_resource: JSON.stringify({
                status: 'ok',
                result: {
                    right: {
                        snapshot: {},
                        event: null
                    }
                }
            })
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope',
            commandTypes: ['CLIENT_INSTANCE_UPSERT']
        }, [client])).toMatchObject({
            atomicCompletionFailures: 0,
            receiptOutboxIdCount: 0,
            appInbox: [{ durableResultValid: true }]
        });
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope',
            commandTypes: ['CLIENT_INSTANCE_UPSERT']
        }, [{ ...client, result_resource: JSON.stringify({ status: 'ok' }) }]))
            .toMatchObject({ atomicCompletionFailures: 1 });
    });

    it.each([
        ['swapped principal', { principalId: 'principal-2', stateRevision: 4, requestId: 'client-command-1' }],
        ['stale revision', { principalId: 'principal-1', stateRevision: 3, requestId: 'client-command-1' }],
        ['wrong request', { principalId: 'principal-1', stateRevision: 4, requestId: 'other-request' }]
    ])('rejects a %s in a same-shaped client result', (_name, mismatch) => {
        const clientResourceId = 'physical-client-row-1';
        const clientCommandId = 'client-command-1';
        const client = {
            ...command,
            ri_resource_id: clientResourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'CLIENT_INSTANCE_UPSERT',
                    resource: JSON.stringify({ requestId: clientCommandId })
                }
            }),
            result_resource: JSON.stringify({
                status: 'ok',
                result: {
                    right: {
                        snapshot: {
                            stateRevision: mismatch.stateRevision,
                            principal: {
                                applicationId: 'app-1',
                                workspaceId: 'workspace-1',
                                principalId: mismatch.principalId
                            }
                        },
                        event: { eventId: 'event-1', requestId: mismatch.requestId, snapshotVersion: 4 }
                    }
                }
            })
        };
        const authoritative: readonly PersistedCommandEvidence[] = [{
            appInboxResourceId: clientResourceId,
            valid: true,
            commandType: 'CLIENT_INSTANCE_UPSERT',
            commandIds: [clientCommandId],
            receipt: {
                appInboxResourceId: clientResourceId,
                commandId: clientCommandId,
                commandHash: `sha256:${'c'.repeat(64)}`,
                outcome: 'applied',
                outboxIds: [],
                identityKind: 'physical-resource-id' as const,
                requestId: clientCommandId,
                aggregateRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    principalId: 'principal-1'
                },
                stateRevision: 4,
                snapshotVersion: 4,
                eventId: 'event-1'
            }
        }];
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'] },
            [client],
            [],
            [],
            undefined,
            authoritative
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('rejects a swapped group in a same-shaped group result', () => {
        const resourceId = 'physical-group-row-1';
        const logicalId = 'group-command-1';
        const group = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_UPDATE',
                    resource: JSON.stringify({ commandId: logicalId })
                }
            }),
            result_resource: JSON.stringify({
                status: 'ok',
                result: {
                    right: {
                        snapshot: {
                            stateRevision: 8,
                            group: {
                                applicationId: 'app-1',
                                workspaceId: 'workspace-1',
                                groupId: 'group-2'
                            }
                        },
                        event: { eventId: 'group-event-1', requestId: logicalId, snapshotVersion: 8 }
                    }
                }
            })
        };
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_UPDATE'] },
            [group],
            [],
            [],
            undefined,
            [{
                appInboxResourceId: resourceId,
                valid: true,
                commandType: 'GROUP_UPDATE',
                commandIds: [logicalId],
                receipt: {
                    appInboxResourceId: resourceId,
                    commandId: logicalId,
                    commandHash: `sha256:${'d'.repeat(64)}`,
                    outcome: 'applied',
                    outboxIds: [],
                    identityKind: 'physical-resource-id',
                    requestId: logicalId,
                    aggregateRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'group-1'
                    },
                    stateRevision: 8,
                    snapshotVersion: 8,
                    eventId: 'group-event-1'
                }
            }]
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('accepts a group result whose independently convergent presence is newer', () => {
        const resourceId = 'physical-group-row-newer-presence';
        const logicalId = 'group-command-newer-presence';
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1'
        };
        const canonicalSnapshot = createGroupSnapshotFixture({
            ...groupRef,
            sessionIds: ['owner-session', 'member-session']
        });
        const event = {
            ...groupRef,
            eventId: 'group-event-1',
            eventType: 'member-joined',
            snapshotVersion: 8,
            causalRevision: { groupRevision: 8, presenceRevision: 1 },
            occurredAtEpochMs: 1,
            actor: { kind: 'service', serviceId: 'api-v1' },
            reason: null,
            traceId: null,
            requestId: logicalId,
            payload: {}
        };
        const snapshot = {
            ...canonicalSnapshot,
            stateRevision: 10,
            causalRevision: { groupRevision: 8, presenceRevision: 2 },
            group: {
                ...canonicalSnapshot.group,
                snapshotVersion: 8,
                presenceVersion: 2
            }
        };
        const result = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_MEMBER_UPSERT',
                    resource: JSON.stringify({ commandId: logicalId })
                }
            }),
            result_resource: JSON.stringify({
                status: 'ok',
                result: {
                    right: {
                        snapshot,
                        event
                    }
                }
            })
        };
        const authoritative = [{
            appInboxResourceId: resourceId,
            valid: true,
            commandType: 'GROUP_MEMBER_UPSERT',
            commandIds: [logicalId],
            receipt: {
                appInboxResourceId: resourceId,
                commandId: logicalId,
                commandHash: `sha256:${'e'.repeat(64)}`,
                outcome: 'applied',
                outboxIds: [],
                identityKind: 'physical-resource-id' as const,
                requestId: logicalId,
                aggregateRef: groupRef,
                stateRevision: 9,
                causalRevision: { groupRevision: 8, presenceRevision: 1 },
                snapshotVersion: 8,
                eventId: 'group-event-1'
            }
        }];
        const evidence = (
            candidate = result,
            authority: readonly PersistedCommandEvidence[] = authoritative
        ) => deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_MEMBER_UPSERT'] },
            [candidate],
            [],
            [],
            undefined,
            authority
        );

        expect(evidence()).toMatchObject({
            atomicCompletionFailures: 0,
            statusResultFailures: 0
        });

        for (
            const invalidSnapshot of [
                { ...snapshot, stateRevision: 11 },
                { ...snapshot, causalRevision: { groupRevision: 9, presenceRevision: 2 } },
                {
                    ...snapshot,
                    stateRevision: 8,
                    causalRevision: { groupRevision: 8, presenceRevision: 0 }
                }
            ]
        ) {
            const invalid = {
                ...result,
                result_resource: JSON.stringify({
                    status: 'ok',
                    result: {
                        right: {
                            snapshot: invalidSnapshot,
                            event
                        }
                    }
                })
            };
            expect(evidence(invalid)).toMatchObject({
                atomicCompletionFailures: 1,
                statusResultFailures: 1
            });
        }

        const { causalRevision: _causalRevision, ...receiptWithoutCausalRevision } = authoritative[0]!.receipt!;
        for (
            const receipt of [
                receiptWithoutCausalRevision,
                { ...authoritative[0]!.receipt!, stateRevision: 10 }
            ]
        ) {
            expect(evidence(result, [{ ...authoritative[0]!, receipt }])).toMatchObject({
                atomicCompletionFailures: 1,
                statusResultFailures: 1
            });
        }

        for (
            const invalidEvent of [
                { ...event, eventId: 'swapped-event' },
                { ...event, requestId: 'swapped-command' }
            ]
        ) {
            const invalid = {
                ...result,
                result_resource: JSON.stringify({
                    status: 'ok',
                    result: {
                        right: {
                            snapshot,
                            event: invalidEvent
                        }
                    }
                })
            };
            expect(evidence(invalid)).toMatchObject({
                atomicCompletionFailures: 1,
                statusResultFailures: 1
            });
        }
    });

    it('rejects a truncated authoritative group snapshot', () => {
        const { snapshot, event, evidence } = createCanonicalNewerPresenceEvidence();

        expect(evidence({
            stateRevision: snapshot.stateRevision,
            causalRevision: snapshot.causalRevision,
            group: snapshot.group
        }, event)).toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1
        });
    });

    it('rejects a truncated authoritative group event', () => {
        const { snapshot, event, evidence } = createCanonicalNewerPresenceEvidence();

        expect(evidence(snapshot, {
            eventId: event.eventId,
            requestId: event.requestId,
            snapshotVersion: event.snapshotVersion
        })).toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1
        });
    });

    it('accepts a canonical terminal group denial without inventing a receipt', () => {
        const resourceId = 'physical-denied-group-row';
        const denied = {
            ...command,
            ri_resource_id: resourceId,
            ri_status: 'FAILED',
            result_status: 'FAILED',
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_MEMBER_UPSERT',
                    resource: '{"commandId":"denied-group-command"}'
                }
            }),
            result_resource: JSON.stringify({
                type: 'app-inbox-failure',
                version: 'canonical.v2',
                code: 'group-capacity-denied',
                status: 409,
                message: 'Group capacity reached',
                issues: null,
                denial: null,
                retry: null
            })
        };
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_MEMBER_UPSERT'] },
            [denied],
            [],
            [],
            undefined,
            [{
                appInboxResourceId: resourceId,
                valid: true,
                commandType: 'GROUP_MEMBER_UPSERT',
                commandIds: ['denied-group-command']
            }]
        )).toMatchObject({
            atomicCompletionFailures: 0,
            failedAppInboxCount: 1,
            statusResultFailures: 0
        });
    });
});
