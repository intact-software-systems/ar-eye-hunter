import { checkNodeClockOffset, sampleNodeClockPair } from '@shared-test/black-box-runner/cluster-proofs/check-node-clock-offset.ts';
import { parseNodeClockProbe } from '@shared-test/black-box-runner/cluster-proofs/parse-node-clock-probe.ts';

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
                const pair = await sampleNodeClockPair({ origin: first, peerId: calibrationId }, { origin: second, peerId: enforcementId });
                const now = performance.now();
                const result = checkNodeClockOffset(pair, now, budgetMs);
                console.log(JSON.stringify(
                    repeated
                        ? {
                            sequence,
                            at,
                            ...result,
                            elapsedMs: now - started,
                            calibrationRoundTripMs: pair.calibration.responseReceivedAtMonotonicMs -
                                pair.calibration.requestStartedAtMonotonicMs,
                            enforcementRoundTripMs: pair.enforcement.responseReceivedAtMonotonicMs -
                                pair.enforcement.requestStartedAtMonotonicMs,
                            calibrationAgeMs: now - pair.calibration.responseReceivedAtMonotonicMs,
                            enforcementAgeMs: now - pair.enforcement.responseReceivedAtMonotonicMs,
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
