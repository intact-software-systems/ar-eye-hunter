import { computeRtcB06RetentionHeapPolicy } from '../acceptance/rtc-b06-retention-heap-policy.ts';
import {
    decodeRtcBaselineEnvironment,
    decodeRtcBaselineExternalCohort
} from '../contracts/rtc-baseline-artifact-decoding.ts';
import { validateRtcBaselineExternalCohort } from '../contracts/rtc-baseline-artifact-validation.ts';
import type {
    RtcBaselineExternalCohortDto,
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineResult
} from '../contracts/rtc-baseline-contracts.ts';

import { requiresRtcBaselineRepeat, type PersistedMetric } from '../evidence/rtc-baseline-statistics.ts';

export interface RtcB06EvidenceReport {
    readonly metricOutcome: 'conclusive' | 'inconclusive' | 'unavailable';
    readonly warnings: readonly RtcBaselineIssueDto[];
}

export interface RtcB06EvidenceReportInput {
    readonly artifacts: ReadonlyMap<string, Uint8Array>;
    readonly metricSummaries: readonly PersistedMetric[];
}

export function readRtcB06EvidenceReport(input: RtcB06EvidenceReportInput): RtcBaselineResult<RtcB06EvidenceReport> {
    const environmentBytes = input.artifacts.get('environment.json');
    if (environmentBytes === undefined) {
        return invalidWarningEvidence('Finalized runtime environment is required for metric interpretation.');
    }
    const environmentJson = readReportJson(environmentBytes);
    if (!environmentJson.ok) {
        return environmentJson;
    }
    const environment = decodeRtcBaselineEnvironment(environmentJson.value);
    if (!environment.ok) {
        return environment;
    }
    if (
        !['E3-memory', 'E4-pg'].includes(environment.value.environmentId) ||
        environment.value.workloadIds.length !== 1 || environment.value.workloadIds[0] !== 'RTC-B06'
    ) {
        return invalidWarningEvidence('B06 reports require exact E3-memory or E4-pg B06 evidence.');
    }
    const executionContext = environment.value.observation?.host.executionContext;
    if (executionContext === undefined) {
        return invalidWarningEvidence('Runtime execution context is required for metric interpretation.');
    }
    const metricsInconclusive = input.metricSummaries.some((metric) =>
        requiresRtcBaselineRepeat(metric, executionContext)
    );
    const warnings: RtcBaselineIssueDto[] = [];
    for (const [path, bytes] of input.artifacts) {
        if (!path.startsWith('results/external-cohorts/')) {
            continue;
        }
        const decoded = readRetentionCohort(bytes);
        if (!decoded.ok) {
            return decoded;
        }
        const policy = readRetentionWarnings(decoded.value);
        if (!policy.ok) {
            return policy;
        }
        warnings.push(...policy.value);
    }
    return {
        ok: true,
        value: {
            metricOutcome: input.metricSummaries.length === 0
                ? 'unavailable'
                : metricsInconclusive
                ? 'inconclusive'
                : 'conclusive',
            warnings
        }
    };
}

function readRetentionCohort(bytes: Uint8Array): RtcBaselineResult<RtcBaselineExternalCohortDto> {
    const raw = readReportJson(bytes);
    if (!raw.ok) {
        return raw;
    }
    const decoded = decodeRtcBaselineExternalCohort(raw.value);
    if (!decoded.ok) {
        return decoded;
    }
    const issues = validateRtcBaselineExternalCohort(decoded.value);
    return issues.length > 0 ? { ok: false, issues } : decoded;
}

function readRetentionWarnings(
    cohort: RtcBaselineExternalCohortDto
): RtcBaselineResult<readonly RtcBaselineIssueDto[]> {
    const raw = cohort.rawEvidence;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return invalidWarningEvidence('Retention warning evidence must be an object.');
    }
    const ids = raw.heapBreachingSampleIds;
    if (
        !Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string') ||
        new Set(ids).size !== ids.length || ids.some((id) => !cohort.identity.memberSampleIds.includes(id)) ||
        raw.retainedAttemptCount !== cohort.identity.memberSampleIds.length
    ) {
        return invalidWarningEvidence(
            'Heap breach identities must be distinct members of the complete retention cohort.'
        );
    }
    const policy = computeRtcB06RetentionHeapPolicy(cohort.identity.memberSampleIds.length, ids);
    if (!policy.ok) {
        return policy;
    }
    if (
        raw.requiredHeapBreachCount !== policy.value.requiredHeapBreachCount ||
        !matchesRetentionWarnings(raw.warnings, policy.value.warnings)
    ) {
        return invalidWarningEvidence('Retention warnings must exactly report the approved heap threshold policy.');
    }
    return { ok: true, value: policy.value.warnings };
}

function matchesRetentionWarnings(
    warnings: RtcBaselineJson | undefined,
    expected: readonly RtcBaselineIssueDto[]
): boolean {
    return Array.isArray(warnings) && warnings.length === expected.length && warnings.every((warning, index) => {
        const issue = expected[index]!;
        return typeof warning === 'object' && warning !== null && !Array.isArray(warning) &&
            Object.keys(warning).sort().join(',') === 'code,message,path' &&
            warning.code === issue.code && warning.message === issue.message && warning.path === issue.path;
    });
}

function invalidWarningEvidence(message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path: '$.rawEvidence.warnings', code: 'invalid-retention-warnings', message }] };
}

function readReportJson(bytes: Uint8Array): RtcBaselineResult<RtcBaselineJson> {
    try {
        return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as RtcBaselineJson };
    }
    catch {
        return invalidWarningEvidence('Finalized report evidence JSON is malformed.');
    }
}
