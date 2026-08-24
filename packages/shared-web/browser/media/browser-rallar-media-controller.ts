import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { BrowserLocalMediaSourceRuntime } from '@shared-web/browser/media/browser-local-media-source-runtime.ts';
import { BrowserRemoteMediaStreamRuntime } from '@shared-web/browser/media/browser-remote-media-stream-runtime.ts';
import type {
    RallarCameraSourceStartOptions,
    RallarMediaFacade,
    RallarMediaSourceKind,
    RallarMediaSourceStatus,
    RallarMicrophoneSourceStartOptions,
    RallarScreenSourceStartOptions
} from '@shared-web/browser/rallar-media-facade.ts';

export interface BrowserRallarMediaControllerOptions {
    readonly connect: () => Promise<ApiMiddleware>;
    readonly readMiddleware: () => ApiMiddleware | undefined;
}

export interface RallarMediaPort {
    readonly operations: RallarMediaFacade;
    readSourceStatus(kind: RallarMediaSourceKind): RallarMediaSourceStatus | undefined;
    readSourceStatuses(): readonly RallarMediaSourceStatus[];
    attachRemoteStreamCallback(): void;
    detachRemoteStreamCallback(context?: ApiMiddleware): void;
    stopForDisconnect(context?: ApiMiddleware): void;
}

export class BrowserRallarMediaController implements RallarMediaPort {
    public readonly operations: RallarMediaFacade;

    private readonly options: BrowserRallarMediaControllerOptions;
    private readonly localSources: BrowserLocalMediaSourceRuntime;
    private readonly remoteStreams: BrowserRemoteMediaStreamRuntime;

    public constructor(options: BrowserRallarMediaControllerOptions) {
        this.options = options;
        this.localSources = new BrowserLocalMediaSourceRuntime({
            connect: options.connect
        });
        this.remoteStreams = new BrowserRemoteMediaStreamRuntime({
            readMiddleware: options.readMiddleware
        });
        this.operations = this.createOperations();
    }

    public readSourceStatus(
        kind: RallarMediaSourceKind
    ): RallarMediaSourceStatus | undefined {
        return this.localSources.readStatus(kind);
    }

    public readSourceStatuses(): readonly RallarMediaSourceStatus[] {
        return this.localSources.readStatuses();
    }

    public attachRemoteStreamCallback(): void {
        this.remoteStreams.attach();
    }

    public detachRemoteStreamCallback(context?: ApiMiddleware): void {
        this.remoteStreams.detach(context);
    }

    public stopForDisconnect(context?: ApiMiddleware): void {
        this.remoteStreams.stopForDisconnect(context);
        this.localSources.stopForDisconnect();
    }

    private createOperations(): RallarMediaFacade {
        return {
            microphone: this.localSources
                .createController<RallarMicrophoneSourceStartOptions>('microphone'),
            camera: this.localSources
                .createController<RallarCameraSourceStartOptions>('camera'),
            screen: this.localSources
                .createController<RallarScreenSourceStartOptions>('screen'),
            setLocalStream: async (stream) => await this.localSources.setLocalStream(stream),
            setAudioEnabled: async (enabled) => await this.localSources.setAudioEnabled(enabled),
            setVideoEnabled: async (enabled) => await this.localSources.setVideoEnabled(enabled),
            stopLocal: async (kind) => await this.localSources.stopLocal(kind),
            setPolicy: async (policy) => {
                const context = await this.options.connect();
                context.middleware.rtcRxStreamer.setMediaPolicy(policy);
            },
            onRemoteStream: (listener) => this.remoteStreams.onRemoteStream(listener)
        };
    }
}
