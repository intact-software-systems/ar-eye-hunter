import { describe, expect, it } from 'vitest';

import { decodeJsonWireText } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { computeTopologyMutation, validateTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import { createRtcTopologyReplayFixture } from '../replay/consumer/rtc-topology-replay-fixture.ts';

describe('topology publication persistence phases', () => {
    it('computes the complete outbox and delivery input before a write can start', () => {
        const { publication, currentSnapshot } = createRtcTopologyReplayFixture();
        const input = {
            read: { snapshot: null, publicationClaim: null },
            candidate: currentSnapshot,
            publication,
            deliveryPublisherStreamId: '00000000-0000-4000-8000-000000000001',
            facts: {
                publicationExpireAtTimestamp: 86_401_000,
                commandHash: `sha256:${'a'.repeat(64)}`,
                attemptCount: 1
            }
        };

        const computed = computeTopologyMutation(input);

        if (computed.outcome !== 'write' || computed.publicationDelivery === null) {
            throw new Error('Expected publication-bearing topology write');
        }
        const { outboxWrite, appendInput } = computed.publicationDelivery;
        if (appendInput === null) {
            throw new Error('Expected a topology delivery append input');
        }
        const persistedPublication = computed.persistence.publication;
        if (persistedPublication === null) {
            throw new Error('Expected a persisted publication and receipt');
        }
        expect(computed.persistence.snapshot).toMatchObject({
            expectedRevision: null,
            acceptedStorageRevision: 0,
            unexpectedRevisionError: {
                name: 'RtcTopologyRepositoryInvariantCorruptionError',
                code: 'rtc-topology-repository-invariant-corruption'
            }
        });
        expect(decodeJsonWireText(computed.persistence.snapshot.value, 'Topology snapshot')).toMatchObject({
            activeSessionIds: ['session-1'],
            version: 8
        });
        expect(decodeJsonWireText(persistedPublication.receiptValue, 'Topology receipt')).toMatchObject({
            kind: 'rtc-topology-execution-receipt',
            acceptedStorageRevision: 0,
            attemptCount: 1
        });
        expect(persistedPublication.collisionError).toMatchObject({
            name: 'RtcTopologyPublicationCollisionError',
            code: 'rtc-topology-publication-collision',
            storageKey: persistedPublication.key
        });
        expect(decodePersistedALMessage(outboxWrite.entry.resource)).toMatchObject({
            targets: { recipientPeerIds: ['session-1'] },
            constraints: { expiresAtMs: 86_401_000 }
        });
        expect(appendInput).toMatchObject({
            publisherStreamId: '00000000-0000-4000-8000-000000000001',
            groupRef: {
                applicationId: 'replay-app',
                workspaceId: 'replay-workspace',
                groupId: 'replay-group'
            },
            retainUntilEpochMs: 86_401_000,
            retainUntil: new Date(86_401_000)
        });
        expect(outboxWrite).toMatchObject({
            createdAt: '1970-01-01T00:00:01Z',
            expiresAt: '1970-01-02T00:00:01Z',
            matchCreatedAt: '1970-01-01T00:00:01Z',
            matchExpiresAt: '1970-01-02T00:00:01Z'
        });
        expect(appendInput?.outboxKey).toEqual(outboxWrite.entry.key);
        expect(computeTopologyMutation(input)).toEqual(computed);
        expect(() => validateTopologyMutation({ ...input, computed })).not.toThrow();
        expect(() =>
            validateTopologyMutation({
                ...input,
                computed: {
                    ...computed,
                    publicationDelivery: {
                        ...computed.publicationDelivery,
                        outboxWrite: {
                            ...outboxWrite,
                            entry: { ...outboxWrite.entry, resource: '{}' }
                        }
                    }
                }
            })
        ).toThrow();
        expect(() =>
            validateTopologyMutation({
                ...input,
                computed: {
                    ...computed,
                    publicationDelivery: {
                        ...computed.publicationDelivery,
                        outboxWrite: {
                            ...outboxWrite,
                            entry: {
                                ...outboxWrite.entry,
                                audit: {
                                    ...outboxWrite.entry.audit,
                                    expiryTs: outboxWrite.entry.audit.expiryTs.add({ milliseconds: 1 })
                                }
                            }
                        }
                    }
                }
            })
        ).toThrow();
        expect(() =>
            validateTopologyMutation({
                ...input,
                computed: {
                    ...computed,
                    publicationDelivery: {
                        ...computed.publicationDelivery,
                        appendInput: {
                            ...appendInput,
                            retainUntil: new Date(appendInput.retainUntilEpochMs + 1)
                        }
                    }
                }
            })
        ).toThrow('RTC topology mutation differs from canonical computation');
    });
});
