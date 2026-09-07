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
    readRtcTopologyProofDurableState,
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

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { computeStateSnapshotPages } from '@shared/api/state-snapshot-page.ts';
import { type CompletedStateSnapshot } from '@shared/api/state-snapshot-page.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';

interface ProofRequest {
    readonly url: string;
    readonly init: RequestInit | undefined;
}

const proofGroup = { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' };
const proofSession = {
    label: 'N5',
    principal: 'alice' as const,
    clientId: 'alice-client',
    sessionId: 'session-1',
    accessToken: 'token',
    apiBaseUrl: 'http://localhost',
    wsBaseUrl: 'ws://localhost'
};

interface ProofDatabaseTestRow {
    readonly [key: string]: string | number | undefined;
}
interface ProofDatabaseTestQuery {
    (strings: TemplateStringsArray): Promise<readonly ProofDatabaseTestRow[]>;
}
interface ProofDatabaseTestPort {
    begin(options: string, read: (query: ProofDatabaseTestQuery) => Promise<ProofDurableState>): Promise<ProofDurableState>;
    end(): Promise<void>;
}
const databaseFactory = vi.hoisted(() => vi.fn<() => ProofDatabaseTestPort>());
vi.mock('postgres', () => ({ default: databaseFactory }));

describe('API-v1 RTC topology replay proof semantics', () => {
    afterEach(async () => {
        if (vi.isFakeTimers()) {
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
        }
        vi.unstubAllGlobals();
    });

    it('replays topology after restart through one strict path identity', async () => {
        const requests: ProofRequest[] = [];
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

    it('requires AppInbox quiescence before accepting a live publisher advance', () => {
        const state: ProofDurableState = {
            ...durableState(
                [
                    { streamId: 'publisher-a', headSequence: 11 },
                    { streamId: 'publisher-b', headSequence: 20 },
                    { streamId: 'consumer-c', headSequence: 0 }
                ],
                [cursor('consumer-c', 'publisher-a', 11), cursor('consumer-c', 'publisher-b', 20)]
            ),
            unresolvedAppInboxCount: 1
        };

        expect(() =>
            assertSinglePublisherHeadAdvanced({
                state,
                consumerStreamId: 'consumer-c',
                priorHeads: { 'publisher-a': 10, 'publisher-b': 20 }
            })
        ).toThrow('unresolved APP_INBOX');
    });

    it('reads AppInbox quiescence and publisher state from one repeatable-read snapshot', async () => {
        const transactionQueryTexts: string[] = [];
        const transaction = vi.fn((strings: TemplateStringsArray) => {
            const query = strings.join('');
            transactionQueryTexts.push(query);
            if (query.includes('ri_type_id = \'APP_OUTBOX\'')) {
                return Promise.resolve([{ unresolved_count: 0 }]);
            }
            if (query.includes('ri_type_id = \'APP_INBOX\'')) {
                return Promise.resolve([{ unresolved_count: 1 }]);
            }
            if (query.includes('from rtc_topology_delivery_stream')) {
                return Promise.resolve([
                    { stream_id: 'publisher-a', head_sequence: 11 },
                    { stream_id: 'publisher-b', head_sequence: 20 },
                    { stream_id: 'consumer-c', head_sequence: 0 }
                ]);
            }
            return Promise.resolve([
                {
                    consumer_stream_id: 'consumer-c',
                    publisher_stream_id: 'publisher-a',
                    last_processed_sequence: 11
                },
                {
                    consumer_stream_id: 'consumer-c',
                    publisher_stream_id: 'publisher-b',
                    last_processed_sequence: 20
                }
            ]);
        });
        const begin = vi.fn(async (
            _options: string,
            readSnapshot: (sql: ProofDatabaseTestQuery) => Promise<ProofDurableState>
        ) => await readSnapshot(transaction));
        const end = vi.fn(async () => undefined);
        const sql = Object.assign(
            vi.fn(() => {
                throw new Error('Proof durable reads must run inside the repeatable-read transaction.');
            }),
            { begin, end }
        );
        databaseFactory.mockReturnValue(sql);

        await expect(readRtcTopologyProofDurableState('postgres://proof')).resolves.toMatchObject({
            unresolvedAppOutboxCount: 0,
            unresolvedAppInboxCount: 1
        });
        expect(begin).toHaveBeenCalledWith('isolation level repeatable read read only', expect.any(Function));
        expect(transactionQueryTexts).toHaveLength(4);
        expect(transactionQueryTexts).toEqual(expect.arrayContaining([
            expect.stringContaining('ri_type_id = \'APP_INBOX\''),
            expect.stringContaining('ri_type_id = \'APP_OUTBOX\''),
            expect.stringContaining('from rtc_topology_delivery_stream'),
            expect.stringContaining('from rtc_topology_replay_cursor')
        ]));
        expect(end).toHaveBeenCalledWith({ timeout: 5 });
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

    it('observes a large trusted topology only after every page arrives and retains original publication identity', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const opening = ApiV1RtcTopologyProofSocket.open(proofSession, 'ticket', proofGroup);
        const native = TestWebSocket.instances.at(-1)!;
        native.open();
        const socket = await opening;
        try {
            const pages = topologyPages({
                messageId: JSON.stringify(['rtc-topology-publication', 'large']),
                revision: { groupRevision: 7, presenceRevision: 9 },
                version: 12,
                sessionCount: 1500
            });
            expect(pages.length).toBeGreaterThan(1);
            for (const page of pages.slice(1).reverse()) {
                native.receive(JSON.stringify(page));
            }
            expect(socket.readDiagnostics().topologyTuples).toEqual([]);
            native.receive(JSON.stringify(pages[0]));
            const observed = await socket.waitForTopology({ causalRevision: { groupRevision: 7, presenceRevision: 9 }, causalMatch: 'exact' });
            expect(observed.messageId).toBe(JSON.stringify(['rtc-topology-publication', 'large']));
            expect(observed.activeSessionIds).toHaveLength(1500);
            native.receive(JSON.stringify(pages[0]));
            expect(socket.readDiagnostics().topologyTuples).toHaveLength(1);
        }
        finally {
            socket.close();
        }
    });

    it('rejects a trusted page from another proof room before recording authority', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const opening = ApiV1RtcTopologyProofSocket.open(proofSession, 'ticket', { ...proofGroup, workspaceId: 'another' });
        const native = TestWebSocket.instances.at(-1)!;
        native.open();
        const socket = await opening;
        try {
            for (
                const page of topologyPages({
                    messageId: JSON.stringify(['rtc-topology-publication', 'wrong-scope']),
                    revision: { groupRevision: 7, presenceRevision: 9 },
                    version: 12,
                    sessionCount: 1
                })
            ) {
                native.receive(JSON.stringify(page));
            }
            await expect(socket.waitForTopology({ causalRevision: { groupRevision: 7, presenceRevision: 9 }, causalMatch: 'exact' })).rejects.toThrow(
                'another scope'
            );
            expect(socket.readDiagnostics().topologyTuples).toEqual([]);
        }
        finally {
            socket.close();
        }
    });

    it('keeps incomplete transfer fragments isolated across proof socket lifetimes', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const pages = topologyPages({
            messageId: JSON.stringify(['rtc-topology-hydration', 'session-1', 'generation']),
            revision: { groupRevision: 7, presenceRevision: 9 },
            version: 12,
            sessionCount: 1500
        });
        const firstOpening = ApiV1RtcTopologyProofSocket.open(proofSession, 'ticket', proofGroup);
        const firstNative = TestWebSocket.instances.at(-1)!;
        firstNative.open();
        const first = await firstOpening;
        firstNative.receive(JSON.stringify(pages[0]));
        first.close();
        const nextOpening = ApiV1RtcTopologyProofSocket.open(proofSession, 'ticket', proofGroup);
        const nextNative = TestWebSocket.instances.at(-1)!;
        nextNative.open();
        const next = await nextOpening;
        try {
            for (const page of pages.slice(1)) {
                nextNative.receive(JSON.stringify(page));
            }
            expect(next.readDiagnostics().topologyTuples).toEqual([]);
            nextNative.receive(JSON.stringify(pages[0]));
            expect((await next.waitForTopology({ causalRevision: { groupRevision: 7, presenceRevision: 9 }, causalMatch: 'exact' })).deliveryKind).toBe(
                'hydration'
            );
        }
        finally {
            next.close();
        }
    });

    it('retains delivery identity and matches exact publication or hydration observations', () => {
        const publication = decodeTopologyObservation(
            topologyMessage(
                JSON.stringify(['rtc-topology-publication', 'work-live-a']),
                { groupRevision: 7, presenceRevision: 9 },
                12
            ),
            proofGroup
        )!;
        const hydration = decodeTopologyObservation(
            topologyMessage(
                JSON.stringify(['rtc-topology-hydration', 'session-1', 'generation-1', 7, 9, 12]),
                { groupRevision: 7, presenceRevision: 9 },
                12
            ),
            proofGroup
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

        const before = replayMetrics({
            poll: 7,
            notification: 0,
            localCommit: 0,
            replayedEntryCount: 10
        });
        const after = replayMetrics({
            poll: 9,
            notification: 0,
            localCommit: 0,
            replayedEntryCount: 12
        });
        expect(assertPollDrivenReplayMetricDelta(before, after)).toEqual({
            pollWakes: 2,
            notificationWakes: 0,
            localCommitWakes: 0,
            replayedEntryCount: 2
        });
        expect(() =>
            assertPollDrivenReplayMetricDelta(
                before,
                replayMetrics({
                    poll: 9,
                    notification: 0,
                    localCommit: 0,
                    replayedEntryCount: 13
                })
            )
        ).toThrow('exactly two');
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
            'ticket',
            proofGroup
        ).catch((error) => {
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

interface ReplayMetricsInput {
    readonly poll: number;
    readonly notification: number;
    readonly localCommit: number;
    readonly replayedEntryCount: number;
}

function replayMetrics(input: ReplayMetricsInput) {
    return {
        wakeCountBySource: {
            poll: input.poll,
            notification: input.notification,
            'local-commit': input.localCommit
        },
        replayedEntryCount: input.replayedEntryCount
    };
}

function topologyMessage(messageId: string, causalRevision: GroupStateCausalRevision, version: number): CompletedStateSnapshot {
    const assembly = new StateSnapshotAssembly();
    try {
        const pages = topologyPages({ messageId, revision: causalRevision, version, sessionCount: 1 });
        const result = assembly.accept({ message: pages[0], scope: proofGroup, nowMs: Date.now() });
        if (result.right?.kind !== 'complete') {
            throw new Error(result.left?.message ?? 'Expected complete topology');
        }
        return result.right.snapshot;
    }
    finally {
        assembly.dispose();
    }
}

function topologyObservation(
    causalRevision: GroupStateCausalRevision,
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
    return {
        streams,
        cursors,
        unresolvedAppInboxCount: 0,
        unresolvedAppOutboxCount: 0
    };
}

function cursor(
    consumerStreamId: string,
    publisherStreamId: string,
    lastProcessedSequence: number
): ProofDurableState['cursors'][number] {
    return { consumerStreamId, publisherStreamId, lastProcessedSequence };
}

interface TopologyPagesInput {
    readonly messageId: string;
    readonly revision: GroupStateCausalRevision;
    readonly version: number;
    readonly sessionCount: number;
}
function topologyPages(input: TopologyPagesInput): readonly ALMessage[] {
    const nowMs = Date.now();
    const activeSessionIds = Array.from({ length: input.sessionCount }, (_, index) => `session-${index + 1}`).sort();
    const snapshot: RallarOverlayTopologySnapshot = {
        groupRef: proofGroup,
        overlayId: toScopedOverlayId(proofGroup),
        sourceGroupStateCausalRevision: input.revision,
        version: input.version,
        state: 'active',
        name: 'Proof',
        topology: 'tree',
        degreeLimit: 2,
        createdByClientId: 'alice-client',
        createdAtEpochMs: nowMs,
        updatedAtEpochMs: nowMs,
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            activeSessionIds.map((
                id,
                index
            ) => [id, activeSessionIds.slice(Math.max(0, index - 1), index).concat(activeSessionIds.slice(index + 1, index + 2))])
        )
    };
    return computeStateSnapshotPages({
        scope: { applicationId: proofGroup.applicationId, workspaceId: proofGroup.workspaceId, kind: 'group', resourceId: proofGroup.groupId },
        revision: JSON.stringify([input.revision.groupRevision, input.revision.presenceRevision, input.version]),
        resource: JSON.stringify(snapshot),
        envelope: {
            id: { v: 2, msgId: input.messageId, ts: nowMs, senderId: 'api-node-17' },
            route: { topicId: 'overlay.topology', resourceId: 'topology', contextId: proofGroup.groupId },
            targets: { mode: 'unicast', toPeerId: 'session-1' },
            constraints: { expiresAtMs: nowMs + 60000 },
            delivery: { reliability: 'best-effort', ack: 'none' },
            audit: { createdBy: 'api-node-17', createdTs: nowMs }
        }
    }).fold((issue) => {
        throw new Error(issue.message);
    }, (pages) => pages);
}
