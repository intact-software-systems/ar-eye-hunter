import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { encodeLiveWsNotice, type LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
const PRODUCER_ID = 'snapshot-publisher';
import assert from 'node:assert/strict';
import { createPostgresLiveWsNoticeTransport } from '../../src/db/create-postgres-live-ws-notice-transport.ts';

Deno.test('oversized native frame crosses bounded PostgreSQL notifications and emits only a complete, hash-checked notice', async () => {
    const groupRef = { applicationId: 'game-a', workspaceId: 'region-a', groupId: 'room' };
    const topic = AppTopics.serverRoomSnapshot;
    const message = newALBroadcastMessage(PRODUCER_ID, newALRoute(topic, 'room', 'game'), 'room', topic, { data: 'é'.repeat(8000) }, { groupRef, ttlMs: 5000 });
    const encoded = encodeLiveWsNotice({
        channel: 'test',
        publisherId: 'serverA',
        expiresAtMs: message.constraints!.expiresAtMs!,
        message,
        scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
        audience: { mode: 'generation-room', groupRef, recipientSessionIds: ['alice'], generations: { alice: 'g-a' } }
    });
    assert.equal(encoded.kind, 'fragmented');
    if (encoded.kind !== 'fragmented') {
        throw Error('Expected a private fragmented notice');
    }
    const payloads: string[] = [];
    let receive: (text: string) => void | Promise<void> = () => {};
    const transport = createPostgresLiveWsNoticeTransport({
        notify: async (_channel, fragment) => {
            const text = JSON.stringify(fragment);
            assert.ok(new TextEncoder().encode(text).length < 8000, 'PostgreSQL NOTIFY payload must fit its real limit');
            payloads.push(text);
        },
        listen: async (_channel, onMessage) => {
            receive = onMessage;
        }
    }, Date.now);
    const received: LiveWsNotice[] = [];
    let repairs = 0;
    await transport.subscribe('test', (value) => {
        received.push(value);
    }, () => {
        repairs++;
    });
    await transport.publish(encoded.notice);
    assert.ok(payloads.length >= 3);
    await receive(payloads[1]);
    await receive(payloads[1]);
    assert.equal(received.length, 0);
    for (const text of payloads.toReversed()) {
        await receive(text);
    }
    assert.deepEqual(received, [encoded.notice]);
    for (const text of payloads) {
        await receive(text);
    }
    assert.equal(received.length, 1, 'late parts and a complete replay are suppressed');
    const corrupted = payloads.map((text) => JSON.stringify({ ...JSON.parse(text), hash: computeSha256CanonicalJson('corrupt') }));
    const part = JSON.parse(corrupted[1]);
    part.data = part.data.replace(/^./u, part.data.startsWith('A') ? 'B' : 'A');
    corrupted[1] = JSON.stringify(part);
    for (const text of corrupted) {
        await receive(text);
    }
    assert.equal(received.length, 1);
    await transport.stop();
    const repairsBeforeLateDelivery = repairs;
    for (const text of payloads) {
        await receive(text);
    }
    assert.deepEqual(received, [encoded.notice]);
    assert.equal(repairs, repairsBeforeLateDelivery);
});
