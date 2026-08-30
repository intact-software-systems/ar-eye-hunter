import { strFromU8 } from 'fflate';

import type { RtcBaselineIssueDto, RtcBaselineJson, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineVerifiedArtifacts } from '../evidence/rtc-baseline-evidence-layout.ts';
import type { RtcBaselineFinalizedReaderDependencies } from '../evidence/rtc-baseline-finalized-artifact-reader.ts';
import {
    createRtcBaselineFinalizedArtifactVerifier,
    type RtcBaselineFinalizedArtifactVerifier
} from '../evidence/rtc-baseline-finalized-verification.ts';
import type { RtcRepositoryPerformanceObservation } from './rtc-performance-observation.ts';

export interface RtcPerformanceObservationEvidenceValidationInput {
    readonly entries: Readonly<Record<string, Uint8Array>>;
    readonly observation: RtcRepositoryPerformanceObservation;
    readonly sha256: (bytes: Uint8Array) => Promise<string>;
}

interface RtcPerformanceObservationEvidenceContractInput {
    readonly role: 'primary' | 'repeat';
    readonly evidence: RtcBaselineVerifiedArtifacts;
    readonly declaredOutcome: RtcRepositoryPerformanceObservation['primary']['outcome'];
    readonly acceptedMetrics: boolean;
    readonly observation: RtcRepositoryPerformanceObservation;
}

export async function validateRtcPerformanceObservationEvidence(
    input: RtcPerformanceObservationEvidenceValidationInput
) {
    const dependencies = toFinalizedReaderDependencies(input);
    const verifier = createRtcBaselineFinalizedArtifactVerifier(dependencies);
    const primary = await verifier.readStructurallyVerifiedArtifacts(input.observation.observationId);
    const issues = primary.ok
        ? validateRtcPerformanceObservationEvidenceContract({
            role: 'primary',
            evidence: primary.value,
            declaredOutcome: input.observation.primary.outcome,
            acceptedMetrics: input.observation.primary.acceptedMetrics,
            observation: input.observation
        })
        : prefixEvidenceIssues('primary', primary.issues);
    if (input.observation.repeat.decision === 'required') {
        issues.push(...await validateRtcPerformanceObservationRepeat(input, verifier));
    }
    return issues;
}

async function validateRtcPerformanceObservationRepeat(
    input: RtcPerformanceObservationEvidenceValidationInput,
    verifier: RtcBaselineFinalizedArtifactVerifier
) {
    const repeatId = `${input.observation.observationId}-repeat-01`;
    const repeat = await verifier.readStructurallyVerifiedArtifacts(repeatId);
    if (!repeat.ok) {
        return prefixEvidenceIssues('repeat', repeat.issues);
    }
    if (input.observation.repeat.outcome === 'not-run') {
        return [
            issue(
                '$.repeat.outcome',
                'archive-evidence-outcome-mismatch',
                'A required repeat must declare its finalized evidence outcome.'
            )
        ];
    }
    const issues = validateRtcPerformanceObservationEvidenceContract({
        role: 'repeat',
        evidence: repeat.value,
        declaredOutcome: input.observation.repeat.outcome,
        acceptedMetrics: false,
        observation: input.observation
    });
    const linked = await verifier.validateRepeatLink(repeatId, repeat.value.summary);
    return linked.ok ? issues : [...issues, ...prefixEvidenceIssues('repeat', linked.issues)];
}

function validateRtcPerformanceObservationEvidenceContract(
    input: RtcPerformanceObservationEvidenceContractInput
) {
    const observed = input.evidence.environment.observation;
    const b05 = input.observation.schema === 'rallar.rtc-performance-observation.v1';
    const environmentId = b05 ? 'E2-browser' : 'E3-memory';
    const workloadId = b05 ? 'RTC-B05' : 'RTC-B06';
    const contractMatches = input.evidence.environment.environmentId === environmentId &&
        JSON.stringify(input.evidence.environment.workloadIds) === `["${workloadId}"]` &&
        JSON.stringify(input.evidence.manifest.workloadIds) === `["${workloadId}"]` &&
        observed !== null &&
        observed.git.headCommit === input.observation.source.commit &&
        observed.git.headTree === input.observation.source.tree;
    const actualOutcome = [
            ...input.evidence.summary.sampleOutcomes,
            ...input.evidence.summary.cohortOutcomes
        ].some(({ outcome }) => outcome !== 'passed')
        ? 'failed'
        : 'passed';
    const metricsMatch = input.role === 'repeat' ||
        input.acceptedMetrics === (
                actualOutcome === 'passed' && input.evidence.summary.metricSummaries.length > 0
            );
    return [
        ...(!contractMatches
            ? [issue(
                `$.${input.role}.evidence`,
                'archive-evidence-contract-mismatch',
                `Finalized evidence must describe this ${workloadId} ${environmentId} source.`
            )]
            : []),
        ...(input.declaredOutcome !== actualOutcome
            ? [issue(
                `$.${input.role}.outcome`,
                'archive-evidence-outcome-mismatch',
                'Declared observation outcome differs from finalized evidence.'
            )]
            : []),
        ...(!metricsMatch
            ? [issue(
                `$.${input.role}.acceptedMetrics`,
                'archive-evidence-metrics-mismatch',
                'Accepted metrics require passing evidence with retained metric summaries.'
            )]
            : [])
    ];
}

function toFinalizedReaderDependencies(
    input: RtcPerformanceObservationEvidenceValidationInput
): RtcBaselineFinalizedReaderDependencies {
    const primaryId = input.observation.observationId;
    function prefixFor(baselineId: string) {
        return baselineId === primaryId
            ? `primary/${primaryId}/`
            : baselineId === `${primaryId}-repeat-01`
            ? `repeat/${baselineId}/`
            : null;
    }
    async function readBytes(baselineId: string, path: string): Promise<RtcBaselineResult<Uint8Array>> {
        const prefix = prefixFor(baselineId);
        const bytes = prefix === null ? undefined : input.entries[`${prefix}${path}`];
        return bytes === undefined
            ? {
                ok: false,
                issues: [issue(`$.${path}`, 'missing-archive-evidence', 'Archived evidence file is missing.')]
            }
            : { ok: true, value: bytes };
    }
    return {
        readBytes,
        readJson: async (baselineId: string, path: string): Promise<RtcBaselineResult<RtcBaselineJson>> => {
            const bytes = await readBytes(baselineId, path);
            if (!bytes.ok) {
                return bytes;
            }
            try {
                return { ok: true, value: JSON.parse(strFromU8(bytes.value)) as RtcBaselineJson };
            }
            catch {
                return {
                    ok: false,
                    issues: [issue(`$.${path}`, 'invalid-json', 'Archived evidence JSON is malformed.')]
                };
            }
        },
        listArtifactPaths: async (baselineId: string): Promise<RtcBaselineResult<string[]>> => {
            const prefix = prefixFor(baselineId);
            return prefix === null
                ? {
                    ok: false,
                    issues: [issue(
                        '$.baselineId',
                        'unexpected-baseline-id',
                        'Archive does not contain this baseline.'
                    )]
                }
                : {
                    ok: true,
                    value: Object.keys(input.entries)
                        .filter((path) => path.startsWith(prefix))
                        .map((path) => path.slice(prefix.length))
                        .filter((path) => path !== 'SHA256SUMS')
                };
        },
        sha256: input.sha256
    };
}

function prefixEvidenceIssues(
    role: 'primary' | 'repeat',
    issues: readonly RtcBaselineIssueDto[]
) {
    return issues.map((problem) => ({
        ...problem,
        path: `$.${role}.evidence${problem.path.slice(1)}`
    }));
}

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}
