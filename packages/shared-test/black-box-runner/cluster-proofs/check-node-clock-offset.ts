import { readServerClockSample } from '@shared-web/browser/connection/server-clock/read-server-clock-sample.ts';
import { computeRemoteClockWindow, type RemoteClockObservation } from '@shared/resilience/remote-clock.ts';

export interface ClockProbeNode {
    readonly origin: string;
    readonly peerId: string;
}

interface NodeClockPair {
    readonly calibration: RemoteClockObservation;
    readonly enforcement: RemoteClockObservation;
}

export function checkNodeClockOffset(pair: NodeClockPair, nowMonotonicMs: number, budgetMs: number) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) {
        throw new RangeError('Supply a nonnegative integer millisecond offset budget.');
    }
    const calibration = projectWindow(pair.calibration, nowMonotonicMs);
    const enforcement = projectWindow(pair.enforcement, nowMonotonicMs);
    const minimumOffsetMs = enforcement.earliestEpochMs - calibration.latestEpochMs;
    const maximumOffsetMs = enforcement.latestEpochMs - calibration.earliestEpochMs;
    let verdict: 'within' | 'outside' | 'inconclusive' = 'inconclusive';
    if (minimumOffsetMs >= -budgetMs && maximumOffsetMs <= budgetMs) {
        verdict = 'within';
    }
    else if (maximumOffsetMs < -budgetMs || minimumOffsetMs > budgetMs) {
        verdict = 'outside';
    }
    return { verdict, minimumOffsetMs, maximumOffsetMs, budgetMs };
}

function projectWindow(observation: RemoteClockObservation, nowMonotonicMs: number) {
    const window = computeRemoteClockWindow({
        observation,
        nowMonotonicMs,
        policy: { maxRoundTripMs: 500, maxAgeMs: 2_000, maxRelativeDriftPpm: 1_000, maxMonotonicErrorMs: 2 }
    });
    if (window.left) {
        throw new Error(window.left.join(' '));
    }
    return window.right!;
}

export async function sampleNode(baseUrl: string, expectedServerPeerId: string) {
    const sample = await readServerClockSample({ baseUrl, expectedServerPeerId, signal: AbortSignal.timeout(2_000) }, {
        fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        nowMonotonicMs: () => performance.now()
    });
    if (sample.left) {
        throw new Error('Time sample unavailable for ' + expectedServerPeerId + ': ' + sample.left.code);
    }
    return sample.right!;
}

export async function sampleNodeClockPair(calibration: ClockProbeNode, enforcement: ClockProbeNode) {
    const [first, second] = await Promise.allSettled([
        sampleNode(calibration.origin, calibration.peerId), sampleNode(enforcement.origin, enforcement.peerId)
    ]);
    if (first.status === 'rejected') throw first.reason;
    if (second.status === 'rejected') throw second.reason;
    return { calibration: first.value, enforcement: second.value };
}
