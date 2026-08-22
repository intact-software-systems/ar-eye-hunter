import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiV1RtcTopologyProofApi } from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-api.mts';
import {
    assertPollDrivenReplayMetricDelta,
    assertSharedPublicationIdentity,
    exactPublicationExpectation,
    readObservedPublicationIds
} from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-evidence.mts';
import {
    assertLivePassiveConsumerState,
    assertPublisherHeadsAdvanced,
    assertPublisherHeadsUnchanged,
    assertReplacementConsumerSeeded,
    assertSinglePublisherHeadAdvanced,
    type ProofDurableState
} from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-postgres.mts';
import {
    adoptProofTopologyObservations,
    ApiV1RtcTopologyProofSocket,
    causallyIncludes,
    decodeTopologyObservation,
    matchesProofTopologyExpectation,
    type ProofTopologyObservation
} from '@shared-test/black-box-runner/topology-replay/api-v1-rtc-topology-proof-websocket.mts';
import { withManagedApiServerSuspended } from '@shared-test/black-box-runner/topology-replay/with-managed-api-server-suspended.mts';

describe('API-v1 RTC topology replay proof semantics', () => {
    afterEach(async () => {
        if (vi.isFakeTimers()) {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
        vi.unstubAllGlobals();
    });

    it('replays topology after restart through one strict path identity', async () => {
        const requests: Array<{ url: string; init: RequestInit | undefined; }> = [];
        vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(url), init });
            return Promise.resolve(new Response('{}'));
        });
        const api = new ApiV1RtcTopologyProofApi({
            alice: { username: 'alice', password: 'secret' },
            bob: { username: 'bob', password: 'secret' },
            admin: { username: 'admin', password: 'admin' }
        });
        const input = {
            proofId: 'rtc-replay-0123456789abcdef01234567',
            applicationId: 'app',
            workspaceId: 'workspace',
            groupId: 'group',
            actor: {
                label: 'N1',
                principal: 'alice' as const,
                clientId: 'alice-client',
                sessionId: 'alice-session',
                accessToken: 'secret-token',
                apiBaseUrl: 'http://127.0.0.1:18080',
                wsBaseUrl: 'ws://127.0.0.1:18080'
            }
        };

        await api.establishBaseline(input);
        await api.establishBaseline(input);

        expect(requests.map((request) => request.url)).toEqual(
            Array(2).fill(
                'http://127.0.0.1:18080/api/state/apps/app/workspaces/workspace/groups/group/' +
                    'topology/reconfigure/requests/rtc-replay-0123456789abcdef01234567-baseline'
            )
        );
        for (const request of requests) {
            expect(request.init?.headers).not.toHaveProperty('Idempotency-Key');
            expect(JSON.parse(String(request.init?.body))).toEqual({ publish: false });
        }
    });

    it('accepts current topology that causally dominates the triggering mutation', () => {
        expect(
            causallyIncludes(
                { groupRevision: 3, presenceRevision: 8 },
                { groupRevision: 3, presenceRevision: 7 }
            )
        ).toBe(true);
        expect(
            causallyIncludes(
                { groupRevision: 3, presenceRevision: 6 },
                { groupRevision: 3, presenceRevision: 7 }
            )
        ).toBe(false);
    });

    it('requires two publishers, passive C cursor pairs, and a new seeded C-prime stream', () => {
        const live = durableState(
            [
                { streamId: 'publisher-a', headSequence: 10 },
                { streamId: 'publisher-b', headSequence: 20 },
                { streamId: 'consumer-c', headSequence: 0 }
            ],
            [cursor('consumer-c', 'publisher-a', 10), cursor('consumer-c', 'publisher-b', 20)]
        );
        expect(assertLivePassiveConsumerState(live)).toEqual({
            passiveConsumerStreamId: 'consumer-c',
            publisherHeads: { 'publisher-a': 10, 'publisher-b': 20 }
        });
        expect(() => assertLivePassiveConsumerState({ ...live, unresolvedAppOutboxCount: 1 })).toThrow(
            'unresolved APP_OUTBOX'
        );

        const afterLiveA = durableState(
            [
                { streamId: 'publisher-a', headSequence: 11 },
                { streamId: 'publisher-b', headSequence: 20 },
                { streamId: 'consumer-c', headSequence: 0 }
            ],
            [cursor('consumer-c', 'publisher-a', 11), cursor('consumer-c', 'publisher-b', 20)]
        );
        const liveA = assertSinglePublisherHeadAdvanced({
            state: afterLiveA,
            consumerStreamId: 'consumer-c',
            priorHeads: { 'publisher-a': 10, 'publisher-b': 20 }
        });
        expect(liveA).toEqual({
            advancedPublisherStreamId: 'publisher-a',
            publisherHeads: { 'publisher-a': 11, 'publisher-b': 20 }
        });

        const afterLiveB = durableState(
            [
                { streamId: 'publisher-a', headSequence: 11 },
                { streamId: 'publisher-b', headSequence: 21 },
                { streamId: 'consumer-c', headSequence: 0 }
            ],
            [cursor('consumer-c', 'publisher-a', 11), cursor('consumer-c', 'publisher-b', 21)]
        );
        const liveB = assertSinglePublisherHeadAdvanced({
            state: afterLiveB,
            consumerStreamId: 'consumer-c',
            priorHeads: liveA.publisherHeads
        });
        expect(liveB).toEqual({
            advancedPublisherStreamId: 'publisher-b',
            publisherHeads: { 'publisher-a': 11, 'publisher-b': 21 }
        });

        const beforeRestart = durableState(
            [
                { streamId: 'publisher-a', headSequence: 11 },
                { streamId: 'publisher-b', headSequence: 21 },
                { streamId: 'consumer-c', headSequence: 0 }
            ],
            []
        );
        const heads = assertPublisherHeadsAdvanced(beforeRestart, {
            'publisher-a': 10,
            'publisher-b': 20
        });
        const afterRestart = durableState(
            [...beforeRestart.streams, { streamId: 'consumer-c-prime', headSequence: 0 }],
            [
                cursor('consumer-c-prime', 'publisher-a', 11),
                cursor('consumer-c-prime', 'publisher-b', 21)
            ]
        );
        expect(
            assertReplacementConsumerSeeded({
                state: afterRestart,
                priorStreamIds: new Set(live.streams.map((stream) => stream.streamId)),
                publisherHeads: heads
            })
        ).toBe('consumer-c-prime');
    });

    it('rejects a live checkpoint unless exactly one publisher appends one entry', () => {
        const state = durableState(
            [
                { streamId: 'publisher-a', headSequence: 11 },
                { streamId: 'publisher-b', headSequence: 21 },
                { streamId: 'consumer-c', headSequence: 0 }
            ],
            [cursor('consumer-c', 'publisher-a', 11), cursor('consumer-c', 'publisher-b', 21)]
        );

        expect(() =>
            assertSinglePublisherHeadAdvanced({
                state,
                consumerStreamId: 'consumer-c',
                priorHeads: { 'publisher-a': 10, 'publisher-b': 20 }
            })
        ).toThrow('exactly one publisher');
    });

    it('rejects any duplicate topology publication after replay', () => {
        const priorHeads = { 'publisher-a': 11, 'publisher-b': 21 };
        expect(assertPublisherHeadsUnchanged(
            durableState(
                [
                    { streamId: 'publisher-a', headSequence: 11 },
                    { streamId: 'publisher-b', headSequence: 21 }
                ],
                []
            ),
            priorHeads
        )).toEqual(priorHeads);
        expect(() =>
            assertPublisherHeadsUnchanged(
                durableState(
                    [
                        { streamId: 'publisher-a', headSequence: 12 },
                        { streamId: 'publisher-b', headSequence: 21 }
                    ],
                    []
                ),
                priorHeads
            )
        ).toThrow('changed during topology mutation replay');
    });

    it('retains delivery identity and matches exact publication or hydration observations', () => {
        const publication = decodeTopologyObservation(
            topologyMessage(
                JSON.stringify(['rtc-topology-publication', 'work-live-a']),
                { groupRevision: 7, presenceRevision: 9 },
                12
            )
        )!;
        const hydration = decodeTopologyObservation(
            topologyMessage(
                JSON.stringify(['rtc-topology-hydration', 'session-1', 'generation-1', 7, 9, 12]),
                { groupRevision: 7, presenceRevision: 9 },
                12
            )
        )!;

        expect(publication).toMatchObject({
            deliveryKind: 'publication',
            messageId: JSON.stringify(['rtc-topology-publication', 'work-live-a'])
        });
        expect(hydration).toMatchObject({ deliveryKind: 'hydration' });
        expect(
            matchesProofTopologyExpectation(publication, {
                causalRevision: { groupRevision: 7, presenceRevision: 9 },
                causalMatch: 'exact',
                version: 12,
                deliveryKind: 'publication',
                messageId: JSON.stringify(['rtc-topology-publication', 'work-live-a'])
            })
        ).toBe(true);
        expect(
            matchesProofTopologyExpectation(publication, {
                causalRevision: { groupRevision: 7, presenceRevision: 9 },
                causalMatch: 'exact',
                deliveryKind: 'hydration'
            })
        ).toBe(false);
    });

    it('models browser adoption by dropping stale duplicates while preserving advances', () => {
        const first = topologyObservation({ groupRevision: 7, presenceRevision: 9 }, 12);
        const stale = topologyObservation({ groupRevision: 7, presenceRevision: 8 }, 11);
        const advanced = topologyObservation({ groupRevision: 8, presenceRevision: 10 }, 13);

        expect(adoptProofTopologyObservations([first, stale, advanced])).toEqual([first, advanced]);
        expect(() =>
            adoptProofTopologyObservations([
                first,
                topologyObservation({ groupRevision: 8, presenceRevision: 8 }, 13)
            ])
        ).toThrow('incomparable');
    });

    it('binds each live mutation to its exact publication revision and replay delta', () => {
        // Correlation is the causal revision the mutation produced, never a
        // precomputed work identity: legacy per-command work and damped coalesced
        // work derive message ids differently, and the proof must hold for both.
        expect(exactPublicationExpectation({ groupRevision: 7, presenceRevision: 9 })).toEqual({
            causalRevision: { groupRevision: 7, presenceRevision: 10 },
            causalMatch: 'exact',
            deliveryKind: 'publication'
        });

        const before = replayMetrics(7, 0, 0, 10);
        const after = replayMetrics(9, 0, 0, 12);
        expect(assertPollDrivenReplayMetricDelta(before, after)).toEqual({
            pollWakes: 2,
            notificationWakes: 0,
            localCommitWakes: 0,
            replayedEntryCount: 2
        });
        expect(() => assertPollDrivenReplayMetricDelta(before, replayMetrics(9, 0, 0, 13))).toThrow(
            'exactly two'
        );
    });

    it('records one shared publication identity across both passive sockets', () => {
        const shared = JSON.stringify(['rtc-topology-publication', 'observed-work-id']);
        const observations = [
            { ...topologyObservation({ groupRevision: 7, presenceRevision: 10 }, 12), messageId: shared },
            { ...topologyObservation({ groupRevision: 7, presenceRevision: 10 }, 12), messageId: shared }
        ];

        expect(assertSharedPublicationIdentity(observations)).toBe(shared);
        expect(readObservedPublicationIds(observations)).toEqual([shared]);
        expect(() =>
            assertSharedPublicationIdentity([
                observations[0]!,
                { ...observations[1]!, messageId: JSON.stringify(['rtc-topology-publication', 'other']) }
            ])
        ).toThrow('distinct publication ids');
    });

    it('fails a WebSocket readiness assertion at the fixed ten-second boundary', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', NeverOpeningWebSocket);
        let failure: Error | undefined;
        void ApiV1RtcTopologyProofSocket.open(
            {
                label: 'N5',
                principal: 'alice',
                clientId: 'alice-client',
                sessionId: 'alice-session',
                accessToken: 'token',
                apiBaseUrl: 'http://127.0.0.1:18082',
                wsBaseUrl: 'ws://127.0.0.1:18082'
            },
            'ticket'
        ).catch((error: unknown) => {
            failure = error instanceof Error ? error : new Error(String(error));
        });

        await vi.advanceTimersByTimeAsync(9_999);
        expect(failure).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);

        expect(failure?.message).toContain('10000ms');
    });

    it('always resumes the non-target proof process after scheduled claim work', async () => {
        const events: string[] = [];
        const controls = {
            stop: async () => undefined,
            restart: async () => undefined,
            suspend: async (port: number) => {
                events.push(`suspend:${port}`);
            },
            resume: async (port: number) => {
                events.push(`resume:${port}`);
            }
        };

        await expect(
            withManagedApiServerSuspended(controls, 18081, async () => {
                events.push('run:success');
                return 'completed';
            })
        ).resolves.toBe('completed');
        const failure = new Error('scheduled claim failed');
        await expect(
            withManagedApiServerSuspended(controls, 18080, async () => {
                events.push('run:failure');
                throw failure;
            })
        ).rejects.toBe(failure);

        expect(events).toEqual([
            'suspend:18081',
            'run:success',
            'resume:18081',
            'suspend:18080',
            'run:failure',
            'resume:18080'
        ]);
    });
});

class NeverOpeningWebSocket extends EventTarget {
    readyState = 0;

    close(): void {
        this.readyState = 3;
    }
}

function replayMetrics(
    poll: number,
    notification: number,
    localCommit: number,
    replayedEntryCount: number
) {
    return {
        wakeCountBySource: { poll, notification, 'local-commit': localCommit },
        replayedEntryCount
    };
}

function topologyMessage(
    messageId: string,
    causalRevision: Readonly<{ groupRevision: number; presenceRevision: number; }>,
    version: number
): string {
    return JSON.stringify({
        id: { msgId: messageId },
        route: { topicId: 'overlay.topology' },
        payload: {
            typeId: 'overlay.topology',
            resource: JSON.stringify({
                sourceGroupStateCausalRevision: causalRevision,
                version,
                activeSessionIds: ['session-1'],
                nextHopsBySessionId: { 'session-1': [] }
            })
        }
    });
}

function topologyObservation(
    causalRevision: Readonly<{ groupRevision: number; presenceRevision: number; }>,
    version: number
): ProofTopologyObservation {
    return {
        causalRevision,
        version,
        semanticJson: JSON.stringify({ causalRevision, version }),
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        messageId: JSON.stringify(['rtc-topology-publication', `${causalRevision.groupRevision}`]),
        deliveryKind: 'publication'
    };
}

function durableState(
    streams: ProofDurableState['streams'],
    cursors: ProofDurableState['cursors']
): ProofDurableState {
    return { streams, cursors, unresolvedAppOutboxCount: 0 };
}

function cursor(
    consumerStreamId: string,
    publisherStreamId: string,
    lastProcessedSequence: number
): ProofDurableState['cursors'][number] {
    return { consumerStreamId, publisherStreamId, lastProcessedSequence };
}
