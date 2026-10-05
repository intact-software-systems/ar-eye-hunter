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
        expect(warning).toHaveBeenCalledWith('Failed to add queued candidate:', new Error('native rejection'));
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

it('observes actual spliced candidate indices without swallowing accounting or native continuation', async () => {
    const candidate = { candidate: 'private-candidate' };
    const observations: { index: number; stage: string; error?: object; }[] = [];
    let attempts = 0;
    let added = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await flushRtcIceCandidateQueue({
        queue: [candidate, candidate, candidate],
        peerConnection: {
            addIceCandidate: async () => {
                if (++attempts === 2) {
                    throw new DOMException('private-message', 'OperationError');
                }
            }
        },
        onCandidateAdded: () => {
            added++;
        },
        onCandidateObservation: (observation) => {
            observations.push(observation);
            if (observation.stage === 'submitted') {
                throw new Error('sink failure');
            }
        }
    });
    expect(added).toBe(2);
    expect(observations.map(({ index, stage }) => ({ index, stage }))).toEqual([
        { index: 0, stage: 'submitted' },
        { index: 0, stage: 'returned' },
        { index: 1, stage: 'submitted' },
        { index: 1, stage: 'rejected' },
        { index: 2, stage: 'submitted' },
        { index: 2, stage: 'returned' }
    ]);
    expect(JSON.stringify(observations.find((row) => row.stage === 'rejected')?.error)).not.toContain('private-');
});

it('continues the original FIFO when the diagnostic error reader throws without rereading the error', async () => {
    const observations: { index: number; stage: string; error?: object; }[] = [];
    const attempted: string[] = [];
    let added = 0;
    let reads = 0;
    const failure = new Error('native failure');
    Object.defineProperty(failure, 'errorDetail', {
        get: () => {
            reads++;
            return 'sctp-failure';
        }
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await flushRtcIceCandidateQueue({
        queue: [{ candidate: 'first' }, { candidate: 'last' }],
        peerConnection: {
            addIceCandidate: async (candidate) => {
                attempted.push(candidate?.candidate ?? '');
                if (candidate?.candidate === 'first') {
                    throw failure;
                }
            }
        },
        onCandidateAdded: () => {
            added++;
        },
        onCandidateObservation: (row) => observations.push(row),
        readCandidateError: () => {
            throw new Error('diagnostic read failed');
        }
    });
    expect(attempted).toEqual(['first', 'last']);
    expect(added).toBe(1);
    expect(reads).toBe(0);
    expect(observations.find((row) => row.stage === 'rejected')).toEqual({
        candidate: { candidate: 'first' },
        index: 0,
        stage: 'rejected',
        error: {
            errorDetail: { status: 'unavailable', reason: 'read-failed' },
            sctpCauseCode: { status: 'unavailable', reason: 'read-failed' },
            receivedAlert: { status: 'unavailable', reason: 'read-failed' },
            sentAlert: { status: 'unavailable', reason: 'read-failed' },
            iceErrorCode: { status: 'unavailable', reason: 'read-failed' },
            exceptionName: { status: 'unavailable', reason: 'read-failed' }
        }
    });
});
