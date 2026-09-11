import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations
} from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundAdmissionStore
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundPendingControlId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import {
    computeALInboundWorkEntry,
    toALInboundWorkKey
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    setNextInboundCommitConflicted
} from './inbound-runtime-test-fixture.ts';

describe('inbound durable effect worker lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries persisted effects after a transient claim failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [
                toMessageOwnerMutation(message, Number.MAX_SAFE_INTEGER),
                toCanonicalMessageMutation(message, Number.MAX_SAFE_INTEGER)
            ],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: 'persisted-dispatch',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'dispatch-local', message: toMessageReference(message) }
            })]
        });
        const reserveEntries = resources.workQueue.reserveEntries.bind(resources.workQueue);
        let shouldFailClaim = true;
        vi.spyOn(resources.workQueue, 'reserveEntries').mockImplementation(async (input) => {
            if (shouldFailClaim) {
                shouldFailClaim = false;
                throw new Error('Admission backend temporarily unavailable');
            }
            return await reserveEntries(input);
        });
        const deliveredMessageIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        try {
            await runtime.ready();

            expect(deliveredMessageIds).toEqual([]);

            await expect.poll(() => deliveredMessageIds).toEqual([message.id.msgId]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('surfaces authoritative storage corruption that cannot be attributed to one queued message', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        vi.spyOn(resources.workQueue, 'readWorkPage').mockRejectedValue(
            new ALAdmissionCorruptionError('queuebox:page', new TypeError('invalid stored queue metadata'))
        );
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
        finally {
            runtime.dispose();
        }
    });

    it('marks corruption discovered during message delivery as NON_RETRYABLE', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'corrupt-delivery', contextId: 'room' },
            'receiver',
            'chat',
            { text: 'hello' }
        );
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [
                toMessageOwnerMutation(message, Number.MAX_SAFE_INTEGER),
                toCanonicalMessageMutation(message, Number.MAX_SAFE_INTEGER)
            ],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: 'corrupt-delivery',
                expireAtTimestamp: Date.now() + 60_000,
                payload: { kind: 'dispatch-local', message: toMessageReference(message) }
            })]
        });
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async () => {
                throw new ALAdmissionCorruptionError(
                    'inbound:effect:corrupt-delivery',
                    new TypeError('invalid durable delivery')
                );
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        try {
            await runtime.ready();
            const stored = await resources.workQueue.getItem(
                toALInboundWorkKey(resources.admissionStore.namespace, 'corrupt-delivery')
            );
            expect(stored).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        }
        finally {
            runtime.dispose();
        }
    });

    // Retry exhaustion is terminal for the work owner whether or not the row still decodes.
    it.each([true, false])('finalizes exhausted work as NON_RETRYABLE when malformed is %s', async (malformed) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const nowMs = Date.now();
        const work = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            observedAtMs: nowMs - 20_000,
            expireAtTimestamp: nowMs + 120_000,
            effectId: 'exhausted-message',
            payload: { kind: 'release-buffered', trackKey: 'stream', seq: 1 }
        });
        await resources.workQueue.enqueue({
            ...work.entry,
            resource: malformed ? '{invalid-json' : work.entry.resource,
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Instant.fromEpochMilliseconds(nowMs - 10_001)
            }
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                delivered.push(entry.key.resourceId);
            },
            sendControlMessage: async (message) => {
                delivered.push(message.id.msgId);
            },
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        expect(await resources.workQueue.getItem(work.entry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 21, nextTs: undefined }
        });
        vi.setSystemTime(nowMs + 60_000);
        for (let cycle = 0; cycle < 6; cycle += 1) {
            await resources.queueEngine.executeOnce();
        }
        expect(await resources.workQueue.getItem(work.entry.key)).toMatchObject({
            status: EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 21, nextTs: undefined }
        });
        expect(delivered).toEqual([]);
    });

    it('rejects work missing its ingress source without blocking a valid sibling', async () => {
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: engine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const missingSource = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'missing-source', contextId: 'room' }, 'receiver', 'chat', {});
        const work = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            effectId: 'missing-source',
            payload: { kind: 'dispatch-local', message: toMessageReference(missingSource) }
        });
        // A surviving queue entry with lost provenance cannot regain authority by retrying.
        await resources.workQueue.enqueueIfAbsent(work.entry);
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                delivered.push(entry.key.resourceId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        const valid = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'valid-source', contextId: 'room' }, 'receiver', 'chat', {});
        await runtime.admitIncomingMessage(valid, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(async () => {
            await engine.executeOnce();
            return resources.workQueue.getItem(work.entry.key);
        }).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual(['valid-source']);
    });

    it.each(['corrupt', 'missing'] as const)('marks work referring to a %s buffered message as NON_RETRYABLE', async (failure) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'buffered', contextId: 'room' }, 'receiver', 'chat', {});
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: 'sender',
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: `${failure}-buffered-release`,
                expireAtTimestamp: Date.now() + 60_000,
                payload: {
                    kind: 'release-buffered',
                    trackKey: 'chat:sender',
                    seq: 1
                }
            })]
        });
        if (failure === 'corrupt') {
            vi.spyOn(resources.admissionStore, 'readBufferedRelease').mockRejectedValue(
                new ALAdmissionCorruptionError(
                    'inbound:buffered:chat:sender:1',
                    new TypeError('invalid buffered message')
                )
            );
        }
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        try {
            await runtime.ready();
            const stored = await resources.workQueue.getItem(
                toALInboundWorkKey(resources.admissionStore.namespace, `${failure}-buffered-release`)
            );
            expect(stored).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        }
        finally {
            runtime.dispose();
        }
    });

    it('completes a replayed buffered release when retained progress proves delivery', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const store = resources.admissionStore;
        const delivered: string[] = [];
        const dependencies = {
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async (entry: ResourceEntry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        };
        const runtime = new ALInboundMessageRuntime(dependencies);
        onTestFinished(() => runtime.dispose());
        const message = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'completed', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 1 }
        };
        const trackKey = toALOrderingTrackKey(message)!;
        await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(async () => (await store.readOrderedDelivery(trackKey, 2)).completedThrough).toBe(1);
        runtime.dispose();
        expect(await store.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() })).toBeUndefined();

        const work = computeALInboundWorkEntry({
            namespace: store.namespace,
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            effectId: 'replayed-release',
            payload: { kind: 'release-buffered', trackKey, seq: 1 }
        });
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(store, message)).observations,
            mutations: [],
            durableEffects: [work]
        });
        const restarted = new ALInboundMessageRuntime({
            ...dependencies,
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox'),
                stores: { admissionStore: store, workQueue: resources.workQueue }
            }),
            diagnostics: undefined
        });
        onTestFinished(() => restarted.dispose());
        await restarted.ready();
        await expect.poll(async () => (await resources.workQueue.getItem(work.entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(delivered).toEqual([message.id.msgId]);
    });

    it('converges after a crash between the progress commit and the claim release', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'crash', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 1 }
        };
        // The delivery commits its progress, then the process dies before the claim is released:
        // redelivery must converge on the retained progress instead of dispatching twice.
        const releaseEntries = resources.workQueue.releaseEntries.bind(resources.workQueue);
        let crashedKey: Key | undefined;
        vi.spyOn(resources.workQueue, 'releaseEntries').mockImplementation(async (entries, disposition) => {
            if (crashedKey === undefined && disposition.status === EntityStatus.COMPLETED) {
                crashedKey = entries[0]!.key;
                return await releaseEntries(entries, { status: EntityStatus.RETRY, delayMs: 1 });
            }
            return await releaseEntries(entries, disposition);
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());

        await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

        await expect.poll(() => crashedKey).toBeDefined();
        await expect.poll(async () => (await resources.workQueue.getItem(crashedKey!))?.status)
            .toBe(EntityStatus.COMPLETED);
        expect(delivered).toEqual([message.id.msgId]);
        expect((await resources.admissionStore.readOrderedDelivery(toALOrderingTrackKey(message)!, 2)).completedThrough)
            .toBe(1);
    });

    it('returns from admission without waiting for the delivery it committed', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const dispatchStarted = Promise.withResolvers<void>();
        const releaseDispatch = Promise.withResolvers<void>();
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async () => {
                dispatchStarted.resolve();
                await releaseDispatch.promise;
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => {
            releaseDispatch.resolve();
            runtime.dispose();
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'unawaited', contextId: 'room' }, 'receiver', 'chat', {});

        const acceptance = await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

        expect(acceptance.right).toEqual({ kind: 'admitted' });
        await dispatchStarted.promise;
        releaseDispatch.resolve();
    });

    it('returns from control admission without waiting for the delivery it committed', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const sendStarted = Promise.withResolvers<void>();
        const releaseSend = Promise.withResolvers<void>();
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {
                sendStarted.resolve();
                await releaseSend.promise;
            },
            diagnostics: undefined
        });
        onTestFinished(() => {
            releaseSend.resolve();
            runtime.dispose();
        });
        await runtime.ready();

        // Retained control work gives the batch a delivery to hold, so the admission below must outlive it.
        const forwarded = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            effectId: 'forwarded-control',
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage({ v: 2, msgId: 'forwarded-ack', ts: 1, senderId: 'receiver' }, {
                    ackedMsgId: 'tracked-message',
                    fromPeerId: 'receiver',
                    toPeerId: 'sender',
                    status: 'accepted',
                    observedAtEpochMs: 1
                })
            }
        });
        await resources.workQueue.enqueueIfAbsent(forwarded.entry);
        const tracked = newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'tracked', contextId: 'room' },
            'receiver',
            'chat',
            {}
        );
        await seedTrackedAcknowledgement(resources.admissionStore, tracked);
        const ack = newALAckControlMessage({ v: 2, msgId: 'inbound-ack', ts: 1, senderId: 'sender' }, {
            ackedMsgId: tracked.id.msgId,
            fromPeerId: 'sender',
            toPeerId: 'receiver',
            status: 'accepted',
            observedAtEpochMs: 1
        });

        const acceptance = await runtime.admitIncomingMessage(ack, { kind: 'ws-client', peerId: 'sender' });

        expect(acceptance.right).toEqual({ kind: 'control', handled: true });
        await sendStarted.promise;
        releaseSend.resolve();
    });

    it('leaves retained control work unclaimed when the acknowledgement it admitted wrote no row', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: new InboxOutboxEngine(),
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const controls: ALMessage[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async () => {},
            sendControlMessage: async (message) => {
                controls.push(message);
            },
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();

        // The same retained row the committing admission above claims, behind the page the bootstrap
        // batch already read. No engine round is ever driven here, so only a commit's own
        // announcement can bring the batch that would claim it.
        const forwarded = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            effectId: 'unannounced-control',
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage({ v: 2, msgId: 'unannounced-ack', ts: 1, senderId: 'receiver' }, {
                    ackedMsgId: 'tracked-message',
                    fromPeerId: 'receiver',
                    toPeerId: 'sender',
                    status: 'accepted',
                    observedAtEpochMs: 1
                })
            }
        });
        await resources.workQueue.enqueueIfAbsent(forwarded.entry);
        const tracked = newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'partially-acknowledged', contextId: 'room' },
            'receiver',
            'chat',
            {}
        );
        // Two peers owe this obligation, so one peer's acknowledgement completes none of it and the
        // commit that admits it moves the acknowledgement history and writes no work row.
        await seedTrackedAcknowledgement(resources.admissionStore, tracked, ['sender', 'second-peer']);
        const ack = newALAckControlMessage({ v: 2, msgId: 'partial-ack', ts: 1, senderId: 'sender' }, {
            ackedMsgId: tracked.id.msgId,
            fromPeerId: 'sender',
            toPeerId: 'receiver',
            status: 'accepted',
            observedAtEpochMs: 1
        });

        const acceptance = await runtime.admitIncomingMessage(ack, { kind: 'ws-client', peerId: 'sender' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(acceptance.right).toEqual({ kind: 'control', handled: true });
        expect(controls).toEqual([]);
        expect((await resources.workQueue.getItem(forwarded.entry.key))?.status).toBe(EntityStatus.NEW);
    });

    it('dispatches a replayed admission in the batch its own commit schedules', async () => {
        const fixture = createInboundTestRuntime({
            stores: createInboundTestStores({
                namespace: 'replayed-dispatch',
                storage: 'memory',
                observer: createPassThroughIndexedDbOperationObserver()
            }),
            effectWorkerId: 'al-inbound:replayed-dispatch'
        });
        await fixture.runtime.ready();
        setNextInboundCommitConflicted(fixture.stores.admissionStore);

        const acceptance = await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'replayed-dispatch' }),
            INBOUND_TEST_SOURCE
        );

        expect(acceptance.right).toEqual({ kind: 'pending-admission' });
        // The replay runs inside a claim of the page that batch already read, so the dispatch it
        // commits is behind that page. The engine is never started and no round is ever executed
        // here: the batch this commit schedules for the end of the replaying one is the only thing
        // that can have claimed the dispatch.
        await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
    });

    it('sends the control a replayed admission commits in the batch its own commit schedules', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: new InboxOutboxEngine(),
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const controls: ALMessage[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async () => {},
            sendControlMessage: async (msg) => {
                controls.push(msg);
            },
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        const tracked = newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'retained-control', contextId: 'room' },
            'receiver',
            'chat',
            {}
        );
        await seedTrackedAcknowledgement(resources.admissionStore, tracked);
        await resources.workQueue.enqueueIfAbsent(
            toRetainedControlAdmission(resources.admissionStore.namespace, tracked)
        );

        await runtime.ready();

        // The replay runs inside a claim of the page that batch already read, so the acknowledgement
        // it commits is behind that page. The engine is never started and no round is ever executed
        // here: the batch this commit schedules for the end of the replaying one is the only thing
        // that can have claimed the send.
        await expect.poll(() => controls.map((control) => control.payload.typeId)).toHaveLength(1);
    });

    it('marks a buffered release without its canonical message NON_RETRYABLE instead of completing the work', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const store = resources.admissionStore;
        const buffered = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'second', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 2 }
        };
        const read = await readAdmission(store, buffered);
        const trackKey = toALOrderingTrackKey(buffered)!;
        const work = computeALInboundWorkEntry({
            namespace: store.namespace,
            observedAtMs: Date.now(),
            effectId: 'release-without-canonical-message',
            expireAtTimestamp: Date.now() + 60_000,
            payload: { kind: 'release-buffered', trackKey, seq: 2 }
        });
        // The ordering slot names a canonical message row that admission never wrote.
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: buffered.id.senderId,
            observations: read.observations,
            mutations: [{
                kind: 'set-buffered',
                snapshot: { trackKey, seq: 2, msg: buffered, plan: read.prePlan },
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: [work]
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).route.resourceId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();

        await expect.poll(async () => (await resources.workQueue.getItem(work.entry.key))?.status)
            .toBe(EntityStatus.NON_RETRYABLE);
        expect(delivered).toEqual([]);
    });

    it('wakes work admitted while a prior reservation is being finalized', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const finalizationStarted = Promise.withResolvers<void>();
        const releaseFinalization = Promise.withResolvers<void>();
        const releaseEntries = resources.workQueue.releaseEntries.bind(resources.workQueue);
        let paused = false;
        vi.spyOn(resources.workQueue, 'releaseEntries').mockImplementation(async (...args) => {
            const result = await releaseEntries(...args);
            if (!paused) {
                paused = true;
                finalizationStarted.resolve();
                await releaseFinalization.promise;
            }
            return result;
        });
        const deliveredMessageIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        const first = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'first', contextId: 'room' }, 'receiver', 'chat', {});
        const second = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'second', contextId: 'room' }, 'receiver', 'chat', {});
        try {
            const firstAdmission = runtime.admitIncomingMessage(first, { kind: 'ws-client', peerId: 'sender' });
            await finalizationStarted.promise;
            const secondAdmission = await runtime.admitIncomingMessage(second, { kind: 'ws-client', peerId: 'sender' });
            expect(secondAdmission.right).toEqual({ kind: 'admitted' });
            releaseFinalization.resolve();
            await firstAdmission;

            await expect.poll(() => deliveredMessageIds).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            releaseFinalization.resolve();
            runtime.dispose();
        }
    });

    it('keeps one page read in flight when admission overlaps work advertisement', async () => {
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: engine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        const resumeRead = Promise.withResolvers<void>();
        onTestFinished(() => {
            resumeRead.resolve();
            runtime.dispose();
        });
        await runtime.ready();
        const readStarted = Promise.withResolvers<void>();
        const admissionWoke = Promise.withResolvers<void>();
        const readPage = resources.workQueue.readWorkPage.bind(resources.workQueue);
        let activeReads = 0;
        let maximumReads = 0;
        let pauseNextRead = true;
        vi.spyOn(resources.workQueue, 'readWorkPage').mockImplementation(async (request) => {
            activeReads += 1;
            maximumReads = Math.max(maximumReads, activeReads);
            try {
                const page = await readPage(request);
                if (pauseNextRead) {
                    pauseNextRead = false;
                    readStarted.resolve();
                    await resumeRead.promise;
                }
                return page;
            }
            finally {
                activeReads -= 1;
            }
        });
        const wake = engine.wake.bind(engine);
        vi.spyOn(engine, 'wake').mockImplementation(() => {
            wake();
            admissionWoke.resolve();
        });
        const advertised = engine.executeOnce();
        await readStarted.promise;
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'overlapping-read', contextId: 'room' }, 'receiver', 'chat', {});
        const admission = runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
        await admissionWoke.promise;
        resumeRead.resolve();
        await Promise.all([advertised, admission]);
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual([message.id.msgId]);
        expect(maximumReads).toBe(1);

        // An external writer does not call this runtime's admission wakeup.
        for (let cycle = 0; cycle < 6; cycle += 1) {
            await engine.executeOnce();
        }
        const external = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'external-work', contextId: 'room' }, 'receiver', 'chat', {});
        const expireAtTimestamp = Math.max(
            Date.now() + 60_000,
            QueueBoxUtilities.toResourceEntryFromMsg(external, 'inbox').audit.expiryTs.epochMilliseconds
        );
        const store = resources.admissionStore;
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: external.id.senderId,
            observations: (await readAdmission(store, external)).observations,
            mutations: [
                toMessageOwnerMutation(external, expireAtTimestamp),
                toCanonicalMessageMutation(external, expireAtTimestamp)
            ],
            durableEffects: [computeALInboundWorkEntry({
                namespace: store.namespace,
                effectId: 'externally-admitted-work',
                observedAtMs: Date.now(),
                expireAtTimestamp,
                payload: { kind: 'dispatch-local', message: toMessageReference(external) }
            })]
        });
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual([message.id.msgId, external.id.msgId]);
        expect(maximumReads).toBe(1);
    });

    it('cancels a pending retry on disposal and never restarts delivery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        let attempts = 0;
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            dispatchInboxEntry: async () => {
                attempts += 1;
                throw new Error('Delivery temporarily unavailable');
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        try {
            await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
            await expect.poll(() => attempts).toBe(1);

            runtime.dispose();
            vi.setSystemTime(Date.now() + 30_000);
            await resources.queueEngine.executeOnce();
            await runtime.ready();
            await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

            expect(attempts).toBe(1);
        }
        finally {
            runtime.dispose();
        }
    });

    it.each(['exhaustion-read', 'work-claim'] as const)('fences disposal during %s and recovers unfinished work after restart', async (stage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const store = resources.admissionStore;
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: stage, contextId: 'room' }, 'receiver', 'chat', {}, { ttlMs: 60_000 });
        const work = computeALInboundWorkEntry({
            namespace: store.namespace,
            effectId: 'paused-delivery',
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            payload: { kind: 'dispatch-local', message: toMessageReference(message) }
        });
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(store, message)).observations,
            mutations: [
                toMessageOwnerMutation(message, Date.now() + 60_000),
                toCanonicalMessageMutation(message, Date.now() + 60_000)
            ],
            durableEffects: [work]
        });
        const operationStarted = Promise.withResolvers<void>();
        const resumeOperation = Promise.withResolvers<void>();
        if (stage === 'exhaustion-read') {
            const reserve = resources.workQueue.reserveRetryExhaustionFinalizations.bind(resources.workQueue);
            vi.spyOn(resources.workQueue, 'reserveRetryExhaustionFinalizations').mockImplementationOnce(async (...args) => {
                const result = await reserve(...args);
                operationStarted.resolve();
                await resumeOperation.promise;
                return result;
            });
        }
        else {
            const reserve = resources.workQueue.reserveEntries.bind(resources.workQueue);
            vi.spyOn(resources.workQueue, 'reserveEntries').mockImplementationOnce(async (request) => {
                const result = await reserve(request);
                operationStarted.resolve();
                await resumeOperation.promise;
                return result;
            });
        }
        const deliveredMessageIds: string[] = [];
        const dependencies = {
            ...resources,
            planIncomingMessage,
            dispatchInboxEntry: async (entry: ResourceEntry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        };
        const runtime = new ALInboundMessageRuntime(dependencies);
        onTestFinished(() => {
            resumeOperation.resolve();
            runtime.dispose();
        });
        const ready = runtime.ready();
        await operationStarted.promise;
        runtime.dispose();
        resumeOperation.resolve();
        await ready;
        await resources.queueEngine.executeOnce();
        expect(deliveredMessageIds).toEqual([]);
        expect(await resources.workQueue.getItem(work.entry.key)).toMatchObject({
            status: stage === 'exhaustion-read' ? EntityStatus.NEW : EntityStatus.RESERVED,
            dequeueAudit: { attempts: stage === 'exhaustion-read' ? 0 : 1 }
        });

        vi.setSystemTime(Date.now() + 10_001);
        const restarted = new ALInboundMessageRuntime({
            ...dependencies,
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox'),
                stores: { admissionStore: store, workQueue: resources.workQueue }
            }),
            diagnostics: undefined
        });
        onTestFinished(() => restarted.dispose());
        await restarted.ready();
        await expect.poll(() => deliveredMessageIds).toEqual([message.id.msgId]);
    });
});

function planIncomingMessage(
    message: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
): ALMessageHandlingPlan {
    return planALMessageHandling(message, {
        ...observations,
        selfPeerId: 'receiver',
        fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
        connectedPeerIds: ['sender'],
        groupMemberPeerIds: ['sender', 'receiver'],
        overlayNeighborPeerIds: []
    });
}

function toMessageReference(message: ALMessage) {
    return { senderId: message.id.senderId, msgId: message.id.msgId };
}

function toMessageOwnerMutation(message: ALMessage, expireAtTimestamp: number): ALInboundAdmissionMutation {
    return {
        kind: 'set-msg-owner',
        value: {
            msgId: message.id.msgId,
            senderId: message.id.senderId,
            source: { kind: 'ws-client', peerId: message.id.senderId },
            supersedenceKey: null
        },
        expireAtTimestamp
    };
}

function toCanonicalMessageMutation(message: ALMessage, expireAtTimestamp: number): ALInboundAdmissionMutation {
    return {
        kind: 'set-inbound-message',
        value: { msgId: message.id.msgId, senderId: message.id.senderId, msg: message, retainUntilMs: expireAtTimestamp },
        expireAtTimestamp
    };
}

/** A retained `admit-control` row for the acknowledgement that completes a tracked message's pending ack. */
function toRetainedControlAdmission(namespace: string, tracked: ALMessage): ResourceEntry {
    const expiresAtMs = Date.now() + 60_000;
    const ack = newALAckControlMessage({ v: 2, msgId: 'retained-control-ack', ts: 1, senderId: 'sender' }, {
        ackedMsgId: tracked.id.msgId,
        fromPeerId: 'sender',
        toPeerId: 'receiver',
        status: 'accepted',
        observedAtEpochMs: 1
    });
    return computeALInboundWorkEntry({
        namespace,
        effectId: toALInboundPendingControlId(ack),
        observedAtMs: Date.now(),
        expireAtTimestamp: expiresAtMs,
        payload: { kind: 'admit-control', msg: ack, expiresAtMs }
    }).entry;
}

/** The provenance an inbound acknowledgement needs: this peer forwarded the message and owes an ack. */
async function seedTrackedAcknowledgement(
    store: ALInboundAdmissionStore,
    message: ALMessage,
    expectedFromPeerIds: readonly string[] = ['sender']
): Promise<void> {
    const expireAtTimestamp = Date.now() + 60_000;
    const source = { kind: 'ws-client' as const, peerId: message.id.senderId };
    const read = await readAdmission(store, message);
    const committed = await store.commitBundle({
        admissionExpiresAtMs: null,
        senderId: message.id.senderId,
        observations: read.observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: { msgId: message.id.msgId, senderId: message.id.senderId, source, supersedenceKey: null },
            expireAtTimestamp
        }, {
            kind: 'set-control-pending',
            msgId: message.id.msgId,
            senderId: message.id.senderId,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: [...expectedFromPeerIds],
                    ackedFromPeerIds: [],
                    expireAtTimestamp
                }
            },
            expireAtTimestamp
        }, {
            kind: 'set-control-owners',
            msgId: message.id.msgId,
            value: { ambiguous: false, values: [{ peerId: 'sender', senderId: message.id.senderId }] },
            expireAtTimestamp
        }],
        durableEffects: []
    });
    expect(committed).toBe('committed');
}

async function readAdmission(store: ALInboundAdmissionStore, message: ALMessage) {
    const source = { kind: 'ws-client' as const, peerId: message.id.senderId };
    const nowMs = Date.now();
    return await store.readIncomingMessage({
        msg: message,
        source,
        nowMs,
        prePlan: planIncomingMessage(message, source, { nowMs })
    });
}
