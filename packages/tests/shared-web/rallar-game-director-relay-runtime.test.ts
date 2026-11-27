import type { RallarDirectorRelayConfig, RallarDirectorRelayHandle, RallarMessageOrderGap, RallarMessageOrderGapReason } from '@shared-web/browser/rallar.ts';
import { RallarGameDirectorRelayRuntime } from '@shared-web/game/director/rallar-game-director-relay-runtime.ts';
import type { RallarGameEnvelope } from '@shared-web/game/envelopes.ts';
import type { RallarGameMatchConfig, RallarGameRallarFacade } from '@shared-web/game/match/rallar-game-match-contracts.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGameRoomStateFixture } from './rallar-game-room-state-fixture.ts';

interface Payload {
    readonly value: string;
}
describe('RallarGameDirectorRelayRuntime', () => {
    it.each(
        [
            { scenario: 'an optional snapshot is absent', initialRole: 'member', nextRole: 'member', value: undefined },
            { scenario: 'the local session is watching', initialRole: 'spectator', nextRole: 'spectator', value: { value: 'world' } },
            { scenario: 'the local session becomes a watcher during the read', initialRole: 'member', nextRole: 'spectator', value: { value: 'world' } }
        ] as const
    )('does not publish or read director status when $scenario', async ({ initialRole, nextRole, value }) => {
        let role: 'member' | 'spectator' = initialRole;
        let relayConfig: RallarDirectorRelayConfig<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>> | undefined;
        const readFreshDirectorStatus = () => {
            throw new Error('Director status is unavailable without a snapshot');
        };
        const readSnapshot = vi.fn(async () => {
            role = nextRole;
            return value;
        });
        const createRelay = ((config: RallarDirectorRelayConfig<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>) => {
            relayConfig = config;
            return toTestDouble<RallarDirectorRelayHandle<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>>({
                stop: vi.fn()
            });
        }) as RallarGameRallarFacade['director']['createRelay'];
        const config = toTestDouble<RallarGameMatchConfig<Payload, Payload, Payload, Payload, Payload>>({
            protocol: 'test.game.v1',
            topicId: 'game.topic',
            roomId: 'room-1',
            readSnapshot,
            rallar: toTestDouble<RallarGameRallarFacade>({
                director: toTestDouble<RallarGameRallarFacade['director']>({ createRelay }),
                session: () => toTestDouble<NonNullable<ReturnType<RallarGameRallarFacade['session']>>>({ sessionId: 'local' }),
                rooms: toTestDouble<RallarGameRallarFacade['rooms']>({
                    state: () =>
                        createGameRoomStateFixture({ applicationId: 'test', workspaceId: 'default', groupId: 'room-1' }, [{
                            principalId: 'local',
                            username: 'local',
                            role,
                            status: 'active',
                            isOwner: false,
                            isOnline: true,
                            sessionIds: ['local'],
                            topicGrants: {}
                        }])
                })
            })
        });
        const runtime = new RallarGameDirectorRelayRuntime(
            toTestDouble<RallarGameDirectorRelayRuntime.Input<Payload, Payload, Payload, Payload, Payload>>({
                config,
                typeIds: {
                    capability: 'capability',
                    intent: 'intent',
                    event: 'event',
                    snapshot: 'snapshot',
                    syncRequest: 'sync-request',
                    heartbeat: 'heartbeat'
                },
                heartbeatTtlMs: 1_000,
                isStopped: () => false,
                readFreshDirectorStatus
            })
        );

        runtime.start();
        const snapshot = await relayConfig?.readSnapshot?.();

        expect(snapshot).toBeUndefined();
    });

    it('omits failure reason from a successful public relay result', async () => {
        const relayResult = { status: 'sent' as const };
        const sendOutput = vi.fn(async () => relayResult);
        const runtime = createPublishingRuntime(sendOutput);
        runtime.start();

        const result = await runtime.publishEvent({ value: 'accepted' });

        expect(result).toMatchObject({
            status: 'sent',
            transport: 'director-relay',
            relay: relayResult
        });
        expect(result).not.toHaveProperty('reason');
        expect(sendOutput).toHaveBeenCalledWith(expect.objectContaining({ kind: 'event' }), undefined);
    });

    it('passes a logical receipt request through to the relay output', async () => {
        const sendOutput = vi.fn(async () => ({ status: 'sent' as const }));
        const runtime = createPublishingRuntime(sendOutput);
        runtime.start();

        await runtime.publishEvent({ value: 'ended' }, { ack: 'all-logical-recipients' });

        expect(sendOutput).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'event', payload: { value: 'ended' } }),
            { ack: 'all-logical-recipients' }
        );
    });

    it.each(
        [
            { reason: 'channel-wait-cap', outcome: 'asks the director for one sync', syncRequests: [{ reason: 'event-order-gap' }] },
            { reason: 'ended-at-sender', outcome: 'asks for no sync', syncRequests: [] }
        ] as const
    )('$outcome on an event order gap of reason $reason', async ({ reason, syncRequests }) => {
        const requestSync = vi.fn(async <T>(_envelope?: T) => ({ status: 'sent' as const }));
        let relayConfig: PayloadRelayConfig | undefined;
        const runtime = createPublishingRuntime(vi.fn(), {
            isDirector: false,
            relay: { requestSync },
            recordConfig: (config) => {
                relayConfig = config;
            }
        });
        runtime.start();
        const onOutputGap = relayConfig?.onOutputGap;
        if (!onOutputGap) {
            throw new Error('The match takes the relay\'s output gaps.');
        }

        await onOutputGap(toOutputGap(reason));

        expect(requestSync.mock.calls).toEqual(
            syncRequests.map((payload) => [expect.objectContaining({ kind: 'sync-request', payload })])
        );
    });
});

type PayloadRelayHandle = RallarDirectorRelayHandle<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>;
type PayloadRelayConfig = RallarDirectorRelayConfig<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>;

interface PublishingRuntimeOptions {
    readonly isDirector: boolean;
    readonly relay: Partial<PayloadRelayHandle>;
    recordConfig(config: PayloadRelayConfig): void;
}

function createPublishingRuntime(
    sendOutput: PayloadRelayHandle['sendOutput'],
    options: PublishingRuntimeOptions = { isDirector: true, relay: {}, recordConfig: () => {} }
): RallarGameDirectorRelayRuntime<Payload, Payload, Payload, Payload, Payload> {
    const createRelay = ((relayConfig: PayloadRelayConfig) => {
        options.recordConfig(relayConfig);
        return toTestDouble<PayloadRelayHandle>({ sendOutput, stop: vi.fn(), ...options.relay });
    }) as RallarGameRallarFacade['director']['createRelay'];
    const config = toTestDouble<RallarGameMatchConfig<Payload, Payload, Payload, Payload, Payload>>({
        protocol: 'test.game.v1',
        topicId: 'game.topic',
        rallar: toTestDouble<RallarGameRallarFacade>({
            director: toTestDouble<RallarGameRallarFacade['director']>({
                createRelay
            })
        })
    });
    return new RallarGameDirectorRelayRuntime(
        toTestDouble<RallarGameDirectorRelayRuntime.Input<Payload, Payload, Payload, Payload, Payload>>({
            config,
            typeIds: {
                capability: 'capability',
                intent: 'intent',
                event: 'event',
                snapshot: 'snapshot',
                syncRequest: 'sync-request',
                heartbeat: 'heartbeat'
            },
            heartbeatTtlMs: 1_000,
            isStopped: () => false,
            readFreshDirectorStatus: () =>
                toTestDouble<ReturnType<RallarGameDirectorRelayRuntime.Input<Payload, Payload, Payload, Payload, Payload>['readFreshDirectorStatus']>>({
                    isDirector: options.isDirector,
                    appointment: {
                        version: 1,
                        mode: 'appointed-spa',
                        sessionId: 'director-session',
                        principalId: 'director-principal',
                        epoch: 2,
                        appointedAtEpochMs: 1,
                        heartbeatTtlMs: 1_000
                    }
                }),
            createEnvelope: (kind, payload, options) => ({
                protocol: 'test.game.v1',
                kind,
                roomRef: { applicationId: 'test', workspaceId: 'default', groupId: 'room-1' },
                senderId: 'director-1',
                senderGenerationId: 'generation-director-1',
                seq: 1,
                sentAtEpochMs: 1,
                directorEpoch: options.directorEpoch,
                payload
            }),
            syncRequested: () => {}
        })
    );
}

function toOutputGap(reason: RallarMessageOrderGapReason): RallarMessageOrderGap {
    return {
        topicId: 'game.topic',
        typeId: 'event',
        senderId: 'director-session',
        stream: 'director-stream',
        fromPosition: 2,
        toPosition: 2,
        reason
    };
}

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
