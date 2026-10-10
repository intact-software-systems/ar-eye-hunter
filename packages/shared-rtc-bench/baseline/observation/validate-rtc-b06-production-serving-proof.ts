import { validateFullStackRtcProductionProof } from '../../../shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';
import type { RtcBaselineIssueDto, RtcBaselineSampleDto } from '../contracts/rtc-baseline-contracts.ts';
export function validateRtcB06ProductionServingProof(sample: RtcBaselineSampleDto): readonly RtcBaselineIssueDto[] {
    const observation = sample.runtimeObservation;
    const mode = observation?.resolvedConfiguration.find((entry) =>
        entry.caseKey.caseId === sample.identity.caseId && entry.caseKey.inputKey === sample.identity.inputKey &&
        entry.field === 'appServingMode'
    );
    if (sample.identity.workloadId !== 'RTC-B06' || mode?.value !== 'production' || !observation) {
        return [];
    }
    const raw = sample.rawEvidence;
    const proof = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.productionServing : undefined;
    const baselineId = observation.controllerInputs.find((entry) => entry.name === 'baselineId')?.value;
    const issues = validateFullStackRtcProductionProof(proof, {
        baselineId: typeof baselineId === 'string' ? baselineId : '',
        attempt: {
            workloadId: sample.identity.workloadId,
            caseId: sample.identity.caseId,
            inputKey: sample.identity.inputKey,
            intendedPhase: sample.identity.intendedPhase,
            outerOrdinal: sample.identity.outerOrdinal,
            environmentId: 'E3-memory',
            rawResultRelativePath:
                `artifacts/staging/rtc-b06-${sample.identity.caseId}-${sample.identity.inputKey}-${sample.identity.intendedPhase}-${
                    String(sample.identity.outerOrdinal).padStart(3, '0')
                }.json`
        },
        git: observation.git,
        inputFiles: observation.sourceHashes
    });
    return issues.length > 0
        ? [{
            path: '$.rawEvidence.productionServing',
            code: 'production-serving-proof-invalid',
            message:
                'Production RTC-B06 results require exact sealed input/output, served-byte and original browser entry proof.'
        }]
        : [];
}
