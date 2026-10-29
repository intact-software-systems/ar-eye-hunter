import type { RallarRemoteStream } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { AsyncNotifications } from '@shared/cache/async-notifications.ts';
import type { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';

const RALLAR_REMOTE_STREAM_CALLBACK_ID = 'rallar:remote-stream';

export namespace BrowserRemoteMediaStreamRuntime {
    export interface StreamSubscriptions {
        onRemoteStreamDo(
            id: string,
            callback: Parameters<WebRtcRxStreamerService['onRemoteStreamDo']>[1]
        ): void;
        removeOnRemoteStreamCallbackById(id: string): boolean;
    }

    export interface Connection {
        readonly middleware: {
            readonly rtcRxStreamer: StreamSubscriptions;
        };
    }

    export interface Input {
        readMiddleware(): Connection | undefined;
    }
}

export class BrowserRemoteMediaStreamRuntime {
    private readonly notifications = new AsyncNotifications<RallarRemoteStream>();
    private callbackRegistered = false;
    private readonly input: BrowserRemoteMediaStreamRuntime.Input;

    public constructor(input: BrowserRemoteMediaStreamRuntime.Input) {
        this.input = input;
    }

    public onRemoteStream(
        listener: (remote: RallarRemoteStream) => void | Promise<void>
    ): RallarUnsubscribe {
        const subscription = this.notifications.subscribe(listener);
        this.attach();
        return () => {
            subscription.unsubscribe();
            if (this.notifications.size === 0) {
                this.detach();
            }
        };
    }

    public attach(): void {
        if (this.callbackRegistered || this.notifications.size === 0) {
            return;
        }
        const context = this.input.readMiddleware();
        if (!context) {
            return;
        }
        context.middleware.rtcRxStreamer.onRemoteStreamDo(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
            async (peerId, stream, event) => {
                await this.notifications.publishConcurrent({ peerId, stream, event }, (error) => {
                    console.error('Error notifying Rallar remote stream listener', error);
                });
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

    public stopForDisconnect(context?: BrowserRemoteMediaStreamRuntime.Connection): void {
        this.detach(context);
        this.callbackRegistered = false;
    }
}
