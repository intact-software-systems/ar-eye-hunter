import { computeRtcBaselineMetricObservations } from '../catalog/rtc-baseline-workload-manifest.ts';
import {
    validateRtcBaselineRetainedSampleObservations,
    validateRtcBaselineStoredArtifact
} from '../contracts/rtc-baseline-artifact-validation.ts';
import type {
    RtcBaselineCohortIdentityDto,
    RtcBaselineEnvironmentId,
    RtcBaselineIssueDto,
    RtcBaselineRawReferenceDto,
    RtcBaselineResult,
    RtcBaselineRuntimeObservationDto,
    RtcBaselineSampleDto,
    RtcBaselineSampleIdentityDto,
    RtcBaselineSampleOutcomeDto
} from '../contracts/rtc-baseline-contracts.ts';
import type {
    RtcBaselineCohortOutcomeRecord,
    RtcBaselineStoredArtifact,
    RtcBaselineSummaryArtifactRecord
} from './rtc-baseline-evidence-layout.ts';
import { canonicalizeRtcBaselineRawReferences } from './rtc-baseline-evidence-layout.ts';
import type { RtcBaselineMetricObservation } from './rtc-baseline-statistics.ts';

export interface RtcBaselineArtifactProjection {
    readonly sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    readonly cohortOutcomes: readonly RtcBaselineCohortOutcomeRecord[];
    readonly failures: readonly RtcBaselineFailureOutcomeRecord[];
    readonly metricObservations: readonly RtcBaselineMetricObservation[];
    readonly rawReferences: readonly RtcBaselineRawReferenceDto[];
    readonly artifactIssues: readonly RtcBaselineIssueDto[];
}

export interface RtcBaselineFailureOutcomeRecord {
    readonly identity: RtcBaselineSampleIdentityDto | RtcBaselineCohortIdentityDto;
    readonly outcome: 'failed' | 'not-run';
    readonly issues: readonly RtcBaselineIssueDto[];
}

export interface RtcBaselineArtifactProjector {
    appendFailureOutcome(failure: RtcBaselineFailureOutcomeRecord): Promise<RtcBaselineResult<void>>;
    appendStoredArtifact(artifact: RtcBaselineStoredArtifact): Promise<RtcBaselineResult<void>>;
    getProjection(): RtcBaselineArtifactProjection;
}

const encoder = new TextEncoder();

function successful(): RtcBaselineResult<void> {
    return { ok: true, value: undefined };
}

function failed(code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path: '$.samples', code, message }] };
}

function toIndexedSampleIssues(
    issues: readonly RtcBaselineIssueDto[],
    sampleIndex: number
): RtcBaselineIssueDto[] {
    return issues.map((issue) => ({
        ...issue,
        path: issue.path.replace('$.samples[0]', `$.samples[${sampleIndex}]`)
    }));
}

function toSampleOutcome(sample: RtcBaselineSampleDto): RtcBaselineSampleOutcomeDto {
    return { identity: sample.identity, outcome: sample.outcome, issues: sample.issues };
}

function isMatchingFailedSample(
    sample: RtcBaselineSampleOutcomeDto,
    failure: RtcBaselineFailureOutcomeRecord
): boolean {
    return sample.outcome === 'failed' && failure.outcome === 'failed' &&
        Object.entries(sample.identity).every(([key, value]) => Reflect.get(failure.identity, key) === value) &&
        JSON.stringify(sample.issues) === JSON.stringify(failure.issues);
}

export function createRtcBaselineArtifactProjector(
    projectorInput: RtcBaselineArtifactProjectionState.Input
): RtcBaselineArtifactProjector {
    return new RtcBaselineArtifactProjectionState(projectorInput);
}

namespace RtcBaselineArtifactProjectionState {
    export interface Input {
        readonly environmentId: RtcBaselineEnvironmentId;
        readonly environmentObservation: RtcBaselineRuntimeObservationDto | null;
        readonly conflictingSampleCode: string;
        readonly conflictingSampleMessage: (sampleId: string) => string;
        readonly sha256: (bytes: Uint8Array) => Promise<string>;
    }
}

class RtcBaselineArtifactProjectionState implements RtcBaselineArtifactProjector {
    private readonly sampleDigestById = new Map<string, string>();
    private readonly sampleOutcomes: RtcBaselineSampleOutcomeDto[] = [];
    private readonly cohortOutcomes: RtcBaselineCohortOutcomeRecord[] = [];
    private readonly failures: RtcBaselineFailureOutcomeRecord[] = [];
    private readonly metricObservations: RtcBaselineMetricObservation[] = [];
    private readonly rawReferences: RtcBaselineRawReferenceDto[] = [];
    private readonly artifactIssues: RtcBaselineIssueDto[] = [];
    private readonly projectorInput: RtcBaselineArtifactProjectionState.Input;

    constructor(projectorInput: RtcBaselineArtifactProjectionState.Input) {
        this.projectorInput = projectorInput;
    }

    private async appendSample(sample: RtcBaselineSampleDto): Promise<RtcBaselineResult<void>> {
        let digest: string;
        try {
            digest = await this.projectorInput.sha256(encoder.encode(JSON.stringify(sample)));
        }
        catch (error) {
            return failed('hash-failed', error instanceof Error ? error.message : String(error));
        }
        const existingDigest = this.sampleDigestById.get(sample.identity.sampleId);
        if (existingDigest !== undefined) {
            return existingDigest === digest
                ? successful()
                : failed(
                    this.projectorInput.conflictingSampleCode,
                    this.projectorInput.conflictingSampleMessage(sample.identity.sampleId)
                );
        }
        const receipt = this.failures.find((failure) =>
            'sampleId' in failure.identity && failure.identity.sampleId === sample.identity.sampleId
        );
        const outcome = toSampleOutcome(sample);
        if (receipt && !isMatchingFailedSample(outcome, receipt)) {
            return failed('conflicting-failure-sample', 'Failed sample and causal receipt contradict each other.');
        }
        const sampleIndex = this.sampleDigestById.size;
        this.sampleDigestById.set(sample.identity.sampleId, digest);
        this.artifactIssues.push(
            ...validateRtcBaselineStoredArtifact(sample),
            ...toIndexedSampleIssues(
                validateRtcBaselineRetainedSampleObservations(this.projectorInput.environmentObservation, [sample]),
                sampleIndex
            )
        );
        if (!receipt) {
            this.sampleOutcomes.push(outcome);
        }
        this.metricObservations.push(
            ...computeRtcBaselineMetricObservations([sample], this.projectorInput.environmentId)
        );
        this.rawReferences.push(...sample.rawReferences);
        return successful();
    }

    private async appendSamples(samples: readonly RtcBaselineSampleDto[]): Promise<RtcBaselineResult<void>> {
        for (const sample of samples) {
            const appended = await this.appendSample(sample);
            if (!appended.ok) {
                return appended;
            }
        }
        return successful();
    }

    async appendStoredArtifact(artifact: RtcBaselineStoredArtifact): Promise<RtcBaselineResult<void>> {
        if (artifact.schema === 'rallar.rtc-baseline.sample.v1') {
            return this.appendSample(artifact);
        }
        this.artifactIssues.push(...validateRtcBaselineStoredArtifact(artifact));
        if (artifact.schema === 'rallar.rtc-baseline.external-attempt.v1') {
            return this.appendSamples(artifact.samples);
        }
        if (artifact.schema === 'rallar.rtc-baseline.external-cohort.v1') {
            this.cohortOutcomes.push({
                identity: artifact.identity,
                outcome: artifact.outcome,
                issues: artifact.issues
            });
            return this.appendSamples(artifact.samples);
        }
        return successful();
    }

    async appendFailureOutcome(failure: RtcBaselineFailureOutcomeRecord): Promise<RtcBaselineResult<void>> {
        const projected = { identity: failure.identity, outcome: failure.outcome, issues: failure.issues };
        if ('sampleId' in failure.identity) {
            const sampleId = failure.identity.sampleId;
            if (
                this.failures.some((receipt) =>
                    'sampleId' in receipt.identity && receipt.identity.sampleId === sampleId
                )
            ) {
                return failed('duplicate-failure-outcome', 'A sample cannot have multiple causal failure receipts.');
            }
            const sample = this.sampleOutcomes.find((outcome) => outcome.identity.sampleId === sampleId);
            if (sample && (!this.sampleDigestById.has(sampleId) || !isMatchingFailedSample(sample, failure))) {
                return failed('conflicting-failure-sample', 'Failed sample and causal receipt contradict each other.');
            }
            if (!sample) {
                this.sampleOutcomes.push({
                    identity: failure.identity,
                    outcome: failure.outcome,
                    issues: failure.issues
                });
            }
        }
        else {
            this.cohortOutcomes.push({ identity: failure.identity, outcome: 'failed', issues: failure.issues });
        }
        this.failures.push(projected);
        return successful();
    }

    getProjection(): RtcBaselineArtifactProjection {
        return {
            sampleOutcomes: this.sampleOutcomes,
            cohortOutcomes: this.cohortOutcomes,
            failures: this.failures,
            metricObservations: this.metricObservations,
            rawReferences: this.rawReferences,
            artifactIssues: this.artifactIssues
        };
    }
}

export function projectRtcBaselineArtifactOutcomes(input: {
    sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    cohortOutcomes: readonly RtcBaselineCohortOutcomeRecord[];
    failures: readonly RtcBaselineFailureOutcomeRecord[];
}) {
    const samples = new Map(
        input.sampleOutcomes.map(({ identity, outcome, issues }) => [
            identity.sampleId,
            { identity, outcome, issues }
        ])
    );
    const cohorts = new Map(
        input.cohortOutcomes.map(({ identity, outcome, issues }) => [
            identity.cohortId,
            { identity, outcome, issues }
        ])
    );
    for (const failure of input.failures) {
        if ('sampleId' in failure.identity) {
            samples.set(failure.identity.sampleId, {
                identity: failure.identity,
                outcome: failure.outcome,
                issues: failure.issues
            });
        }
        else {
            cohorts.set(failure.identity.cohortId, {
                identity: failure.identity,
                outcome: 'failed',
                issues: failure.issues
            });
        }
    }
    return {
        sampleOutcomes: [...samples.values()].sort((left, right) =>
            left.identity.sampleId.localeCompare(right.identity.sampleId)
        ),
        cohortOutcomes: [...cohorts.values()].sort((left, right) =>
            left.identity.cohortId.localeCompare(right.identity.cohortId)
        )
    };
}

export function validateRtcBaselineArtifactOutcomeReconciliation(input: {
    sampleOutcomes: readonly RtcBaselineSampleOutcomeDto[];
    rawReferences: readonly RtcBaselineRawReferenceDto[];
    cohorts: readonly RtcBaselineCohortOutcomeRecord[];
    failures: readonly RtcBaselineFailureOutcomeRecord[];
    summary: RtcBaselineSummaryArtifactRecord;
}) {
    const outcomes = projectRtcBaselineArtifactOutcomes({
        sampleOutcomes: input.sampleOutcomes,
        cohortOutcomes: input.cohorts,
        failures: input.failures
    });
    const issues: RtcBaselineIssueDto[] = [];
    if (JSON.stringify(outcomes.sampleOutcomes) !== JSON.stringify(input.summary.sampleOutcomes)) {
        issues.push({
            path: '$.summary.sampleOutcomes',
            code: 'sample-outcome-mismatch',
            message: 'Summary sample outcomes differ from retained artifacts.'
        });
    }
    if (JSON.stringify(outcomes.cohortOutcomes) !== JSON.stringify(input.summary.cohortOutcomes)) {
        issues.push({
            path: '$.summary.cohortOutcomes',
            code: 'cohort-outcome-mismatch',
            message: 'Summary cohort outcomes differ from retained artifacts.'
        });
    }
    const storedRaw = canonicalizeRtcBaselineRawReferences(input.rawReferences);
    const summaryRaw = canonicalizeRtcBaselineRawReferences(input.summary.rawReferences);
    if (!storedRaw.ok) {
        issues.push(...storedRaw.issues);
    }
    if (!summaryRaw.ok) {
        issues.push(...summaryRaw.issues);
    }
    if (
        storedRaw.ok &&
        summaryRaw.ok &&
        JSON.stringify(storedRaw.value) !== JSON.stringify(summaryRaw.value)
    ) {
        issues.push({
            path: '$.summary.rawReferences',
            code: 'raw-reference-mismatch',
            message: 'Summary raw references differ from retained samples.'
        });
    }
    return issues;
}
