import { OnQRtcMessageCallback, QRtcClientCallbacks } from './QRtcClientCallbacks.ts';
import { QRtcPeerConnection } from './QRtcPeerConnection.ts';

enum RtcSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

enum RtcRole {
    None = 'None',
    Initiator = 'Initiator',
    Receiver = 'Receiver',
}

export type RtcDataChannelInputDto = {
    readonly peerId: string
    readonly dataChannelName: string
    readonly dataChannelInit?: RTCDataChannelInit
    readonly binaryType?: BinaryType
    readonly flowControl?: RtcDataChannelFlowControlPolicy
}

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

export type RtcDataChannelFlowControlPolicy = Readonly<{
    highWatermarkBytes?: number;
    lowWatermarkBytes?: number;
    overflow?: RtcDataChannelOverflowMode;
    maxQueueItems?: number;
}>;

export type RtcDataChannelSendOptions = Readonly<{
    key?: string;
    maxAgeMs?: number;
    now?: () => number;
}>;

export type RtcDataChannelSendResult = Readonly<{
    status: 'sent' | 'queued' | 'dropped' | 'replaced' | 'closed';
    reason?: string;
    key?: string;
    bufferedAmount: number;
}>;

export type RtcDataChannelCounters = Readonly<{
    sent: number;
    queued: number;
    dropped: number;
    replaced: number;
    closed: number;
    flushed: number;
    droppedOldest: number;
    droppedStale: number;
    receivedRaw: number;
    receivedString: number;
    receivedBinary: number;
}>;

export type RtcDataChannelHealth = Readonly<{
    peerId: string;
    label: string;
    state?: string;
    role: string;
    readyState?: RTCDataChannelState;
    binaryType?: BinaryType;
    bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    queuedItemCount: number;
    rawCallbackCount: number;
    messageCallbackCount: number;
    lifecycleCallbackCount: number;
    flowControl: Required<RtcDataChannelFlowControlPolicy>;
    counters: RtcDataChannelCounters;
}>;

export type RtcRawMessageCallback = {
    onMessage: (data: MessageEvent['data'], ev: MessageEvent) => Promise<void>;
};

type QRtcDataChannelStatus = {
    state: RtcSessionState | undefined
    role: RtcRole
    dc: RTCDataChannel | undefined
}

type QRtcMessageCallbackDto = {
    readonly callback: OnQRtcMessageCallback,
    readonly type: string
}

type QueuedSend = {
    payload: RtcDataChannelPayload;
    key?: string;
    maxAgeMs?: number;
    createdAtEpochMs: number;
}

type RtcDataChannelOpenWaiter = {
    resolve: (isOpen: boolean) => void;
    timeout: ReturnType<typeof setTimeout> | undefined;
}

export const DEFAULT_RTC_DATA_CHANNEL_OPEN_TIMEOUT_MS = 5_000;

const DEFAULT_FLOW_CONTROL: Required<RtcDataChannelFlowControlPolicy> = {
    highWatermarkBytes: 64 * 1024,
    lowWatermarkBytes: 16 * 1024,
    overflow: 'drop-new',
    maxQueueItems: 32,
};

const emptyCounters = (): Record<keyof RtcDataChannelCounters, number> => ({
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
    receivedBinary: 0,
});

export class QRtcDataChannel {
    public readonly status: QRtcDataChannelStatus;

    private readonly clientCallbacks = new Map<string, QRtcClientCallbacks>();
    private readonly onMessageCallbacks = new Map<string, QRtcMessageCallbackDto>();
    private readonly onRawMessageCallbacks = new Map<string, RtcRawMessageCallback>();
    private readonly sendQueue: QueuedSend[] = [];
    private readonly openWaiters: RtcDataChannelOpenWaiter[] = [];
    private readonly counters = emptyCounters();

    constructor(
        public readonly peerConnection: QRtcPeerConnection,
        public readonly input: RtcDataChannelInputDto
    ) {
        this.status = {
            state: RtcSessionState.Idle,
            role: RtcRole.None,
            dc: undefined
        };
    }

    reset() {
        this.resolveOpenWaiters(false);
        this.closeDataChannelIfPresent();
        this.sendQueue.length = 0;
        this.status.state = RtcSessionState.Idle;
    }

    clearCallbacks() {
        this.clientCallbacks.clear();
        this.onMessageCallbacks.clear();
        this.onRawMessageCallbacks.clear();
    }

    private closeDataChannelIfPresent() {
        if (this.status?.dc) {
            try {
                const dc = this.status.dc;

                dc.close();
                this.clearDataChannelReference(dc);
            } catch (e) {
                console.error('Error closing data channel. Ignoring ...', e);
            }
        }
    }

    // ----------------------------------------
    // Callback registry
    // ----------------------------------------

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
                type: type
            }
        );

        return this;
    }

    removeOnRtcMessageCallbackById(id: string): boolean {
        return this.onMessageCallbacks.delete(id);
    }

    // ----------------------------------------
    // Send data on data channel
    // ----------------------------------------
    sendAsJsonString(data: string): Promise<void> {
        this.sendRawOrThrow(data);
        return Promise.resolve();
    }

    // ----------------------------------------
    // Send data on data channel
    // ----------------------------------------
    send(data: object): Promise<void> {
        this.sendRawOrThrow(JSON.stringify(data));
        return Promise.resolve();
    }

    sendJson(
        data: unknown,
        options: RtcDataChannelSendOptions = {},
    ): RtcDataChannelSendResult {
        return this.sendRaw(JSON.stringify(data), options);
    }

    sendBinary(
        data: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
        options: RtcDataChannelSendOptions = {},
    ): RtcDataChannelSendResult {
        return this.sendRaw(data, options);
    }

    sendRaw(
        data: RtcDataChannelPayload,
        options: RtcDataChannelSendOptions = {},
    ): RtcDataChannelSendResult {
        const dc = this.status.dc;
        if (!dc || dc.readyState !== 'open') {
            return this.toSendResult('closed', 'Data channel not open', options.key);
        }

        this.flushQueuedSends();

        if (this.isBackPressured(dc)) {
            return this.handleBackPressure(data, options);
        }

        this.sendPayload(dc, data);
        return this.toSendResult('sent', undefined, options.key);
    }

    onRawMessageDo(
        id: string,
        callback: RtcRawMessageCallback,
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
                this.flowControl().lowWatermarkBytes,
            queuedItemCount: this.sendQueue.length,
            rawCallbackCount: this.onRawMessageCallbacks.size,
            messageCallbackCount: this.onMessageCallbacks.size,
            lifecycleCallbackCount: this.clientCallbacks.size,
            flowControl: this.flowControl(),
            counters: { ...this.counters },
        };
    }

    waitUntilOpen(
        timeoutMs: number = DEFAULT_RTC_DATA_CHANNEL_OPEN_TIMEOUT_MS,
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
                timeout: undefined,
            };

            waiter.timeout = setTimeout(
                () => this.resolveOpenWaiter(waiter, false),
                timeoutMs,
            );
            this.openWaiters.push(waiter);
        });
    }

    // ----------------------------------------
    // Connection logic
    // ----------------------------------------

    connect(isInitiator: boolean) {
        if (this.isOpen() || !this.isReadyToConnect()) {
            console.log('Ignoring connect, data connection is in progress and not ready to connect: ' + this.status.state + ' role ' + this.status.role +
                ' peerId ' + this.input.peerId + ' dataChannelName ' + this.input.dataChannelName);
            return;
        }

        // Note: Order matters here
        this.clearTerminalDataChannelReference();
        this.status.state = RtcSessionState.Connecting;
        this.status.role = isInitiator ? RtcRole.Initiator : RtcRole.Receiver;

        this.peerConnection
            .onDataChannelDo(
                this.dataChannelCallbackId(),
                event => {

                    if (event.channel.label !== this.input.dataChannelName) {
                        return Promise.resolve();
                    }
                    if (this.status.dc && this.status.dc !== event.channel) {
                        this.closeDataChannelIfPresent();
                    }

                    this.status.dc = event.channel;

                    this.setupDataChannelCallbacks(this.status.dc);
                    console.log('Data channel created: ' + this.status.dc.label);

                    return Promise.resolve();
                }
            );

        if (isInitiator) {
            this.status.dc = this.input.dataChannelInit === undefined
                ? this.peerConnection.createDataChannel(this.input.dataChannelName)
                : this.peerConnection.createDataChannel(
                    this.input.dataChannelName,
                    this.input.dataChannelInit,
                );
            console.log('Data channel created: ' + this.status.dc.label);

            this.setupDataChannelCallbacks(this.status.dc);
        } else {
            console.log('Waiting for data channel to be created for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer');
        }
    }

    private setupDataChannelCallbacks(dc: RTCDataChannel) {
        this.configureDataChannel(dc);

        dc.onopen = () => {
            if (this.status.dc !== dc) {
                console.warn('Received data channel open event for different data channel: ' + dc.label + ' vs ' + this.status.dc?.label);
                return;
            }

            console.log('Data channel open for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer');

            this.status.state = RtcSessionState.Open;
            this.resolveOpenWaiters(true);

            for (const callback of this.clientCallbacks.values()) {
                try {
                    callback.onOpen?.();
                } catch (e) {
                    console.error('Callback onOpen failed:', e);
                }
            }
        };

        dc.onmessage = async event => {
            if (this.status.dc !== dc) {
                console.warn('Received data message for a different channel: ' + dc.label + ' vs ' + this.status.dc?.label);
                return;
            }

            // console.log('WebRTC Received: ' + event.data);

            let isProcessed = await this.dispatchRawMessage(event);
            this.countReceived(event.data);
            if (this.onMessageCallbacks.size === 0) {
                if (!isProcessed) {
                    console.warn('Received message with no registered callbacks');
                }
                return;
            }

            const msg =
                typeof event.data == 'string'
                    ? this.parseJsonMessage(event.data, isProcessed)
                    : event.data;
            if (msg === undefined) {
                return;
            }

            for (const dto of this.onMessageCallbacks.values()) {
                try {
                    if (dto.type === msg.type) {
                        await dto.callback.onMessage(msg, event);
                        isProcessed = true;
                    } else if (!msg.type) {
                        await dto.callback.onMessage(msg, event);
                        isProcessed = true;
                    }
                } catch (e) {
                    console.error('Callback onMessage failed:', e);
                }
            }

            if (!isProcessed) {
                console.warn('Received message with unknown callback type: ' + msg.type);
            }
        };

        dc.onclose = async () => {
            if (this.status.dc !== dc) {
                console.warn('Received data channel close event for different data channel: ' + dc.label + ' vs ' + this.status.dc?.label);
                return;
            }

            console.error('Data channel closed for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer', new Error().stack ?? '');

            this.status.state = RtcSessionState.Closed;
            this.resolveOpenWaiters(false);
            this.clearDataChannelReference(dc);

            for (const callback of this.clientCallbacks.values()) {
                try {
                    await callback.onClose?.();
                } catch (e) {
                    console.error('Callback onClose failed:', e);
                }
            }
        };

        dc.onerror = async () => {
            if (this.status.dc !== dc) {
                console.warn('Received data channel error event for different data channel: ' + dc.label + ' vs ' + this.status.dc?.label);
                return;
            }

            console.log('Data channel error for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer');

            this.status.state = RtcSessionState.Failed;
            this.resolveOpenWaiters(false);

            for (const callback of this.clientCallbacks.values()) {
                try {
                    await callback.onError?.();
                } catch (e) {
                    console.error('Callback onError failed:', e);
                }
            }
        };
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
        isOpen: boolean,
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
        const result = this.sendRaw(data, { now: () => Date.now() });
        if (result.status === 'closed') {
            console.error('Data channel not open for ' + this.input.dataChannelName + ' and ' + this.input.peerId + ' peer', new Error().stack ?? '');
            throw new Error('Data channel not open');
        }
    }

    private configureDataChannel(dc: RTCDataChannel): void {
        if (this.input.binaryType) {
            dc.binaryType = this.input.binaryType;
        }

        dc.bufferedAmountLowThreshold = this.flowControl()
            .lowWatermarkBytes;
        dc.onbufferedamountlow = () => this.flushQueuedSends();
    }

    private async dispatchRawMessage(event: MessageEvent): Promise<boolean> {
        let isProcessed = false;
        for (const callback of this.onRawMessageCallbacks.values()) {
            try {
                await callback.onMessage(event.data, event);
                isProcessed = true;
            } catch (e) {
                console.error('Callback onRawMessage failed:', e);
            }
        }

        return isProcessed;
    }

    private parseJsonMessage(
        data: string,
        alreadyProcessed: boolean,
    ): unknown | undefined {
        try {
            return JSON.parse(data);
        } catch (error) {
            if (!alreadyProcessed) {
                console.error('Failed to parse WebRTC JSON message', error);
            }
            return undefined;
        }
    }

    private handleBackPressure(
        payload: RtcDataChannelPayload,
        options: RtcDataChannelSendOptions,
    ): RtcDataChannelSendResult {
        const policy = this.flowControl();
        const createdAtEpochMs = (options.now ?? (() => Date.now()))();
        const queued: QueuedSend = {
            payload,
            key: options.key,
            maxAgeMs: options.maxAgeMs,
            createdAtEpochMs,
        };

        switch (policy.overflow) {
            case 'drop-new':
                return this.toSendResult('dropped', 'Back pressure', options.key);
            case 'replace-by-key':
                if (options.key) {
                    const index = this.sendQueue.findIndex((item) =>
                        item.key === options.key
                    );
                    if (index >= 0) {
                        this.sendQueue[index] = queued;
                        return this.toSendResult(
                            'replaced',
                            'Replaced queued payload',
                            options.key,
                        );
                    }
                }

                return this.enqueueQueuedSend(queued, policy, 'Queued payload');
            case 'drop-old':
                if (this.sendQueue.length >= policy.maxQueueItems) {
                    this.sendQueue.shift();
                    this.counters.droppedOldest += 1;
                }
                return this.enqueueQueuedSend(
                    queued,
                    policy,
                    'Queued payload after dropping oldest',
                );
            case 'queue':
                return this.enqueueQueuedSend(queued, policy, 'Queued payload');
        }
    }

    private enqueueQueuedSend(
        queued: QueuedSend,
        policy: Required<RtcDataChannelFlowControlPolicy>,
        reason: string,
    ): RtcDataChannelSendResult {
        if (this.sendQueue.length >= policy.maxQueueItems) {
            return this.toSendResult('dropped', 'Queue full', queued.key);
        }

        this.sendQueue.push(queued);
        return this.toSendResult('queued', reason, queued.key);
    }

    private flushQueuedSends(): void {
        const dc = this.status.dc;
        if (!dc || dc.readyState !== 'open') {
            return;
        }

        while (this.sendQueue.length > 0 && !this.isBackPressured(dc)) {
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
        payload: RtcDataChannelPayload,
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

    private isStale(queued: QueuedSend): boolean {
        if (queued.maxAgeMs === undefined) {
            return false;
        }

        return Date.now() - queued.createdAtEpochMs > queued.maxAgeMs;
    }

    private isBackPressured(dc: RTCDataChannel): boolean {
        return dc.bufferedAmount >= this.flowControl().highWatermarkBytes;
    }

    private flowControl(): Required<RtcDataChannelFlowControlPolicy> {
        return {
            ...DEFAULT_FLOW_CONTROL,
            ...(this.input.flowControl ?? {}),
        };
    }

    private toSendResult(
        status: RtcDataChannelSendResult['status'],
        reason: string | undefined,
        key: string | undefined,
    ): RtcDataChannelSendResult {
        this.counters[status] += 1;
        return {
            status,
            reason,
            key,
            bufferedAmount: this.status.dc?.bufferedAmount ?? 0,
        };
    }

    private countReceived(data: MessageEvent['data']): void {
        this.counters.receivedRaw += 1;
        if (typeof data === 'string') {
            this.counters.receivedString += 1;
            return;
        }

        this.counters.receivedBinary += 1;
    }
}
