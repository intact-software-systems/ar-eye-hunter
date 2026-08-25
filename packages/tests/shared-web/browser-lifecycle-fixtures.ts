import { vi } from 'vitest';

export interface DeferredFixture<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
}

export function createDeferred<T>(): DeferredFixture<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

export function createMediaTrack(
    id: string,
    kind: 'audio' | 'video'
): MediaStreamTrack {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const track = {
        id,
        kind,
        enabled: true,
        readyState: 'live',
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.add(listener);
            }
        }),
        removeEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject
        ) => {
            if (type === 'ended') {
                listeners.delete(listener);
            }
        }),
        stop: vi.fn(() => {
            track.readyState = 'ended';
            const event = { type: 'ended' } as Event;
            for (const listener of listeners) {
                if (typeof listener === 'function') {
                    listener(event);
                }
                else {
                    listener.handleEvent(event);
                }
            }
        })
    };
    return track as object as MediaStreamTrack;
}

export function createMediaStream(
    id: string,
    tracks: readonly MediaStreamTrack[]
): MediaStream {
    return {
        id,
        active: tracks.some((track) => track.readyState !== 'ended'),
        getTracks: vi.fn(() => [...tracks]),
        getAudioTracks: vi.fn(() => tracks.filter((track) => track.kind === 'audio')),
        getVideoTracks: vi.fn(() => tracks.filter((track) => track.kind === 'video'))
    } as object as MediaStream;
}
