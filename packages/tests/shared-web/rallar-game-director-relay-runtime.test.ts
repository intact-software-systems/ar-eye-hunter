import type { RallarDirectorRelayConfig, RallarDirectorRelayHandle } from '@shared-web/browser/rallar.ts';
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
                            sessionIds: ['local']
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
});

function createPublishingRuntime(
    sendOutput: RallarDirectorRelayHandle<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>['sendOutput']
): RallarGameDirectorRelayRuntime<Payload, Payload, Payload, Payload, Payload> {
    const createRelay = (() =>
        toTestDouble<RallarDirectorRelayHandle<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>>({
            sendOutput,
            stop: vi.fn()
        })) as RallarGameRallarFacade['director']['createRelay'];
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
                    isDirector: true,
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
            })
        })
    );
}

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
