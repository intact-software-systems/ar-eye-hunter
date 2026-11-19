import { readServerClockSample } from '@shared-web/browser/connection/server-clock/read-server-clock-sample.ts';
import { computeRemoteClockWindow, type RemoteClockObservation } from '@shared/resilience/remote-clock.ts';
import { parseNodeClockProbe } from './parse-node-clock-probe.ts';

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

if (import.meta.main) {
    try {
        const { first, second, calibrationId, enforcementId, budgetMs, observations, intervalMs, repeated } =
            parseNodeClockProbe(process.argv.slice(2));
        let exit = 0;
        for (let sequence = 1; sequence <= observations; sequence++) {
            if (sequence > 1) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
            const started = performance.now();
            const at = new Date().toISOString();
            try {
                const [calibration, enforcement] = await Promise.all([
                    sampleNode(first, calibrationId),
                    sampleNode(second, enforcementId)
                ]);
                const now = performance.now();
                const result = checkNodeClockOffset({ calibration, enforcement }, now, budgetMs);
                console.log(JSON.stringify(
                    repeated
                        ? {
                            sequence,
                            at,
                            ...result,
                            elapsedMs: now - started,
                            calibrationRoundTripMs: calibration.responseReceivedAtMonotonicMs -
                                calibration.requestStartedAtMonotonicMs,
                            enforcementRoundTripMs: enforcement.responseReceivedAtMonotonicMs -
                                enforcement.requestStartedAtMonotonicMs,
                            calibrationAgeMs: now - calibration.responseReceivedAtMonotonicMs,
                            enforcementAgeMs: now - enforcement.responseReceivedAtMonotonicMs,
                            widthMs: result.maximumOffsetMs - result.minimumOffsetMs
                        }
                        : result
                ));
                if (result.verdict !== 'within') {
                    exit = Math.max(exit, 1);
                }
            }
            catch (error) {
                if (!repeated) {
                    throw error;
                }
                console.log(
                    JSON.stringify({
                        sequence,
                        at,
                        verdict: 'unavailable',
                        elapsedMs: performance.now() - started,
                        reason: error instanceof Error ? error.message : 'Clock observation failed.'
                    })
                );
                exit = 2;
            }
        }
        process.exitCode = exit;
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : 'Clock qualification failed.');
        process.exitCode = 2;
    }
}
