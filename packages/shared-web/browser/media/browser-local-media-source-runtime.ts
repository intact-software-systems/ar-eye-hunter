import {
    browserLocalMediaSourceKinds,
    captureBrowserLocalMediaSource,
    composeBrowserLocalMediaStream,
    emptyBrowserMediaStream,
    hasActiveBrowserMediaStreamTrack,
    readBrowserMediaSourceTracks,
    readBrowserMediaStreamTracks,
    toBrowserLocalMediaSourceStatus,
    toBrowserMediaErrorMessage,
    type BrowserLocalMediaSourceStartOptions,
    type BrowserLocalMediaSourceState
} from '@shared-web/browser/media/browser-local-media-source-support.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarMediaSourceController,
    RallarMediaSourceHandle,
    RallarMediaSourceKind,
    RallarMediaSourceStatus
} from '@shared-web/browser/rallar-media-facade.ts';

export namespace BrowserLocalMediaSourceRuntime {
    export interface Input {
        connect(): Promise<ApiMiddleware>;
    }
}

export class BrowserLocalMediaSourceRuntime {
    private readonly sources = new Map<RallarMediaSourceKind, BrowserLocalMediaSourceState>();
    private readonly input: BrowserLocalMediaSourceRuntime.Input;

    public constructor(input: BrowserLocalMediaSourceRuntime.Input) {
        this.input = input;
    }

    public readStatus(
        kind: RallarMediaSourceKind
    ): RallarMediaSourceStatus | undefined {
        const runtime = this.sources.get(kind);
        return runtime ? toBrowserLocalMediaSourceStatus(runtime) : undefined;
    }

    public readStatuses(): readonly RallarMediaSourceStatus[] {
        return Array.from(this.sources.values()).map(toBrowserLocalMediaSourceStatus);
    }

    public createController<TOptions>(
        kind: RallarMediaSourceKind
    ): RallarMediaSourceController<TOptions> {
        return {
            start: async (sourceOptions?: TOptions) =>
                await this.startSource(
                    kind,
                    (sourceOptions ?? {}) as BrowserLocalMediaSourceStartOptions
                ),
            status: () => this.readStatus(kind),
            stop: async () => await this.stopSource(kind)
        };
    }

    public async setLocalStream(stream: MediaStream): Promise<void> {
        const context = await this.input.connect();
        await context.middleware.rtcRxStreamer.setLocalMediaStream(stream);
    }

    public async setAudioEnabled(enabled: boolean): Promise<void> {
        const context = await this.input.connect();
        context.middleware.rtcRxStreamer.setLocalAudioEnabled(enabled);
    }

    public async setVideoEnabled(enabled: boolean): Promise<void> {
        const context = await this.input.connect();
        context.middleware.rtcRxStreamer.setLocalVideoEnabled(enabled);
    }

    public async stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void> {
        const context = await this.input.connect();
        this.stopSourcesForKind(kind, false);
        context.middleware.rtcRxStreamer.stopLocalMedia(kind);
    }

    public stopForDisconnect(): void {
        this.stopSourcesForKind('all', false);
    }

    private async attachLocalSources(): Promise<void> {
        const context = await this.input.connect();
        const runtimes = Array.from(this.sources.values())
            .filter((runtime) => runtime.state === 'open');
        const tracks = runtimes.flatMap((runtime) =>
            readBrowserMediaStreamTracks(runtime.stream)
                .filter((track) => track.readyState !== 'ended')
        );
        if (tracks.length === 0) {
            context.middleware.rtcRxStreamer.stopLocalMedia('all');
            return;
        }
        const stream = composeBrowserLocalMediaStream(runtimes, tracks);
        await context.middleware.rtcRxStreamer.setLocalMediaStream(stream);
        context.middleware.rtcRxStreamer.setLocalAudioEnabled(
            tracks.some((track) => track.kind === 'audio' && track.enabled)
        );
        context.middleware.rtcRxStreamer.setLocalVideoEnabled(
            tracks.some((track) => track.kind === 'video' && track.enabled)
        );
    }

    private async stopSource(
        kind: RallarMediaSourceKind,
        attach = true
    ): Promise<RallarMediaSourceStatus | undefined> {
        const runtime = this.sources.get(kind);
        if (!runtime) {
            return undefined;
        }
        this.sources.delete(kind);
        for (const track of readBrowserMediaStreamTracks(runtime.stream)) {
            track.stop();
        }
        runtime.state = 'ended';
        if (attach) {
            await this.attachLocalSources();
        }
        return toBrowserLocalMediaSourceStatus(runtime);
    }

    private stopSourcesForKind(
        kind: 'audio' | 'video' | 'all',
        attach: boolean
    ): void {
        const sourceKinds = browserLocalMediaSourceKinds(kind);
        for (const sourceKind of sourceKinds) {
            const runtime = this.sources.get(sourceKind);
            if (!runtime) {
                continue;
            }
            this.sources.delete(sourceKind);
            for (const track of readBrowserMediaSourceTracks(sourceKind, runtime.stream)) {
                track.stop();
            }
            runtime.state = 'ended';
        }
        if (attach) {
            this.attachLocalSources().catch((error) =>
                console.error('Error attaching Rallar local media sources', error)
            );
        }
    }

    private registerEndedCallbacks(runtime: BrowserLocalMediaSourceState): void {
        for (const track of readBrowserMediaStreamTracks(runtime.stream)) {
            track.addEventListener?.('ended', () => {
                if (
                    this.sources.get(runtime.kind) !== runtime ||
                    hasActiveBrowserMediaStreamTrack(runtime.stream)
                ) {
                    return;
                }
                runtime.state = 'ended';
                this.sources.delete(runtime.kind);
                this.attachLocalSources().catch((error) =>
                    console.error('Error attaching Rallar local media sources', error)
                );
            }, { once: true });
        }
    }

    private toHandle(kind: RallarMediaSourceKind): RallarMediaSourceHandle {
        const runtime = this.requireSource(kind);
        return {
            kind,
            stream: runtime.stream,
            status: () => this.readStatus(kind) ?? toBrowserLocalMediaSourceStatus(runtime),
            attach: async () => {
                await this.attachLocalSources();
                return this.readStatus(kind) ?? toBrowserLocalMediaSourceStatus(runtime);
            },
            setEnabled: async (enabled) => {
                for (const track of readBrowserMediaSourceTracks(kind, runtime.stream)) {
                    track.enabled = enabled;
                }
                await this.attachLocalSources();
                return this.readStatus(kind) ?? toBrowserLocalMediaSourceStatus(runtime);
            },
            stop: async () =>
                await this.stopSource(kind) ?? toBrowserLocalMediaSourceStatus({
                    ...runtime,
                    state: 'ended'
                })
        };
    }

    private requireSource(kind: RallarMediaSourceKind): BrowserLocalMediaSourceState {
        const runtime = this.sources.get(kind);
        if (!runtime) {
            throw new Error(`Rallar media source is not started: ${kind}.`);
        }
        return runtime;
    }

    private async startSource(
        kind: RallarMediaSourceKind,
        options: BrowserLocalMediaSourceStartOptions = {}
    ): Promise<RallarMediaSourceHandle> {
        await this.stopSource(kind, false);
        let runtime: BrowserLocalMediaSourceState;
        try {
            const stream = options.stream ?? await captureBrowserLocalMediaSource(kind, options);
            runtime = { kind, stream, state: 'open' };
            this.sources.set(kind, runtime);
            this.registerEndedCallbacks(runtime);
        }
        catch (error) {
            runtime = {
                kind,
                stream: emptyBrowserMediaStream(),
                state: 'failed',
                error: toBrowserMediaErrorMessage(error)
            };
            this.sources.set(kind, runtime);
            throw error;
        }
        const handle = this.toHandle(kind);
        if (options.attach ?? true) {
            await handle.attach();
        }
        return handle;
    }
}
