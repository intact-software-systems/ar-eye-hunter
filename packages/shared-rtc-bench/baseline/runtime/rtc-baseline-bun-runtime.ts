import { createRtcBaselineBunAcceptance } from './create-rtc-baseline-bun-acceptance.ts';
import type { BunRtcBaselineAdapters } from './rtc-baseline-bun-adapters.ts';
import { createRtcBaselineBunEvidence } from './rtc-baseline-bun-evidence.ts';
import { createRtcBaselineBunFinalization } from './rtc-baseline-bun-finalization.ts';
import type { RtcBaselineCaptureAdmission } from './rtc-baseline-capture-admission.ts';
import { createRtcBaselineEnvelope, type RtcBaselineEnvelope } from './rtc-baseline-envelope.ts';
import { createRtcBaselineRepeatInitializer } from './rtc-baseline-repeat-initializer.ts';
import { createRtcBaselineBunObservation } from './rtc-baseline-runtime-observation.ts';

export const RTC_BASELINE_BUN_ROOT_PATH = 'tmp/perf/rtc-baseline';

export function createRtcBaselineBunRuntime(
    adapters: BunRtcBaselineAdapters,
    captureAdmission?: RtcBaselineCaptureAdmission
): RtcBaselineEnvelope {
    const admittedCapture = captureAdmission === undefined ? undefined : Object.freeze({ ...captureAdmission });
    const observeRuntime = createRtcBaselineBunObservation(adapters, admittedCapture);
    const evidence = createRtcBaselineBunEvidence({
        rootPath: RTC_BASELINE_BUN_ROOT_PATH,
        filePort: adapters.filePort,
        writerLockRuntime: adapters.writerLockRuntime,
        observeRuntime
    });
    const acceptance = createRtcBaselineBunAcceptance(evidence, adapters.freshWorker);
    const { finalizedEvidence, finalizedReader } = createRtcBaselineBunFinalization(
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
