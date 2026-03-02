export interface QRtcClientCallbacks {
    onOpen?: () => Promise<void>;
    onError?: () => Promise<void>;
    onClose?: () => Promise<void>;
}

export interface OnQRtcMessageCallback {
    onMessage: (data: unknown, ev: MessageEvent) => Promise<void>
}