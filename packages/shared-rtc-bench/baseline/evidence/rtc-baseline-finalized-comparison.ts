import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type {
    RtcBaselineComparisonChoice,
    RtcBaselineComparisonChoiceInput,
    RtcBaselinePairedComparison,
    RtcBaselinePairedComparisonInput
} from './rtc-baseline-evidence-layout.ts';
import type { RtcBaselineFinalizedArtifactVerifier } from './rtc-baseline-finalized-verification.ts';
import {
    compareRtcBaselinePersistedMetrics,
    evaluateRtcBaselineWorkloadRepeatOutcome,
    rtcBaselineTriggeredWorkloads
} from './rtc-baseline-statistics.ts';

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path, code, message }] };
}

async function readComparisonChoice(
    verifier: RtcBaselineFinalizedArtifactVerifier,
    input: RtcBaselineComparisonChoiceInput
): Promise<RtcBaselineResult<RtcBaselineComparisonChoice>> {
    const { primaryBaselineId, comparisonBaselineId, inputPath, workloadId } = input;
    const primary = await verifier.readVerifiedArtifacts(primaryBaselineId);
    if (!primary.ok) {
        return primary;
    }
    const repeatRequired = rtcBaselineTriggeredWorkloads(primary.value).includes(workloadId);
    const selectedId = repeatRequired ? `${primaryBaselineId}-repeat-01` : primaryBaselineId;
    if (comparisonBaselineId !== selectedId) {
        return failed(
            inputPath,
            'invalid-comparison-baseline',
            repeatRequired
                ? 'A noisy primary requires its exact -repeat-01 baseline.'
                : 'A stable primary must compare from itself.'
        );
    }
    const selected = selectedId === primaryBaselineId ? primary : await verifier.readVerifiedArtifacts(selectedId);
    if (!selected.ok) {
        return selected;
    }
    const linked = await verifier.validateRepeatLink(selectedId, selected.value.summary);
    if (!linked.ok) {
        return linked;
    }
    const context = primary.value.environment.observation?.host.executionContext;
    const repeatEvaluation = context === undefined
        ? { ok: true as const, value: { repeatRequired: false, stillNoisy: false } }
        : evaluateRtcBaselineWorkloadRepeatOutcome({
            primaryMetrics: primary.value.summary.metricSummaries,
            repeatMetrics: selected.value.summary.metricSummaries,
            workloadId,
            executionContext: context
        });
    if (!repeatEvaluation.ok) {
        return repeatEvaluation;
    }
    const environment = selected.value.environment;
    if (environment.observation === null) {
        return failed(
            '$.environment.observation',
            'missing-runtime-observation',
            'Comparison baselines require a runtime observation.'
        );
    }
    return {
        ok: true,
        value: {
            primary: primary.value.summary,
            selected: selected.value.summary,
            selectedId,
            repeatRequired,
            stillNoisy: repeatEvaluation.value.stillNoisy,
            environment: { ...environment, observation: environment.observation }
        }
    };
}

async function readPairedComparison(
    verifier: RtcBaselineFinalizedArtifactVerifier,
    input: RtcBaselinePairedComparisonInput
): Promise<RtcBaselineResult<RtcBaselinePairedComparison>> {
    const primary = await readComparisonChoice(verifier, {
        primaryBaselineId: input.primaryBaselineId,
        comparisonBaselineId: input.primaryComparisonCohortId,
        inputPath: '$.primaryComparisonCohortId',
        workloadId: input.workloadId
    });
    if (!primary.ok) {
        return primary;
    }
    const candidate = await readComparisonChoice(verifier, {
        primaryBaselineId: input.candidateBaselineId,
        comparisonBaselineId: input.candidateComparisonCohortId,
        inputPath: '$.candidateComparisonCohortId',
        workloadId: input.workloadId
    });
    if (!candidate.ok) {
        return candidate;
    }
    const compared = compareRtcBaselinePersistedMetrics({
        baselineEnvironment: primary.value.environment,
        candidateEnvironment: candidate.value.environment,
        baselineMetrics: primary.value.selected.metricSummaries,
        candidateMetrics: candidate.value.selected.metricSummaries,
        workloadId: input.workloadId
    });
    if (!compared.ok) {
        return compared;
    }
    const value = {
        primary: {
            primaryBaselineId: input.primaryBaselineId,
            comparisonBaselineId: primary.value.selectedId,
            repeatRequired: primary.value.repeatRequired
        },
        candidate: {
            primaryBaselineId: input.candidateBaselineId,
            comparisonBaselineId: candidate.value.selectedId,
            repeatRequired: candidate.value.repeatRequired
        },
        comparisons: compared.value
    };
    if (primary.value.stillNoisy || candidate.value.stillNoisy) {
        return {
            ok: true,
            value: {
                outcome: 'inconclusive-still-noisy',
                ...value,
                issues: [
                    {
                        path: '$.comparisons',
                        code: 'repeat-still-noisy',
                        message: 'Selected repeat is noisy.'
                    }
                ]
            }
        };
    }
    return { ok: true, value: { outcome: 'conclusive', ...value } };
}

export function createRtcBaselineFinalizedComparisonReader(
    verifier: RtcBaselineFinalizedArtifactVerifier
) {
    return {
        readPairedComparison: (input: RtcBaselinePairedComparisonInput) => readPairedComparison(verifier, input)
    };
}
