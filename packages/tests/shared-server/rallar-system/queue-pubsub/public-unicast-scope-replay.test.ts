import { describe, expect, it, onTestFinished } from 'vitest';

import { installQueueBoxPubSubBridge, toPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

describe('persisted public unicast scope replay', () => {
    it.each(['claimant', 'remote'] as const)('checks captured scope at %s delivery after same-ID reconnect', async (delivery) => {
        const fixture = await createReplayFixture();
        const message = newALUnicastMessage('server', { topicId: 'app.message', contextId: 'direct', resourceId: 'scope' }, 'peer', 'message.v1', {}, {
            ttlMs: 30_000,
            qos: { durability: { algo: 'local-outbox' } }
        });
        const scope = { ...SCOPE };
        const admission = fixture.service.enqueueOutboxIfAbsent(message, ['peer'], scope);
        scope.workspaceId = 'changed-during-admission';
        const admitted = await admission;
        expect(admitted.verdict.kind).toBe('admitted');
        if (!admitted.entry) {
            throw new Error('Expected a durable public unicast row');
        }
        expect(await fixture.service.readCapturedPolicy(admitted.message, admitted.entry))
            .toMatchObject({ recipientScope: SCOPE, admittedAudience: ['peer'] });
        fixture.proof.scope = { ...SCOPE, workspaceId: 'another-workspace' };
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        fixture.socket.addConnection(new ConnectionContext({ id: 'peer', socket: replacement }));

        if (delivery === 'remote') {
            await fixture.bridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'other', entry: admitted.entry }));
        }
        else {
            await fixture.engine.executeOnce();
            await expect.poll(() => fixture.bridge.published.length).toBe(1);
        }

        expect(fixture.native.sent).toEqual([]);
        expect(replacement.sent).toEqual([]);
        if (delivery === 'claimant') {
            expect(fixture.bridge.published).toHaveLength(1);
        }
        fixture.proof.scope = SCOPE;
        await fixture.bridge.subscriber?.(toPubSubMessage({ channel: 'events', publisherId: 'other', entry: admitted.entry }));
        expect(replacement.sent).toHaveLength(1);
    });
});

async function createReplayFixture() {
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://original');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const proof = { scope: SCOPE, expiresAtEpochMs: Date.now() + 30_000 };
    const engine = new InboxOutboxEngine();
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket,
        outbox: outboundStores.workQueue,
        outboundStores,
        queueEngine: engine,
        readAuthenticatedConnectionScope: () => proof
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    const bridge = new RecordingBridge();
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: service,
        bridge,
        channel: 'events',
        publisherId: 'local',
        filterEligibleCapturedSessionIds: (_message, sessionIds) => sessionIds
    });
    return { service, socket, native, proof, engine, bridge };
}

class RecordingBridge implements QueueBoxPubSubBridge {
    readonly published: QueueBoxPubSubMessage[] = [];
    subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1] | undefined;

    async publish(_channel: string, message: QueueBoxPubSubMessage): Promise<void> {
        this.published.push(message);
    }

    async subscribe(_channel: string, subscriber: Parameters<QueueBoxPubSubBridge['subscribe']>[1]): Promise<void> {
        this.subscriber = subscriber;
    }
}
