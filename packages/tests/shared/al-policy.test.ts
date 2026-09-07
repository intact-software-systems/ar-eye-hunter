import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    type ALMessagePlanningContext,
    type ALQosInputProvider,
    type ALQosNormalizationInput
} from '@shared/al-contracts/al-policy.ts';

describe('AL QoS policy', () => {
    it('requires resynchronization without delivery, forwarding, ACKs or sequence repair', () => {
        const msg = newALMulticastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'state' }, groupRef('room'), 'chat.v1', {}, {
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        Object.freeze(msg.id);
        Object.freeze(msg.route);
        Object.freeze(msg.payload);
        Object.freeze(msg.delivery);
        Object.freeze(msg.targets);
        Object.freeze(msg);
        const orderingObservation = Object.freeze({ status: 'resync-required' as const, missingSeqs: Object.freeze([]), releasableSeqs: Object.freeze([]) });
        const context = Object.freeze({
            nowMs: msg.id.ts,
            selfPeerId: 'self',
            fromPeerId: 'sender',
            groupMemberPeerIds: Object.freeze(['sender', 'self', 'next']),
            connectedPeerIds: Object.freeze(['sender', 'next']),
            overlayNeighborPeerIds: Object.freeze(['next']),
            orderingObservation
        });
        const plan = planALMessageHandling(msg, context);
        expect(plan.dropReason).toBe('resync-required');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.enabled).toBe(false);
        expect(plan.ack.enabled).toBe(false);
        expect(plan.repair.enabled).toBe(false);
        expect(plan.nack).toEqual({ enabled: true, toPeerId: 'sender', reason: 'resync-required', missingSeqs: [] });
        expect(planALMessageHandling(msg, context)).toEqual(plan);
    });

    it('normalizes frozen policy facts deterministically without changing requests or defaults', () => {
        const message: ALMessage = Object.freeze({
            ...newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'receiver', 'chat.v1', {}),
            qos: Object.freeze({
                ack: Object.freeze({ algo: 'subtree' as const, opts: Object.freeze({ timeoutMs: 90_000 }) }),
                durability: Object.freeze({ algo: 'local-inbox' as const }),
                ownership: Object.freeze({ algo: 'exclusive' as const }),
                fanout: Object.freeze({ algo: 'limit' as const, opts: Object.freeze({ limit: 12 }) })
            })
        });
        const input: ALQosNormalizationInput = Object.freeze({
            defaults: Object.freeze({ congestion: Object.freeze({ algo: 'defer' as const, opts: Object.freeze({ priority: 4 }) }) }),
            capabilities: Object.freeze({ supportedAck: Object.freeze(['none', 'hop'] as const), maxAckTimeoutMs: 500, maxFanout: 5 }),
            authorization: Object.freeze({ maxDurability: 'local-outbox' as const, allowedOwnerships: Object.freeze(['shared'] as const) }),
            live: Object.freeze({ connectedNeighborCount: 2 })
        });
        const before = structuredClone({ message, input });
        const normalized = normalizeALQosPolicy(message, input);
        expect(normalized.effective.ack).toEqual({ algo: 'none', opts: { timeoutMs: 500 } });
        expect(normalized.effective.durability.algo).toBe('local-outbox');
        expect(normalized.effective.ownership.algo).toBe('shared');
        expect(normalized.effective.fanout.opts.limit).toBe(2);
        expect(normalized.effective.congestion).toEqual({ algo: 'defer', opts: { priority: 4 } });
        expect(normalized.unmetRequirements).toEqual([]);
        expect(normalizeALQosPolicy(message, input)).toEqual(normalized);
        expect({ message, input }).toEqual(before);
    });

    it('does not emit a resync NACK without an upstream peer or after expiry', () => {
        const message = newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'self', 'chat.v1', {}, { ttlMs: 1 });
        const context: ALMessagePlanningContext = {
            nowMs: message.id.ts,
            selfPeerId: 'self',
            orderingObservation: { status: 'resync-required', missingSeqs: [], releasableSeqs: [] }
        };
        const originating = planALMessageHandling(message, context);
        expect(originating.dropReason).toBe('resync-required');
        expect(originating.nack.enabled).toBe(false);
        expect(originating.repair.enabled).toBe(false);
        const expired = planALMessageHandling(message, { ...context, fromPeerId: 'sender', nowMs: message.id.ts + 2 });
        expect(expired.nack.reason).toBe('expired');
        expect(expired.nack.missingSeqs).toEqual([]);
        expect(expired.ack.enabled).toBe(false);
    });

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
                nowMs: 0,
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
                nowMs: 0,
                selfPeerId: 'self',
                dedupSeen: true
            }
        );

        expect(plan.dropReason).toContain('Duplicate message');
        expect(plan.localDelivery.enabled).toBe(false);
        expect(plan.forwarding.enabled).toBe(false);
        expect(plan.ack.enabled).toBe(false);
    });

    it('keeps semantic dedup sender-scoped by default', () => {
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
                nowMs: 0,
                selfPeerId: 'self',
                dedupSeen: false
            }
        );

        const secondPlan = planALMessageHandling(
            second,
            {
                nowMs: 0,
                selfPeerId: 'self',
                dedupSeen: false
            }
        );

        expect(secondPlan.dropReason).toBeUndefined();
        expect(secondPlan.dedupKey).not.toBe(firstPlan.dedupKey);
    });

    it('keeps default supersedence keys sender-scoped', () => {
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
                nowMs: 0,
                selfPeerId: 'self',
                supersedenceObservation: { status: 'current' }
            }
        );

        const secondPlan = planALMessageHandling(
            second,
            {
                nowMs: 0,
                selfPeerId: 'self',
                supersedenceObservation: { status: 'current' }
            }
        );

        expect(secondPlan.dropReason).toBeUndefined();
        expect(secondPlan.supersedence.status).toBe('current');
        expect(secondPlan.supersedence.key).not.toBe(firstPlan.supersedence.key);
    });

    it('defers local delivery for an observed small gap while preserving forward progress', () => {
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
                nowMs: 0,
                selfPeerId: 'self',
                fromPeerId: 'peer-1',
                connectedPeerIds: ['peer-1', 'peer-2'],
                groupMemberPeerIds: ['self', 'peer-1', 'peer-2'],
                overlayNeighborPeerIds: ['peer-2'],
                orderingObservation: { status: 'gap', missingSeqs: [2], releasableSeqs: [] }
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
                nowMs: 0,
                selfPeerId: 'self',
                overloaded: true
            },
            normalizationInput
        );

        expect(normalized.effective.congestion.algo).toBe('reject');
        expect(plan.dropReason).toContain('overloaded');
    });

    it('drops superseded messages when a newer message already owns the supersedence key', () => {
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

        const plan = planALMessageHandling(
            older,
            {
                nowMs: 0,
                selfPeerId: 'self',
                supersedenceObservation: { status: 'superseded', latestMsgId: newer.id.msgId }
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
                nowMs: 0,
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
