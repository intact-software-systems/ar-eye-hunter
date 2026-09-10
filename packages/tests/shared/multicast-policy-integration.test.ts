import { Temporal } from '@js-temporal/polyfill';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as shared from '@shared/mod.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import type { QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import {
    captureOutboundWorkRunnable,
    computeOutboundTestAdmission,
    createOutboundMessage,
    peekOutboundWorkReadyAt
} from './alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './alm/outbound-test-payload.ts';
import { settleCommittedOutboundBatch } from './wait-for-al-outbound-work.ts';

interface CapturedRtcConnection extends shared.WebRtcConnectionService {
    readonly sendByPeerId: ReadonlyMap<string, readonly object[]>;
}

describe('multicast QoS integration', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each(['current', 'revoked', 'expired'] as const)(
        'replays a conflicted forwarding admission with captured ingress and %s authority',
        async (authority) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            onTestFinished(() => {
                vi.useRealTimers();
            });
            const connectionService = createConnectionService(['relay', 'peer-2', 'peer-3']);
            const groups = createReadableCache({ 'group-1': createGroupSnapshot(['self', 'origin', 'relay', 'peer-2', 'peer-3']) });
            const overlays = createReadableCache({ 'group-1': createOverlayInfo(['relay', 'peer-2']) });
            const engine = new InboxOutboxEngine();
            const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, queueEngine: engine });
            const store = resources.admissionStore;
            const competitorMessage = createOutboundMessage('forward-competitor');
            const competitor = await computeOutboundTestAdmission(store, { ...competitorMessage, id: { ...competitorMessage.id, senderId: 'origin' } });
            const commit = store.commitBundle.bind(store);
            vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle) => {
                expect(await commit(competitor)).toBe('committed');
                return await commit(bundle);
            });
            const holdClaims = vi.spyOn(resources.workQueue, 'reserveEntries').mockResolvedValue(new Map());
            const dependencies: shared.WebRtcOverlayMulticastManager.Dependencies = {
                connectionService,
                groupCache: groups,
                overlayCache: overlays,
                multicasterFactory: (id) => new shared.WebRtcOverlayMulticastService(id, connectionService),
                qosProvider: undefined,
                outboundDiagnostics: undefined,
                outboundRuntime: resources,
                circuitBreaker: toCircuitBreaker(),
                rateLimiter: toRateLimiter(),
                dequeueResilience: createDefaultALOutboundDequeueResilience()
            };
            const initial = new shared.WebRtcOverlayMulticastManager(dependencies);
            const message = shared.newALMulticastMessage(
                'origin',
                { topicId: 'chat', resourceId: 'pending-forward', contextId: 'group-1' },
                groupRef('group-1'),
                'chat.message',
                { text: 'forwarded' },
                { ttlMs: 1_000, ttlHops: 3 }
            );
            expect(await initial.forwardIfRequired(message, 'relay')).toHaveLength(1);
            expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
            expect(connectionService.sendByPeerId.size).toBe(0);
            initial.dispose();
            holdClaims.mockRestore();
            if (authority === 'revoked') {
                const current = createGroupSnapshot(['self', 'origin', 'relay', 'peer-2', 'peer-3']);
                groups.accept('group-1', {
                    ...current,
                    activeSessions: current.activeSessions.map((session) =>
                        session.sessionId === 'relay' ? { ...session, expiresAtEpochMs: Date.now() } : session
                    )
                });
            }
            if (authority === 'expired') {
                vi.setSystemTime(message.constraints!.expiresAtMs!);
            }
            overlays.accept('group-1', createOverlayInfo(['relay', 'peer-2', 'peer-3']));
            const restarted = new shared.WebRtcOverlayMulticastManager(dependencies);
            onTestFinished(() => restarted.dispose());
            await vi.waitFor(async () => {
                await engine.executeOnce();
                expect(await peekOutboundWorkReadyAt(resources.workQueue, store.namespace)).toBeUndefined();
            });
            expect(connectionService.sendByPeerId.get('peer-2') ?? []).toHaveLength(authority === 'current' ? 1 : 0);
            expect(connectionService.sendByPeerId.get('peer-3') ?? []).toEqual([]);
            expect((await store.readSentMessage(message.id.msgId)) !== undefined).toBe(authority === 'current');
            if (authority === 'current') {
                expect(connectionService.sendByPeerId.get('peer-2')?.[0]).toMatchObject({
                    constraints: { ttlHops: 2 },
                    diagnostics: { visitedPeerIds: ['self'] }
                });
            }
        }
    );
    it.each([false, true])('keeps RTC_OUTBOX room-authority waiting neutral; authority arrives at expiry: %s', async (atExpiry) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const connectionService = createConnectionService(['peer-1']);

        const groups = createReadableCache<GroupSnapshot>({});
        const overlays = createReadableCache<OverlayInfo>({});
        const base = createResourceInboxResilience();
        const resilience = new shared.ResourceInboxResilience({ ...base, retryPolicy: { ...base.retryPolicy, maxAttempts: 1 } });
        const engine = new InboxOutboxEngine();
        const drainOnce = captureOutboundWorkRunnable(engine);
        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService,
            groupCache: groups,
            overlayCache: overlays,
            multicasterFactory: (id) => new shared.WebRtcOverlayMulticastService(id, connectionService),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, queueEngine: engine }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: resilience
        });
        onTestFinished(() => manager.dispose());
        const message = shared.newALMulticastMessage(
            'self',
            { topicId: 'chat', resourceId: 'waiting-authority', contextId: 'group-1' },
            groupRef('group-1'),
            'chat.message.v1',
            {},
            { ttlMs: 30_000 }
        );
        const entry = shared.QueueBoxUtilities.toResourceEntryFromMsg(message, shared.EnqueuedType.RTC_OUTBOX);
        // toResourceEntryFromMsg's createdTs falls back through Temporal.Now (local wall clock)
        // reinterpreted as UTC; a due nextTs sidesteps that gap instead of relying on it for readiness.
        await manager.outbox.enqueue({
            ...entry,
            dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(Date.now()) }
        });
        const failure = vi.spyOn(resilience, 'failure');
        const success = vi.spyOn(resilience, 'success');
        for (let cycle = 0; cycle < 25; cycle += 1) {
            await drainOnce();
            const waiting = await manager.outbox.getItem(entry.key);
            expect(waiting?.dequeueAudit.attempts).toBe(0);
            expect(waiting?.status).toBe(shared.EntityStatus.RETRY);
            expect(waiting?.audit.expiryTs.equals(entry.audit.expiryTs)).toBe(true);
            vi.setSystemTime(waiting!.dequeueAudit.nextTs!.epochMilliseconds + 1);
        }
        expect(failure).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
        expect(connectionService.sendByPeerId.size).toBe(0);
        if (atExpiry) {
            vi.setSystemTime(entry.audit.expiryTs.epochMilliseconds);
        }
        groups.set('group-1', createGroupSnapshot(['self', 'peer-1']));
        overlays.set('group-1', createOverlayInfo(['peer-1']));
        // The first drain admits the row; the send it commits runs on the owner's follow-up batch.
        await drainOnce();
        await drainOnce();
        expect(connectionService.sendByPeerId.get('peer-1') ?? []).toHaveLength(atExpiry ? 0 : 1);
        expect(success).toHaveBeenCalledTimes(atExpiry ? 0 : 1);
        expect(failure).not.toHaveBeenCalled();
    });

    it('uses the shared handling planner to produce forwarding copies', () => {
        const connectionService = createConnectionService([
            'peer-1',
            'peer-2',
            'peer-3'
        ]);
        const service = new shared.WebRtcOverlayMulticastService(
            'group-1',
            connectionService
        );
        const msg = {
            ...shared.newALMulticastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.typing.v1',
                {
                    text: 'typing'
                },
                {
                    ttlHops: 2,
                    qos: {
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1
                            }
                        },
                        durability: {
                            algo: 'volatile'
                        }
                    }
                }
            ),
            diagnostics: {
                visitedPeerIds: ['peer-3']
            }
        };

        const plan = service.createForwardingPlan(
            msg,
            createOverlayContext(['self', 'sender-1', 'peer-1', 'peer-2', 'peer-3'], [
                'peer-1',
                'peer-2',
                'peer-3'
            ]),
            { fromPeerId: 'peer-1', qos: undefined }
        );

        expect(plan.handlingPlan.dropReason).toBeUndefined();
        expect(plan.handlingPlan.forwarding.persist).toBe(false);
        expect(plan.handlingPlan.forwarding.nextHopPeerIds).toEqual(['peer-2']);
        expect(plan.handlingPlan.ack.algo).toBe('none');
        expect(plan.transportMessages).toHaveLength(1);
        expect(plan.transportMessages[0].constraints?.ttlHops).toBe(1);
        expect(plan.transportMessages[0].diagnostics?.visitedPeerIds).toEqual([
            'peer-3',
            'self'
        ]);
        expect(plan.transportMessages[0].forwarding?.nextHopPeerIds).toEqual([
            'peer-2'
        ]);
    });

    it('sends volatile multicast immediately instead of queueing it', async () => {
        const connectionService = createConnectionService(['peer-1']);

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-2',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.typing.v1',
            {
                text: 'typing'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        const result = await enqueueRtcAndDrain(manager, msg);
        const reserved = await manager.outbox.reserveEntries({
            typeIds: new Set([shared.EnqueuedType.RTC_OUTBOX]),
            statusIds: new Set([shared.EntityStatus.NEW]),
            reservationInput: 10
        });

        expect(result.status).toBe('accepted');
        expect(result.entries).toMatchObject([{ status: shared.EntityStatus.COMPLETED }]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('admits durable multicast actions before native submission', async () => {
        const connectionService = createConnectionService(['peer-1']);

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        const result = await enqueueRtcAndDrain(manager, msg);
        const reserved = await manager.outbox.reserveEntries({
            typeIds: new Set([shared.EnqueuedType.RTC_OUTBOX]),
            statusIds: new Set([shared.EntityStatus.NEW]),
            reservationInput: 10
        });

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('dequeues durable multicast through the shared outbound runtime', async () => {
        const connectionService = createConnectionService(['peer-1']);

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({
                'group-1': createGroupSnapshot(['self', 'peer-1'])
            }),
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3b',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'hello again'
            },
            {
                reliability: 'at-least-once',
                ack: 'all-logical-recipients'
            }
        );

        await enqueueRtcAndDrain(manager, msg);
        await settleCommittedOutboundBatch();

        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
    });

    it('repairs multicast ack timeouts by rerouting to an alternate parent', async () => {
        vi.useFakeTimers();

        try {
            const connectionService = createConnectionService(['peer-1', 'peer-2']);

            const manager = new shared.WebRtcOverlayMulticastManager({
                connectionService: connectionService,
                groupCache: createReadableCache({
                    'group-1': createGroupSnapshot(['self', 'peer-1', 'peer-2'])
                }),
                overlayCache: createReadableCache({
                    'group-1': createOverlayInfo(['peer-1', 'peer-2'])
                }),
                multicasterFactory: (overlayId) =>
                    new shared.WebRtcOverlayMulticastService(
                        overlayId,
                        connectionService
                    ),
                qosProvider: undefined,
                outboundDiagnostics: undefined,
                outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
                circuitBreaker: toCircuitBreaker(),
                rateLimiter: toRateLimiter(),
                dequeueResilience: createDefaultALOutboundDequeueResilience()
            });
            onTestFinished(() => manager.dispose());

            const msg = shared.newALMulticastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'msg-3c',
                    contextId: 'group-1'
                },
                groupRef('group-1'),
                'chat.message.v1',
                {
                    text: 'repair via alternate parent'
                },
                {
                    qos: {
                        delivery: {
                            algo: 'at-least-once'
                        },
                        durability: {
                            algo: 'volatile'
                        },
                        ack: {
                            algo: 'hop',
                            opts: {
                                timeoutMs: 100
                            }
                        },
                        retry: {
                            algo: 'exp-backoff',
                            opts: {
                                maxAttempts: 1
                            }
                        },
                        repair: {
                            algo: 'retransmit',
                            opts: {
                                maxRepairs: 1
                            }
                        },
                        fanout: {
                            algo: 'limit',
                            opts: {
                                limit: 1
                            }
                        }
                    }
                }
            );

            await enqueueRtcAndDrain(manager, msg);
            await settleCommittedOutboundBatch();

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toBeUndefined();

            await vi.advanceTimersByTimeAsync(100);
            await vi.waitFor(() => expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(1));

            expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
            expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(1);
            expect(
                connectionService.sendByPeerId.get('peer-2')?.[0]
            ).toMatchObject({ id: { msgId: msg.id.msgId } });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each(['current', 'missing', 'removed'] as const)('requires %s room authority before targeted repair effects', async (authority) => {
        const connectionService = createConnectionService(['peer-1', 'peer-2']);

        const snapshot = createGroupSnapshot(['self', 'peer-1', 'peer-2']);
        const groups = createReadableCache({ 'group-1': snapshot });
        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: groups,
            overlayCache: createReadableCache({
                'group-1': createOverlayInfo(['peer-1', 'peer-2'])
            }),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALMulticastMessage(
            'self',
            {
                topicId: 'chat',
                resourceId: 'msg-3d',
                contextId: 'group-1'
            },
            groupRef('group-1'),
            'chat.message.v1',
            {
                text: 'repair just one peer'
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

        await enqueueRtcAndDrain(manager, msg);
        await settleCommittedOutboundBatch();
        if (authority === 'missing') {
            groups.clearAll();
        }
        else if (authority === 'removed') {
            groups.set('group-1', {
                ...snapshot,
                members: snapshot.members.map((member) =>
                    member.principalId === 'peer-2' && member.status === 'active'
                        ? { ...member, status: 'removed', removed: member.updated }
                        : member
                )
            });
        }
        await manager.acceptControlMessage(
            shared.newALRepairControlMessage(
                { v: 2, msgId: 'repair-control', senderId: 'peer-2', ts: Date.now() },
                { fromPeerId: 'peer-2', toPeerId: 'self', msgId: msg.id.msgId, reason: 'retransmit', observedAtEpochMs: Date.now() }
            )
        );

        if (authority === 'current') {
            await vi.waitFor(() => expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(2));
        }
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-2')).toHaveLength(authority === 'current' ? 2 : 1);
        if (authority === 'current') {
            expect(connectionService.sendByPeerId.get('peer-2')?.[1]).toMatchObject({ id: { msgId: msg.id.msgId } });
        }
        manager.dispose();
    });

    it('sends volatile unicast immediately through the same planning path', async () => {
        const connectionService = createConnectionService(['peer-1']);

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALUnicastMessage(
            'sender-4',
            {
                topicId: 'chat',
                resourceId: 'msg-4',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'private hello'
            }
        );

        const result = await enqueueRtcAndDrain(manager, msg);
        const reserved = await manager.outbox.reserveEntries({
            typeIds: new Set([shared.EnqueuedType.RTC_OUTBOX]),
            statusIds: new Set([shared.EntityStatus.NEW]),
            reservationInput: 10
        });

        expect(result.status).toBe('accepted');
        expect(result.entries).toMatchObject([{ status: shared.EntityStatus.COMPLETED }]);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });

    it('does not call raw RTC send when the next-hop channel is not open', async () => {
        const connectionService = createConnectionService(['peer-1'], {
            'peer-1': 'connecting'
        });

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALUnicastMessage(
            'sender-4b',
            {
                topicId: 'chat',
                resourceId: 'msg-4b',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'warming hello'
            },
            {
                qos: {
                    durability: {
                        algo: 'volatile'
                    }
                }
            }
        );

        await enqueueRtcAndDrain(manager, msg);

        expect(connectionService.sendByPeerId.get('peer-1')).toBeUndefined();
    });

    it('admits durable unicast actions without a second physical queue copy', async () => {
        const connectionService = createConnectionService(['peer-1']);

        const manager = new shared.WebRtcOverlayMulticastManager({
            connectionService: connectionService,
            groupCache: createReadableCache({}),
            overlayCache: createReadableCache({}),
            multicasterFactory: (overlayId) =>
                new shared.WebRtcOverlayMulticastService(
                    overlayId,
                    connectionService
                ),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundRuntime: createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => manager.dispose());

        const msg = shared.newALUnicastMessage(
            'sender-5',
            {
                topicId: 'chat',
                resourceId: 'msg-5',
                contextId: 'conversation-1'
            },
            'peer-1',
            'chat.private-text.v1',
            {
                text: 'durable hello'
            },
            {
                qos: {
                    delivery: {
                        algo: 'at-least-once'
                    },
                    durability: {
                        algo: 'local-outbox'
                    },
                    ack: {
                        algo: 'hop',
                        opts: {
                            timeoutMs: 1_500
                        }
                    },
                    retry: {
                        algo: 'exp-backoff',
                        opts: {
                            maxAttempts: 4
                        }
                    }
                }
            }
        );

        const result = await enqueueRtcAndDrain(manager, msg);
        const reserved = await manager.outbox.reserveEntries({
            typeIds: new Set([shared.EnqueuedType.RTC_OUTBOX]),
            statusIds: new Set([shared.EntityStatus.NEW]),
            reservationInput: 10
        });

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(connectionService.sendByPeerId.get('peer-1')).toHaveLength(1);
        expect(reserved.size).toBe(0);
    });
});

/** Admits a message and waits for the one owner batch the admission committed, the way the worker does. */
async function enqueueRtcAndDrain(
    manager: shared.WebRtcOverlayMulticastManager,
    msg: shared.ALMessage
): Promise<shared.ALOutboundEnqueueResult> {
    const result = await manager.enqueueIfAbsent(msg);
    await settleCommittedOutboundBatch();
    return result;
}

function createConnectionService(connectedPeerIds: readonly string[], readyStates: Readonly<Record<string, RTCDataChannelState>> = {}): CapturedRtcConnection {
    const sendByPeerId = new Map<string, object[]>();
    const peers = new Map(connectedPeerIds.map((peerId) => [peerId, createRtcPeer(peerId, readyStates[peerId] ?? 'open', sendByPeerId)]));
    const connectionService = new shared.WebRtcConnectionService({ send: async () => undefined, connect: async () => undefined }, {
        sessionId: 'self',
        token: 'test-token',
        faultPort: createPassThroughTransportFaultPort(),
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'test',
        rtcSignalingTopicId: 'rtc-signaling'
    });
    vi.spyOn(connectionService, 'readyPeerIdsForLane').mockReturnValue(connectedPeerIds);
    vi.spyOn(connectionService, 'readPeer').mockImplementation((peerId) => peers.get(peerId));
    return Object.assign(connectionService, { sendByPeerId });
}

function createRtcPeer(peerId: string, readyState: RTCDataChannelState, sendByPeerId: Map<string, object[]>): QRtcPeerDto {
    const connection = new shared.QRtcPeerConnection({ send: async () => undefined }, {
        sessionId: 'self',
        peerSessionId: peerId,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        isPolite: false
    });
    const channel = new shared.QRtcDataChannel(connection, {
        faultPort: createPassThroughTransportFaultPort(),
        peerId,
        dataChannelName: 'test'
    });
    const health = channel.readHealth();
    vi.spyOn(channel, 'readHealth').mockReturnValue({ ...health, readyState });
    vi.spyOn(channel, 'sendJson').mockImplementation((message) => {
        if (typeof message !== 'object' || message === null) {
            throw new Error('Expected an RTC message object');
        }
        const sent = sendByPeerId.get(peerId) ?? [];
        sent.push(message);
        sendByPeerId.set(peerId, sent);
        return { status: 'sent', bufferedAmount: 0 };
    });
    return { peerId, connection, channel, channels: new Map([['reliable', channel]]), media: new shared.QRtcMediaChannel(connection, { peerId }) };
}

function createOverlayContext(
    memberSessionIds: readonly string[],
    nextHopSessionIds: readonly string[]
): shared.OverlayMulticasterContext {
    return {
        nowMs: Date.now(),
        overlayId: 'group-1',
        room: createGroupSnapshot(memberSessionIds),
        overlay: createOverlayInfo(nextHopSessionIds)
    };
}

function createGroupSnapshot(memberSessionIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...groupRef('group-1'), sessionIds: memberSessionIds });
    return { ...snapshot, activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 60_000 })) };
}

function createOverlayInfo(nextHopSessionIds: readonly string[]): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 0
        },
        provenance: 'server',
        state: 'active',
        overlayId: 'group-1',
        groupRef: groupRef('group-1'),
        topology: 'star',
        name: 'Group 1',
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        nextHopSessionIds,
        degreeLimit: nextHopSessionIds.length,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}

function groupRef(groupId: string): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId
    };
}

function createReadableCache<T>(valuesByKey: Record<string, T>): LatestRepository<string, T> {
    const cache = new LatestRepository<string, T>();
    for (const [key, value] of Object.entries(valuesByKey)) {
        cache.accept(key, value);
    }
    return cache;
}

function createResourceInboxResilience() {
    return shared.ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new shared.CircuitBreakerPolicy(
            10,
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 }),
            Temporal.Duration.from({ seconds: 10 })
        ),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}
