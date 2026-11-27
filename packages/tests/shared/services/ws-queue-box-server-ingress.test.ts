import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALAdmissionMemoryState } from '@shared/alm/al-admission-backend.ts';
import { readALInboundMessageOwner } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { loseInboundWritesFromNowOn } from '../alm/inbound-runtime-test-fixture.ts';
import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { createIncomingMessage, createRoomMessage, createServerIngressFixture } from './ws-queue-box-server-ingress-fixture.ts';
import { settleQueueEngine } from './ws-queue-box-server-receipt-fixture.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../al-control-test-payloads.ts';
import { attachTestWebSocket } from '../websocket/attach-test-web-socket.ts';

const PENDING_ADMISSION_DENIALS = ['unauthorized', 'membership-fenced', 'not-yet-in-sync'] as const;

describe('WS server bounded and authorized admission', () => {
    it('captures authenticated scope in admitted provenance before asynchronous admission', async () => {
        const fixture = await createServerIngressFixture();
        const message = createIncomingMessage();

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect(readALInboundMessageOwner({
            database: fixture.backend,
            namespace: fixture.admissionStore.namespace,
            msgId: message.id.msgId,
            senderId: message.id.senderId
        })).resolves.toMatchObject({
            source: { kind: 'ws-client', peerId: 'session-1', authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } }
        });
    });

    it('rejects absent and expired authenticated connection scope before writing work', async () => {
        for (const proof of [undefined, { scope: { applicationId: 'app', workspaceId: 'workspace' }, expiresAtEpochMs: 0 }]) {
            const fixture = await createServerIngressFixture(
                () => {
                    throw new Error('Scope refusal must precede application policy');
                },
                'session-1',
                () => proof
            );
            expect((await fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1')).left)
                .toEqual({ code: 'unauthorized', message: 'AL message message-1 arrived without a current authenticated WS scope' });
            expect(fixture.admission.data.size).toBe(0);
            expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        }
    });

    it('rejects a proven scope that differs from an explicit room target', async () => {
        const fixture = await createServerIngressFixture(
            () => {
                throw new Error('Foreign scope must precede application policy');
            },
            'session-1',
            () => ({
                scope: { applicationId: 'other', workspaceId: 'workspace' },
                expiresAtEpochMs: Date.now() + 60_000
            })
        );
        fixture.service.authorizeInboundMessagesWith({ sendNacks: false, authorize: async () => ({ authorized: true }) });

        expect((await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).left)
            .toEqual({ code: 'unauthorized', message: 'AL message message-1 addresses app/workspace, outside its connection\'s authenticated scope' });
        expect(fixture.admission.data.size).toBe(0);
    });

    it('rejects a proven scope that differs from an explicit principal target', async () => {
        const fixture = await createServerIngressFixture();
        const message: ALMessage = {
            ...createIncomingMessage(),
            targets: {
                mode: 'broadcast',
                scope: 'principal',
                groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' },
                principalRef: { applicationId: 'other', workspaceId: 'workspace', principalId: 'alice' }
            }
        };

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code)
            .toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
    });

    it.each(
        [
            ['an all broadcast', { mode: 'broadcast', scope: 'all' }, 'unauthorized'],
            [
                'a principal broadcast that names no room',
                {
                    mode: 'broadcast',
                    scope: 'principal',
                    principalRef: { applicationId: 'app', workspaceId: 'workspace', principalId: 'alice' }
                },
                'malformed'
            ]
        ] as const
    )('refuses %s from a client as %s and admits nothing', async (_name, targets, code) => {
        const fixture = await createServerIngressFixture();

        expect((await fixture.service.acceptIncomingMessage({ ...createIncomingMessage(), targets }, 'session-1')).left?.code)
            .toBe(code);
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('never sends a world broadcast back to the session that sent it', async () => {
        const fixture = await createServerIngressFixture();
        const peer = new SimulatedWebSocket('ws://peer');
        await peer.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-2', socket: peer }));
        const message: ALMessage = { ...createIncomingMessage(), targets: { mode: 'broadcast', scope: 'world' } };

        const result = fixture.service.sendToTargetsWithResult({
            message,
            sentPositions: null,
            inboundScope: { applicationId: 'app', workspaceId: 'workspace' }
        });

        expect(result.recipients.map((recipient) => recipient.peerId)).toEqual(['session-2']);
        expect(peer.sent).toHaveLength(1);
        expect(fixture.socket.sent).toEqual([]);
    });

    it('never sends a client\'s room broadcast back to its sender', async () => {
        const fixture = await createServerIngressFixture();
        const peer = new SimulatedWebSocket('ws://peer');
        await peer.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-2', socket: peer }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1', 'session-2'], snapshotVersion: 1 } })
        });
        const message = createRoomMessage();

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect.poll(() => peer.sent.length).toBe(1);

        const isRoomFrame = (frame: string) => decodePersistedALMessage(frame).route.topicId === message.route.topicId;
        expect(peer.sent.filter(isRoomFrame)).toHaveLength(1);
        expect(fixture.socket.sent.filter(isRoomFrame)).toEqual([]);
    });

    it('admits a scoped client unicast even when its recipient is not connected locally', async () => {
        const fixture = await createServerIngressFixture();
        const message: ALMessage = {
            ...createIncomingMessage(),
            targets: { mode: 'unicast', toPeerId: 'remote-session' }
        };

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect(readALInboundMessageOwner({
            database: fixture.backend,
            namespace: fixture.admissionStore.namespace,
            msgId: message.id.msgId,
            senderId: message.id.senderId
        })).resolves.toMatchObject({ source: { authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' } } });
    });

    it('does not send a client unicast to a same-ID local socket reconnected in another scope', async () => {
        const fixture = await createServerIngressFixture(undefined, 'session-1', (connection) => ({
            scope: connection.id === 'target-session'
                ? { applicationId: 'other', workspaceId: 'workspace' }
                : { applicationId: 'app', workspaceId: 'workspace' },
            expiresAtEpochMs: Date.now() + 60_000
        }));
        const targetSocket = new SimulatedWebSocket('ws://target');
        await targetSocket.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'target-session', socket: targetSocket }));
        const message: ALMessage = {
            ...createIncomingMessage(),
            targets: { mode: 'unicast', toPeerId: 'target-session' }
        };

        const sent = fixture.service.sendToTargetsWithResult({
            message,
            sentPositions: null,
            recipientSessionIds: ['target-session'],
            inboundScope: { applicationId: 'app', workspaceId: 'workspace' }
        });

        expect(sent.sentCount).toBe(0);
        expect(targetSocket.sent).toEqual([]);
    });

    it('rejects invalid envelopes and forged identities without poisoning a valid message identity', async () => {
        let applicationAllowed = false;
        const fixture = await createServerIngressFixture((message) => {
            if (!applicationAllowed) {
                throw new Error('Decode and authenticated origin refusal must precede application policy');
            }
            return Either.ofRight(message);
        });
        const message = createIncomingMessage();
        expect((await fixture.service.acceptIncomingMessage({}, 'session-1')).left?.code).toBe('malformed');
        const forged = { ...message, id: { ...message.id, senderId: 'victim' } };
        expect((await fixture.service.acceptIncomingMessage(forged, 'session-1')).left)
            .toEqual({ code: 'unauthorized', message: 'AL origin must match an authenticated live WS connection' });
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);

        applicationAllowed = true;
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect.poll(() => fixture.delivered).toEqual([message]);
    });

    it('requires room authority even when a message supplies no snapshot floor', async () => {
        const fixture = await createServerIngressFixture();
        const message = createRoomMessage();
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code).toBe('unsupported');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it.each(PENDING_ADMISSION_DENIALS.flatMap((reason) => [false, true].map((sendNack) => [reason, sendNack] as const)))(
        'rechecks %s room authority before pending admission can commit or acknowledge (sendNack=%s)',
        async (reason, sendNack) => {
            let nowMs = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
            const fixture = await createServerIngressFixture();
            let pending = false;
            fixture.service.authorizeInboundMessagesWith({
                sendNacks: true,
                authorize: async () =>
                    pending
                        ? { authorized: false, reason, logMessage: 'Current room authority changed', sendNack }
                        : { authorized: true, roomAudience: { recipientPeerIds: [], snapshotVersion: 1 } }
            });
            const commit = fixture.admissionStore.commitBundle.bind(fixture.admissionStore);
            vi.spyOn(fixture.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
                expect(await commit({ ...bundle, mutations: bundle.mutations.filter((mutation) => mutation.kind === 'set-msg-owner'), durableEffects: [] }))
                    .toBe(
                        'committed'
                    );
                const status = await commit(bundle);
                expect(status).toBe('conflict');
                return status;
            });
            // Every later attempt's write is lost too, so the send is retained however often its owner looks again;
            // the store commits again once the row is retained, before the replay that rechecks authority.
            const restoreWrites = loseInboundWritesFromNowOn(fixture.admissionStore);
            const enqueue = fixture.admission.workQueue.enqueueIfAbsent.bind(fixture.admission.workQueue);
            let observedMetadata: ALAdmissionMemoryState['data'] | undefined;
            vi.spyOn(fixture.admission.workQueue, 'enqueueIfAbsent').mockImplementationOnce(async (entry) => {
                const retained = await enqueue(entry);
                restoreWrites();
                observedMetadata = new Map(fixture.admission.data);
                pending = true;
                return retained;
            });
            const message = { ...createRoomMessage(), constraints: { expiresAtMs: Date.now() + 60_000 }, qos: { ack: { algo: 'hop' as const } } };
            expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('pending-admission');
            await expect.poll(async () => {
                const keys = await fixture.admission.workQueue.getAllKeys();
                return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
            }).toBe(reason === 'not-yet-in-sync' ? 'RETRY' : 'COMPLETED');
            expect(fixture.admission.data).toEqual(observedMetadata);
            const nacksRefusal = sendNack && reason !== 'not-yet-in-sync';
            expectPendingRefusalNack(fixture.socket.sent, nacksRefusal ? reason : undefined);
            expect(fixture.delivered).toEqual([]);
            const keys = await fixture.admission.workQueue.getAllKeys();
            expect(keys).toHaveLength(1);
            expect((await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe(reason === 'not-yet-in-sync' ? 'RETRY' : 'COMPLETED');
            if (nacksRefusal) {
                await settleQueueEngine(fixture.engine);
                expectPendingRefusalNack(fixture.socket.sent, reason);
            }
            if (reason === 'not-yet-in-sync') {
                const waiting = await fixture.admission.workQueue.getItem(keys[0]);
                expect(waiting?.dequeueAudit.attempts).toBe(0);
                expect(waiting?.dequeueAudit.nextTs?.epochMilliseconds).toBe(Date.now() + 50);
                nowMs = waiting!.dequeueAudit.nextTs!.epochMilliseconds;
                await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.dequeueAudit.nextTs?.epochMilliseconds).toBe(nowMs + 50);
                const stillWaiting = await fixture.admission.workQueue.getItem(keys[0]);
                expect(stillWaiting?.dequeueAudit.attempts).toBe(0);
                expect(stillWaiting?.dequeueAudit.nextTs?.epochMilliseconds).toBe(nowMs + 50);
                pending = false;
                nowMs = stillWaiting!.dequeueAudit.nextTs!.epochMilliseconds;
                await expect.poll(async () => {
                    return fixture.delivered.length;
                }).toBe(1);
                expect(fixture.delivered[0].constraints?.expiresAtMs).toBe(message.constraints.expiresAtMs);
            }
        }
    );

    it.each([true, false])('returns configured denial NACKs without accepting room traffic (sendNack=%s)', async (sendNack) => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({
                authorized: false,
                reason: 'unauthorized',
                logMessage: 'Sender is no longer a room member',
                sendNack
            })
        });

        const message: ALMessage = { ...createRoomMessage(), qos: { ack: { algo: 'hop' }, durability: { algo: 'local-inbox' } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        if (sendNack) {
            const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
            expect(controls).toMatchObject([{
                id: { senderId: 'server' },
                targets: { mode: 'unicast', toPeerId: 'session-1' },
                qos: { delivery: { algo: 'best-effort' }, durability: { algo: 'volatile' }, ack: { algo: 'none' } },
                payload: { typeId: 'al.control.nack.v5' }
            }]);
            expect(decodeALNackPayload(JSON.parse(controls[0].payload.resource))).toMatchObject({
                fromPeerId: 'server',
                toPeerId: 'session-1',
                msgId: 'message-1',
                reason: 'unauthorized'
            });
        }
        else {
            expect(fixture.socket.sent).toEqual([]);
        }
        expect(fixture.delivered).toEqual([]);
    });

    it('answers a membership-fenced sender with a fenced NACK and refuses it as unauthorized', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({
                authorized: false,
                reason: 'membership-fenced',
                logMessage: 'Rejected room message for room-1: membership-fenced: member-removed: Group member has been removed.',
                sendNack: true,
                serverSnapshotVersion: 4
            })
        });

        const message: ALMessage = { ...createRoomMessage(), qos: { ack: { algo: 'hop' }, durability: { algo: 'local-inbox' } } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left).toEqual({
            code: 'unauthorized',
            message: 'Rejected room message for room-1: membership-fenced: member-removed: Group member has been removed.'
        });
        const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
        expect(controls).toHaveLength(1);
        expect(decodeALNackPayload(JSON.parse(controls[0].payload.resource))).toMatchObject({
            fromPeerId: 'server',
            toPeerId: 'session-1',
            msgId: 'message-1',
            reason: 'membership-fenced',
            serverSnapshotVersion: 4
        });
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it.each(['unauthorized', 'not-yet-in-sync'] as const)('keeps the %s outcome when its advisory NACK exceeds the payload ceiling', async (reason) => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({ authorized: false, reason, logMessage: 'Room policy denied', sendNack: true })
        });
        for (const msgId of ['x'.repeat(65536), 'é'.repeat(32768), '"'.repeat(32768), '"'.repeat(32700)]) {
            const message: ALMessage = { ...createRoomMessage(), id: { ...createRoomMessage().id, msgId } };
            const result = await fixture.service.acceptIncomingMessage(message, 'session-1');
            if (reason === 'unauthorized') {
                expect(result.left).toEqual({ code: 'unauthorized', message: 'Room policy denied' });
            }
            else {
                expect(result.right).toEqual({ kind: 'pending-admission' });
            }
        }
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toHaveLength(reason === 'unauthorized' ? 0 : 4);
        expect(fixture.delivered).toEqual([]);
    });

    it.each(['unauthorized', 'not-yet-in-sync'] as const)(
        'keeps the %s outcome for an authenticated peer outside the control receiver limit',
        async (reason) => {
            const peerId = 'p'.repeat(129);
            const fixture = await createServerIngressFixture(undefined, peerId);
            fixture.service.authorizeInboundMessagesWith({
                sendNacks: true,
                authorize: async () => ({ authorized: false, reason, logMessage: 'Room policy denied', sendNack: true })
            });
            const message: ALMessage = { ...createRoomMessage(), id: { ...createRoomMessage().id, senderId: peerId } };
            const result = await fixture.service.acceptIncomingMessage(message, peerId);
            if (reason === 'unauthorized') {
                expect(result.left).toEqual({ code: 'unauthorized', message: 'Room policy denied' });
            }
            else {
                expect(result.right).toEqual({ kind: 'pending-admission' });
            }
            expect(fixture.socket.sent).toEqual([]);
            expect(fixture.admission.data.size).toBe(0);
            expect(await fixture.admission.workQueue.getAllKeys()).toHaveLength(reason === 'unauthorized' ? 0 : 1);
            expect(fixture.delivered).toEqual([]);
        }
    );

    it('preserves advisory NACK transport error diagnostics', async () => {
        const fixture = await createServerIngressFixture();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({ authorized: false, reason: 'unauthorized', logMessage: 'Denied', sendNack: true })
        });
        const failure = new Error('Native send failed');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(fixture.socket, 'send').mockImplementation(() => {
            throw failure;
        });
        expect((await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).left?.code).toBe('unauthorized');
        expect(errors).toHaveBeenCalledWith('Error sending WS server message to session-1', failure);
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('retains a room send its authority is behind on, answers the advisory NACK, and delivers it once the authority catches up', async () => {
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const fixture = await createServerIngressFixture();
        let behind = true;
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () =>
                behind
                    ? {
                        authorized: false,
                        reason: 'not-yet-in-sync',
                        logMessage: 'Room snapshot is catching up',
                        sendNack: true,
                        serverSnapshotVersion: 1
                    }
                    : { authorized: true, roomAudience: { recipientPeerIds: [], snapshotVersion: 2 } }
        });
        const message = { ...createRoomMessage(), constraints: { expiresAtMs: nowMs + 60_000 } };

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right).toEqual({ kind: 'pending-admission' });
        const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
        expect(controls).toHaveLength(1);
        expect(decodeALNackPayload(JSON.parse(controls[0].payload.resource))).toMatchObject({
            fromPeerId: 'server',
            toPeerId: 'session-1',
            msgId: 'message-1',
            reason: 'not-yet-in-sync',
            serverSnapshotVersion: 1
        });
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe('RETRY');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);

        behind = false;
        nowMs = (await fixture.admission.workQueue.getItem(keys[0]))!.dequeueAudit.nextTs!.epochMilliseconds;
        await expect.poll(() => fixture.delivered.length).toBe(1);
        expect(fixture.delivered[0].id).toEqual(message.id);
        expect(fixture.delivered[0].constraints?.expiresAtMs).toBe(message.constraints.expiresAtMs);
        await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe('COMPLETED');
        expect(fixture.delivered).toHaveLength(1);
        expect(fixture.socket.sent).toHaveLength(1);
    });

    it('does not parse an oversized native wire message or admit its decoded equivalent', async () => {
        const fixture = await createServerIngressFixture();
        const message = createIncomingMessage();
        const serialized = ' '.repeat(AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes) + JSON.stringify(message);
        const parse = vi.spyOn(JSON, 'parse');
        onTestFinished(() => parse.mockRestore());

        await fixture.socket.receive(serialized);

        expect(parse.mock.calls.some(([value]) => value === serialized)).toBe(false);
        expect(fixture.admission.data.size).toBe(0);
        await fixture.socket.receive(JSON.stringify(message));
        await expect.poll(() => fixture.delivered).toEqual([message]);
    });

    it('rechecks the connection generation after asynchronous authorization', async () => {
        const fixture = await createServerIngressFixture();
        const gate = Promise.withResolvers<void>();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => {
                await gate.promise;
                return { authorized: true };
            }
        });
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
        const replacement = new SimulatedWebSocket('ws://replacement');
        await replacement.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-1', socket: replacement }));
        gate.resolve();

        expect((await receiving).left?.code).toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('rejects a reconnect queued after authorization before admission starts', async () => {
        const fixture = await createServerIngressFixture();
        const replacement = new SimulatedWebSocket('ws://replacement');
        await replacement.open();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => {
                queueMicrotask(() => {
                    queueMicrotask(() => {
                        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-1', socket: replacement }));
                    });
                });
                return { authorized: true };
            }
        });

        expect((await fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1')).left?.code)
            .toBe('unauthorized');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('preserves the application authorization refusal before room policy or admission', async () => {
        const fixture = await createServerIngressFixture(() => Either.ofLeft({ code: 'malformed', message: 'Invalid command' }));
        const authorizedRoomMessages: ALMessage[] = [];
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async (message) => {
                authorizedRoomMessages.push(message);
                return { authorized: true };
            }
        });

        expect((await fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1')).left)
            .toEqual({ code: 'malformed', message: 'Invalid command' });
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
        expect(authorizedRoomMessages).toEqual([]);
    });

    it('preserves the nonlocal protocol refusal before application policy', async () => {
        const fixture = await createServerIngressFixture(() => {
            throw new Error('Protocol refusal must precede application policy');
        });
        const message = newALAckControlMessage(
            { v: 4, msgId: 'forged-ack', senderId: 'session-1', ts: 1, traceId: 'trace-ws-queue-box-server-ingress' },
            toTestALAckPayload({
                ackedMsgId: 'subject',
                fromPeerId: 'session-1',
                toPeerId: 'origin',
                originPeerId: 'origin',
                logicalRecipientPeerId: 'another-recipient',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: 1
            })
        );

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement from a WS session speaks for another recipient than its sender'
        });
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('propagates the application authorization exception without admission effects', async () => {
        const failure = new Error('Application authorization failed');
        const fixture = await createServerIngressFixture(() => {
            throw failure;
        });

        await expect(fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1')).rejects.toBe(failure);
        expect(fixture.admission.data.size).toBe(0);
        expect(await fixture.admission.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('admits and delivers the original message when application policy returns a different right value', async () => {
        const message = createIncomingMessage();
        const replacement: ALMessage = { ...message, id: { ...message.id, msgId: 'replacement' } };
        const fixture = await createServerIngressFixture(() => Either.ofRight(replacement));

        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right?.kind).toBe('admitted');
        await expect.poll(() => fixture.delivered).toEqual([message]);
        expect((await fixture.admissionStore.readDeliverySurface({ senderId: 'session-1', msgId: 'message-1' }, Date.now()))?.msg)
            .toEqual(message);
        expect(await fixture.admissionStore.readDeliverySurface({ senderId: 'session-1', msgId: 'replacement' }, Date.now()))
            .toBeUndefined();
    });

    it('rechecks changed application policy before retained room work can be admitted', async () => {
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        let applicationAllowed = true;
        const fixture = await createServerIngressFixture((message) =>
            applicationAllowed ? Either.ofRight(message) : Either.ofLeft({ code: 'unauthorized', message: 'Application policy changed' })
        );
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: false, reason: 'not-yet-in-sync', logMessage: 'Waiting for room state', sendNack: false })
        });
        const message = { ...createRoomMessage(), constraints: { expiresAtMs: nowMs + 60_000 } };
        expect((await fixture.service.acceptIncomingMessage(message, 'session-1')).right).toEqual({ kind: 'pending-admission' });
        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe('RETRY');
        applicationAllowed = false;
        nowMs = (await fixture.admission.workQueue.getItem(keys[0]))!.dequeueAudit.nextTs!.epochMilliseconds;

        await expect.poll(async () => (await fixture.admission.workQueue.getItem(keys[0]))?.status).toBe('COMPLETED');
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });

    it('fences an authorization result that arrives after disposal', async () => {
        const fixture = await createServerIngressFixture();
        const gate = Promise.withResolvers<void>();
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => {
                await gate.promise;
                return { authorized: true };
            }
        });
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
        const disposed = fixture.service.dispose();
        gate.resolve();

        expect((await receiving).right?.kind).toBe('disposed');
        await disposed;
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('does not commit an admission read that completes after disposal', async () => {
        const fixture = await createServerIngressFixture();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const read = fixture.admissionStore.readIncomingMessage.bind(fixture.admissionStore);
        vi.spyOn(fixture.admissionStore, 'readIncomingMessage').mockImplementation(async (...input) => {
            started.resolve();
            await release.promise;
            return await read(...input);
        });
        const receiving = fixture.service.acceptIncomingMessage(createIncomingMessage(), 'session-1');
        await started.promise;
        const disposed = fixture.service.dispose();
        release.resolve();

        expect((await receiving).right?.kind).toBe('disposed');
        await disposed;
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it.each([
        { state: 'buffered behind a gap', sends: [2], resent: 2, then: [1], delivered: ['message-1', 'message-2'] },
        { state: 'delivered with the track head at it', sends: [1], resent: 1, then: [], delivered: ['message-1'] },
        {
            state: 'delivered with the track head two sequences past it',
            sends: [1, 2, 3],
            resent: 1,
            then: [],
            delivered: ['message-1', 'message-2', 'message-3']
        }
    ])('delivers a re-sent ordered copy $state once and answers its sender alone admitted again', async ({ sends, resent, then, delivered }) => {
        const fixture = await createServerIngressFixture();
        const peer = new SimulatedWebSocket('ws://peer');
        await peer.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-2', socket: peer }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1', 'session-2'], snapshotVersion: 1 } })
        });
        const resentMsgId = `message-${resent}`;
        for (const seq of sends) {
            expect((await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1')).left).toBeUndefined();
        }
        await expect.poll(() => readReceiptPhases(fixture.socket, resentMsgId)).toEqual(['admitted']);

        const again = await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(resent), 'session-1');
        for (const seq of then) {
            await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1');
        }

        expect(again.right?.kind).toBe('duplicate');
        await expect.poll(() => readReceiptPhases(fixture.socket, resentMsgId)).toEqual(['admitted', 'admitted']);
        await settleQueueEngine(fixture.engine);
        expect(readReceiptPhases(fixture.socket, resentMsgId)).toEqual(['admitted', 'admitted']);
        await expect.poll(() => fixture.delivered.map((message) => message.id.msgId)).toEqual(delivered);
        expect(readReceiptPhases(peer, resentMsgId)).toEqual([]);
        expect(peer.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === resentMsgId)).toHaveLength(1);
    });

    // Each send's admission extends the track's progress expiry; a completion fenced on that whole row conflicted, and
    // its work handed the delivered message to the application a second or third time.
    it('hands each ordered message to the application once when sends arrive back to back', async () => {
        const fixture = await createServerIngressFixture();
        const peer = new SimulatedWebSocket('ws://peer');
        await peer.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-2', socket: peer }));
        const received: string[] = [];
        fixture.service.onAnyInboxMessageDo('application', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
            }
        });
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1', 'session-2'], snapshotVersion: 1 } })
        });
        for (const seq of [1, 2, 3]) {
            expect((await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1')).left).toBeUndefined();
        }

        await expect.poll(() => received).toEqual(['message-1', 'message-2', 'message-3']);
        await settleQueueEngine(fixture.engine);
        expect(received).toEqual(['message-1', 'message-2', 'message-3']);
        const trackKey = toALOrderingTrackKey(createOrderedRoomMessage(1))!;
        expect((await fixture.admissionStore.readOrderedDelivery(trackKey, 4)).completedThrough).toBe(3);
    });

    // Of two sends written side by side, the second lost its write to the first's admission and was parked until a
    // replay ran.
    it('admits two ordered sends of one track written side by side, and hands each to the application once in order', async () => {
        const fixture = await createServerIngressFixture();
        const received: string[] = [];
        fixture.service.onAnyInboxMessageDo('application', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
            }
        });
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1'], snapshotVersion: 1 } })
        });

        const answers = await Promise.all(
            [1, 2].map(async (seq) => (await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1')).right?.kind)
        );

        expect(answers).toEqual(['admitted', 'admitted']);
        const trackKey = toALOrderingTrackKey(createOrderedRoomMessage(1))!;
        await expect.poll(async () => (await fixture.admissionStore.readOrderedDelivery(trackKey, 3)).completedThrough).toBe(2);
        await settleQueueEngine(fixture.engine);
        expect(received).toEqual(['message-1', 'message-2']);
        const rows = await Promise.all(
            (await fixture.admission.workQueue.getAllKeys()).map(async (key) =>
                decodeALInboundWorkEntry((await fixture.admission.workQueue.getItem(key))!, fixture.admissionStore.namespace)
            )
        );
        expect(rows.filter((row) => row.payload.kind === 'admit-message')).toEqual([]);
    });

    // Each send lost its admission write to its predecessor's completion and was parked, its track's later sends
    // buffered behind it until a replay ran seconds later.
    it('delivers five ordered sends of one track in order when each arrives during its predecessor\'s completion', async () => {
        const fixture = await createServerIngressFixture();
        const trackKey = toALOrderingTrackKey(createOrderedRoomMessage(1))!;
        const readCompletedThrough = async () => (await fixture.admissionStore.readOrderedDelivery(trackKey, 6)).completedThrough;
        const received: string[] = [];
        // Each send's hand-over to the application waits for its successor's store read, so its completion commits
        // inside that read's window.
        const handOvers = new Map<string, PromiseWithResolvers<void>>();
        const readHandOver = (msgId: string) => handOvers.get(msgId) ?? handOvers.set(msgId, Promise.withResolvers()).get(msgId)!;
        onTestFinished(() => handOvers.forEach((handOver) => handOver.resolve()));
        fixture.service.onAnyInboxMessageDo('application', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
                await readHandOver(message.id.msgId).promise;
            }
        });
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1'], snapshotVersion: 1 } })
        });
        const read = fixture.admissionStore.readIncomingMessage.bind(fixture.admissionStore);
        const held = new Set<string>();
        vi.spyOn(fixture.admissionStore, 'readIncomingMessage').mockImplementation(async (request) => {
            const observed = await read(request);
            const seq = request.msg.ordering?.seq;
            if (seq !== undefined && seq > 1 && !held.has(request.msg.id.msgId)) {
                held.add(request.msg.id.msgId);
                await expect.poll(() => received).toContain(`message-${seq - 1}`);
                readHandOver(`message-${seq - 1}`).resolve();
                await settleQueueEngine(fixture.engine);
                await expect.poll(readCompletedThrough).toBe(seq - 1);
            }
            return observed;
        });

        const answers: (string | undefined)[] = [];
        for (const seq of [1, 2, 3, 4, 5]) {
            answers.push((await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1')).right?.kind);
        }
        readHandOver('message-5').resolve();

        expect(answers).toEqual(['admitted', 'admitted', 'admitted', 'admitted', 'admitted']);
        await expect.poll(readCompletedThrough).toBe(5);
        await settleQueueEngine(fixture.engine);
        expect(received).toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5']);
    });

    // Pins the hand-on on the WS server: each send admitted behind the held delivery is run by the batch that completed
    // its predecessor. Without it, a batch that followed delivered message 2, and each later send that a batch had
    // already set aside waited for the rotation. The engine's rounds are stopped before the hold is let go, so only the
    // batches already owed can deliver what follows.
    it('hands each ordered send admitted behind a held delivery to the application as its predecessor completes', async () => {
        const fixture = await createServerIngressFixture();
        const trackKey = toALOrderingTrackKey(createOrderedRoomMessage(1))!;
        const received: string[] = [];
        const firstHandOver = Promise.withResolvers<void>();
        onTestFinished(() => firstHandOver.resolve());
        fixture.service.onAnyInboxMessageDo('application', {
            onMessage: async (message) => {
                received.push(message.id.msgId);
                if (message.id.msgId === 'message-1') {
                    await firstHandOver.promise;
                }
            }
        });
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1'], snapshotVersion: 1 } })
        });
        const answers = [(await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(1), 'session-1')).right?.kind];
        await expect.poll(() => received).toEqual(['message-1']);
        for (const seq of [2, 3, 4, 5]) {
            answers.push((await fixture.service.acceptIncomingMessage(createOrderedRoomMessage(seq), 'session-1')).right?.kind);
        }
        await fixture.engine.stop();

        firstHandOver.resolve();

        expect(answers).toEqual(['admitted', 'admitted', 'admitted', 'admitted', 'admitted']);
        await expect.poll(async () => (await fixture.admissionStore.readOrderedDelivery(trackKey, 6)).completedThrough).toBe(5);
        expect(received).toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5']);
        const readRows = async () =>
            await Promise.all(
                (await fixture.admission.workQueue.getAllKeys()).map(async (key) => (await fixture.admission.workQueue.getItem(key))!)
            );
        // The batch releases its rows after their completions commit, so the rows are read once its release shows.
        await expect.poll(async () =>
            (await readRows())
                .filter((row) => decodeALInboundWorkEntry(row, fixture.admissionStore.namespace).payload.kind === 'dispatch-local')
                .map((row) => [row.status, row.dequeueAudit.attempts])
        ).toEqual(Array(5).fill(['COMPLETED', 1]));
        expect((await readRows()).map((row) => row.status)).not.toContain('RETRY');
    });

    it('leaves a durable message in QueueBox when an application subscriber fails', async () => {
        const fixture = await createServerIngressFixture();
        const message: ALMessage = { ...createIncomingMessage(), qos: { durability: { algo: 'local-inbox' } } };
        fixture.service.onAnyInboxMessageDo('observer', {
            onMessage: async () => {
                throw new Error('Temporary application failure');
            }
        });
        await fixture.service.acceptIncomingMessage(message, 'session-1');

        const keys = await fixture.admission.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        await expect.poll(async () => {
            return (await fixture.admission.workQueue.getItem(keys[0]))?.status;
        }).toBe('RETRY');
    });
});

/** `session-1`'s receipted room message at `seq` of its one ordered track. */
function createOrderedRoomMessage(seq: number): ALMessage {
    const message = createRoomMessage();
    return {
        ...message,
        id: { ...message.id, msgId: `message-${seq}` },
        constraints: { expiresAtMs: Date.now() + 60_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        ordering: { orderingKey: 'stream', epoch: 1, seq }
    };
}

/** The socket holds nothing, or exactly the one NACK of `message-1` that states `reason`. */
function expectPendingRefusalNack(sent: SimulatedWebSocket['sent'], reason: string | undefined): void {
    if (reason === undefined) {
        expect(sent).toEqual([]);
        return;
    }
    expect(sent).toHaveLength(1);
    const nack = decodePersistedALMessage(String(sent[0]));
    expect(nack.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    expect(decodeALNackPayload(JSON.parse(nack.payload.resource))).toMatchObject({
        fromPeerId: 'server',
        toPeerId: 'session-1',
        msgId: 'message-1',
        reason
    });
}

function readReceiptPhases(socket: SimulatedWebSocket, msgId: string): readonly string[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)))
        .filter((receipt) => receipt.msgId === msgId)
        .map((receipt) => receipt.phase);
}

// 6c: only a lane that passes a parent's repair copy down relays a gap NACK for a message that asked for no receipt.
// The server's inbound lane passes no copy down, so it admits nothing for such a NACK and the server never relays a
// peer NACK to the client that sent the track.
describe('a session\'s gap NACK about a client\'s unreceipted ordered room track', () => {
    const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

    function createUnreceiptedFeedFrame(seq: number): ALMessage {
        const message = newALBroadcastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'session-1',
            scope: 'room',
            route: { topicId: 'room.feed', resourceId: `feed-${seq}`, contextId: ROOM.groupId },
            typeId: 'room.feed.v1',
            resource: { seq },
            options: { groupRef: ROOM, reliability: 'at-least-once', ack: 'none', ttlMs: 30_000, ordering: { orderingKey: 'feed', epoch: 1, seq } }
        });
        return { ...message, id: { ...message.id, msgId: `feed-${seq}` } };
    }

    it('is not handled at the server, which relays nothing to the client that sent the track', async () => {
        const fixture = await createServerIngressFixture();
        const peer = new SimulatedWebSocket('ws://peer');
        await peer.open();
        attachTestWebSocket(fixture.server, new ConnectionContext({ id: 'session-2', socket: peer }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true, roomAudience: { recipientPeerIds: ['session-1', 'session-2'], snapshotVersion: 1 } })
        });
        const frame = createUnreceiptedFeedFrame(3);
        expect((await fixture.service.acceptIncomingMessage(frame, 'session-1')).right?.kind).toBe('admitted');
        await settleQueueEngine(fixture.engine);
        const sentBefore = fixture.socket.sent.length;
        const nack = newALNackControlMessage(
            { v: 4, msgId: 'session-2-gap', senderId: 'session-2', ts: Date.now(), traceId: frame.id.traceId },
            toTestALNackPayload({
                msgId: frame.id.msgId,
                fromPeerId: 'session-2',
                toPeerId: 'server',
                originPeerId: 'session-1',
                reason: 'gap',
                orderingKey: toALOrderingTrackKey(frame),
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }],
                observedAtEpochMs: Date.now()
            })
        );

        const accepted = await fixture.service.acceptIncomingMessage(nack, 'session-2');
        await settleQueueEngine(fixture.engine);

        expect(accepted.right).toEqual({ kind: 'control', handled: false });
        expect(
            fixture.socket.sent.slice(sentBefore).map((frameText) => decodePersistedALMessage(frameText).payload.typeId)
                .filter((typeId) => typeId === AL_CONTROL_NACK_TYPE_ID)
        ).toEqual([]);
    });
});
