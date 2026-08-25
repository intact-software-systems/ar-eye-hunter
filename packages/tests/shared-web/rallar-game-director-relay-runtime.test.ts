import type { RallarDirectorRelayConfig, RallarDirectorRelayHandle } from '@shared-web/browser/rallar.ts';
import { RallarGameDirectorRelayRuntime } from '@shared-web/game/rallar-game-director-relay-runtime.ts';
import type { RallarGameEnvelope, RallarGameMatchConfig, RallarGameRallarFacade } from '@shared-web/game/types.ts';
import { describe, expect, it, vi } from 'vitest';

interface Payload {
    readonly value: string;
}
describe('RallarGameDirectorRelayRuntime', () => {
    it('does not read director status when an optional snapshot is absent', async () => {
        let relayConfig: RallarDirectorRelayConfig<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>> | undefined;
        const readFreshDirectorStatus = () => {
            throw new Error('Director status is unavailable without a snapshot');
        };
        const readSnapshot = vi.fn(async () => undefined);
        const createRelay = ((config: RallarDirectorRelayConfig<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>) => {
            relayConfig = config;
            return toTestDouble<RallarDirectorRelayHandle<RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>, RallarGameEnvelope<Payload>>>({
                stop: vi.fn()
            });
        }) as RallarGameRallarFacade['director']['createRelay'];
        const config = toTestDouble<RallarGameMatchConfig<Payload, Payload, Payload, Payload, Payload>>({
            protocol: 'test.game.v1',
            topicId: 'game.topic',
            readSnapshot,
            rallar: toTestDouble<RallarGameRallarFacade>({
                director: toTestDouble<RallarGameRallarFacade['director']>({ createRelay })
            })
        });
        const runtime = new RallarGameDirectorRelayRuntime(
            toTestDouble<RallarGameDirectorRelayRuntime.Input<Payload, Payload, Payload, Payload, Payload>>({
                config,
                laneIds: {
                    input: 'input',
                    intent: 'intent',
                    snapshot: 'snapshot',
                    metrics: 'metrics',
                    replication: 'replication'
                },
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
        const createRelay =
            (() =>
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
        const runtime = new RallarGameDirectorRelayRuntime(
            toTestDouble<RallarGameDirectorRelayRuntime.Input<Payload, Payload, Payload, Payload, Payload>>({
                config,
                laneIds: {
                    input: 'input',
                    intent: 'intent',
                    snapshot: 'snapshot',
                    metrics: 'metrics',
                    replication: 'replication'
                },
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
                    roomId: 'room-1',
                    senderId: 'director-1',
                    seq: 1,
                    sentAtEpochMs: 1,
                    directorEpoch: options.directorEpoch,
                    payload
                })
            })
        );
        runtime.start();

        const result = await runtime.publishEvent({ value: 'accepted' });

        expect(result).toMatchObject({
            status: 'sent',
            transport: 'director-relay',
            relay: relayResult
        });
        expect(result).not.toHaveProperty('reason');
    });
});

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
