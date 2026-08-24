import type { RallarMessagesController } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus
} from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS } from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { BrowserDirectorRelayTransport, RALLAR_DIRECTOR_RELAY_PROTOCOL } from './browser-director-relay-transport.ts';
import { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

const RALLAR_DIRECTOR_DEFAULT_TOPIC_ID = 'app.rallar.director';
const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';

export interface BrowserDirectorRelayRuntimeInput {
    readonly status: BrowserDirectorStatusRuntime;
    readonly transport: BrowserDirectorRelayTransport;
    readonly messages: RallarMessagesController['operations'];
    readonly realtime: RallarRealtimeFacade;
    readSession(): AuthSession | undefined;
}

interface BrowserDirectorRelaySessionInput<TIntent, TOutput, TSnapshot> {
    readonly config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>;
    readonly status: BrowserDirectorStatusRuntime;
    readonly transport: BrowserDirectorRelayTransport;
    readonly messages: RallarMessagesController['operations'];
    readonly realtime: RallarRealtimeFacade;
    readonly readSession: () => AuthSession | undefined;
    readonly onStop: (stop: () => void) => void;
}

interface ReceivedDirectorEnvelope<T> {
    readonly transport: 'rtc' | 'ws';
    readonly senderId: string;
    readonly envelope: RallarDirectorRelayEnvelope<T>;
}

export class BrowserDirectorRelayRuntime {
    private readonly input: BrowserDirectorRelayRuntimeInput;
    private readonly stops = new Set<() => void>();

    public constructor(input: BrowserDirectorRelayRuntimeInput) {
        this.input = input;
    }

    public create<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
        const session = new BrowserDirectorRelaySession({
            ...this.input,
            config,
            onStop: (stop) => this.stops.delete(stop)
        });
        this.stops.add(session.stop);
        return session.start();
    }

    public stopAll(): void {
        const stops = [...this.stops];
        this.stops.clear();
        for (const stop of stops) {
            runShutdownStep(stop);
        }
    }
}

class BrowserDirectorRelaySession<TIntent, TOutput, TSnapshot>
    implements RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
    private readonly input: BrowserDirectorRelaySessionInput<TIntent, TOutput, TSnapshot>;
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
        input: BrowserDirectorRelaySessionInput<TIntent, TOutput, TSnapshot>
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

    public readonly requestSync = async (
        payload?: unknown
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

    private async receive<T>(input: ReceivedDirectorEnvelope<T>): Promise<void> {
        if (!isDirectorRelayEnvelope(input.envelope, this.topicId)) {
            return;
        }
        const current = this.status();
        if (this.stopped || !isCurrentDirectorEnvelope(current, input.envelope)) {
            return;
        }
        const message: RallarDirectorRelayMessage<T> = {
            transport: input.transport,
            senderId: input.senderId,
            data: input.envelope.payload,
            envelope: input.envelope,
            receivedAtEpochMs: Date.now()
        };
        await this.routeEnvelope(message);
    }

    private async routeEnvelope<T>(
        message: RallarDirectorRelayMessage<T>
    ): Promise<void> {
        if (message.envelope.typeId === this.heartbeatTypeId) {
            this.receiveHeartbeat(message);
            return;
        }
        if (message.envelope.typeId === this.input.config.outputTypeId) {
            await this.receiveOutput(message);
            return;
        }
        if (message.envelope.typeId === this.snapshotTypeId) {
            await this.receiveSnapshot(message);
            return;
        }
        if (!this.status().isDirector) {
            return;
        }
        if (message.envelope.typeId === this.input.config.intentTypeId) {
            await this.receiveIntent(message);
            return;
        }
        if (message.envelope.typeId === this.syncRequestTypeId) {
            await this.receiveSyncRequest(message);
        }
    }

    private receiveHeartbeat<T>(message: RallarDirectorRelayMessage<T>): void {
        const current = this.status();
        if (message.senderId !== current.appointment?.sessionId) {
            return;
        }
        if (current.roomRef && current.appointment) {
            this.input.status.recordHeartbeat(
                current.roomRef,
                current.appointment,
                message.receivedAtEpochMs
            );
            this.input.status.emit();
        }
    }

    private async receiveOutput<T>(message: RallarDirectorRelayMessage<T>): Promise<void> {
        const current = this.status();
        if (!current.isFresh || message.senderId !== current.appointment?.sessionId) {
            return;
        }
        await this.input.config.onOutput?.(
            message as unknown as RallarDirectorRelayMessage<TOutput>
        );
    }

    private async receiveSnapshot<T>(
        message: RallarDirectorRelayMessage<T>
    ): Promise<void> {
        const current = this.status();
        if (!current.isFresh || message.senderId !== current.appointment?.sessionId) {
            return;
        }
        await this.input.config.onSnapshot?.(
            message as unknown as RallarDirectorRelayMessage<TSnapshot>
        );
    }

    private async receiveIntent<T>(message: RallarDirectorRelayMessage<T>): Promise<void> {
        const output = await this.input.config.onIntent?.(
            message as unknown as RallarDirectorRelayMessage<TIntent>,
            this
        );
        const outputs = Array.isArray(output) ? output : output ? [output] : [];
        for (const item of outputs) {
            await this.sendOutput(item as TOutput);
        }
    }

    private async receiveSyncRequest<T>(
        message: RallarDirectorRelayMessage<T>
    ): Promise<void> {
        await this.input.config.onSyncRequest?.(message, this);
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

function isCurrentDirectorEnvelope(
    status: RallarDirectorStatus,
    envelope: RallarDirectorRelayEnvelope
): boolean {
    return Boolean(
        status.appointment && status.roomId &&
            envelope.roomId === status.roomId &&
            envelope.epoch === status.appointment.epoch
    );
}

function isDirectorRelayEnvelope(
    value: unknown,
    topicId: string
): value is RallarDirectorRelayEnvelope {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const envelope = value as Partial<RallarDirectorRelayEnvelope>;
    return envelope.protocol === RALLAR_DIRECTOR_RELAY_PROTOCOL &&
        envelope.topicId === topicId &&
        typeof envelope.typeId === 'string' &&
        typeof envelope.roomId === 'string' &&
        typeof envelope.epoch === 'number' &&
        typeof envelope.sentAtEpochMs === 'number' &&
        'payload' in envelope;
}

function runShutdownStep(step: () => void): void {
    try {
        step();
    }
    catch {
        // Relay teardown remains best-effort during transport shutdown.
    }
}
