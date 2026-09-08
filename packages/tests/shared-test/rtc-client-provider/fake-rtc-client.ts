import type { RtcClient } from '../../../shared-test/black-box-runner/rtc-provider.ts';

export interface FakeRtcClient extends RtcClient {
    connected: boolean;
    closed: boolean;
    sentMessages: unknown[];
    emitMessage: (message: unknown) => void;
    emitClose: (event: unknown) => void;
}

export function createFakeRtcClient(): FakeRtcClient {
    let messageHandler: ((message: unknown) => void) | undefined;
    let closeHandler: ((event: unknown) => void) | undefined;

    return {
        connected: false,
        closed: false,
        sentMessages: [],

        async connect() {
            this.connected = true;
        },

        async send(message: unknown) {
            this.sentMessages.push(message);
        },

        async close() {
            this.closed = true;
            closeHandler?.({
                reason: 'closed by fake client'
            });
        },

        onMessage(handler: (message: unknown) => void) {
            messageHandler = handler;
        },

        onClose(handler: (event: unknown) => void) {
            closeHandler = handler;
        },

        emitMessage(message: unknown) {
            messageHandler?.(message);
        },

        emitClose(event: unknown) {
            closeHandler?.(event);
        }
    };
}
