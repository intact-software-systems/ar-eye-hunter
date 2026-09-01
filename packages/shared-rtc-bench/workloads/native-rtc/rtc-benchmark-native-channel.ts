export class RtcBenchmarkNativeChannel extends EventTarget implements RTCDataChannel {
    readonly label: string;
    readonly id = 1;
    readonly protocol: string;
    readonly negotiated: boolean;
    readonly ordered: boolean;
    readonly maxPacketLifeTime: number | null;
    readonly maxRetransmits: number | null;
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'arraybuffer';
    readyState: RTCDataChannelState = 'connecting';
    onopen: RTCDataChannel['onopen'] = null;
    onclose: RTCDataChannel['onclose'] = null;
    onclosing: RTCDataChannel['onclosing'] = null;
    onerror: RTCDataChannel['onerror'] = null;
    onmessage: RTCDataChannel['onmessage'] = null;
    onbufferedamountlow: RTCDataChannel['onbufferedamountlow'] = null;
    readonly sent: (string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>)[] = [];

    constructor(label: string, init: RTCDataChannelInit = {}) {
        super();
        this.label = label;
        this.protocol = init.protocol ?? '';
        this.negotiated = init.negotiated ?? false;
        this.ordered = init.ordered ?? true;
        this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
        this.maxRetransmits = init.maxRetransmits ?? null;
    }

    async emitOpen(): Promise<void> {
        this.readyState = 'open';
        await this.onopen?.call(this, new Event('open'));
    }

    close(): void {
        this.readyState = 'closed';
    }

    async emitClose(): Promise<void> {
        this.readyState = 'closed';
        await this.onclose?.call(this, new Event('close'));
    }

    async emitError(): Promise<void> {
        this.readyState = 'closed';
        await this.onerror?.call(this, new NativeRtcErrorEvent());
    }

    async emitBufferedAmountLow(): Promise<void> {
        await this.onbufferedamountlow?.call(this, new Event('bufferedamountlow'));
    }

    attachedHandlerCount(): number {
        return [this.onmessage, this.onopen, this.onclose, this.onerror, this.onbufferedamountlow]
            .filter((handler) => handler !== null).length;
    }

    send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
        if (this.readyState !== 'open') {
            throw new Error('Native channel is not open');
        }
        this.sent.push(data);
    }
}

class NativeRtcError extends DOMException implements RTCError {
    readonly errorDetail = 'data-channel-failure';
    readonly receivedAlert = null;
    readonly sentAlert = null;
    readonly sctpCauseCode = null;
    readonly sdpLineNumber = null;
    readonly httpRequestStatusCode = null;

    constructor() {
        super('Simulated native data-channel failure', 'OperationError');
    }
}

class NativeRtcErrorEvent extends Event implements RTCErrorEvent {
    readonly error: RTCError = new NativeRtcError();

    constructor() {
        super('error');
    }
}
