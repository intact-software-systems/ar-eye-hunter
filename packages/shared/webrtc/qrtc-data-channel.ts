import type { ApiJsonValue } from '../api/api-json-value.ts';
import { validateJsonMessageSize } from '../api/json-message-validation.ts';
import { toError } from '../resilience/to-error.ts';

import { OnQRtcMessageCallback, QRtcClientCallbacks } from './qrtc-client-callbacks.ts';
import { QRtcPeerConnection } from './qrtc-peer-connection.ts';
import { RtcDataChannelSendQueue } from './rtc-data-channel-send-queue.ts';

export type RtcDataChannelPayload =
    | string
    | Blob
    | ArrayBuffer
    | ArrayBufferView<ArrayBuffer>;

export type RtcDataChannelOverflowMode =
    | 'drop-new'
    | 'drop-old'
    | 'replace-by-key'
    | 'queue';

export interface RtcDataChannelFlowControlPolicy {
    readonly highWatermarkBytes?: number;
    readonly lowWatermarkBytes?: number;
    readonly overflow?: RtcDataChannelOverflowMode;
    readonly maxQueueItems?: number;
}

export interface RtcDataChannelSendOptions {
    readonly key?: string;
    readonly maxAgeMs?: number;
    readonly now?: () => number;
}

export interface RtcDataChannelSendResult {
    readonly status: 'sent' | 'queued' | 'dropped' | 'replaced' | 'closed';
    readonly reason?: string;
    readonly key?: string;
    readonly bufferedAmount: number;
}

export interface RtcDataChannelCounters {
    readonly sent: number;
    readonly queued: number;
    readonly dropped: number;
    readonly replaced: number;
    readonly closed: number;
    readonly flushed: number;
    readonly droppedOldest: number;
    readonly droppedStale: number;
    readonly receivedRaw: number;
    readonly receivedString: number;
    readonly receivedBinary: number;
}

export interface RtcDataChannelHealth {
    readonly peerId: string;
    readonly label: string;
    readonly state: string;
    readonly role: string;
    readonly readyState?: RTCDataChannelState;
    readonly binaryType?: BinaryType;
    readonly bufferedAmount: number;
    readonly bufferedAmountLowThreshold: number;
    readonly queuedItemCount: number;
    readonly rawCallbackCount: number;
    readonly messageCallbackCount: number;
    readonly lifecycleCallbackCount: number;
    readonly flowControl: Required<RtcDataChannelFlowControlPolicy>;
    readonly counters: RtcDataChannelCounters;
}

export interface RtcRawMessageCallback {
    onMessage: (data: RtcDataChannelPayload, ev: MessageEvent<RtcDataChannelPayload>) => Promise<void>;
}

export const DEFAULT_RTC_DATA_CHANNEL_OPEN_TIMEOUT_MS = 5_000;

const RtcSessionState = {
    Idle: 'Idle',
    Connecting: 'Connecting',
    Open: 'Open',
    Closed: 'Closed',
    Failed: 'Failed'
} as const;

type RtcSessionState = (typeof RtcSessionState)[keyof typeof RtcSessionState];

const RtcRole = {
    None: 'None',
    Initiator: 'Initiator',
    Receiver: 'Receiver'
} as const;

type RtcRole = (typeof RtcRole)[keyof typeof RtcRole];

type RtcApplicationMessage = ApiJsonValue | RtcDataChannelPayload;

interface RtcMessageSubscription {
    readonly callback: OnQRtcMessageCallback;
    readonly type: string;
}

interface RtcDataChannelOpenWaiter {
    resolve: (isOpen: boolean) => void;
    timeout: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_FLOW_CONTROL: Required<RtcDataChannelFlowControlPolicy> = {
    highWatermarkBytes: 64 * 1024,
    lowWatermarkBytes: 16 * 1024,
    overflow: 'drop-new',
    maxQueueItems: 32
};

const createInitialCounters = (): Record<keyof RtcDataChannelCounters, number> => ({
    sent: 0,
    queued: 0,
    dropped: 0,
    replaced: 0,
    closed: 0,
    flushed: 0,
    droppedOldest: 0,
    droppedStale: 0,
    receivedRaw: 0,
    receivedString: 0,
    receivedBinary: 0
});

export namespace QRtcDataChannel {
    export interface InputDto {
        readonly peerId: string;
        readonly dataChannelName: string;
        readonly dataChannelInit?: RTCDataChannelInit;
        readonly binaryType?: BinaryType;
        readonly flowControl?: RtcDataChannelFlowControlPolicy;
    }

    export interface Status {
        state: RtcSessionState;
        role: RtcRole;
        dc: RTCDataChannel | undefined;
    }
}

export class QRtcDataChannel {
    public readonly status: QRtcDataChannel.Status;

    private readonly clientCallbacks = new Map<string, QRtcClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, RtcMessageSubscription>();
    private readonly onRawMessageCallbacks = new Map<string, RtcRawMessageCallback>();
    private readonly sendQueue = new RtcDataChannelSendQueue<RtcDataChannelPayload>();
    private readonly openWaiters: RtcDataChannelOpenWaiter[] = [];
    private readonly counters = createInitialCounters();
    private readonly flowControlPolicy: Required<RtcDataChannelFlowControlPolicy>;

    public readonly peerConnection: QRtcPeerConnection;
    public readonly input: QRtcDataChannel.InputDto;
    private readonly now: () => number;

    constructor(
        peerConnection: QRtcPeerConnection,
        input: QRtcDataChannel.InputDto,
        now: () => number = Date.now
    ) {
        this.peerConnection = peerConnection;
        this.input = input;
        this.now = now;
        this.flowControlPolicy = { ...DEFAULT_FLOW_CONTROL, ...input.flowControl };
        this.status = {
            state: RtcSessionState.Idle,
            role: RtcRole.None,
            dc: undefined
        };
    }

    reset(): void {
        this.peerConnection.removeDataChannelCallbackById(this.dataChannelCallbackId());
        this.resolveOpenWaiters(false);
        this.closeDataChannelIfPresent();
        this.sendQueue.clear();
        this.status.state = RtcSessionState.Idle;
    }

    clearCallbacks() {
        this.clientCallbacks.clear();
        this.onMessageCallbacks.clear();
        this.onRawMessageCallbacks.clear();
    }

    private closeDataChannelIfPresent(): void {
        const dataChannel = this.status.dc;
        if (!dataChannel) {
            return;
        }
        try {
            dataChannel.close();
        }
        catch (error) {
            console.error('Error closing data channel', toError(error));
        }
        finally {
            this.clearDataChannelReference(dataChannel);
        }
    }

    onRtcCallbacksDo(
        id: string,
        clientCallbacks: QRtcClientCallbacks
    ) {
        this.clientCallbacks.set(id, clientCallbacks);
        return this;
    }

    removeRtcCallbackById(id: string): boolean {
        return this.clientCallbacks.delete(id);
    }

    onRtcMessageDo(
        id: string,
        onMessage: OnQRtcMessageCallback,
        type: string = '*'
    ) {
        this.onMessageCallbacks.set(
            id,
            {
                callback: onMessage,
                type
            }
        );

        return this;
    }

    removeOnRtcMessageCallbackById(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    sendAsJsonString(data: string): Promise<void> {
        this.sendRawOrThrow(data);
        return Promise.resolve();
    }

    send(data: object): Promise<void> {
        this.sendRawOrThrow(JSON.stringify(data));
        return Promise.resolve();
    }

    sendJson<T>(
        data: T,
        options: RtcDataChannelSendOptions = {}
    ): RtcDataChannelSendResult {
        return this.sendRaw(JSON.stringify(data), options);
    }

    sendBinary(
        data: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
        options: RtcDataChannelSendOptions = {}
    ): RtcDataChannelSendResult {
        return this.sendRaw(data, options);
    }

    sendRaw(
        data: RtcDataChannelPayload,
        options: RtcDataChannelSendOptions = {}
    ): RtcDataChannelSendResult {
        const dc = this.status.dc;
        if (!dc || dc.readyState !== 'open') {
            return this.recordSendResult('closed', 'Data channel not open', options.key);
        }

        this.flushQueuedSends();

        if (this.isBackPressured(dc)) {
            return this.enqueueBackPressuredSend(data, options);
        }

        this.sendPayload(dc, data);
        return this.recordSendResult('sent', undefined, options.key);
    }

    onRawMessageDo(
        id: string,
        callback: RtcRawMessageCallback
    ): QRtcDataChannel {
        this.onRawMessageCallbacks.set(id, callback);
        return this;
    }

    removeOnRawMessageCallbackById(id: string): boolean {
        return this.onRawMessageCallbacks.delete(id);
    }

    readHealth(): RtcDataChannelHealth {
        const dc = this.status.dc;
        return {
            peerId: this.input.peerId,
            label: this.input.dataChannelName,
            state: this.status.state,
            role: this.status.role,
            readyState: dc?.readyState,
            binaryType: dc?.binaryType,
            bufferedAmount: dc?.bufferedAmount ?? 0,
            bufferedAmountLowThreshold: dc?.bufferedAmountLowThreshold ??
                this.flowControlPolicy.lowWatermarkBytes,
            queuedItemCount: this.sendQueue.size,
            rawCallbackCount: this.onRawMessageCallbacks.size,
            messageCallbackCount: this.onMessageCallbacks.size,
            lifecycleCallbackCount: this.clientCallbacks.size,
            flowControl: this.flowControlPolicy,
            counters: { ...this.counters }
        };
    }

    waitUntilOpen(
        timeoutMs: number = DEFAULT_RTC_DATA_CHANNEL_OPEN_TIMEOUT_MS
    ): Promise<boolean> {
        if (this.status.dc?.readyState === 'open') {
            this.status.state = RtcSessionState.Open;
            return Promise.resolve(true);
        }

        if (
            this.status.state === RtcSessionState.Closed ||
            this.status.state === RtcSessionState.Failed ||
            this.status.dc?.readyState === 'closing' ||
            this.status.dc?.readyState === 'closed' ||
            timeoutMs <= 0
        ) {
            return Promise.resolve(false);
        }

        return new Promise<boolean>((resolve) => {
            const waiter: RtcDataChannelOpenWaiter = {
                resolve,
                timeout: undefined
            };

            waiter.timeout = setTimeout(
                () => this.resolveOpenWaiter(waiter, false),
                timeoutMs
            );
            this.openWaiters.push(waiter);
        });
    }

    connect(isInitiator: boolean): void {
        if (this.isOpen() || !this.isReadyToConnect()) {
            return;
        }

        this.clearTerminalDataChannelReference();
        this.status.state = RtcSessionState.Connecting;
        this.status.role = isInitiator ? RtcRole.Initiator : RtcRole.Receiver;
        this.peerConnection.onDataChannelDo(
            this.dataChannelCallbackId(),
            (event) => this.acceptRemoteDataChannel(event)
        );

        if (isInitiator) {
            this.status.dc = this.peerConnection.createDataChannel(
                this.input.dataChannelName,
                this.input.dataChannelInit
            );
            this.setupDataChannelCallbacks(this.status.dc);
        }
    }

    private acceptRemoteDataChannel(event: RTCDataChannelEvent): Promise<void> {
        if (event.channel.label !== this.input.dataChannelName) {
            return Promise.resolve();
        }
        if (this.status.dc && this.status.dc !== event.channel) {
            this.closeDataChannelIfPresent();
        }
        this.status.dc = event.channel;
        this.setupDataChannelCallbacks(event.channel);
        return Promise.resolve();
    }

    private setupDataChannelCallbacks(dataChannel: RTCDataChannel): void {
        this.configureDataChannel(dataChannel);
        dataChannel.onopen = () => this.openDataChannel(dataChannel);
        dataChannel.onmessage = (event) => this.dispatchDataChannelMessage(dataChannel, event);
        dataChannel.onclose = () => this.closeDataChannel(dataChannel);
        dataChannel.onerror = () => this.failDataChannel(dataChannel);
    }

    private async openDataChannel(dataChannel: RTCDataChannel): Promise<void> {
        if (this.status.dc !== dataChannel) {
            return;
        }
        this.status.state = RtcSessionState.Open;
        this.resolveOpenWaiters(true);
        for (const callback of this.clientCallbacks.values()) {
            try {
                await callback.onOpen?.();
            }
            catch (error) {
                console.error('Callback onOpen failed', toError(error));
            }
        }
    }

    private async dispatchDataChannelMessage(
        dataChannel: RTCDataChannel,
        event: MessageEvent<RtcDataChannelPayload>
    ): Promise<void> {
        if (this.status.dc !== dataChannel) {
            return;
        }
        const rawProcessed = await this.dispatchRawMessage(event);
        this.countReceived(event);
        if (this.onMessageCallbacks.size === 0) {
            if (!rawProcessed) {
                console.warn('Received message with no registered callbacks');
            }
            return;
        }

        await this.dispatchApplicationMessage(dataChannel, event, rawProcessed);
    }

    private async dispatchApplicationMessage(
        dataChannel: RTCDataChannel,
        event: MessageEvent<RtcDataChannelPayload>,
        rawProcessed: boolean
    ): Promise<void> {
        let isProcessed = rawProcessed;
        let message: RtcApplicationMessage = event.data;
        let hasDecoded = false;
        for (const subscription of this.onMessageCallbacks.values()) {
            if (this.status.dc !== dataChannel) {
                return;
            }
            try {
                if (subscription.callback.maxMessageBytes !== undefined) {
                    const validated = validateJsonMessageSize(event.data, subscription.callback.maxMessageBytes);
                    if (validated.left) {
                        await subscription.callback.onRejected?.(validated.left, event);
                        isProcessed = true;
                        continue;
                    }
                }
                if (!hasDecoded) {
                    try {
                        message = this.decodeApplicationMessage(event.data);
                        hasDecoded = true;
                    }
                    catch {
                        if (!rawProcessed) {
                            console.error('Failed to parse WebRTC JSON message');
                        }
                        return;
                    }
                }
                const messageType = typeof message === 'object' && message !== null && 'type' in message
                    ? message.type
                    : undefined;
                if (messageType && subscription.type !== messageType) {
                    continue;
                }
                await subscription.callback.onMessage(message, event);
                isProcessed = true;
            }
            catch (error) {
                console.error('Callback onMessage failed', toError(error));
            }
        }
        if (!isProcessed) {
            console.warn('Received message with unknown callback type');
        }
    }

    private decodeApplicationMessage(data: RtcDataChannelPayload): RtcApplicationMessage {
        if (typeof data !== 'string') {
            return data;
        }
        // Without a reviver JSON.parse produces only JSON values; domain validation remains with the receiver.
        return JSON.parse(data) as ApiJsonValue;
    }

    private async closeDataChannel(dataChannel: RTCDataChannel): Promise<void> {
        if (this.status.dc !== dataChannel) {
            return;
        }
        this.status.state = RtcSessionState.Closed;
        this.resolveOpenWaiters(false);
        this.sendQueue.clear();
        this.clearDataChannelReference(dataChannel);
        await this.notifyCloseCallbacks();
    }

    private async failDataChannel(dataChannel: RTCDataChannel): Promise<void> {
        if (this.status.dc !== dataChannel) {
            return;
        }
        this.status.state = RtcSessionState.Failed;
        this.resolveOpenWaiters(false);
        this.sendQueue.clear();
        this.clearDataChannelReference(dataChannel);
        await this.notifyErrorCallbacks();
        await this.notifyCloseCallbacks();
    }

    isOpen() {
        return this.status.state === RtcSessionState.Open;
    }

    isReadyToConnect() {
        return this.status.state === RtcSessionState.Idle ||
            this.status.state === RtcSessionState.Failed ||
            this.status.state === RtcSessionState.Closed;
    }

    private clearTerminalDataChannelReference(): void {
        const dc = this.status.dc;
        if (
            !dc ||
            (
                this.status.state !== RtcSessionState.Closed &&
                this.status.state !== RtcSessionState.Failed &&
                dc.readyState !== 'closing' &&
                dc.readyState !== 'closed'
            )
        ) {
            return;
        }

        this.clearDataChannelReference(dc);
    }

    private clearDataChannelReference(dc: RTCDataChannel): void {
        dc.onmessage = null;
        dc.onopen = null;
        dc.onclose = null;
        dc.onerror = null;
        dc.onbufferedamountlow = null;

        if (this.status.dc === dc) {
            this.status.dc = undefined;
        }
    }

    private async notifyCloseCallbacks(): Promise<void> {
        for (const callback of this.clientCallbacks.values()) {
            try {
                await callback.onClose?.();
            }
            catch (e) {
                console.error('Callback onClose failed', toError(e));
            }
        }
    }

    private async notifyErrorCallbacks(): Promise<void> {
        for (const callback of this.clientCallbacks.values()) {
            try {
                await callback.onError?.();
            }
            catch (e) {
                console.error('Callback onError failed', toError(e));
            }
        }
    }

    private dataChannelCallbackId(): string {
        return `${this.input.peerId}:${this.input.dataChannelName}`;
    }

    private resolveOpenWaiters(isOpen: boolean): void {
        const waiters = this.openWaiters.splice(0);
        for (const waiter of waiters) {
            if (waiter.timeout) {
                clearTimeout(waiter.timeout);
            }
            waiter.resolve(isOpen);
        }
    }

    private resolveOpenWaiter(
        waiter: RtcDataChannelOpenWaiter,
        isOpen: boolean
    ): void {
        const index = this.openWaiters.indexOf(waiter);
        if (index < 0) {
            return;
        }

        this.openWaiters.splice(index, 1);
        if (waiter.timeout) {
            clearTimeout(waiter.timeout);
        }
        waiter.resolve(isOpen);
    }

    private sendRawOrThrow(data: RtcDataChannelPayload): void {
        const result = this.sendRaw(data);
        if (result.status === 'closed') {
            console.error(
                'Data channel not open for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer',
                new Error().stack ?? ''
            );
            throw new Error('Data channel not open');
        }
    }

    private configureDataChannel(dc: RTCDataChannel): void {
        if (this.input.binaryType) {
            dc.binaryType = this.input.binaryType;
        }

        dc.bufferedAmountLowThreshold = this.flowControlPolicy
            .lowWatermarkBytes;
        dc.onbufferedamountlow = () => this.flushQueuedSends();
    }

    private async dispatchRawMessage(event: MessageEvent<RtcDataChannelPayload>): Promise<boolean> {
        let isProcessed = false;
        for (const callback of this.onRawMessageCallbacks.values()) {
            try {
                await callback.onMessage(event.data, event);
                isProcessed = true;
            }
            catch (e) {
                console.error('Callback onRawMessage failed', toError(e));
            }
        }

        return isProcessed;
    }

    private enqueueBackPressuredSend(
        payload: RtcDataChannelPayload,
        options: RtcDataChannelSendOptions
    ): RtcDataChannelSendResult {
        const policy = this.flowControlPolicy;
        const createdAtEpochMs = (options.now ?? this.now)();
        const queued: RtcDataChannelSendQueue.QueuedSend<RtcDataChannelPayload> = {
            payload,
            key: options.key,
            maxAgeMs: options.maxAgeMs,
            createdAtEpochMs
        };

        const offerResult = this.sendQueue.offer(queued, policy);
        if (offerResult.droppedOldest) {
            this.counters.droppedOldest += 1;
        }

        return this.recordSendResult(
            offerResult.status,
            offerResult.reason,
            offerResult.key
        );
    }

    private flushQueuedSends(): void {
        const dc = this.status.dc;
        if (!dc || dc.readyState !== 'open') {
            return;
        }

        while (!this.isBackPressured(dc)) {
            const next = this.sendQueue.shift();
            if (!next) {
                return;
            }

            if (this.isStale(next)) {
                this.counters.droppedStale += 1;
                continue;
            }

            this.sendPayload(dc, next.payload);
            this.counters.flushed += 1;
            this.counters.sent += 1;
        }
    }

    private sendPayload(
        dc: RTCDataChannel,
        payload: RtcDataChannelPayload
    ): void {
        if (typeof payload === 'string') {
            dc.send(payload);
            return;
        }

        if (payload instanceof ArrayBuffer) {
            dc.send(payload);
            return;
        }

        if (ArrayBuffer.isView(payload)) {
            dc.send(payload);
            return;
        }

        dc.send(payload);
    }

    private isStale(queued: RtcDataChannelSendQueue.QueuedSend<RtcDataChannelPayload>): boolean {
        if (queued.maxAgeMs === undefined) {
            return false;
        }

        return this.now() - queued.createdAtEpochMs > queued.maxAgeMs;
    }

    private isBackPressured(dc: RTCDataChannel): boolean {
        return dc.bufferedAmount >= this.flowControlPolicy.highWatermarkBytes;
    }

    private recordSendResult(
        status: RtcDataChannelSendResult['status'],
        reason: string | undefined,
        key: string | undefined
    ): RtcDataChannelSendResult {
        this.counters[status] += 1;
        return {
            status,
            reason,
            key,
            bufferedAmount: this.status.dc?.bufferedAmount ?? 0
        };
    }

    private countReceived(event: MessageEvent<RtcDataChannelPayload>): void {
        this.counters.receivedRaw += 1;
        if (typeof event.data === 'string') {
            this.counters.receivedString += 1;
            return;
        }

        this.counters.receivedBinary += 1;
    }
}
