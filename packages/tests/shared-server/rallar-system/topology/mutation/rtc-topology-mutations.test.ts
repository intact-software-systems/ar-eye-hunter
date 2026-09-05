import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyPublicationClaim
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RTT_COMMAND_HASH = `sha256:${'a'.repeat(64)}`;

describe('RTC topology publication mutation phases', () => {
    it('keeps RTC topology mutation computation synchronous and effect-free', () => {
        const source = readFileSync(
            new URL(
                '../../../../../shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts',
                import.meta.url
            ),
            'utf8'
        );
        const forbidden = [
            /\.begin\s*\(/,
            /\b(?:Date|Temporal)\b/,
            /random/i,
            /(?:Deno|process)\.env/,
            /hashMutationCommand/,
            /recordRallarTiming|performance\.now/,
            /\b(?:async|await)\b/
        ];

        for (const pattern of forbidden) {
            expect(source, `forbidden pure-module pattern ${pattern}`).not.toMatch(pattern);
        }
    });

    it('shares a strict persisted publication validator from a neutral pure contract module', () => {
        const publicationContractUrl = new URL(
            '../../../../../shared-server/rallar-system/topology/publication/validate-rtc-topology-publication.ts',
            import.meta.url
        );
        expect(existsSync(publicationContractUrl)).toBe(true);
        if (!existsSync(publicationContractUrl)) {
            return;
        }

        const contractSource = readFileSync(publicationContractUrl, 'utf8');
        expect(contractSource).not.toMatch(
            /\.begin\s*\(|\b(?:async|await)\b|\b(?:Date|Temporal)\b|performance\.now|(?:Deno|process)\.env/
        );
        expect(contractSource).not.toMatch(/\/repositories\//);
        const mutationSource = readFileSync(
            new URL(
                '../../../../../shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts',
                import.meta.url
            ),
            'utf8'
        );
        const publicationRepositorySource = readFileSync(
            new URL(
                '../../../../../shared-server/rallar-system/topology/publication/' +
                    'rtc-topology-publication-repository.ts',
                import.meta.url
            ),
            'utf8'
        );
        expect(mutationSource).toMatch(/validate-rtc-topology-publication/);
        expect(publicationRepositorySource).toMatch(/validate-rtc-topology-publication/);
    });
    it('computes and validates an absent topology guard deterministically from frozen input', () => {
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1'
        };
        const candidate = topologySnapshot(groupRef, 1);
        const input = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: null
            },
            candidate,
            publication: null,
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
        expect(validateTopologyMutation({ ...input, computed: tampered })[0]?.cause).toHaveProperty(
            'message',
            expect.stringMatching(/differs from the computed value/i)
        );
        expect(validateTopologyMutation({ ...input, computed: tampered })[0]?.cause).toHaveProperty(
            'message',
            expect.stringMatching(/differs from the computed value/i)
        );
    });

    it('loads only the durable publication winner and rejects a claim without its snapshot', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const snapshot = topologySnapshot(groupRef, 2);
        const publication = topologyPublication(snapshot, 'work-1');
        const entry = {
            key: 'snapshot',
            value: JSON.stringify(snapshot),
            expireAtTimestamp: 1_000,
            updatedTimestamp: 'now',
            revision: 3
        };
        const loadedInput = deepFreeze({
            read: {
                snapshot: { entry, value: snapshot },
                publicationClaim: topologyPublicationClaim(publication)
            },
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(loadedInput)).toEqual({
            outcome: 'loaded',
            snapshot,
            publication
        });
        const missingSnapshot = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: topologyPublicationClaim(publication)
            },
            candidate: null,
            publication: null,
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
                    ...topologyPublicationClaim(publication),
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
        const publicationSnapshot = topologySnapshot(groupRef, 2);
        const publication = topologyPublication(publicationSnapshot, 'work-causal');
        const toRead = (snapshot: RallarOverlayTopologySnapshot) => ({
            snapshot: {
                entry: {
                    key: 'snapshot',
                    value: JSON.stringify(snapshot),
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: 'now',
                    revision: 3
                },
                value: snapshot
            },
            publicationClaim: topologyPublicationClaim(publication)
        });
        const exactInput = deepFreeze({
            read: toRead(publicationSnapshot),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(exactInput)).toEqual({
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
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(reorderedInput)).toEqual({
            outcome: 'loaded',
            snapshot: reorderedEquivalent,
            publication
        });

        const newerDurable = topologySnapshot(groupRef, 3);
        const newerInput = deepFreeze({
            read: toRead(newerDurable),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null
            }
        });
        expect(computeAndValidateTopologyTwice(newerInput)).toEqual({
            outcome: 'loaded',
            snapshot: newerDurable,
            publication
        });

        const olderDurable = topologySnapshot(groupRef, 1);
        const tornInput = deepFreeze({
            read: toRead(olderDurable),
            candidate: null,
            publication: null,
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
        const candidate = topologySnapshot(groupRef, 1);
        const publication = topologyPublication(candidate, 'work-expiry');
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication,
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

    it('validates the complete topology publication envelope before the write phase', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const candidate = topologySnapshot(groupRef, 1);
        const publication = topologyPublication(candidate, 'work-malformed-envelope');
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
            facts: {
                publicationExpireAtTimestamp: 86_400_100,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1
            }
        });
        const computed = computeTopologyMutation(input);

        expect(validateTopologyMutation({ ...input, computed })[0]?.cause).toHaveProperty(
            'message',
            expect.stringMatching(/message|publication|envelope|identity|payload/i)
        );
    });

    it('computes duplicate, advanced, and superseded topology outcomes', () => {
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        };
        const current = topologySnapshot(groupRef, 2);
        const entry = {
            key: 'snapshot',
            value: JSON.stringify(current),
            expireAtTimestamp: 1_000,
            updatedTimestamp: 'now',
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
                    candidate: topologySnapshot(groupRef, 3),
                    publication: null,
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
                    candidate: topologySnapshot(groupRef, 1),
                    publication: null,
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
function topologyPublication(snapshot: RallarOverlayTopologySnapshot, workId: string) {
    const createdAtEpochMs = 100;
    return {
        publicationId:
            `${workId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`,
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

function topologyPublicationClaim(
    publication: ReturnType<typeof topologyPublication>
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

function computeAndValidateTopologyTwice(input: Parameters<typeof computeTopologyMutation>[0]) {
    const first = computeTopologyMutation(input);
    const second = computeTopologyMutation(input);
    expect(second).toEqual(first);
    expect(validateTopologyMutation({ ...input, computed: first })).toEqual([]);
    expect(validateTopologyMutation({ ...input, computed: first })).toEqual([]);
    return first;
}
