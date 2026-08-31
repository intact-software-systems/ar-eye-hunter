import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { flushRtcIceCandidateQueue } from '@shared/webrtc/flush-rtc-ice-candidate-queue.ts';

describe('flushRtcIceCandidateQueue', () => {
    afterEach(() => vi.restoreAllMocks());

    it('adds candidates in FIFO order and continues after a normalized native failure', async () => {
        const queue: RTCIceCandidateInit[] = [
            { candidate: 'first' },
            { candidate: 'rejected' },
            { candidate: 'last' }
        ];
        const nativeAttempts: (RTCIceCandidateInit | null)[] = [];
        let successfulAdditions = 0;
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const peerConnection: Pick<RTCPeerConnection, 'addIceCandidate'> = {
            addIceCandidate: async (candidate = null) => {
                nativeAttempts.push(candidate);
                if (candidate?.candidate === 'rejected') {
                    return Promise.reject('native rejection');
                }
            }
        };

        await flushRtcIceCandidateQueue({
            queue,
            peerConnection,
            onCandidateAdded: () => successfulAdditions++
        });

        expect(nativeAttempts).toEqual([
            { candidate: 'first' },
            { candidate: 'rejected' },
            { candidate: 'last' }
        ]);
        expect(successfulAdditions).toBe(2);
        expect(queue).toEqual([]);
        expect(warning).toHaveBeenCalledExactlyOnceWith('Failed to add queued candidate:', new Error('native rejection'));
    });

    it('retains candidates enqueued while a native addition is pending for the next drain', async () => {
        const queue: RTCIceCandidateInit[] = [{ candidate: 'first' }, { candidate: 'second' }];
        const releaseFirst = Promise.withResolvers<void>();
        const nativeAttempts: (RTCIceCandidateInit | null)[] = [];
        let successfulAdditions = 0;
        const peerConnection: Pick<RTCPeerConnection, 'addIceCandidate'> = {
            addIceCandidate: async (candidate = null) => {
                nativeAttempts.push(candidate);
                if (candidate?.candidate === 'first') {
                    await releaseFirst.promise;
                }
            }
        };
        const drain = flushRtcIceCandidateQueue({
            queue,
            peerConnection,
            onCandidateAdded: () => successfulAdditions++
        });
        try {
            expect(queue).toEqual([]);
            queue.push({ candidate: 'next-drain' });
            expect(nativeAttempts).toEqual([{ candidate: 'first' }]);
            expect(successfulAdditions).toBe(0);
        }
        finally {
            releaseFirst.resolve();
            await drain;
        }

        expect(nativeAttempts).toEqual([{ candidate: 'first' }, { candidate: 'second' }]);
        expect(successfulAdditions).toBe(2);
        expect(queue).toEqual([{ candidate: 'next-drain' }]);
        await flushRtcIceCandidateQueue({
            queue,
            peerConnection,
            onCandidateAdded: () => successfulAdditions++
        });
        expect(nativeAttempts).toEqual([
            { candidate: 'first' },
            { candidate: 'second' },
            { candidate: 'next-drain' }
        ]);
        expect(successfulAdditions).toBe(3);
        expect(queue).toEqual([]);
    });
});
