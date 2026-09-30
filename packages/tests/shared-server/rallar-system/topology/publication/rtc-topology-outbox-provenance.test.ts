import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { computeRtcTopologyOutboxProvenance } from '@shared-server/rallar-system/topology/publication/rtc-topology-outbox-provenance.ts';
import { computeRtcTopologyPublicationDeliveryWrite } from '@shared-server/rallar-system/topology/replay/work/write-rtc-topology-publication-transaction.ts';
import {
    computeWsOutboxProvenanceDigest,
    decodeWsOutboxProvenance,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createGroupRef,
    createPublication,
    createTopologySnapshot
} from '../rtc-topology-repository-test-fixtures.ts';

describe('RTC topology producer provenance', () => {
    it('refuses a page audience or scope that differs from the accepted publication', async () => {
        const publication = createPublication(createTopologySnapshot(createGroupRef(), 1), 'work-proof');
        const delivery = await computeRtcTopologyPublicationDeliveryWrite(publication, undefined);
        for (const defect of ['audience', 'scope'] as const) {
            const changed = delivery.outboxWrites.map((write) => {
                const message = decodePersistedALMessage(write.entry.resource);
                if (message.targets?.mode !== 'broadcast') {
                    throw new Error('Expected a topology broadcast');
                }
                return {
                    ...write,
                    entry: {
                        ...write.entry,
                        resource: JSON.stringify({
                            ...message,
                            targets: {
                                ...message.targets,
                                ...(defect === 'audience'
                                    ? { recipientPeerIds: ['session-late'] }
                                    : { groupRef: { ...publication.groupRef, workspaceId: 'other' } })
                            }
                        })
                    }
                };
            });
            await expect(computeRtcTopologyOutboxProvenance(publication, changed)).rejects.toThrow('differs from its publication');
        }
    });

    it.each(['captured', 'wrong-scope', 'late-joiner', 'changed-row', 'changed-proof-audience', 'missing-proof'] as const)(
        'foreign first dequeue preserves frozen topology authority for %s',
        async (recipient) => {
            const groupRef = createGroupRef();
            const publication = {
                ...createPublication(createTopologySnapshot(groupRef, 1), 'work-proof'),
                createdAtEpochMs: Date.now(),
                expiresAtEpochMs: Date.now() + 60_000
            };
            const computed = await computeRtcTopologyPublicationDeliveryWrite(publication, undefined);
            const repository = new FakeRuntimeStateRepository();
            for (const proof of computed.provenanceWrites) {
                if (recipient === 'missing-proof') {
                    continue;
                }
                const decoded = decodeWsOutboxProvenance(JSON.parse(proof.value));
                const facts = recipient === 'changed-proof-audience'
                    ? { ...decoded, target: { kind: 'scoped-room-broadcast' as const, groupRef, admittedAudience: ['session-a'] } }
                    : decoded;
                const value = recipient === 'changed-proof-audience'
                    ? JSON.stringify({ ...facts, digest: await computeWsOutboxProvenanceDigest(computed.outboxWrites[0]!.entry, facts) })
                    : proof.value;
                await repository.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, proof.key, value, publication.expiresAtEpochMs);
            }
            const reader = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
            const engine = new InboxOutboxEngine();
            const socket = new JsonWebSocketServer();
            const native = new TestWebSocket('ws://foreign');
            native.open();
            socket.addConnection(new ConnectionContext({ id: recipient === 'late-joiner' ? 'session-late' : 'session-a', socket: native }));
            if (recipient === 'late-joiner') {
                const captured = new TestWebSocket('ws://captured');
                captured.open();
                socket.addConnection(new ConnectionContext({ id: 'session-a', socket: captured }));
            }
            const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
            const service = createDefaultWsQueueBoxServerService({
                name: 'foreign-server',
                socket,
                outbox: stores.workQueue,
                outboundStores: stores,
                queueEngine: engine,
                readProducerProvenance: (message, entry) => reader.readProducerProvenance(message, entry),
                readAuthenticatedConnectionScope: () => ({
                    scope: { applicationId: groupRef.applicationId, workspaceId: recipient === 'wrong-scope' ? 'other' : groupRef.workspaceId },
                    principalId: 'owner',
                    expiresAtEpochMs: publication.expiresAtEpochMs
                })
            });
            onTestFinished(() => {
                service.dispose();
                engine.stop();
            });
            const original = computed.outboxWrites[0]!.entry;
            const entry = recipient === 'changed-row' ? { ...original, resource: `${original.resource} ` } : original;
            const message = decodePersistedALMessage(entry.resource);

            await stores.workQueue.enqueue(entry);
            await engine.executeOnce();
            if (recipient === 'changed-row' || recipient === 'changed-proof-audience' || recipient === 'missing-proof') {
                await expect.poll(async () => (await stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
            }
            else {
                await expect.poll(async () => service.readCapturedPolicy(message, entry)).toMatchObject({
                    admittedAudience: ['session-a', 'session-b']
                });
                expect(await service.readCapturedPolicy(message, entry)).not.toHaveProperty('recipientScope');
            }
            expect(native.sent).toHaveLength(recipient === 'captured' ? 1 : 0);
        }
    );
});
