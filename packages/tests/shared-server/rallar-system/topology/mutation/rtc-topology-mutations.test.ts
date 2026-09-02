// dprint-ignore
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationInput,
    type RtcTopologyPublicationClaim
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { toRtcTopologyPublicationId, toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

const RTT_COMMAND_HASH = `sha256:${'a'.repeat(64)}`;

describe('RTC topology publication mutation phases', () => {
    it.each(
        (['duplicate', 'advanced', 'publish-superseded'] as const).flatMap((outcome) => [-1, -0].map((revision) => ({ outcome, revision })))
    )(
        'rejects original snapshot revision $revision for $outcome before writing',
        ({ outcome, revision }) => {
            const input = createRevisionMutationInput(outcome, revision);
            const computed = computeTopologyMutation(input);
            expect(computed.outcome).toBe(outcome === 'publish-superseded' ? outcome : 'write');
            expect(() => validateTopologyMutation({ ...input, computed })).toThrow(
                new Error(`Invalid runtime state upsert expected revision: ${revision}`)
            );
        }
    );

    it.each(['duplicate', 'advanced', 'publish-superseded'] as const)(
        'accepts the last incrementable snapshot revision for %s',
        (outcome) => {
            const input = createRevisionMutationInput(outcome, Number.MAX_SAFE_INTEGER - 1);
            const computed = computeTopologyMutation(input);
            expect(() => validateTopologyMutation({ ...input, computed })).not.toThrow();
            if (computed.outcome !== 'write' && computed.outcome !== 'publish-superseded') {
                throw new Error('Expected a conditional snapshot write');
            }
            expect(computed.persistence.snapshot.acceptedStorageRevision).toBe(Number.MAX_SAFE_INTEGER);
        }
    );

    it('does not require increment capacity when superseded work writes no snapshot', () => {
        const input = createRevisionMutationInput('publish-superseded', Number.MAX_SAFE_INTEGER);
        const withoutPublication = {
            ...input,
            publication: null,
            facts: { publicationExpireAtTimestamp: null, commandHash: null, attemptCount: null }
        };
        const computed = computeTopologyMutation(withoutPublication);
        expect(computed.outcome).toBe('superseded');
        expect(() => validateTopologyMutation({ ...withoutPublication, computed })).not.toThrow();
    });

    it('computes and validates publication persistence from explicit facts without clocks or randomness', () => {
        const candidate = createTopologySnapshot({ applicationId: 'app-1', workspaceId: '_', groupId: 'room-1' }, 1);
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication: createTopologyPublication(candidate, 'pure-publication'),
            deliveryPublisherStreamId: null,
            facts: { publicationExpireAtTimestamp: 86_400_100, commandHash: RTT_COMMAND_HASH, attemptCount: 1 }
        });
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('Hidden clock');
        });
        const random = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Hidden randomness');
        });
        try {
            const first = computeTopologyMutation(input);
            const second = computeTopologyMutation(input);
            validateTopologyMutation({ ...input, computed: first });
            validateTopologyMutation({ ...input, computed: second });
            expect(second).toEqual(first);
        }
        finally {
            clock.mockRestore();
            random.mockRestore();
        }
    });

    it.each(['proxy', 'accessor', 'hidden serializer'] as const)('rejects behavior-bearing %s output without invoking it', (kind) => {
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate: createTopologySnapshot({ applicationId: 'app-1', workspaceId: '_', groupId: 'room-1' }, 1),
            publication: null,
            deliveryPublisherStreamId: null,
            facts: { publicationExpireAtTimestamp: null, commandHash: null, attemptCount: null }
        });
        const computed = computeTopologyMutation(input);
        let reads = 0;
        const candidate = kind === 'proxy'
            ? new Proxy(computed, {
                get(target, key, receiver) {
                    reads += 1;
                    return Reflect.get(target, key, receiver);
                }
            })
            : Object.defineProperty({ ...computed }, kind === 'accessor' ? 'outcome' : 'toJSON', {
                enumerable: kind === 'accessor',
                get: () => {
                    reads += 1;
                    return kind === 'accessor' ? computed.outcome : () => computed;
                }
            });

        expect(() => validateTopologyMutation({ ...input, computed: candidate })).toThrow(TypeError);
        expect(reads).toBe(0);
    });
    it('computes and validates an absent topology guard deterministically from frozen input', () => {
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1'
        };
        const candidate = createTopologySnapshot(groupRef, 1);
        const input = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: null
            },
            candidate,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });

        const first = computeAndValidateTopologyTwice(input);
        const second = computeTopologyMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({
            outcome: 'write',
            snapshotGuard: { expectedRevision: null, candidate }
        });
        if (first.outcome !== 'write') {
            throw new Error('Expected topology write');
        }
        const tampered = {
            ...first,
            snapshotGuard: {
                ...first.snapshotGuard,
                candidate: {
                    ...first.snapshotGuard.candidate,
                    name: 'tampered'
                }
            }
        };
        expect(() => validateTopologyMutation({ ...input, computed: tampered })).toThrow(
            'differs from canonical'
        );
        expect(() => validateTopologyMutation({ ...input, computed: tampered })).toThrow(
            'differs from canonical'
        );
    });

    it('loads only the durable publication winner and rejects a claim without its snapshot', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const snapshot = createTopologySnapshot(groupRef, 2);
        const publication = createTopologyPublication(snapshot, 'work-1');
        const entry = {
            key: 'snapshot',
            value: JSON.stringify(snapshot),
            expireAtTimestamp: 1_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 3
        };
        const loadedInput = deepFreeze({
            read: {
                snapshot: { entry, value: snapshot },
                publicationClaim: createTopologyPublicationClaim(publication)
            },
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(loadedInput)).toMatchObject({
            outcome: 'loaded',
            snapshot,
            publication
        });
        const missingSnapshot = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: createTopologyPublicationClaim(publication)
            },
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        const inconsistent = deepFreeze({
            ...loadedInput,
            read: {
                ...loadedInput.read,
                publicationClaim: {
                    ...createTopologyPublicationClaim(publication),
                    publication: {
                        ...publication,
                        recipientSessionIds: ['session-z']
                    }
                }
            }
        });
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
    });

    it('relates a claimed publication payload to the independently read snapshot', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const publicationSnapshot = createTopologySnapshot(groupRef, 2);
        const publication = createTopologyPublication(publicationSnapshot, 'work-causal');
        const toRead = (snapshot: RallarOverlayTopologySnapshot) => ({
            snapshot: {
                entry: {
                    key: 'snapshot',
                    value: JSON.stringify(snapshot),
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: '1970-01-01T00:00:01.000Z',
                    revision: 3
                },
                value: snapshot
            },
            publicationClaim: createTopologyPublicationClaim(publication)
        });
        const exactInput = deepFreeze({
            read: toRead(publicationSnapshot),
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(exactInput)).toMatchObject({
            outcome: 'loaded',
            snapshot: publicationSnapshot,
            publication
        });

        const reorderedEquivalent = {
            ...publicationSnapshot,
            groupRef: {
                groupId: groupRef.groupId,
                applicationId: groupRef.applicationId,
                workspaceId: groupRef.workspaceId
            },
            nextHopsBySessionId: {
                'session-b': ['session-a'],
                'session-a': ['session-b']
            }
        };
        const reorderedInput = deepFreeze({
            read: toRead(reorderedEquivalent),
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(reorderedInput)).toMatchObject({
            outcome: 'loaded',
            snapshot: reorderedEquivalent,
            publication
        });

        const newerDurable = createTopologySnapshot(groupRef, 3);
        const newerInput = deepFreeze({
            read: toRead(newerDurable),
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(newerInput)).toMatchObject({
            outcome: 'loaded',
            snapshot: newerDurable,
            publication
        });

        const olderDurable = createTopologySnapshot(groupRef, 1);
        const tornInput = deepFreeze({
            read: toRead(olderDurable),
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(tornInput)).toEqual({
            outcome: 'retry',
            reason: 'publication-ahead-of-snapshot'
        });

        const equalTupleDifferentSnapshot = {
            ...publicationSnapshot,
            name: 'different durable payload'
        };
        const corruptInput = deepFreeze({
            read: toRead(equalTupleDifferentSnapshot),
            candidate: null,
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(() => computeTopologyMutation(corruptInput)).toThrow(
            'equal causal tuple differs from durable snapshot'
        );
        expect(() => computeTopologyMutation(corruptInput)).toThrow(
            'equal causal tuple differs from durable snapshot'
        );
    });

    it('materializes publication expiry in canonical computed topology output', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const candidate = createTopologySnapshot(groupRef, 1);
        const publication = createTopologyPublication(candidate, 'work-expiry');
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: 86_400_123,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });

        expect(computeAndValidateTopologyTwice(input)).toMatchObject({
            outcome: 'write',
            publicationExpireAtTimestamp: 86_400_123
        });
    });

    it.each(['createdAt', 'expiresAt', 'matchCreatedAt', 'matchExpiresAt'] as const)(
        'rejects a changed persisted publication %s before writing',
        (field) => {
            const candidate = createTopologySnapshot({ applicationId: 'app-1', workspaceId: '_', groupId: 'room-1' }, 1);
            const input = deepFreeze({
                read: { snapshot: null, publicationClaim: null },
                candidate,
                publication: createTopologyPublication(candidate, 'persisted-publication'),
                deliveryPublisherStreamId: null,
                facts: { publicationExpireAtTimestamp: 86_400_100, commandHash: RTT_COMMAND_HASH, attemptCount: 1 }
            });
            const computed = computeTopologyMutation(input);
            validateTopologyMutation({ ...input, computed });
            if (computed.outcome !== 'write' || computed.publicationDelivery === null) {
                throw new Error('Expected publication persistence');
            }
            const altered = {
                ...computed,
                publicationDelivery: {
                    ...computed.publicationDelivery,
                    outboxWrite: { ...computed.publicationDelivery.outboxWrite, [field]: 'different timestamp' }
                }
            };

            expect(() => validateTopologyMutation({ ...input, computed: altered })).toThrow(
                'differs from canonical computation'
            );
        }
    );

    it('validates the complete topology publication envelope before the write phase', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const candidate = createTopologySnapshot(groupRef, 1);
        const publication = createTopologyPublication(candidate, 'work-malformed-envelope');
        const malformed = {
            ...publication,
            message: {
                ...publication.message,
                id: {
                    ...publication.message.id,
                    msgId: 'nondeterministic-message-id'
                }
            }
        };
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication: malformed,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: 86_400_100,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });
        expect(() => computeTopologyMutation(input)).toThrow(
            /message|publication|envelope|identity/i
        );
    });

    it('computes duplicate, advanced, and superseded topology outcomes', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const current = createTopologySnapshot(groupRef, 2);
        const entry = {
            key: 'snapshot',
            value: JSON.stringify(current),
            expireAtTimestamp: 1_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 5
        };
        expect(
            computeAndValidateTopologyTwice(
                deepFreeze({
                    read: {
                        snapshot: { entry, value: current },
                        publicationClaim: null
                    },
                    candidate: current,
                    publication: null,
                    deliveryPublisherStreamId: null,
                    facts: {
                        publicationExpireAtTimestamp: null,
                        commandHash: null,
                        attemptCount: null
                    }
                })
            )
        ).toMatchObject({ outcome: 'write', observation: 'duplicate' });
        expect(
            computeAndValidateTopologyTwice(
                deepFreeze({
                    read: {
                        snapshot: { entry, value: current },
                        publicationClaim: null
                    },
                    candidate: createTopologySnapshot(groupRef, 3),
                    publication: null,
                    deliveryPublisherStreamId: null,
                    facts: {
                        publicationExpireAtTimestamp: null,
                        commandHash: null,
                        attemptCount: null
                    }
                })
            )
        ).toMatchObject({ outcome: 'write', observation: 'advanced' });
        expect(
            computeAndValidateTopologyTwice(
                deepFreeze({
                    read: {
                        snapshot: { entry, value: current },
                        publicationClaim: null
                    },
                    candidate: createTopologySnapshot(groupRef, 1),
                    publication: null,
                    deliveryPublisherStreamId: null,
                    facts: {
                        publicationExpireAtTimestamp: null,
                        commandHash: null,
                        attemptCount: null
                    }
                })
            )
        ).toEqual({ outcome: 'superseded', current });
        const corrupt = deepFreeze({
            read: {
                snapshot: { entry, value: current },
                publicationClaim: null
            },
            candidate: { ...current, name: 'different tuple payload' },
            publication: null,
            deliveryPublisherStreamId: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
    });
});

function createRevisionMutationInput(
    outcome: 'duplicate' | 'advanced' | 'publish-superseded',
    revision: number
): RtcTopologyMutationInput {
    const current = createTopologySnapshot({ applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }, 2);
    const candidate = outcome === 'duplicate'
        ? current
        : createTopologySnapshot(current.groupRef, outcome === 'advanced' ? 3 : 1);
    return {
        read: {
            snapshot: {
                entry: {
                    key: 'snapshot',
                    value: JSON.stringify(current),
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: '1970-01-01T00:00:01.000Z',
                    revision
                },
                value: current
            },
            publicationClaim: null
        },
        candidate,
        publication: outcome === 'publish-superseded' ? createTopologyPublication(candidate, 'revision-work') : null,
        deliveryPublisherStreamId: null,
        facts: outcome === 'publish-superseded'
            ? { publicationExpireAtTimestamp: 86_400_100, commandHash: RTT_COMMAND_HASH, attemptCount: 1 }
            : { publicationExpireAtTimestamp: null, commandHash: null, attemptCount: null }
    };
}

function createTopologySnapshot(groupRef: GroupRef, version: number): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: version,
            presenceRevision: version
        },
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
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
function createTopologyPublication(snapshot: RallarOverlayTopologySnapshot, workId: string): RtcTopologyPublication {
    const createdAtEpochMs = 100;
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: {
                v: 2,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs,
                senderId: 'rallar-server'
            },
            route: {
                topicId: AppTopics.overlayTopology,
                contextId: snapshot.groupRef.groupId,
                resourceId:
                    `${snapshot.overlayId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`
            },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: snapshot.groupRef,
                minSnapshotVersion: 1
            },
            constraints: { expiresAtMs: 86_400_100 },
            delivery: { reliability: 'best-effort', ack: 'none' },
            payload: {
                typeId: AppTopics.overlayTopology,
                contentType: 'application/json',
                resource: JSON.stringify(snapshot)
            },
            audit: {
                createdBy: 'rallar-server',
                createdTs: createdAtEpochMs
            }
        },
        createdAtEpochMs
    } as const;
}

function createTopologyPublicationClaim(
    publication: RtcTopologyPublication
): RtcTopologyPublicationClaim {
    return {
        receipt: {
            kind: 'rtc-topology-execution-receipt',
            schemaVersion: 1,
            groupRef: publication.groupRef,
            workId: publication.workId,
            commandId: publication.workId,
            requestId: publication.workId,
            commandHash: RTT_COMMAND_HASH,
            publicationId: publication.publicationId,
            outcome: 'accepted',
            attemptCount: 1,
            acceptedCausalRevision: publication.sourceGroupStateCausalRevision,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [publication.publicationId]
        },
        publication
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

function computeAndValidateTopologyTwice(input: RtcTopologyMutationInput) {
    const first = computeTopologyMutation(input);
    const second = computeTopologyMutation(input);
    expect(second).toEqual(first);
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    return first;
}
