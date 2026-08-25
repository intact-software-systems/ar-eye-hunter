import type {
    RallarCameraSourceStartOptions,
    RallarMediaSourceKind,
    RallarMediaSourceState,
    RallarMediaSourceStatus,
    RallarMicrophoneSourceStartOptions,
    RallarScreenSourceStartOptions
} from '@shared-web/browser/rallar-media-facade.ts';

export interface BrowserLocalMediaSourceState {
    readonly kind: RallarMediaSourceKind;
    readonly stream: MediaStream;
    state: RallarMediaSourceState;
    readonly error?: string;
}

export type BrowserLocalMediaSourceStartOptions =
    | RallarMicrophoneSourceStartOptions
    | RallarCameraSourceStartOptions
    | RallarScreenSourceStartOptions;

export async function captureBrowserLocalMediaSource(
    kind: RallarMediaSourceKind,
    options: BrowserLocalMediaSourceStartOptions
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

export function browserLocalMediaSourceKinds(
    kind: 'audio' | 'video' | 'all'
): readonly RallarMediaSourceKind[] {
    if (kind === 'all') {
        return ['microphone', 'camera', 'screen'];
    }
    return kind === 'audio' ? ['microphone'] : ['camera', 'screen'];
}

export function readBrowserMediaStreamTracks(stream: MediaStream): MediaStreamTrack[] {
    return typeof stream.getTracks === 'function' ? stream.getTracks() : [];
}

export function hasActiveBrowserMediaStreamTrack(stream: MediaStream): boolean {
    return readBrowserMediaStreamTracks(stream)
        .some((track) => track.readyState !== 'ended');
}

export function readBrowserMediaSourceTracks(
    kind: RallarMediaSourceKind,
    stream: MediaStream
): MediaStreamTrack[] {
    const tracks = readBrowserMediaStreamTracks(stream);
    if (kind === 'microphone') {
        return tracks.filter((track) => track.kind === 'audio');
    }
    if (kind === 'camera') {
        return tracks.filter((track) => track.kind === 'video');
    }
    return tracks;
}

export function toBrowserLocalMediaSourceStatus(
    runtime: BrowserLocalMediaSourceState
): RallarMediaSourceStatus {
    const tracks = readBrowserMediaStreamTracks(runtime.stream);
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

export function composeBrowserLocalMediaStream(
    runtimes: readonly BrowserLocalMediaSourceState[],
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    const only = runtimes.length === 1 ? runtimes[0] : undefined;
    if (only && readBrowserMediaStreamTracks(only.stream).length === tracks.length) {
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

export function emptyBrowserMediaStream(): MediaStream {
    return typeof globalThis.MediaStream === 'function'
        ? new MediaStream()
        : toMediaStreamLike('rallar-empty-media', []);
}

export function toBrowserMediaErrorMessage<ErrorValue>(error: ErrorValue): string {
    return error instanceof Error ? error.message : String(error);
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
