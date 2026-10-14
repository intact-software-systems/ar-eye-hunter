import type {
    RallarBlackBoxControlSocketEvent,
    RallarBlackBoxControlSocketEventType,
    RallarBlackBoxControlSocketListener
} from '../../../shared-test/rallar-bb-test/control-client.ts';

export class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<RallarBlackBoxControlSocketEventType, Set<RallarBlackBoxControlSocketListener>>();

    addEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<RallarBlackBoxControlSocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.publishEvent('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.publishEvent('open', {});
    }

    publishMessage(messageText: string): void {
        this.publishEvent('message', { data: messageText });
    }

    publishError(event: RallarBlackBoxControlSocketEvent): void {
        this.publishEvent('error', event);
    }

    private publishEvent(type: RallarBlackBoxControlSocketEventType, event: RallarBlackBoxControlSocketEvent): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }
}
