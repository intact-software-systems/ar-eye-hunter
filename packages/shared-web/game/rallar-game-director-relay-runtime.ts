import type { RallarDirectorRelayMessage, RallarDirectorRelaySendResult } from '@shared-web/browser/rallar.ts';
import type { RallarGameFreshDirectorStatus } from './rallar-game-fresh-director-status.ts';
import type {
    RallarGameEnvelope,
    RallarGameEnvelopeHandler,
    RallarGameEnvelopeKind,
    RallarGameLaneIds,
    RallarGameMatchConfig,
    RallarGameRuntimeRelay,
    RallarGameSendResult,
    RallarGameTypeIds
} from './types.ts';

export namespace RallarGameDirectorRelayRuntime {
    export interface EnvelopeInput<T> {
        readonly message: RallarDirectorRelayMessage<RallarGameEnvelope<T>>;
        readonly kind: RallarGameEnvelopeKind;
        readonly handler: RallarGameEnvelopeHandler<T> | undefined;
        readonly requireFreshDirectorSender?: boolean;
    }

    export interface EnvelopeOptions {
        readonly directorEpoch: number;
        readonly roomId?: string;
        readonly senderId?: string;
        readonly sentAtEpochMs?: number;
    }

    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly laneIds: RallarGameLaneIds;
        readonly typeIds: RallarGameTypeIds;
        readonly heartbeatTtlMs: number;
        isStopped(): boolean;
        readFreshDirectorStatus(): RallarGameFreshDirectorStatus | undefined;
        createEnvelope<T>(
            kind: RallarGameEnvelopeKind,
            payload: T,
            options: EnvelopeOptions
        ): RallarGameEnvelope<T>;
        routeEnvelope<T>(
            envelope: RallarGameEnvelope<T>,
            kind: RallarGameEnvelopeKind,
            handler: RallarGameEnvelopeHandler<T> | undefined
        ): Promise<void>;
        handleEnvelope<T>(input: EnvelopeInput<T>): Promise<void>;
        syncRequested(atEpochMs: number): void;
    }
}

/** Owns the match director-relay lifecycle and reliable director transport. */
export class RallarGameDirectorRelayRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameDirectorRelayRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private relay: RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> | undefined;

    constructor(
        input: RallarGameDirectorRelayRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    start(): void {
        this.relay = this.createRelay();
    }

    stop(): void {
        this.relay?.stop();
        this.relay = undefined;
    }

    async sendIntent(intent: TIntent): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return stoppedResult();
        }

        const director = this.input.readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const envelope = this.input.createEnvelope('intent', intent, {
            directorEpoch: director.appointment.epoch
        });
        if (director.isDirector) {
            await this.input.routeEnvelope(envelope, 'intent', this.input.config.onIntent);
            return { status: 'sent', transport: 'local' };
        }

        return toRelaySendResult(await this.ensureRelay().sendIntent(envelope));
    }

    async publishEvent(event: TEvent): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return stoppedResult();
        }

        const director = this.input.readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }
        if (!director.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the fresh local director can publish events.'
            };
        }

        const envelope = this.input.createEnvelope('event', event, {
            directorEpoch: director.appointment.epoch
        });
        return toRelaySendResult(await this.ensureRelay().sendOutput(envelope));
    }

    async sendSnapshot(envelope: RallarGameEnvelope<TSnapshot>): Promise<RallarGameSendResult> {
        return toRelaySendResult(await this.ensureRelay().sendSnapshot(envelope));
    }

    async requestSync<TPayload>(payload?: TPayload): Promise<RallarGameSendResult> {
        if (this.input.isStopped()) {
            return stoppedResult();
        }

        const director = this.input.readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const syncPayload = payload === undefined ? {} as TPayload : payload;
        const envelope = this.input.createEnvelope('sync-request', syncPayload, {
            directorEpoch: director.appointment.epoch
        });
        this.input.syncRequested(envelope.sentAtEpochMs);
        if (!director.isDirector) {
            return toRelaySendResult(await this.ensureRelay().requestSync(envelope));
        }

        await this.input.routeEnvelope(envelope, 'sync-request', this.input.config.onSyncRequest);
        const snapshot = await this.input.config.readSnapshot?.();
        if (snapshot !== undefined) {
            const snapshotEnvelope = this.input.createEnvelope('snapshot', snapshot, {
                directorEpoch: director.appointment.epoch
            });
            await this.sendSnapshot(snapshotEnvelope);
        }
        return { status: 'sent', transport: 'local' };
    }

    private createRelay(): RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> {
        const { config, laneIds, typeIds } = this.input;
        return config.rallar.director.createRelay<
            RallarGameEnvelope<TIntent>,
            RallarGameEnvelope<TEvent>,
            RallarGameEnvelope<TSnapshot>
        >({
            roomId: config.roomRef ? undefined : config.roomId,
            roomRef: config.roomRef,
            laneId: laneIds.intent,
            topicId: config.topicId,
            intentTypeId: typeIds.intent,
            outputTypeId: typeIds.event,
            heartbeatTypeId: typeIds.heartbeat,
            snapshotTypeId: typeIds.snapshot,
            syncRequestTypeId: typeIds.syncRequest,
            heartbeatIntervalMs: Math.max(500, this.input.heartbeatTtlMs / 2),
            snapshotIntervalMs: config.autoSnapshotIntervalMs,
            readSnapshot: config.readSnapshot
                ? async () => {
                    const snapshot = await config.readSnapshot?.();
                    if (snapshot === undefined) {
                        return undefined;
                    }
                    const director = this.input.readFreshDirectorStatus();
                    return !director?.isDirector
                        ? undefined
                        : this.input.createEnvelope('snapshot', snapshot, {
                            directorEpoch: director.appointment.epoch
                        });
                }
                : undefined,
            onIntent: async (message) =>
                await this.input.handleEnvelope({
                    message,
                    kind: 'intent',
                    handler: config.onIntent
                }),
            onOutput: async (message) =>
                await this.input.handleEnvelope({
                    message,
                    kind: 'event',
                    handler: config.onEvent,
                    requireFreshDirectorSender: true
                }),
            onSnapshot: async (message) =>
                await this.input.handleEnvelope({
                    message,
                    kind: 'snapshot',
                    handler: config.onSnapshot,
                    requireFreshDirectorSender: true
                }),
            onSyncRequest: async (message) =>
                await this.input.handleEnvelope({
                    message: message as RallarDirectorRelayMessage<RallarGameEnvelope<object>>,
                    kind: 'sync-request',
                    handler: config.onSyncRequest
                })
        });
    }

    private ensureRelay(): RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> {
        if (this.input.isStopped()) {
            throw new Error('Cannot create Rallar Game relay after match stop.');
        }
        this.relay ??= this.createRelay();
        return this.relay;
    }
}

function toRelaySendResult(relay: RallarDirectorRelaySendResult): RallarGameSendResult {
    if (relay.status === 'sent') {
        return { status: 'sent', transport: 'director-relay', relay };
    }

    const status = relay.status === 'stale-director' ? 'no-director' : relay.status;
    return {
        status,
        transport: 'director-relay',
        relay,
        reason: relay.reason
    };
}

function stoppedResult(): RallarGameSendResult {
    return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
}

function noDirectorResult(): RallarGameSendResult {
    return { status: 'no-director', reason: 'No fresh director is available.' };
}
