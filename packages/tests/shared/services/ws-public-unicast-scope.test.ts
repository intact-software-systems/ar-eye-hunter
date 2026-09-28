import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { captureALOutboundPolicy, decodeALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerLiveDelivery } from '@shared/services/ws-queue-box-server/ws-queue-box-server-live-delivery.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

describe('public WS unicast scope', () => {
    it.each([
        { entry: 'targets', expiresAtEpochMs: 0 },
        { entry: 'result', expiresAtEpochMs: 0 },
        { entry: 'resolved', expiresAtEpochMs: 0 },
        { entry: 'targets', expiresAtEpochMs: Number.MAX_SAFE_INTEGER },
        { entry: 'result', expiresAtEpochMs: Number.MAX_SAFE_INTEGER },
        { entry: 'resolved', expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
    ])('refuses unscoped generic unicast through $entry with lease $expiresAtEpochMs', ({ entry, expiresAtEpochMs }) => {
        const { socket, native, live } = createLiveDelivery(expiresAtEpochMs);
        const service = createDefaultWsQueueBoxServerService({
            name: 'server',
            socket,
            outbox: new InMemoryQueueBox(),
            readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs })
        });
        onTestFinished(() => service.dispose());
        const message = createMessage();
        const result = entry === 'targets'
            ? service.sendToTargets(message)
            : entry === 'resolved'
            ? live.sendToResolvedPeer({ peerId: 'peer', message })
            : service.sendToTargetsWithResult({ message });
        expect(result).toEqual(entry === 'result' ? expect.objectContaining({ status: 'no-recipients', sentCount: 0 }) : 0);
        expect(native.sent).toEqual([]);
    });

    it.each(['targets', 'resolved'] as const)('preserves decoded AL control delivery through %s without generic scope', (entry) => {
        const { native, live } = createLiveDelivery();
        const message = newALAckControlMessage({ v: 2, msgId: 'ack', senderId: 'server', ts: Date.now() }, {
            fromPeerId: 'server',
            toPeerId: 'peer',
            ackedMsgId: 'message',
            originPeerId: 'peer',
            logicalRecipientPeerId: 'server',
            carrier: 'ws',
            status: 'accepted',
            observedAtEpochMs: Date.now()
        });
        expect(entry === 'targets' ? live.sendToTargets(message) : live.sendToResolvedPeer({ peerId: 'peer', message })).toBe(1);
        expect(native.sent).toHaveLength(1);
    });

    it('does not treat a control type ID alone as scope exemption at either live boundary', () => {
        const { native, live } = createLiveDelivery();
        const message = createMessage();
        const forged = { ...message, payload: { ...message.payload, typeId: 'al.control.ack.v2' } };
        expect(live.sendToTargetsWithResult({ message: forged })).toMatchObject({ status: 'no-recipients', sentCount: 0 });
        expect(live.sendToResolvedPeer({ peerId: 'peer', message: forged })).toBe(0);
        expect(native.sent).toEqual([]);
    });
    it('preserves fully decoded internal control effects without a public scope', () => {
        const message = newALAckControlMessage({ v: 2, msgId: 'ack', senderId: 'server', ts: Date.now() }, {
            fromPeerId: 'server',
            toPeerId: 'peer',
            ackedMsgId: 'message',
            originPeerId: 'peer',
            logicalRecipientPeerId: 'server',
            carrier: 'ws',
            status: 'accepted',
            observedAtEpochMs: Date.now()
        });
        const prepared = { kind: 'recipient', peerId: 'peer', connectionId: 'peer', message: toALOutboundTransportMessage(message) };
        expect(decodeWsQueueBoxServerPreparedMessage(prepared, message)).toEqual(prepared);
    });

    it('fails closed unproven auth logout until the direct producer carries explicit provenance', async () => {
        const service = createDefaultWsQueueBoxServerService({ name: 'server', socket: new JsonWebSocketServer(), outbox: new InMemoryQueueBox() });
        onTestFinished(() => service.dispose());
        const message = newALUnicastMessage(
            'server',
            {
                topicId: 'auth.session.logout',
                contextId: 'peer',
                resourceId: 'request'
            },
            'peer',
            'auth.session.logout.v1',
            { sessionId: 'peer', closeCode: 1000, reason: 'auth-logout' },
            { ttlMs: 30_000 }
        );
        expect((await service.enqueueOutboxIfAbsent(message)).verdict).toMatchObject({ kind: 'refused', reason: 'unauthorized' });
        expect(() =>
            decodeWsQueueBoxServerPreparedMessage({
                kind: 'recipient',
                peerId: 'peer',
                connectionId: 'peer',
                message: toALOutboundTransportMessage(message)
            }, message)
        ).toThrow();
    });
    it('captures full recipient scope beside the wire message', () => {
        const message = createMessage();
        const recipientScope = { ...SCOPE };
        const policy = captureALOutboundPolicy({
            msg: message,
            persist: true,
            preparedMessages: [],
            dropReasonCode: undefined,
            recipientScope
        });
        recipientScope.workspaceId = 'changed-after-capture';
        expect(decodeALOutboundCapturedPolicy(JSON.parse(JSON.stringify(policy))))
            .toMatchObject({ recipientScope: SCOPE });
        expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'peer' });
    });

    it('refuses persisted public unicast recipient effects without scope proof', () => {
        const message = createMessage();
        expect(() =>
            decodeWsQueueBoxServerPreparedMessage({
                kind: 'recipient',
                peerId: 'peer',
                connectionId: 'peer',
                message: toALOutboundTransportMessage(message)
            }, message)
        ).toThrow();
    });

    it.each([undefined, {}, { applicationId: 'app', workspaceId: '' }])('refuses malformed prepared scope %j', (recipientScope) => {
        const message = createMessage();
        expect(() =>
            decodeWsQueueBoxServerPreparedMessage({
                kind: 'scoped-recipient',
                peerId: 'peer',
                connectionId: 'peer',
                generationId: 'generation',
                recipientScope,
                message: toALOutboundTransportMessage(message)
            }, message)
        ).toThrow();
    });

    it('reads back the exact scoped recipient and socket generation', () => {
        const message = createMessage();
        const prepared = {
            kind: 'scoped-recipient',
            peerId: 'peer',
            connectionId: 'peer',
            generationId: 'generation',
            recipientScope: SCOPE,
            message: toALOutboundTransportMessage(message)
        };
        expect(decodeWsQueueBoxServerPreparedMessage(JSON.parse(JSON.stringify(prepared)), message))
            .toEqual(prepared);
    });

    it.each(['same-scope', 'other-scope', 'expired', 'encode-replacement'] as const)(
        'sends prepared unicast only to its authenticated generation: %s',
        async (boundary) => {
            const socket = new JsonWebSocketServer();
            const native = new TestWebSocket('ws://prepared');
            native.open();
            socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
            const settled: string[] = [];
            const service = createDefaultWsQueueBoxServerService({
                name: 'server',
                socket,
                outbox: new InMemoryQueueBox(),
                readAuthenticatedConnectionScope: () => ({
                    scope: { ...SCOPE, workspaceId: boundary === 'other-scope' ? 'other' : SCOPE.workspaceId },
                    expiresAtEpochMs: boundary === 'expired' ? 0 : Date.now() + 30_000
                }),
                outboundSettlements: (event) => {
                    if (event.kind === 'attempt-settled') {
                        settled.push(event.outcome);
                    }
                }
            });
            onTestFinished(() => {
                service.dispose();
                vi.restoreAllMocks();
            });
            const replacement = new TestWebSocket('ws://replacement');
            replacement.open();
            const encode = socket.encode.bind(socket);
            vi.spyOn(socket, 'encode').mockImplementation((message) => {
                if (boundary === 'encode-replacement') {
                    socket.addConnection(new ConnectionContext({ id: 'peer', socket: replacement }));
                }
                return encode(message);
            });
            await service.enqueueOutboxIfAbsent(createMessage(), undefined, SCOPE);
            await expect.poll(() => settled.length).toBe(1);
            expect(native.sent).toHaveLength(boundary === 'same-scope' ? 1 : 0);
            expect(replacement.sent).toEqual([]);
        }
    );

    it.each(['replaced', 'expired', 'scope-changed'] as const)('checks %s authentication immediately after encoding', (change) => {
        const socket = new JsonWebSocketServer();
        const original = new TestWebSocket('ws://original');
        original.open();
        const connection = new ConnectionContext({ id: 'peer', socket: original });
        socket.addConnection(connection);
        let proof = { scope: SCOPE, expiresAtEpochMs: Date.now() + 30_000 };
        const service = createDefaultWsQueueBoxServerService({
            name: 'server',
            socket,
            outbox: new InMemoryQueueBox(),
            readAuthenticatedConnectionScope: () => proof
        });
        onTestFinished(() => {
            service.dispose();
            vi.restoreAllMocks();
        });
        const replacement = new TestWebSocket('ws://replacement');
        replacement.open();
        const encode = socket.encode.bind(socket);
        vi.spyOn(socket, 'encode').mockImplementation((message) => {
            if (change === 'replaced') {
                socket.addConnection(new ConnectionContext({ id: 'peer', socket: replacement }));
            }
            else if (change === 'expired') {
                proof = { ...proof, expiresAtEpochMs: 0 };
            }
            else {
                proof = { ...proof, scope: { ...SCOPE, workspaceId: 'other' } };
            }
            return encode(message);
        });

        const result = service.sendToTargetsWithResult({ message: createMessage(), inboundScope: SCOPE });

        expect(result).toMatchObject({ status: 'no-recipients', sentCount: 0, recipientCount: 0 });
        expect(original.sent).toEqual([]);
        expect(replacement.sent).toEqual([]);
    });
});

function createMessage() {
    return newALUnicastMessage('server', { topicId: 'app.message', contextId: 'direct', resourceId: 'scope' }, 'peer', 'message.v1', {}, { ttlMs: 30_000 });
}

function createLiveDelivery(expiresAtEpochMs = 0) {
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://live');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const live = new WsQueueBoxServerLiveDelivery({
        socket,
        targetResolution: new WsQueueBoxServerTargetResolution({
            socket,
            targetResolver: { resolvePeerRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] }
        }),
        deliveryReporting: new WsQueueBoxServerDeliveryReporting({}),
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs })
    });
    return { socket, native, live };
}
