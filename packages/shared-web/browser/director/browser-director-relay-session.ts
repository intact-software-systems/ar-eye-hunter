import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    isCurrentDirectorEnvelope,
    isDirectorRelayEnvelope,
    recordDirectorRelayHeartbeat
} from './browser-director-relay-observation.ts';
import type { BrowserDirectorRelayTransport } from './browser-director-relay-transport.ts';
import type { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

const RALLAR_DIRECTOR_DEFAULT_TOPIC_ID = 'app.rallar.director';
const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';

export namespace BrowserDirectorRelaySession {
    export interface Input<TIntent, TOutput, TSnapshot> {
        readonly config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>;
        readonly status: BrowserDirectorStatusRuntime;
        readonly transport: BrowserDirectorRelayTransport;
        readonly messages: RallarMessagesOperations;
        readonly realtime: RallarRealtimeFacade;
        readSession(): AuthSession | undefined;
        onStop(stop: () => void): void;
    }

    export interface InboundMessage<T> {
        readonly transport: 'rtc' | 'ws';
        readonly senderId: string;
        readonly envelope: RallarDirectorRelayEnvelope<T>;
    }
}

export class BrowserDirectorRelaySession<TIntent, TOutput, TSnapshot>
    implements RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
    private readonly input: BrowserDirectorRelaySession.Input<TIntent, TOutput, TSnapshot>;
    private readonly laneId: string;
    private readonly topicId: string;
    private readonly heartbeatTypeId: string;
    private readonly snapshotTypeId: string;
    private readonly syncRequestTypeId: string;
    private readonly roomTarget: string | GroupRef | undefined;
    private readonly subscriptions = new BrowserRallarSubscriptionScope();
    private readonly timers: ReturnType<typeof setInterval>[] = [];
    private stopped = false;

    public constructor(
        input: BrowserDirectorRelaySession.Input<TIntent, TOutput, TSnapshot>
    ) {
        this.input = input;
        this.laneId = input.config.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID;
        this.topicId = input.config.topicId ?? RALLAR_DIRECTOR_DEFAULT_TOPIC_ID;
        this.heartbeatTypeId = input.config.heartbeatTypeId ??
            `${this.topicId}.heartbeat`;
        this.snapshotTypeId = input.config.snapshotTypeId ??
            `${this.topicId}.snapshot`;
        this.syncRequestTypeId = input.config.syncRequestTypeId ??
            `${this.topicId}.sync-request`;
        this.roomTarget = input.config.roomRef ?? input.config.roomId;
    }

    public start(): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
        this.subscribe();
        this.startHeartbeatTimer();
        this.startSnapshotTimer();
        return this;
    }

    public readonly status = (): RallarDirectorStatus => this.input.status.read(this.roomTarget);

    public readonly sendIntent = async (
        intent: TIntent
    ): Promise<RallarDirectorRelaySendResult> => {
        const guarded = this.guardSend();
        return guarded ?? await this.input.transport.sendIntent({
            current: this.status(),
            laneId: this.laneId,
            topicId: this.topicId,
            typeId: this.input.config.intentTypeId,
            payload: intent
        });
    };

    public readonly sendOutput = async (
        output: TOutput
    ): Promise<RallarDirectorRelaySendResult> => {
        const guarded = this.guardSend();
        return guarded ?? await this.input.transport.sendRoomEnvelope({
            current: this.status(),
            topicId: this.topicId,
            typeId: this.input.config.outputTypeId,
            payload: output
        });
    };

    public readonly sendHeartbeat = async (): Promise<RallarDirectorRelaySendResult> => {
        const guarded = this.guardSend();
        if (guarded) {
            return guarded;
        }
        const current = this.status();
        if (current.roomRef && current.appointment && current.isDirector) {
            this.input.status.recordHeartbeat(current.roomRef, current.appointment);
            this.input.status.emit();
        }
        return await this.input.transport.sendRoomEnvelope({
            current,
            topicId: this.topicId,
            typeId: this.heartbeatTypeId,
            payload: {
                sessionId: current.appointment?.sessionId,
                epoch: current.appointment?.epoch
            }
        });
    };

    public readonly sendSnapshot = async (
        snapshot?: TSnapshot
    ): Promise<RallarDirectorRelaySendResult> => {
        const guarded = this.guardSend();
        if (guarded) {
            return guarded;
        }
        const resolved = snapshot ?? await this.input.config.readSnapshot?.();
        if (resolved === undefined) {
            return { status: 'failed', reason: 'No director snapshot is available.' };
        }
        return await this.input.transport.sendRoomEnvelope({
            current: this.status(),
            topicId: this.topicId,
            typeId: this.snapshotTypeId,
            payload: resolved
        });
    };

    public readonly requestSync = async <TPayload>(
        payload?: TPayload
    ): Promise<RallarDirectorRelaySendResult> => {
        const guarded = this.guardSend();
        return guarded ?? await this.input.transport.sendIntent({
            current: this.status(),
            laneId: this.laneId,
            topicId: this.topicId,
            typeId: this.syncRequestTypeId,
            payload: payload ?? {}
        });
    };

    public readonly stop = (): void => {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.subscriptions.unsubscribe();
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers.length = 0;
        this.input.onStop(this.stop);
    };

    private guardSend(): RallarDirectorRelaySendResult | undefined {
        if (this.stopped) {
            return authEndedResult();
        }
        if (!this.input.readSession()) {
            this.stop();
            return authEndedResult();
        }
        return undefined;
    }

    private subscribe(): void {
        this.subscriptions
            .add(this.input.realtime.onJson<RallarDirectorRelayEnvelope>(
                this.laneId,
                async (message) => {
                    await this.receive({
                        transport: 'rtc',
                        senderId: message.peerId,
                        envelope: message.data
                    });
                }
            ))
            .add(this.input.messages.ws.onMessage<RallarDirectorRelayEnvelope>(
                { topicId: this.topicId },
                async (message) => {
                    await this.receive({
                        transport: 'ws',
                        senderId: message.senderId,
                        envelope: message.payload
                    });
                }
            ));
        this.subscribeToRtcRoomMessages();
    }

    private subscribeToRtcRoomMessages(): void {
        for (
            const typeId of [
                this.input.config.outputTypeId,
                this.heartbeatTypeId,
                this.snapshotTypeId
            ]
        ) {
            this.subscriptions.add(
                this.input.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                    { topicId: this.topicId, typeId },
                    async (message) => {
                        await this.receive({
                            transport: 'rtc',
                            senderId: message.senderId,
                            envelope: message.payload
                        });
                    }
                )
            );
        }
    }

    private async receive(
        input: BrowserDirectorRelaySession.InboundMessage<RallarMessagePayload>
    ): Promise<void> {
        if (!isDirectorRelayEnvelope(input.envelope, this.topicId)) {
            return;
        }
        const current = this.status();
        if (this.stopped || !isCurrentDirectorEnvelope(current, input.envelope)) {
            return;
        }
        await this.route({
            transport: input.transport,
            senderId: input.senderId,
            data: input.envelope.payload,
            envelope: input.envelope,
            receivedAtEpochMs: Date.now()
        });
    }

    private async route(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        if (await this.routeObservedMessage(message)) {
            return;
        }
        if (!this.status().isDirector) {
            return;
        }
        await this.routeDirectorMessage(message);
    }

    private async routeObservedMessage(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<boolean> {
        if (message.envelope.typeId === this.heartbeatTypeId) {
            recordDirectorRelayHeartbeat(this.input.status, this.status(), message);
            return true;
        }
        if (message.envelope.typeId === this.input.config.outputTypeId) {
            await this.receiveOutput(message);
            return true;
        }
        if (message.envelope.typeId === this.snapshotTypeId) {
            await this.receiveSnapshot(message);
            return true;
        }
        return false;
    }

    private async routeDirectorMessage(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        if (message.envelope.typeId === this.input.config.intentTypeId) {
            await this.receiveIntent(message);
            return;
        }
        if (message.envelope.typeId === this.syncRequestTypeId) {
            await this.receiveSyncRequest(message);
        }
    }

    private async receiveOutput(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        const current = this.status();
        if (!current.isFresh || message.senderId !== current.appointment?.sessionId) {
            return;
        }
        await this.input.config.onOutput?.(
            toTypedRelayMessage<TOutput>(message)
        );
    }

    private async receiveSnapshot(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        const current = this.status();
        if (!current.isFresh || message.senderId !== current.appointment?.sessionId) {
            return;
        }
        await this.input.config.onSnapshot?.(
            toTypedRelayMessage<TSnapshot>(message)
        );
    }

    private async receiveIntent(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        const output = await this.input.config.onIntent?.(
            toTypedRelayMessage<TIntent>(message),
            this
        );
        const outputs = Array.isArray(output) ? output : output ? [output] : [];
        for (const item of outputs) {
            await this.sendOutput(item as TOutput);
        }
    }

    private async receiveSyncRequest(
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): Promise<void> {
        await this.input.config.onSyncRequest?.(
            message,
            this
        );
        if (this.input.config.readSnapshot) {
            await this.sendSnapshot();
        }
    }

    private startHeartbeatTimer(): void {
        const intervalMs = this.input.config.heartbeatIntervalMs ?? Math.max(
            500,
            Math.min(
                2_000,
                (this.status().appointment?.heartbeatTtlMs ??
                    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS) / 2
            )
        );
        this.timers.push(setInterval(() => this.sendPeriodicHeartbeat(), intervalMs));
    }

    private startSnapshotTimer(): void {
        if (
            !this.input.config.readSnapshot ||
            this.input.config.snapshotIntervalMs === false
        ) {
            return;
        }
        this.timers.push(setInterval(
            () => this.sendPeriodicSnapshot(),
            this.input.config.snapshotIntervalMs ?? 2_000
        ));
    }

    private sendPeriodicHeartbeat(): void {
        if (!this.canSendPeriodic()) {
            return;
        }
        void this.sendHeartbeat().catch((error) => {
            console.error('Failed to send director relay heartbeat:', error);
        });
    }

    private sendPeriodicSnapshot(): void {
        if (!this.canSendPeriodic()) {
            return;
        }
        void this.sendSnapshot().catch((error) => {
            console.error('Failed to send director relay snapshot:', error);
        });
    }

    private canSendPeriodic(): boolean {
        if (this.stopped) {
            return false;
        }
        if (!this.input.readSession()) {
            this.stop();
            return false;
        }
        return this.status().isDirector;
    }
}

function authEndedResult(): RallarDirectorRelaySendResult {
    return { status: 'no-director', reason: 'Auth session ended.' };
}

/**
 * Applies the configured type-id contract after routing has matched that type id.
 * The payload object is intentionally not copied or transformed.
 */
function toTypedRelayMessage<TPayload>(
    message: RallarDirectorRelayMessage<RallarMessagePayload>
): RallarDirectorRelayMessage<TPayload>;
function toTypedRelayMessage(
    message: RallarDirectorRelayMessage<RallarMessagePayload>
): RallarDirectorRelayMessage<RallarMessagePayload> {
    return message;
}
