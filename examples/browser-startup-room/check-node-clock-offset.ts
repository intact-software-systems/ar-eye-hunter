import { readServerClockSample } from '@shared-web/browser/connection/server-clock/read-server-clock-sample.ts';
import { computeRemoteClockWindow, type RemoteClockObservation } from '@shared/resilience/remote-clock.ts';

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

async function sampleNode(baseUrl: string, expectedServerPeerId: string) {
    const sample = await readServerClockSample({ baseUrl, expectedServerPeerId, signal: AbortSignal.timeout(2_000) }, {
        fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
        nowMonotonicMs: () => performance.now()
    });
    if (sample.left) {
        throw new Error('Time sample unavailable: ' + sample.left.code);
    }
    return sample.right!;
}

function parseOrigin(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || (value !== url.origin && value !== url.origin + '/')) {
        throw new Error('Supply a direct HTTP(S) origin without credentials, query or path.');
    }
    return url.origin;
}

if (import.meta.main) {
    try {
        const args = process.argv.slice(2);
        const [calibrationUrl, calibrationId, enforcementUrl, enforcementId, budget] = args;
        if (args.length !== 5 || !calibrationId || !enforcementId || !/^\d+$/.test(budget)) {
            throw new Error(
                'Expected calibrationOrigin calibrationPeerId enforcementOrigin enforcementPeerId budgetMs.'
            );
        }
        const first = parseOrigin(calibrationUrl);
        const second = parseOrigin(enforcementUrl);
        if (first === second) {
            throw new Error('Supply distinct direct node origins.');
        }
        const [calibration, enforcement] = await Promise.all([
            sampleNode(first, calibrationId),
            sampleNode(second, enforcementId)
        ]);
        const result = checkNodeClockOffset({ calibration, enforcement }, performance.now(), Number(budget));
        console.log(JSON.stringify(result));
        process.exitCode = result.verdict === 'within' ? 0 : 1;
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : 'Clock qualification failed.');
        process.exitCode = 2;
    }
}
