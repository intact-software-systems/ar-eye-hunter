import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    peekOutboundWorkReadyAt
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound admission observation order', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps the raced normal admission authoritative while recovering its stale same-message enqueue', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'read-race',
            decodePrepared: decodeOutboundTestPayload,
            namespace: 'read-race',
            backend,
            supersedenceTrackTtlMs: 300_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const admission = () =>
            new ALOutboundDispatchAdmission<OutboundTestPayload>({
                admissionStore: store,
                workPort: createTestALOutboundWorkPort({
                    admissionStore: store,
                    workQueue: backend.workQueue,
                    nowMs: Date.now
                }),
                toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
                decodePreparedMessage: decodeOutboundTestPayload,
                clock: { nowMs: Date.now },
                browserLocks: undefined,
                diagnostics: undefined
            });
        const stale = admission();
        const winner = admission();
        const message = createOutboundMessage('same-message-read-race');
        const captured = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const read = backend.read.bind(backend);
        let paused = false;
        vi.spyOn(backend, 'read').mockImplementation(async (key, decode) => {
            const value = await read(key, decode);
            if (key === `read-race:sent:${message.id.msgId}` && !paused) {
                paused = true;
                captured.resolve();
                await resume.promise;
            }
            return value;
        });
        const pending = stale.commit({
            msg: message,
            intent: 'enqueue',
            phase: 'immediate',
            options: {},
            planner: (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'send' }] })
        });
        await captured.promise;
        const won = await winner.commit({
            msg: message,
            intent: 'enqueue',
            phase: 'immediate',
            options: {},
            planner: (msg) => ({ msg, persist: true, preparedMessages: [] })
        });
        const winningSnapshot = await store.readSentMessage(message.id.msgId);
        resume.resolve();
        const rejected = await pending;
        expect(won.committed).toBe(true);
        expect(rejected.committed).toBe(false);
        expect(rejected.computed.status).toBe('pending-admission');
        expect(await store.readSentMessage(message.id.msgId)).toEqual(winningSnapshot);
        expect(winningSnapshot?.outboxKey).toBeDefined();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store, workQueue: backend.workQueue },
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'changed' }] }),
            sendPreparedMessage: async () => {
                sent.push('sent');
                return { status: 'sent' };
            }
        });
        await runtime.ready();
        expect(sent).toEqual([]);
        expect(await peekOutboundWorkReadyAt(backend.workQueue, store.namespace)).toBeUndefined();
        expect(await backend.workQueue.getItem(winningSnapshot!.outboxKey!)).toMatchObject({ status: 'NEW' });
        stale.dispose();
        winner.dispose();
    });
    it('rereads repair state after discovering its sender and capturing that sender version', async () => {
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'repair-race',
            decodePrepared: decodeOutboundTestPayload,
            namespace: 'repair-race',
            backend,
            supersedenceTrackTtlMs: 300_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createOutboundMessage('repair-read-race');
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            admissionStore: store,
            workPort: createTestALOutboundWorkPort({
                admissionStore: store,
                workQueue: backend.workQueue,
                nowMs: Date.now
            }),
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined
        });
        await admission.commit({
            msg: message,
            intent: 'enqueue',
            phase: 'immediate',
            options: {},
            planner: (msg) => ({ msg, persist: true, preparedMessages: [] })
        });
        const captured = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const read = backend.read.bind(backend);
        let paused = false;
        vi.spyOn(backend, 'read').mockImplementation(async (key, decode) => {
            const value = await read(key, decode);
            if (key === `repair-race:sent:${message.id.msgId}` && !paused) {
                paused = true;
                captured.resolve();
                await resume.promise;
            }
            return value;
        });
        const pending = store.readRepairMessage(message.id.msgId, (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'send' }] }));
        await captured.promise;
        expect(
            await store.commitBundle({
                senderId: message.id.senderId,
                expectedVersion: 1,
                mutations: [{ kind: 'delete-sent-message', msgId: message.id.msgId }],
                durableEffects: []
            })
        ).toBe('committed');
        resume.resolve();
        const repair = await pending;
        expect(repair.clientRecord?.version).toBe(2);
        expect(repair.sentSnapshot).toBeUndefined();
        expect(repair.plan).toBeUndefined();
        admission.dispose();
    });
});
