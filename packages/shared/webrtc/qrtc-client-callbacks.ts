import type { JsonMessageRejection } from '../api/json-message-validation.ts';

export interface QRtcClientCallbacks {
    onOpen?: () => Promise<void>;
    onError?: () => Promise<void>;
    onClose?: () => Promise<void>;
}

export interface OnQRtcMessageCallback {
    readonly maxMessageBytes?: number;
    onRejected?: (reason: JsonMessageRejection, ev: MessageEvent) => Promise<void>;
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>;
}
