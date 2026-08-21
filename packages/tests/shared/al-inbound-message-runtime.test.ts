import {
    ALInboundMessageRuntime,
    createALInboundAdmissionStore,
    createInMemoryALInboundRuntimeStores,
    InMemoryPersistenceProvider,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALMulticastMessage,
    parseALControlMessage,
    planALMessageHandling,
    QueueBoxUtilities,
    type ALControlAcceptance,
    type ALInboundRuntimeStores,
    type ALMessage,
    type ALMessageHandlingPlan,
    type ResourceEntry
} from '@shared/mod.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ALInboundMessageRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('buffers ordered gaps, emits negative controls, and releases buffered messages in order', async () => {
        const { runtime, dispatchedTexts, controlMessages, forwardedIds } = createInboundHarness();

        const seq2 = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'two'
            },
            {
                seq: 2,
                reliability: 'at-least-once',
                ack: 'none',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const seq1 = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'one'
            },
            {
                seq: 1,
                reliability: 'at-least-once',
                ack: 'none',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(seq2, 'peer-1');

        expect(dispatchedTexts).toEqual([]);
        expect(controlMessages.map((msg) => msg.payload.typeId)).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);

        await runtime.handleIncomingMessage(seq1, 'peer-1');

        expect(dispatchedTexts).toEqual(['one', 'two']);
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });

    // The transport capability is reconciled at admission (not at the
    // forward executor): a disowned message records no forward effect and
    // its subtree ack collapses to an immediate delivered ack — never a
    // deferred ack that waits on a subtree that will not exist.
    it('acks delivered without forwarding when the transport disowns a message', async () => {
        const { runtime, controlMessages, forwardedIds, dispatchedTexts } = createInboundHarness(
            undefined,
            { canForwardMessage: () => false }
        );
        const msg = createOrderedMessage(1, 'kept-local', 'all-logical-recipients');

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(forwardedIds).toEqual([]);
        expect(dispatchedTexts).toEqual(['kept-local']);
        const ackPayloads = controlMessages.flatMap((candidate) => {
            const parsed = parseALControlMessage(candidate);
            return parsed?.type === 'ack' ? [parsed.payload] : [];
        });
        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'delivered'
        });
    });

    it('retries a stale optimistic write and still releases ordered messages once', async () => {
        vi.useFakeTimers();

        const stores = createInMemoryALInboundRuntimeStores();
        const baseAdmission = stores.admissionStore;
        if (!baseAdmission) {
            throw new Error('Expected in-memory admission store');
        }

        let rejectedFirstCommit = false;

        const wrappedStores: ALInboundRuntimeStores = {
            ...stores,
            admissionStore: {
                ready: async () => await baseAdmission.ready(),
                readIncomingMessage: async (msg, fromPeerId, planner) => await baseAdmission.readIncomingMessage(msg, fromPeerId, planner),
                readBufferedRelease: async (trackKey, seq) => await baseAdmission.readBufferedRelease(trackKey, seq),
                planStoredEntry: async (msg, planner) => await baseAdmission.planStoredEntry(msg, planner),
                acceptControlMessage: async (msg) => await baseAdmission.acceptControlMessage(msg),
                commitMutations: async (request) => await baseAdmission.commitMutations(request),
                commitBundle: async (bundle) => {
                    const rejectsGapBuffer = !rejectedFirstCommit &&
                        bundle.senderId === 'peer-1' &&
                        bundle.mutations.some((mutation) => mutation.kind === 'set-buffered');

                    if (rejectsGapBuffer) {
                        rejectedFirstCommit = true;
                        await baseAdmission.commitBundle({
                            senderId: 'peer-1',
                            expectedVersion: bundle.expectedVersion,
                            mutations: [
                                {
                                    kind: 'set-msg-owner',
                                    msgId: 'external-version-bump',
                                    senderId: 'peer-1'
                                }
                            ],
                            durableEffects: []
                        });
                        return 'conflict';
                    }

                    return await baseAdmission.commitBundle(bundle);
                },
                claimReadyEffects: async (workerId, maxCount, leaseMs, nowMs) => await baseAdmission.claimReadyEffects(workerId, maxCount, leaseMs, nowMs),
                completeEffect: async (effectId, workerId) => await baseAdmission.completeEffect(effectId, workerId),
                rescheduleEffect: async (effectId, workerId, retryAtMs, lastError) =>
                    await baseAdmission.rescheduleEffect(effectId, workerId, retryAtMs, lastError),
                peekNextEffectReadyAt: async (nowMs) => await baseAdmission.peekNextEffectReadyAt(nowMs)
            }
        };

        const { runtime, dispatchedTexts, forwardedIds } = createInboundHarness(wrappedStores);
        const seq2 = createOrderedMessage(2, 'two');
        const seq1 = createOrderedMessage(1, 'one');

        const pendingGap = runtime.handleIncomingMessage(seq2, 'peer-1');
        await vi.advanceTimersByTimeAsync(10);
        await pendingGap;
        await runtime.handleIncomingMessage(seq1, 'peer-1');

        expect(rejectedFirstCommit).toBe(true);
        expect(dispatchedTexts).toEqual(['one', 'two']);
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });

    it('retries buffered release when a downstream ack updates the sender version', async () => {
        const stores = createInMemoryALInboundRuntimeStores();
        const baseAdmission = stores.admissionStore;
        if (!baseAdmission) {
            throw new Error('Expected in-memory admission store');
        }

        let releaseFirstCommit!: () => void;
        const releaseCommitBlocked = new Promise<void>((resolve) => {
            releaseFirstCommit = resolve;
        });
        let releaseCommitReached!: () => void;
        const releaseCommitReady = new Promise<void>((resolve) => {
            releaseCommitReached = resolve;
        });
        let didBlock = false;

        const wrappedStores: ALInboundRuntimeStores = {
            ...stores,
            admissionStore: {
                ready: async () => await baseAdmission.ready(),
                readIncomingMessage: async (msg, fromPeerId, planner) => await baseAdmission.readIncomingMessage(msg, fromPeerId, planner),
                readBufferedRelease: async (trackKey, seq) => await baseAdmission.readBufferedRelease(trackKey, seq),
                planStoredEntry: async (msg, planner) => await baseAdmission.planStoredEntry(msg, planner),
                acceptControlMessage: async (msg) => await baseAdmission.acceptControlMessage(msg),
                commitMutations: async (request) => {
                    const blocksOnBufferedRelease = !didBlock &&
                        request.senderId === 'peer-1' &&
                        request.mutations.some((mutation) => mutation.kind === 'delete-buffered');

                    if (blocksOnBufferedRelease) {
                        didBlock = true;
                        releaseCommitReached();
                        await releaseCommitBlocked;
                    }

                    return await baseAdmission.commitMutations(request);
                },
                commitBundle: async (bundle) => {
                    const blocksOnBufferedRelease = !didBlock &&
                        bundle.senderId === 'peer-1' &&
                        bundle.mutations.some((mutation) => mutation.kind === 'delete-buffered');

                    if (blocksOnBufferedRelease) {
                        didBlock = true;
                        releaseCommitReached();
                        await releaseCommitBlocked;
                    }

                    return await baseAdmission.commitBundle(bundle);
                },
                claimReadyEffects: async (workerId, maxCount, leaseMs, nowMs) => await baseAdmission.claimReadyEffects(workerId, maxCount, leaseMs, nowMs),
                completeEffect: async (effectId, workerId) => await baseAdmission.completeEffect(effectId, workerId),
                rescheduleEffect: async (effectId, workerId, retryAtMs, lastError) =>
                    await baseAdmission.rescheduleEffect(effectId, workerId, retryAtMs, lastError),
                peekNextEffectReadyAt: async (nowMs) => await baseAdmission.peekNextEffectReadyAt(nowMs)
            }
        };

        const { runtime, controlMessages, forwardedIds } = createInboundHarness(wrappedStores);
        const seq2 = createOrderedMessage(2, 'two', 'all-logical-recipients');
        const seq1 = createOrderedMessage(1, 'one');

        await runtime.handleIncomingMessage(seq2, 'peer-1');
        expect(forwardedIds).toEqual([seq2.id.msgId]);

        const pendingRelease = runtime.handleIncomingMessage(seq1, 'peer-1');
        await releaseCommitReady;

        await runtime.handleIncomingMessage(
            newALAckControlMessage('peer-2', 'self', seq2.id.msgId, 'delivered'),
            'peer-2'
        );

        releaseFirstCommit();
        await pendingRelease;

        const ackPayloads = controlMessages.flatMap((msg) => {
            const parsed = parseALControlMessage(msg);
            return parsed?.type === 'ack' ? [parsed.payload] : [];
        });

        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: seq2.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
        expect(forwardedIds).toEqual([seq2.id.msgId, seq1.id.msgId]);
    });

    it('waits for downstream acknowledgements before sending the deferred subtree ack upstream', async () => {
        const { runtime, controlMessages, forwardedIds, controlAcceptances } = createInboundHarness();

        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-ack',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(forwardedIds).toEqual([msg.id.msgId]);
        expect(controlMessages).toHaveLength(0);

        await runtime.handleIncomingMessage(
            newALAckControlMessage('peer-2', 'self', msg.id.msgId, 'delivered'),
            'peer-2'
        );

        expect(controlAcceptances).toHaveLength(1);
        expect(controlMessages).toHaveLength(1);

        const parsed = parseALControlMessage(controlMessages[0]);
        expect(parsed?.type).toBe('ack');
        expect(parsed?.payload).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
    });

    it('does not complete deferred subtree ack after the source message expires', async () => {
        vi.useFakeTimers();

        const { runtime, controlMessages, forwardedIds, controlAcceptances } = createInboundHarness();

        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-expiring-pending-ack',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                ttlMs: 10,
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(forwardedIds).toEqual([msg.id.msgId]);
        expect(controlMessages).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(100);
        await runtime.handleIncomingMessage(
            newALAckControlMessage('peer-2', 'self', msg.id.msgId, 'delivered'),
            'peer-2'
        );

        expect(controlAcceptances).toHaveLength(1);
        expect(controlAcceptances[0]?.completedPendingAcks).toEqual([]);
        expect(controlMessages).toHaveLength(0);
    });

    it('retries durable control effects after a transient send failure', async () => {
        vi.useFakeTimers();

        let shouldFailFirstNack = true;
        const sentControls: ALMessage[] = [];
        const { runtime } = createInboundHarness(
            createInMemoryALInboundRuntimeStores(),
            {
                sendControlMessage: async (msg) => {
                    const parsed = parseALControlMessage(msg);
                    if (parsed?.type === 'nack' && shouldFailFirstNack) {
                        shouldFailFirstNack = false;
                        throw new Error('temporary nack failure');
                    }
                    sentControls.push(msg);
                }
            }
        );

        await runtime.handleIncomingMessage(createOrderedMessage(2, 'two'), 'peer-1');

        expect(sentControls.map((msg) => msg.payload.typeId)).toEqual([
            'al.control.repair.v1'
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(sentControls.map((msg) => msg.payload.typeId).sort()).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);
    });

    it('retries durable local dispatch after a transient handler failure', async () => {
        vi.useFakeTimers();

        const delivered: string[] = [];
        let shouldFailFirstDispatch = true;
        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-dispatch',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const { runtime } = createInboundHarness(
            createInMemoryALInboundRuntimeStores(),
            {
                dispatchInboxEntry: async (entry) => {
                    const parsed = JSON.parse(entry.resource) as ALMessage;
                    if (shouldFailFirstDispatch) {
                        shouldFailFirstDispatch = false;
                        throw new Error('temporary dispatch failure');
                    }
                    delivered.push(parsed.id.msgId);
                }
            }
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(delivered).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);

        expect(delivered).toEqual([msg.id.msgId]);
    });

    it('does not retry durable local dispatch after the message expires', async () => {
        vi.useFakeTimers();

        const delivered: string[] = [];
        let shouldFailFirstDispatch = true;
        const msg = newALMulticastMessage(
            'peer-1',
            {
                topicId: 'chat',
                resourceId: 'msg-expiring-dispatch',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'expires'
            },
            {
                ttlMs: 10,
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );
        const { runtime } = createInboundHarness(
            createInMemoryALInboundRuntimeStores(),
            {
                dispatchInboxEntry: async (entry) => {
                    const parsed = JSON.parse(entry.resource) as ALMessage;
                    if (shouldFailFirstDispatch) {
                        shouldFailFirstDispatch = false;
                        throw new Error('temporary dispatch failure');
                    }
                    delivered.push(parsed.id.msgId);
                }
            }
        );

        await runtime.handleIncomingMessage(msg, 'peer-1');

        expect(delivered).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);

        expect(delivered).toEqual([]);
    });

    it('drops buffered ordered messages once normalized qos expiry has elapsed', async () => {
        vi.useFakeTimers();

        const { runtime, dispatchedTexts } = createInboundHarness();
        const seq2 = {
            ...createOrderedMessage(2, 'two'),
            constraints: undefined,
            qos: {
                expiry: {
                    algo: 'expires-at' as const,
                    opts: {
                        expiresAtMs: Date.now() + 10
                    }
                }
            }
        };
        const seq1 = createOrderedMessage(1, 'one');

        await runtime.handleIncomingMessage(seq2, 'peer-1');
        await vi.advanceTimersByTimeAsync(100);
        await runtime.handleIncomingMessage(seq1, 'peer-1');

        expect(dispatchedTexts).toEqual(['one']);
    });

    it('replays persisted durable effects after runtime restart', async () => {
        vi.useFakeTimers();

        const provider = new InMemoryPersistenceProvider<string, unknown>();
        const stores = createPersistentInboundStores(provider);
        const runtime1 = createInboundHarness(
            stores,
            {
                sendControlMessage: async () => {
                    throw new Error('offline');
                }
            }
        ).runtime;

        await runtime1.handleIncomingMessage(createOrderedMessage(2, 'two'), 'peer-1');
        runtime1.dispose();

        const { runtime: runtime2, controlMessages } = createInboundHarness(
            createPersistentInboundStores(provider)
        );
        await runtime2.ready();
        await vi.advanceTimersByTimeAsync(100);

        expect(controlMessages.map((msg) => msg.payload.typeId).sort()).toEqual([
            'al.control.nack.v1',
            'al.control.repair.v1'
        ]);
    });

    it('replays completed pending acks from control-message acceptance after restart', async () => {
        vi.useFakeTimers();

        const provider = new InMemoryPersistenceProvider<string, unknown>();
        const stores = createPersistentInboundStores(provider);
        const forwardedIds: string[] = [];
        const runtime1 = createInboundHarness(
            stores,
            {
                sendControlMessage: async () => {
                    throw new Error('upstream offline');
                },
                forwardMessage: async (msg) => {
                    forwardedIds.push(msg.id.msgId);
                }
            }
        ).runtime;

        const msg = createOrderedMessage(1, 'one', 'all-logical-recipients');
        await runtime1.handleIncomingMessage(msg, 'peer-1');
        expect(forwardedIds).toEqual([msg.id.msgId]);

        await runtime1.handleIncomingMessage(
            newALAckControlMessage('peer-2', 'self', msg.id.msgId, 'delivered'),
            'peer-2'
        );
        runtime1.dispose();

        const { runtime: runtime2, controlMessages } = createInboundHarness(
            createPersistentInboundStores(provider)
        );
        await runtime2.ready();
        await vi.advanceTimersByTimeAsync(100);

        const ackPayloads = controlMessages.flatMap((controlMessage) => {
            const parsed = parseALControlMessage(controlMessage);
            return parsed?.type === 'ack' ? [parsed.payload] : [];
        });

        expect(ackPayloads).toHaveLength(1);
        expect(ackPayloads[0]).toMatchObject({
            ackedMsgId: msg.id.msgId,
            toPeerId: 'peer-1',
            status: 'subtree-complete'
        });
    });
});

function createInboundHarness(
    stores = createInMemoryALInboundRuntimeStores(),
    overrides: Partial<{
        dispatchInboxEntry: (
            entry: ResourceEntry,
            plan?: ALMessageHandlingPlan
        ) => Promise<void>;
        sendControlMessage: (msg: ALMessage) => Promise<void>;
        forwardMessage: (
            msg: ALMessage,
            fromPeerId: string,
            plan: ALMessageHandlingPlan
        ) => Promise<void>;
        canForwardMessage: (msg: ALMessage) => boolean;
    }> = {}
) {
    const inbox = new InMemoryQueueBox(new Map());
    const dispatchedTexts: string[] = [];
    const controlMessages: ALMessage[] = [];
    const forwardedIds: string[] = [];
    const controlAcceptances: ALControlAcceptance[] = [];

    const runtime = new ALInboundMessageRuntime({
        selfPeerId: 'self',
        inbox,
        stores,
        planIncomingMessage: (msg, fromPeerId, runtimeStores) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId,
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                dedupStore: runtimeStores.dedupStore,
                orderingStore: runtimeStores.orderingStore,
                supersedenceStore: runtimeStores.supersedenceStore
            }),
        readStoredEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
        dispatchInboxEntry: overrides.dispatchInboxEntry ?? (async (
            entry: ResourceEntry,
            _plan?: ALMessageHandlingPlan
        ) => {
            const msg = JSON.parse(entry.resource) as ALMessage;
            const payload = JSON.parse(msg.payload.resource) as { text?: string; };
            dispatchedTexts.push(payload.text ?? msg.id.msgId);
        }),
        sendControlMessage: overrides.sendControlMessage ?? (async (msg) => {
            controlMessages.push(msg);
        }),
        onControlMessage: async (_msg, acceptance) => {
            controlAcceptances.push(acceptance);
        },
        forwardMessage: overrides.forwardMessage ?? (async (msg) => {
            forwardedIds.push(msg.id.msgId);
        }),
        canForwardMessage: overrides.canForwardMessage
    });

    return {
        runtime,
        inbox,
        dispatchedTexts,
        controlMessages,
        forwardedIds,
        controlAcceptances
    };
}

function createOrderedMessage(
    seq: number,
    text: string,
    ack: 'none' | 'all-logical-recipients' = 'none'
) {
    return newALMulticastMessage(
        'peer-1',
        {
            topicId: 'chat',
            resourceId: `msg-${seq}`,
            contextId: 'group-1'
        },
        groupRef('group-1'),
        'chat.message.v1',
        {
            text
        },
        {
            seq,
            reliability: 'at-least-once',
            ack,
            qos: {
                durability: {
                    algo: 'volatile'
                }
            }
        }
    );
}

function createPersistentInboundStores(
    provider: InMemoryPersistenceProvider<string, unknown>
) {
    return {
        admissionStore: createALInboundAdmissionStore({
            kind: 'provider',
            namespace: 'al-inbound-runtime-test:provider',
            provider,
            coordinationKey: 'al-inbound-runtime-test:provider',
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000
        })
    };
}

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
