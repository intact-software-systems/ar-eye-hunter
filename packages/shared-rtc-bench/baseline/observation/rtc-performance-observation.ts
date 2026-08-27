import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineObservationId } from '../contracts/rtc-baseline-id.ts';

export type RtcPerformanceObservationOutcome = 'passed' | 'failed' | 'incomplete';

export interface RtcPerformanceObservationSourceDto {
    readonly commit: string;
    readonly tree: string;
    readonly ref: string;
}

export interface RtcPerformanceObservationWorkflowDto {
    readonly runId: number;
    readonly runAttempt: number;
    readonly url: string;
}

export interface RtcPerformanceObservationPrimaryDto {
    readonly outcome: RtcPerformanceObservationOutcome;
    readonly acceptedMetrics: boolean;
}

export interface RtcPerformanceObservationRepeatDto {
    readonly decision: 'not-required' | 'required';
    readonly outcome: 'not-run' | RtcPerformanceObservationOutcome;
}

export interface RtcPerformanceObservation {
    readonly schema: 'rallar.rtc-performance-observation.v1';
    readonly observationId: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly source: RtcPerformanceObservationSourceDto;
    readonly workflow: RtcPerformanceObservationWorkflowDto;
    readonly primary: RtcPerformanceObservationPrimaryDto;
    readonly repeat: RtcPerformanceObservationRepeatDto;
}

export interface RtcPerformanceObservationArchiveDto {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
}

export interface RtcPerformanceObservationIndexEntryDto {
    readonly schema: 'rallar.rtc-performance-observation.index-entry.v1';
    readonly observation: RtcPerformanceObservation;
    readonly archive: RtcPerformanceObservationArchiveDto;
}

export function decodeRtcPerformanceObservationIndexEntry(
    source: unknown
): RtcBaselineResult<RtcPerformanceObservationIndexEntryDto> {
    if (!isRtcPerformanceObservationIndexEntry(source)) {
        return failed('$.indexEntry', 'invalid-index-entry', 'Observation index entry is incomplete or malformed.');
    }
    const indexEntry = source as RtcPerformanceObservationIndexEntryDto;
    const issues = validateRtcPerformanceObservationIndexEntry(indexEntry);
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: indexEntry };
}

export function toRtcPerformanceObservationArchivePath(observation: RtcPerformanceObservation) {
    const year = observation.startedAt.slice(0, 4);
    const month = observation.startedAt.slice(5, 7);
    const day = observation.startedAt.slice(8, 10);
    return `performance-observations/rtc-b05/${year}/${month}/${day}/${observation.observationId}.zip`;
}

function validateRtcPerformanceObservationIndexEntry(
    indexEntry: RtcPerformanceObservationIndexEntryDto
) {
    const observation = indexEntry.observation;
    const expectedId = createRtcBaselineObservationId({
        startedAt: observation.startedAt,
        sourceCommit: observation.source.commit,
        environmentId: 'E2-browser',
        githubRunId: observation.workflow.runId,
        githubRunAttempt: observation.workflow.runAttempt
    });
    return [
        ...(!expectedId.ok || expectedId.value !== observation.observationId
            ? [issue(
                '$.observation.observationId',
                'observation-id-mismatch',
                'Observation identity does not match its provenance.'
            )]
            : []),
        ...(Date.parse(observation.completedAt) < Date.parse(observation.startedAt)
            ? [issue(
                '$.observation.completedAt',
                'invalid-observation-interval',
                'Observation cannot complete before it starts.'
            )]
            : []),
        ...((observation.primary.outcome === 'passed') !== observation.primary.acceptedMetrics
            ? [issue(
                '$.observation.primary',
                'invalid-accepted-metrics',
                'Only a passing primary may expose accepted metrics.'
            )]
            : []),
        ...(!validRepeatOutcome(observation.repeat)
            ? [issue('$.observation.repeat', 'invalid-repeat-outcome', 'Repeat decision and outcome are inconsistent.')]
            : []),
        ...(indexEntry.archive.path !== toRtcPerformanceObservationArchivePath(observation)
            ? [issue(
                '$.archive.path',
                'archive-path-mismatch',
                'Archive path does not match its observation identity and date.'
            )]
            : [])
    ];
}

function isRtcPerformanceObservationIndexEntry(source: unknown) {
    if (!exactRecord(source, ['schema', 'observation', 'archive'])) {
        return false;
    }
    return source.schema === 'rallar.rtc-performance-observation.index-entry.v1' &&
        isRtcPerformanceObservation(source.observation) &&
        isRtcPerformanceObservationArchive(source.archive);
}

function isRtcPerformanceObservation(source: unknown) {
    if (
        !exactRecord(source, [
            'schema',
            'observationId',
            'startedAt',
            'completedAt',
            'source',
            'workflow',
            'primary',
            'repeat'
        ])
    ) {
        return false;
    }
    return source.schema === 'rallar.rtc-performance-observation.v1' &&
        typeof source.observationId === 'string' &&
        canonicalIsoTimestamp(source.startedAt) &&
        canonicalIsoTimestamp(source.completedAt) &&
        isRtcPerformanceObservationSource(source.source) &&
        isRtcPerformanceObservationWorkflow(source.workflow) &&
        isRtcPerformanceObservationPrimary(source.primary) &&
        isRtcPerformanceObservationRepeat(source.repeat);
}

function isRtcPerformanceObservationSource(source: unknown) {
    return exactRecord(source, ['commit', 'tree', 'ref']) &&
        fullOid(source.commit) &&
        fullOid(source.tree) &&
        source.ref === 'main';
}

function isRtcPerformanceObservationWorkflow(source: unknown) {
    return exactRecord(source, ['runId', 'runAttempt', 'url']) &&
        positiveSafeInteger(source.runId) &&
        positiveSafeInteger(source.runAttempt) &&
        validWorkflowUrl(source.url, source.runId);
}

function isRtcPerformanceObservationPrimary(source: unknown) {
    return exactRecord(source, ['outcome', 'acceptedMetrics']) &&
        performanceOutcome(source.outcome) &&
        typeof source.acceptedMetrics === 'boolean';
}

function isRtcPerformanceObservationRepeat(source: unknown) {
    return exactRecord(source, ['decision', 'outcome']) &&
        (source.decision === 'not-required' || source.decision === 'required') &&
        (source.outcome === 'not-run' || performanceOutcome(source.outcome));
}

function isRtcPerformanceObservationArchive(source: unknown) {
    return exactRecord(source, ['path', 'byteLength', 'sha256']) &&
        typeof source.path === 'string' &&
        positiveSafeInteger(source.byteLength) &&
        typeof source.sha256 === 'string' &&
        /^[0-9a-f]{64}$/u.test(source.sha256);
}

function validRepeatOutcome(repeat: RtcPerformanceObservationRepeatDto) {
    return repeat.decision === 'not-required'
        ? repeat.outcome === 'not-run'
        : repeat.outcome !== 'not-run';
}

function validWorkflowUrl(value: unknown, runId: unknown) {
    if (typeof value !== 'string' || !positiveSafeInteger(runId)) {
        return false;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '' &&
            url.pathname.endsWith(`/actions/runs/${runId}`);
    }
    catch {
        return false;
    }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalIsoTimestamp(value: unknown) {
    if (typeof value !== 'string') {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function positiveSafeInteger(value: unknown) {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function fullOid(value: unknown) {
    return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function performanceOutcome(value: unknown): value is RtcPerformanceObservationOutcome {
    return value === 'passed' || value === 'failed' || value === 'incomplete';
}

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [issue(path, code, message)] };
}

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}
