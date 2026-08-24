import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarCameraSourceStartOptions,
    RallarMediaSourceController,
    RallarMediaSourceHandle,
    RallarMediaSourceKind,
    RallarMediaSourceState,
    RallarMediaSourceStatus,
    RallarMicrophoneSourceStartOptions,
    RallarScreenSourceStartOptions
} from '@shared-web/browser/rallar-media-facade.ts';

interface RallarMediaSourceRuntime {
    readonly kind: RallarMediaSourceKind;
    readonly stream: MediaStream;
    state: RallarMediaSourceState;
    readonly error?: string;
}

export interface BrowserLocalMediaSourceRuntimeInput {
    readonly connect: () => Promise<ApiMiddleware>;
}

export class BrowserLocalMediaSourceRuntime {
    private readonly sources = new Map<RallarMediaSourceKind, RallarMediaSourceRuntime>();
    private readonly input: BrowserLocalMediaSourceRuntimeInput;

    public constructor(input: BrowserLocalMediaSourceRuntimeInput) {
        this.input = input;
    }

    public readStatus(
        kind: RallarMediaSourceKind
    ): RallarMediaSourceStatus | undefined {
        const runtime = this.sources.get(kind);
        return runtime ? toMediaSourceStatus(runtime) : undefined;
    }

    public readStatuses(): readonly RallarMediaSourceStatus[] {
        return Array.from(this.sources.values()).map(toMediaSourceStatus);
    }

    public createController<TOptions>(
        kind: RallarMediaSourceKind
    ): RallarMediaSourceController<TOptions> {
        return {
            start: async (sourceOptions?: TOptions) =>
                await this.startSource(
                    kind,
                    (sourceOptions ?? {}) as RallarMediaSourceStartOptions
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
            readMediaStreamTracks(runtime.stream)
                .filter((track) => track.readyState !== 'ended')
        );
        if (tracks.length === 0) {
            context.middleware.rtcRxStreamer.stopLocalMedia('all');
            return;
        }
        const stream = toComposedMediaStream(runtimes, tracks);
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
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.stop();
        }
        runtime.state = 'ended';
        if (attach) {
            await this.attachLocalSources();
        }
        return toMediaSourceStatus(runtime);
    }

    private stopSourcesForKind(
        kind: 'audio' | 'video' | 'all',
        attach: boolean
    ): void {
        const sourceKinds = toMediaSourceKinds(kind);
        for (const sourceKind of sourceKinds) {
            const runtime = this.sources.get(sourceKind);
            if (!runtime) {
                continue;
            }
            this.sources.delete(sourceKind);
            for (const track of readMediaSourceTracks(sourceKind, runtime.stream)) {
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

    private registerEndedCallbacks(runtime: RallarMediaSourceRuntime): void {
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.addEventListener?.('ended', () => {
                if (
                    this.sources.get(runtime.kind) !== runtime ||
                    hasActiveMediaStreamTrack(runtime.stream)
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
            status: () => this.readStatus(kind) ?? toMediaSourceStatus(runtime),
            attach: async () => {
                await this.attachLocalSources();
                return this.readStatus(kind) ?? toMediaSourceStatus(runtime);
            },
            setEnabled: async (enabled) => {
                for (const track of readMediaSourceTracks(kind, runtime.stream)) {
                    track.enabled = enabled;
                }
                await this.attachLocalSources();
                return this.readStatus(kind) ?? toMediaSourceStatus(runtime);
            },
            stop: async () =>
                await this.stopSource(kind) ?? toMediaSourceStatus({
                    ...runtime,
                    state: 'ended'
                })
        };
    }

    private requireSource(kind: RallarMediaSourceKind): RallarMediaSourceRuntime {
        const runtime = this.sources.get(kind);
        if (!runtime) {
            throw new Error(`Rallar media source is not started: ${kind}.`);
        }
        return runtime;
    }

    private async startSource(
        kind: RallarMediaSourceKind,
        options: RallarMediaSourceStartOptions = {}
    ): Promise<RallarMediaSourceHandle> {
        await this.stopSource(kind, false);
        let runtime: RallarMediaSourceRuntime;
        try {
            const stream = options.stream ?? await captureMediaSource(kind, options);
            runtime = { kind, stream, state: 'open' };
            this.sources.set(kind, runtime);
            this.registerEndedCallbacks(runtime);
        }
        catch (error) {
            runtime = {
                kind,
                stream: toEmptyMediaStream(),
                state: 'failed',
                error: toErrorMessage(error)
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

type RallarMediaSourceStartOptions =
    | RallarMicrophoneSourceStartOptions
    | RallarCameraSourceStartOptions
    | RallarScreenSourceStartOptions;

async function captureMediaSource(
    kind: RallarMediaSourceKind,
    options: RallarMediaSourceStartOptions
): Promise<MediaStream> {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices) {
        throw new Error('Browser media devices are not available.');
    }
    if (kind === 'microphone') {
        return await mediaDevices.getUserMedia({
            audio: (options as RallarMicrophoneSourceStartOptions).audio ?? true,
            video: false
        });
    }
    if (kind === 'camera') {
        return await mediaDevices.getUserMedia({
            audio: false,
            video: (options as RallarCameraSourceStartOptions).video ?? true
        });
    }
    const screenOptions = options as RallarScreenSourceStartOptions;
    const getDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    if (!getDisplayMedia) {
        throw new Error('Browser screen capture is not available.');
    }
    return await getDisplayMedia({
        audio: screenOptions.audio ?? false,
        video: screenOptions.video ?? true
    });
}

function toMediaSourceKinds(
    kind: 'audio' | 'video' | 'all'
): readonly RallarMediaSourceKind[] {
    if (kind === 'all') {
        return ['microphone', 'camera', 'screen'];
    }
    return kind === 'audio' ? ['microphone'] : ['camera', 'screen'];
}

function readMediaStreamTracks(stream: MediaStream): MediaStreamTrack[] {
    return typeof stream.getTracks === 'function' ? stream.getTracks() : [];
}

function hasActiveMediaStreamTrack(stream: MediaStream): boolean {
    return readMediaStreamTracks(stream)
        .some((track) => track.readyState !== 'ended');
}

function readMediaSourceTracks(
    kind: RallarMediaSourceKind,
    stream: MediaStream
): MediaStreamTrack[] {
    const tracks = readMediaStreamTracks(stream);
    if (kind === 'microphone') {
        return tracks.filter((track) => track.kind === 'audio');
    }
    if (kind === 'camera') {
        return tracks.filter((track) => track.kind === 'video');
    }
    return tracks;
}

function toMediaSourceStatus(
    runtime: RallarMediaSourceRuntime
): RallarMediaSourceStatus {
    const tracks = readMediaStreamTracks(runtime.stream);
    const endedTrackIds = tracks
        .filter((track) => track.readyState === 'ended')
        .map((track) => track.id);
    const state = runtime.state === 'open' && tracks.length > 0 &&
            endedTrackIds.length === tracks.length
        ? 'ended'
        : runtime.state;
    return {
        kind: runtime.kind,
        state,
        streamId: runtime.stream.id,
        trackIds: tracks.map((track) => track.id),
        audioTrackIds: tracks.filter((track) => track.kind === 'audio')
            .map((track) => track.id),
        videoTrackIds: tracks.filter((track) => track.kind === 'video')
            .map((track) => track.id),
        enabledTrackIds: tracks.filter((track) => track.enabled)
            .map((track) => track.id),
        endedTrackIds,
        error: runtime.error
    };
}

function toComposedMediaStream(
    runtimes: readonly RallarMediaSourceRuntime[],
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    const only = runtimes.length === 1 ? runtimes[0] : undefined;
    if (only && readMediaStreamTracks(only.stream).length === tracks.length) {
        return only.stream;
    }
    if (typeof globalThis.MediaStream === 'function') {
        return new MediaStream([...tracks]);
    }
    return toMediaStreamLike(
        `rallar-local-media:${tracks.map((track) => track.id).join(',')}`,
        tracks
    );
}

function toEmptyMediaStream(): MediaStream {
    return typeof globalThis.MediaStream === 'function'
        ? new MediaStream()
        : toMediaStreamLike('rallar-empty-media', []);
}

function toMediaStreamLike(
    id: string,
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: () => [...tracks],
        getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
        getVideoTracks: () => tracks.filter((track) => track.kind === 'video')
    } as MediaStream;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
