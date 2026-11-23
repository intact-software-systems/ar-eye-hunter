import type { RallarBlackBoxTestCommand } from '../rallar-black-box-test-contracts.ts';
import { decodePositiveInteger } from '../runtime/decode-runtime-result-values.ts';

/** How long a connect's readiness waits when it names no positive timeout of its own. */
const RTC_CONNECT_READINESS_DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How long a connect waits for RTC readiness once it connected: the runtime connects under the connect's own timeout
 * and only then waits for readiness, under the readiness's timeout or, when it names no positive one, the default.
 * Any other command, and a connect that names no readiness, waits none.
 */
export function computeRtcConnectReadinessTimeoutMs(command: RallarBlackBoxTestCommand): number {
    if (command.kind !== 'rtc.connect' || command.readiness === undefined) {
        return 0;
    }
    return decodePositiveInteger(command.readiness.timeoutMs) ?? RTC_CONNECT_READINESS_DEFAULT_TIMEOUT_MS;
}
