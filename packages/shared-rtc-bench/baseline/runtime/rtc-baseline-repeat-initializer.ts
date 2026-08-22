import { rtcBaselineIssue, type RtcBaselineJson } from '../contracts/rtc-baseline-contracts.ts';
import { prepareRtcBaselineRepeatRequest } from '../contracts/rtc-baseline-validation.ts';
import type { RtcBaselineFinalizedReader } from '../evidence/rtc-baseline-finalized-reader.ts';
import type { RtcBaselineEnvelope } from './rtc-baseline-envelope.ts';

export function createRtcBaselineRepeatInitializer(
    envelope: RtcBaselineEnvelope,
    finalizedReader: RtcBaselineFinalizedReader
): RtcBaselineEnvelope['initializeBaseline'] {
    return async function initializeBaseline (request: RtcBaselineJson) {
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
            return envelope.initializeBaseline(request);
        }
        const repeatOf = Reflect.get(request, 'repeatOf');
        if (typeof repeatOf !== 'string') {
            return envelope.initializeBaseline(request);
        }
        if (repeatOf.endsWith('-repeat-01')) {
            return {
                ok: false,
                issues: [
                    rtcBaselineIssue('$.repeatOf', 'repeat-of-repeat', 'A repeat cannot use another repeat.')
                ]
            };
        }
        const primary = await finalizedReader.readVerifiedRepeatPrimary({ baselineId: repeatOf });
        if (!primary.ok) {
            return primary;
        }
        const prepared = prepareRtcBaselineRepeatRequest({
            primary: {
                ...primary.value.manifest.request,
                workloadIds: primary.value.triggeredWorkloadIds
            },
            request,
            repeatLink: {
                primaryBaselineId: repeatOf,
                primarySummarySha256: primary.value.summarySha256
            },
            inheritedDecisions: primary.value.environment.conditionalEnvironmentDecisions
        });
        return prepared.ok ? envelope.initializeBaseline(prepared.value) : prepared;
    };
}
