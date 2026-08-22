import { createRtcBaselineDenoAcceptance } from './rtc-baseline-deno-acceptance.ts';
import type { DenoRtcBaselineAdapters } from './rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoEvidence } from './rtc-baseline-deno-evidence.ts';
import { createRtcBaselineDenoFinalization } from './rtc-baseline-deno-finalization.ts';
import { createRtcBaselineEnvelope, type RtcBaselineEnvelope } from './rtc-baseline-envelope.ts';
import { createRtcBaselineRepeatInitializer } from './rtc-baseline-repeat-initializer.ts';
import { createRtcBaselineDenoObservation } from './rtc-baseline-runtime-observation.ts';

export const RTC_BASELINE_DENO_ROOT_PATH = 'tmp/perf/rtc-baseline';

export function createRtcBaselineDenoRuntime(
    adapters: DenoRtcBaselineAdapters
): RtcBaselineEnvelope {
    const observeRuntime = createRtcBaselineDenoObservation(adapters);
    const evidence = createRtcBaselineDenoEvidence({
        rootPath: RTC_BASELINE_DENO_ROOT_PATH,
        filePort: adapters.filePort,
        writerLockRuntime: adapters.writerLockRuntime,
        observeRuntime
    });
    const acceptance = createRtcBaselineDenoAcceptance(evidence, adapters.freshWorker);
    const { finalizedEvidence, finalizedReader } = createRtcBaselineDenoFinalization(
        evidence,
        adapters.sha256
    );
    const envelope = createRtcBaselineEnvelope({
        acceptance,
        finalizedEvidence,
        finalizedReader,
        observeRuntime
    });

    return {
        ...envelope,
        initializeBaseline: createRtcBaselineRepeatInitializer(envelope, finalizedReader)
    };
}
