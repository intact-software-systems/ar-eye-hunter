import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarRemoteStream } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';

const RALLAR_REMOTE_STREAM_CALLBACK_ID = 'rallar:remote-stream';

export interface BrowserRemoteMediaStreamRuntimeInput {
    readonly readMiddleware: () => ApiMiddleware | undefined;
}

export class BrowserRemoteMediaStreamRuntime {
    private readonly listeners = new Set<
        (
            remote: RallarRemoteStream
        ) => void | Promise<void>
    >();
    private callbackRegistered = false;
    private readonly input: BrowserRemoteMediaStreamRuntimeInput;

    public constructor(input: BrowserRemoteMediaStreamRuntimeInput) {
        this.input = input;
    }

    public onRemoteStream(
        listener: (remote: RallarRemoteStream) => void | Promise<void>
    ): RallarUnsubscribe {
        this.listeners.add(listener);
        this.attach();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.detach();
            }
        };
    }

    public attach(): void {
        if (this.callbackRegistered || this.listeners.size === 0) {
            return;
        }
        const context = this.input.readMiddleware();
        if (!context) {
            return;
        }
        context.middleware.rtcRxStreamer.onRemoteStreamDo(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
            async (peerId, stream, event) => {
                await this.notifyListeners({ peerId, stream, event });
            }
        );
        this.callbackRegistered = true;
    }

    public detach(context = this.input.readMiddleware()): void {
        if (!context || !this.callbackRegistered) {
            return;
        }
        context.middleware.rtcRxStreamer.removeOnRemoteStreamCallbackById(
            RALLAR_REMOTE_STREAM_CALLBACK_ID
        );
        this.callbackRegistered = false;
    }

    public stopForDisconnect(context?: ApiMiddleware): void {
        this.detach(context);
        this.callbackRegistered = false;
    }

    private async notifyListeners(remote: RallarRemoteStream): Promise<void> {
        await Promise.all([...this.listeners].map(async (listener) => {
            try {
                await listener(remote);
            }
            catch (error) {
                console.error('Error notifying Rallar remote stream listener', error);
            }
        }));
    }
}
