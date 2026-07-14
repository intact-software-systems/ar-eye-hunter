import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarCameraSourceStartOptions,
    RallarMediaSourceController,
    RallarMediaSourceHandle,
    RallarMediaSourceKind,
    RallarMediaSourceState,
    RallarMediaSourceStatus,
    RallarMicrophoneSourceStartOptions,
    RallarRemoteStream,
    RallarScreenSourceStartOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-facade-contract.ts';
import type { RallarMediaPort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import type { CreateRallarMediaFacadeOptions } from '@shared-web/browser/rallar-media-facade.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';

const RALLAR_REMOTE_STREAM_CALLBACK_ID = 'rallar:remote-stream';

type RallarMediaSourceRuntime = {
    kind: RallarMediaSourceKind;
    stream: MediaStream;
    state: RallarMediaSourceState;
    error?: string;
};

export type CreateRallarMediaControllerOptions = Readonly<{
    connect(): Promise<ApiMiddleware>;
    readMiddleware(): ApiMiddleware | undefined;
}>;

export function createRallarMediaController(
    options: CreateRallarMediaControllerOptions,
): RallarMediaPort {
    const sources = new Map<RallarMediaSourceKind, RallarMediaSourceRuntime>();
    const remoteStreamListeners = new Set<
        (remote: RallarRemoteStream) => void | Promise<void>
    >();
    let remoteStreamCallbackRegistered = false;

    const readSourceStatus = (
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceStatus | undefined => {
        const runtime = sources.get(kind);
        return runtime ? toMediaSourceStatus(runtime) : undefined;
    };

    const readSourceStatuses = (): readonly RallarMediaSourceStatus[] =>
        Array.from(sources.values()).map(toMediaSourceStatus);

    const attachLocalSources = async (): Promise<void> => {
        const ctx = await options.connect();
        const runtimes = Array.from(sources.values())
            .filter((runtime) => runtime.state === 'open');
        const tracks = runtimes.flatMap((runtime) =>
            readMediaStreamTracks(runtime.stream)
                .filter((track) => track.readyState !== 'ended')
        );
        if (tracks.length === 0) {
            ctx.middleware.rtcRxStreamer.stopLocalMedia('all');
            return;
        }
        const stream = toComposedMediaStream(runtimes, tracks);
        await ctx.middleware.rtcRxStreamer.setLocalMediaStream(stream);
        ctx.middleware.rtcRxStreamer.setLocalAudioEnabled(
            tracks.some((track) => track.kind === 'audio' && track.enabled),
        );
        ctx.middleware.rtcRxStreamer.setLocalVideoEnabled(
            tracks.some((track) => track.kind === 'video' && track.enabled),
        );
    };

    const stopSource = async (
        kind: RallarMediaSourceKind,
        attach = true,
    ): Promise<RallarMediaSourceStatus | undefined> => {
        const runtime = sources.get(kind);
        if (!runtime) {
            return undefined;
        }
        sources.delete(kind);
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.stop();
        }
        runtime.state = 'ended';
        if (attach) {
            await attachLocalSources();
        }
        return toMediaSourceStatus(runtime);
    };

    const stopSourcesForKind = (
        kind: 'audio' | 'video' | 'all',
        attach: boolean,
    ): void => {
        const sourceKinds = kind === 'all'
            ? ['microphone', 'camera', 'screen'] as const
            : kind === 'audio'
                ? ['microphone'] as const
                : ['camera', 'screen'] as const;
        for (const sourceKind of sourceKinds) {
            const runtime = sources.get(sourceKind);
            if (!runtime) {
                continue;
            }
            sources.delete(sourceKind);
            for (const track of readMediaSourceTracks(sourceKind, runtime.stream)) {
                track.stop();
            }
            runtime.state = 'ended';
        }
        if (attach) {
            attachLocalSources().catch((error) =>
                console.error(
                    'Error attaching Rallar local media sources',
                    error,
                )
            );
        }
    };

    const registerEndedCallbacks = (runtime: RallarMediaSourceRuntime): void => {
        for (const track of readMediaStreamTracks(runtime.stream)) {
            track.addEventListener?.('ended', () => {
                if (sources.get(runtime.kind) !== runtime) {
                    return;
                }
                if (readMediaStreamTracks(runtime.stream).some((candidate) =>
                    candidate.readyState !== 'ended'
                )) {
                    return;
                }
                runtime.state = 'ended';
                sources.delete(runtime.kind);
                attachLocalSources().catch((error) =>
                    console.error(
                        'Error attaching Rallar local media sources',
                        error,
                    )
                );
            }, { once: true });
        }
    };

    const requireSource = (kind: RallarMediaSourceKind): RallarMediaSourceRuntime => {
        const runtime = sources.get(kind);
        if (!runtime) {
            throw new Error(`Rallar media source is not started: ${kind}.`);
        }
        return runtime;
    };

    const toHandle = (kind: RallarMediaSourceKind): RallarMediaSourceHandle => {
        const runtime = requireSource(kind);
        return {
            kind,
            stream: runtime.stream,
            status: () => readSourceStatus(kind) ?? toMediaSourceStatus(runtime),
            attach: async () => {
                await attachLocalSources();
                return readSourceStatus(kind) ?? toMediaSourceStatus(runtime);
            },
            setEnabled: async (enabled) => {
                for (const track of readMediaSourceTracks(kind, runtime.stream)) {
                    track.enabled = enabled;
                }
                await attachLocalSources();
                return readSourceStatus(kind) ?? toMediaSourceStatus(runtime);
            },
            stop: async () => await stopSource(kind) ?? toMediaSourceStatus({
                ...runtime,
                state: 'ended',
            }),
        };
    };

    const captureSource = async (
        kind: RallarMediaSourceKind,
        sourceOptions:
            | RallarMicrophoneSourceStartOptions
            | RallarCameraSourceStartOptions
            | RallarScreenSourceStartOptions,
    ): Promise<MediaStream> => {
        const mediaDevices = globalThis.navigator?.mediaDevices;
        if (!mediaDevices) {
            throw new Error('Browser media devices are not available.');
        }
        if (kind === 'microphone') {
            return await mediaDevices.getUserMedia({
                audio: (sourceOptions as RallarMicrophoneSourceStartOptions)
                    .audio ?? true,
                video: false,
            });
        }
        if (kind === 'camera') {
            return await mediaDevices.getUserMedia({
                audio: false,
                video: (sourceOptions as RallarCameraSourceStartOptions).video ??
                    true,
            });
        }
        const screenOptions = sourceOptions as RallarScreenSourceStartOptions;
        const getDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
        if (!getDisplayMedia) {
            throw new Error('Browser screen capture is not available.');
        }
        return await getDisplayMedia({
            audio: screenOptions.audio ?? false,
            video: screenOptions.video ?? true,
        });
    };

    const startSource = async (
        kind: RallarMediaSourceKind,
        sourceOptions:
            | RallarMicrophoneSourceStartOptions
            | RallarCameraSourceStartOptions
            | RallarScreenSourceStartOptions = {},
    ): Promise<RallarMediaSourceHandle> => {
        await stopSource(kind, false);
        let runtime: RallarMediaSourceRuntime;
        try {
            const stream = sourceOptions.stream ??
                await captureSource(kind, sourceOptions);
            runtime = { kind, stream, state: 'open' };
            sources.set(kind, runtime);
            registerEndedCallbacks(runtime);
        } catch (error) {
            runtime = {
                kind,
                stream: toEmptyMediaStream(),
                state: 'failed',
                error: toErrorMessage(error),
            };
            sources.set(kind, runtime);
            throw error;
        }
        const handle = toHandle(kind);
        if (sourceOptions.attach ?? true) {
            await handle.attach();
        }
        return handle;
    };

    const createSourceController = <TOptions>(
        kind: RallarMediaSourceKind,
    ): RallarMediaSourceController<TOptions> => ({
        start: async (sourceOptions?: TOptions) => await startSource(
            kind,
            (sourceOptions ?? {}) as
                | RallarMicrophoneSourceStartOptions
                | RallarCameraSourceStartOptions
                | RallarScreenSourceStartOptions,
        ),
        status: () => readSourceStatus(kind),
        stop: async () => await stopSource(kind),
    });

    const attachRemoteStreamCallback = (): void => {
        if (remoteStreamCallbackRegistered || remoteStreamListeners.size === 0) {
            return;
        }
        const ctx = options.readMiddleware();
        if (!ctx) {
            return;
        }
        ctx.middleware.rtcRxStreamer.onRemoteStreamDo(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
            async (peerId, stream, event) => {
                await Promise.all(
                    [...remoteStreamListeners].map(async (listener) => {
                        try {
                            await listener({ peerId, stream, event });
                        } catch (error) {
                            console.error(
                                'Error notifying Rallar remote stream listener',
                                error,
                            );
                        }
                    }),
                );
            },
        );
        remoteStreamCallbackRegistered = true;
    };

    const detachRemoteStreamCallback = (
        ctx = options.readMiddleware(),
    ): void => {
        if (!ctx || !remoteStreamCallbackRegistered) {
            return;
        }
        ctx.middleware.rtcRxStreamer.removeOnRemoteStreamCallbackById(
            RALLAR_REMOTE_STREAM_CALLBACK_ID,
        );
        remoteStreamCallbackRegistered = false;
    };

    const operations: CreateRallarMediaFacadeOptions = {
        microphone: createSourceController('microphone'),
        camera: createSourceController('camera'),
        screen: createSourceController('screen'),
        setLocalStream: async (stream) => {
            const ctx = await options.connect();
            await ctx.middleware.rtcRxStreamer.setLocalMediaStream(stream);
        },
        setAudioEnabled: async (enabled) => {
            const ctx = await options.connect();
            ctx.middleware.rtcRxStreamer.setLocalAudioEnabled(enabled);
        },
        setVideoEnabled: async (enabled) => {
            const ctx = await options.connect();
            ctx.middleware.rtcRxStreamer.setLocalVideoEnabled(enabled);
        },
        stopLocal: async (kind) => {
            const ctx = await options.connect();
            stopSourcesForKind(kind, false);
            ctx.middleware.rtcRxStreamer.stopLocalMedia(kind);
        },
        setPolicy: async (policy: QRtcMediaPolicy) => {
            const ctx = await options.connect();
            ctx.middleware.rtcRxStreamer.setMediaPolicy(policy);
        },
        onRemoteStream: (listener): RallarUnsubscribe => {
            remoteStreamListeners.add(listener);
            attachRemoteStreamCallback();
            return () => {
                remoteStreamListeners.delete(listener);
                if (remoteStreamListeners.size === 0) {
                    detachRemoteStreamCallback();
                }
            };
        },
    };

    return {
        operations,
        readSourceStatus,
        readSourceStatuses,
        attachRemoteStreamCallback,
        detachRemoteStreamCallback,
        stopForDisconnect: (ctx) => {
            detachRemoteStreamCallback(ctx);
            stopSourcesForKind('all', false);
            remoteStreamCallbackRegistered = false;
        },
    };
}

function readMediaStreamTracks(stream: MediaStream): MediaStreamTrack[] {
    return typeof stream.getTracks === 'function' ? stream.getTracks() : [];
}

function readMediaSourceTracks(
    kind: RallarMediaSourceKind,
    stream: MediaStream,
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
    runtime: RallarMediaSourceRuntime,
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
        error: runtime.error,
    };
}

function toComposedMediaStream(
    runtimes: readonly RallarMediaSourceRuntime[],
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    if (runtimes.length === 1) {
        const only = runtimes[0];
        if (only && readMediaStreamTracks(only.stream).length === tracks.length) {
            return only.stream;
        }
    }
    if (typeof globalThis.MediaStream === 'function') {
        return new MediaStream([...tracks]);
    }
    return toMediaStreamLike(
        `rallar-local-media:${tracks.map((track) => track.id).join(',')}`,
        tracks,
    );
}

function toEmptyMediaStream(): MediaStream {
    if (typeof globalThis.MediaStream === 'function') {
        return new MediaStream();
    }
    return toMediaStreamLike('rallar-empty-media', []);
}

function toMediaStreamLike(
    id: string,
    tracks: readonly MediaStreamTrack[],
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: () => [...tracks],
        getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
        getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    } as MediaStream;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
