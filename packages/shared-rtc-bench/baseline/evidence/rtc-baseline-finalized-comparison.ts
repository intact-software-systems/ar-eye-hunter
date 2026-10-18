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
    rtcBaselineAutomaticRepeatWorkloads,
    rtcBaselineTriggeredWorkloads,
    type RtcBaselineNoiseEvidence,
    type RtcBaselinePersistedMetricComparison
} from './rtc-baseline-statistics.ts';

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path, code, message }] };
}

interface RtcBaselineComparisonSelection {
    selectedId: string;
    repeatRequired: boolean;
}

function resolveComparisonSelection(
    primary: RtcBaselineNoiseEvidence,
    input: RtcBaselineComparisonChoiceInput
): RtcBaselineResult<RtcBaselineComparisonSelection> {
    const repeatRequired = rtcBaselineAutomaticRepeatWorkloads(primary).includes(input.workloadId);
    const noisy = rtcBaselineTriggeredWorkloads(primary).includes(input.workloadId);
    const repeatId = input.primaryBaselineId + '-repeat-01';
    const permittedId = repeatRequired ? repeatId : input.primaryBaselineId;
    const deliberateRepeat = noisy && !repeatRequired && input.comparisonBaselineId === repeatId;
    if (input.comparisonBaselineId !== permittedId && !deliberateRepeat) {
        return failed(
            input.inputPath,
            'invalid-comparison-baseline',
            repeatRequired
                ? 'A noisy primary requires its exact -repeat-01 baseline.'
                : 'Compare the primary itself or an explicitly selected noisy-primary repeat.'
        );
    }
    return { ok: true, value: { selectedId: input.comparisonBaselineId, repeatRequired } };
}

async function readComparisonChoice(
    verifier: RtcBaselineFinalizedArtifactVerifier,
    input: RtcBaselineComparisonChoiceInput
): Promise<RtcBaselineResult<RtcBaselineComparisonChoice>> {
    const { primaryBaselineId, workloadId } = input;
    const primary = await verifier.readVerifiedArtifacts(primaryBaselineId);
    if (!primary.ok) {
        return primary;
    }
    const selection = resolveComparisonSelection(primary.value, input);
    if (!selection.ok) {
        return selection;
    }
    const { selectedId, repeatRequired } = selection.value;
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
            stillNoisy: repeatRequired
                ? repeatEvaluation.value.stillNoisy
                : rtcBaselineTriggeredWorkloads(selected.value).includes(workloadId),
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
    return toPairedComparison(primary.value, candidate.value, compared.value);
}

function toPairedComparison(
    primary: RtcBaselineComparisonChoice,
    candidate: RtcBaselineComparisonChoice,
    comparisons: readonly RtcBaselinePersistedMetricComparison[]
): RtcBaselineResult<RtcBaselinePairedComparison> {
    const value = {
        primary: {
            primaryBaselineId: primary.primary.baselineId,
            comparisonBaselineId: primary.selectedId,
            repeatRequired: primary.repeatRequired
        },
        candidate: {
            primaryBaselineId: candidate.primary.baselineId,
            comparisonBaselineId: candidate.selectedId,
            repeatRequired: candidate.repeatRequired
        },
        comparisons
    };
    if (primary.stillNoisy || candidate.stillNoisy) {
        return {
            ok: true,
            value: {
                outcome: 'inconclusive-still-noisy',
                ...value,
                issues: [
                    {
                        path: '$.comparisons',
                        code: 'repeat-still-noisy',
                        message: 'Selected cohort is noisy; timings remain descriptive and inconclusive.'
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
