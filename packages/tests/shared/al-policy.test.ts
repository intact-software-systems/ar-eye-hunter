import { newALBroadcastMessage, newALMulticastMessage, newALUnicastMessage, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { ALQosInputProvider, normalizeALQosPolicy, planALMessageHandling, resolveALQosNormalizationInput } from '@shared/al-contracts/al-policy.ts';
import { InMemoryALDedupStore, InMemoryALOrderingStore, InMemoryALSupersedenceStore } from '@shared/al-contracts/al-runtime.ts';
import { describe, expect, it } from 'vitest';

describe('AL QoS policy', () => {
    it('applies ttlMs to untargeted and unicast builders only when requested', () => {
        const ttlOptions = { ttlMs: 15_000 };

        const untargeted = newALUntargetedMessage(
            'sender-ttl',
            {
                topicId: 'rtt',
                resourceId: '1',
                contextId: 'peer-a:peer-b'
            },
            'rtt.v1',
            { rttMs: 12 },
            ttlOptions
        );
        const unicast = newALUnicastMessage(
            'sender-ttl',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'room-1'
            },
            'peer-b',
            'chat.v1',
            { text: 'hi' },
            ttlOptions
        );
        const noTtl = newALUntargetedMessage(
            'sender-ttl',
            {
                topicId: 'rtt',
                resourceId: '2',
                contextId: 'peer-a:peer-b'
            },
            'rtt.v1',
            { rttMs: 13 }
        );

        expect(untargeted.constraints?.expiresAtMs).toBe(untargeted.id.ts + ttlOptions.ttlMs);
        expect(unicast.constraints?.expiresAtMs).toBe(unicast.id.ts + ttlOptions.ttlMs);
        expect(noTtl.constraints).toBeUndefined();
    });

    it('normalizes requested policy against local caps and authz', () => {
        const msg = newALMulticastMessage(
            'sender-1',
            {
                topicId: 'chat',
                resourceId: 'msg-1',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                membershipEpoch: 7,
                ttlHops: 12,
                reliability: 'at-least-once',
                ack: 'all-logical-recipients',
                fanoutLimit: 9,
                qos: {
                    forwarding: {
                        algo: 'target',
                        opts: {
                            overlayId: 'group-1'
                        }
                    },
                    repair: {
                        algo: 'retransmit',
                        opts: {
                            maxRepairs: 3
                        }
                    },
                    ack: {
                        algo: 'subtree',
                        opts: {
                            timeoutMs: 60_000
                        }
                    },
                    fanout: {
                        algo: 'limit',
                        opts: {
                            limit: 12
                        }
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 12
                        }
                    },
                    durability: {
                        algo: 'local-inbox'
                    }
                }
            }
        );

        const result = normalizeALQosPolicy(
            msg,
            {
                capabilities: {
                    supportedAck: ['none', 'hop'],
                    supportedRepair: ['none'],
                    supportedForwarding: ['target'],
                    supportedDurability: ['volatile', 'local-outbox', 'local-inbox'],
                    maxTtlHops: 4,
                    maxFanout: 3,
                    maxRetryAttempts: 5,
                    maxAckTimeoutMs: 2_500
                },
                authorization: {
                    maxDurability: 'local-inbox'
                },
                live: {
                    hasAlternateRoute: false,
                    connectedNeighborCount: 2
                }
            }
        );

        expect(result.effective.forwarding.algo).toBe('target');
        expect(result.effective.ack.algo).toBe('hop');
        expect(result.effective.repair.algo).toBe('none');
        expect(result.effective.expiry.opts.ttlHops).toBe(4);
        expect(result.effective.fanout.opts.limit).toBe(2);
        expect(result.effective.retry.opts.maxAttempts).toBe(5);
        expect(result.effective.durability.algo).toBe('local-inbox');
        expect(result.unmetRequirements).toEqual([]);
    });

    it('plans multicast delivery, forwarding and deferred subtree ack', () => {
        const msg = {
            ...newALMulticastMessage(
                'sender-2',
                {
                    topicId: 'chat',
                    resourceId: 'msg-2',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.message.v1',
                {
                    text: 'group hello'
                },
                {
                    ttlHops: 2,
                    reliability: 'at-least-once',
                    ack: 'all-logical-recipients',
                    qos: {
                        forwarding: {
                            algo: 'target',
                            opts: {
                                overlayId: 'group-1'
                            }
                        },
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1
                            }
                        },
                        durability: {
                            algo: 'local-inbox'
                        }
                    }
                }
            ),
            diagnostics: {
                visitedPeerIds: ['peer-visited']
            }
        };

        const plan = planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                fromPeerId: 'peer-1',
                connectedPeerIds: ['peer-1', 'peer-2', 'peer-visited'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2', 'peer-visited'],
                overlayNeighborPeerIds: ['peer-1', 'peer-2', 'peer-visited', 'self']
            }
        );

        expect(plan.dropReason).toBeUndefined();
        expect(plan.localDelivery.enabled).toBe(true);
        expect(plan.localDelivery.persist).toBe(true);
        expect(plan.forwarding.enabled).toBe(true);
        expect(plan.forwarding.nextHopPeerIds).toEqual(['peer-2']);
        expect(plan.forwarding.persist).toBe(true);
        expect(plan.ack.enabled).toBe(true);
        expect(plan.ack.algo).toBe('subtree');
        expect(plan.ack.toPeerId).toBe('peer-1');
        expect(plan.ack.deferred).toBe(true);
        expect(plan.repair.enabled).toBe(false);
    });

    it('drops duplicate messages before delivery or forwarding', () => {
        const msg = newALUnicastMessage(
            'sender-3',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'private hello'
            }
        );

        const plan = planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                seenDedupKeys: new Set([msg.id.msgId])
            }
        );

        expect(plan.dropReason).toContain('Duplicate message');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.enabled).toBe(false);
        expect(plan.ack.enabled).toBe(false);
    });

    it('keeps semantic dedup sender-scoped by default', async () => {
        const dedupStore = new InMemoryALDedupStore();
        const first = newALUnicastMessage(
            'sender-semantic-1',
            {
                topicId: 'presence',
                resourceId: 'state',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'first sender'
            },
            {
                qos: {
                    dedup: {
                        algo: 'semantic-key'
                    }
                }
            }
        );
        const second = newALUnicastMessage(
            'sender-semantic-2',
            {
                topicId: 'presence',
                resourceId: 'state',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'second sender'
            },
            {
                qos: {
                    dedup: {
                        algo: 'semantic-key'
                    }
                }
            }
        );

        const firstPlan = planALMessageHandling(
            first,
            {
                selfPeerId: 'self',
                dedupStore
            }
        );
        await dedupStore.mark(
            firstPlan.dedupKey,
            firstPlan.effective.dedup.opts.windowMs
        );

        const secondPlan = planALMessageHandling(
            second,
            {
                selfPeerId: 'self',
                dedupStore
            }
        );

        expect(secondPlan.dropReason).toBeUndefined();
        expect(secondPlan.dedupKey).not.toBe(firstPlan.dedupKey);
    });

    it('keeps default supersedence keys sender-scoped', async () => {
        const supersedenceStore = new InMemoryALSupersedenceStore();
        const first = newALUnicastMessage(
            'sender-supersedence-1',
            {
                topicId: 'presence',
                resourceId: 'state',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'first sender'
            },
            {
                qos: {
                    supersedence: {
                        algo: 'latest-wins'
                    }
                }
            }
        );
        const second = newALUnicastMessage(
            'sender-supersedence-2',
            {
                topicId: 'presence',
                resourceId: 'state',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'second sender'
            },
            {
                qos: {
                    supersedence: {
                        algo: 'latest-wins'
                    }
                }
            }
        );

        const firstPlan = planALMessageHandling(
            first,
            {
                selfPeerId: 'self',
                supersedenceStore
            }
        );
        await supersedenceStore.accept({
            key: firstPlan.supersedence.key,
            msgId: first.id.msgId,
            ts: first.id.ts
        });

        const secondPlan = planALMessageHandling(
            second,
            {
                selfPeerId: 'self',
                supersedenceStore
            }
        );

        expect(secondPlan.dropReason).toBeUndefined();
        expect(secondPlan.supersedence.status).toBe('current');
        expect(secondPlan.supersedence.key).not.toBe(firstPlan.supersedence.key);
    });

    it('defers local delivery when ordering runtime detects a gap', async () => {
        const orderingStore = new InMemoryALOrderingStore();
        const first = newALMulticastMessage(
            'sender-4',
            {
                topicId: 'chat',
                resourceId: 'msg-4',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'first'
            },
            {
                seq: 1,
                reliability: 'at-least-once'
            }
        );

        await orderingStore.accept(first);

        const second = newALMulticastMessage(
            'sender-4',
            {
                topicId: 'chat',
                resourceId: 'msg-5',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'third'
            },
            {
                seq: 3,
                reliability: 'at-least-once'
            }
        );

        const plan = planALMessageHandling(
            second,
            {
                selfPeerId: 'self',
                fromPeerId: 'peer-1',
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                orderingStore
            }
        );

        expect(plan.dropReason).toBeUndefined();
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.localDelivery.deferred).toBe(true);
        expect(plan.nack.enabled).toBe(true);
        expect(plan.nack.missingSeqs).toEqual([2]);
        expect(plan.orderingRuntime.status).toBe('gap');
        expect(plan.forwarding.enabled).toBe(true);
    });

    it('consults the dedup runtime store during planning', async () => {
        const dedupStore = new InMemoryALDedupStore();
        const msg = newALUnicastMessage(
            'sender-5',
            {
                topicId: 'chat',
                resourceId: 'msg-6',
                contextId: 'conversation-1'
            },
            'self',
            'chat.private-text.v1',
            {
                text: 'private hello'
            }
        );

        await dedupStore.mark(msg.id.msgId, 60_000);

        const plan = planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                dedupStore
            }
        );

        expect(plan.dropReason).toContain('Duplicate message');
    });

    it('resolves topic defaults, authz and live state from a qos provider', () => {
        const msg = newALBroadcastMessage(
            'sender-6',
            {
                topicId: 'alerts',
                resourceId: 'alert-1',
                contextId: 'room-1'
            },
            'all',
            'alerts.notice.v1',
            {
                text: 'system maintenance'
            }
        );

        const provider: ALQosInputProvider = {
            defaultsForMessage: () => ({
                congestion: {
                    algo: 'reject',
                    opts: {
                        priority: 1
                    }
                }
            }),
            liveForMessage: () => ({
                overloaded: true
            })
        };

        const normalizationInput = resolveALQosNormalizationInput(
            msg,
            {
                direction: 'inbound',
                selfPeerId: 'self',
                overloaded: true
            },
            provider
        );
        const normalized = normalizeALQosPolicy(msg, normalizationInput);
        const plan = planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                overloaded: true
            },
            normalizationInput
        );

        expect(normalized.effective.congestion.algo).toBe('reject');
        expect(plan.dropReason).toContain('overloaded');
    });

    it('drops superseded messages when a newer message already owns the supersedence key', async () => {
        const supersedenceStore = new InMemoryALSupersedenceStore();
        const newer = newALUnicastMessage(
            'sender-7',
            {
                topicId: 'presence',
                resourceId: 'state-2',
                contextId: 'room-1'
            },
            'self',
            'presence.state.v1',
            {
                text: 'newer'
            },
            {
                qos: {
                    supersedence: {
                        algo: 'latest-wins',
                        opts: {
                            supersedenceKey: 'presence:peer-1'
                        }
                    }
                }
            }
        );
        const older = {
            ...newALUnicastMessage(
                'sender-7',
                {
                    topicId: 'presence',
                    resourceId: 'state-1',
                    contextId: 'room-1'
                },
                'self',
                'presence.state.v1',
                {
                    text: 'older'
                },
                {
                    qos: {
                        supersedence: {
                            algo: 'latest-wins',
                            opts: {
                                supersedenceKey: 'presence:peer-1'
                            }
                        }
                    }
                }
            ),
            id: {
                ...newer.id,
                msgId: crypto.randomUUID(),
                ts: newer.id.ts - 1_000
            },
            audit: {
                ...newer.audit,
                createdTs: (newer.audit?.createdTs ?? newer.id.ts) - 1_000
            }
        };

        await supersedenceStore.accept({
            key: 'presence:peer-1',
            msgId: newer.id.msgId,
            ts: newer.id.ts
        });

        const plan = planALMessageHandling(
            older,
            {
                selfPeerId: 'self',
                supersedenceStore
            }
        );

        expect(plan.dropReason).toContain('superseded');
        expect(plan.supersedence.status).toBe('superseded');
    });

    it('drops low-priority traffic under overload when congestion policy is drop-low', () => {
        const msg = newALUnicastMessage(
            'sender-8',
            {
                topicId: 'chat',
                resourceId: 'typing-1',
                contextId: 'room-1'
            },
            'self',
            'chat.typing.v1',
            {
                text: 'typing'
            }
        );

        const plan = planALMessageHandling(
            msg,
            {
                selfPeerId: 'self',
                fromPeerId: 'sender-8',
                overloaded: true
            }
        );

        expect(plan.dropReason).toContain('drops low-priority');
        expect(plan.congestion.action).toBe('drop-low');
        expect(plan.nack.enabled).toBe(true);
        expect(plan.nack.reason).toBe('overloaded');
    });
});

function groupRef(groupId: string) {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}
