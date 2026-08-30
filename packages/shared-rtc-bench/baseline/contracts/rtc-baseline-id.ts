import type { RtcBaselineEnvironmentId, RtcBaselineResult } from './rtc-baseline-contracts.ts';

const dateScopedRtcBaselineIdPattern =
    /^\d{8}-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)(?:-repeat-01)?$/;
const observationRtcBaselineIdPattern =
    /^(\d{8}T\d{6}Z)-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)-gh([1-9]\d*)-a([1-9]\d*)(?:-repeat-01)?$/;
const localObservationRtcBaselineIdPattern = /^(\d{8}T\d{9}Z)-[0-9a-f]{12}-e(?:3-memory|4-pg)-local(?:-repeat-01)?$/;
const fullCommitPattern = /^[0-9a-f]{40}$/;
export interface RtcBaselineObservationIdInputDto {
    readonly startedAt: string;
    readonly sourceCommit: string;
    readonly environmentId: RtcBaselineEnvironmentId;
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
}

export interface RtcBaselineLocalObservationIdInputDto {
    readonly startedAt: string;
    readonly sourceCommit: string;
    readonly environmentId: 'E3-memory' | 'E4-pg';
}

export function isRtcBaselineId(baselineId: string) {
    if (dateScopedRtcBaselineIdPattern.test(baselineId)) {
        return true;
    }
    const localMatch = localObservationRtcBaselineIdPattern.exec(baselineId);
    if (localMatch !== null) {
        return isCanonicalLocalUtcTimestamp(localMatch[1]!);
    }
    const match = observationRtcBaselineIdPattern.exec(baselineId);
    return match !== null &&
        isCanonicalUtcTimestamp(match[1]!) &&
        isPositiveSafeInteger(match[2]!) &&
        isPositiveSafeInteger(match[3]!);
}

export function createRtcBaselineLocalObservationId(
    observation: RtcBaselineLocalObservationIdInputDto
): RtcBaselineResult<string> {
    const issues = validateRtcBaselineSourceIdentity(observation);
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    const compactTimestamp = compactRtcBaselineLocalTimestamp(observation.startedAt);
    return {
        ok: true,
        value: `${compactTimestamp}-${
            observation.sourceCommit.slice(0, 12)
        }-${observation.environmentId.toLowerCase()}-local`
    };
}

export function isRtcBrowserBaselineId(baselineId: string) {
    return isRtcBaselineId(baselineId) && baselineId.includes('-e2-browser');
}

export function createRtcBaselineObservationId(
    observation: RtcBaselineObservationIdInputDto
): RtcBaselineResult<string> {
    const issues = validateRtcBaselineObservationIdInput(observation);
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    const compactTimestamp = compactRtcBaselineTimestamp(observation.startedAt);
    return {
        ok: true,
        value: `${compactTimestamp}-${
            observation.sourceCommit.slice(0, 12)
        }-${observation.environmentId.toLowerCase()}-gh${observation.githubRunId}-a${observation.githubRunAttempt}`
    };
}

export function createRtcBaselineRepeatId(primaryBaselineId: string): RtcBaselineResult<string> {
    if (!isRtcBaselineId(primaryBaselineId) || primaryBaselineId.endsWith('-repeat-01')) {
        return {
            ok: false,
            issues: [
                issue(
                    '$.primaryBaselineId',
                    'invalid-primary-baseline-id',
                    'Repeat identity requires one primary baseline ID.'
                )
            ]
        };
    }
    return { ok: true, value: `${primaryBaselineId}-repeat-01` };
}

function isCanonicalUtcTimestamp(compactTimestamp: string) {
    const isoTimestamp = `${compactTimestamp.slice(0, 4)}-${compactTimestamp.slice(4, 6)}-${
        compactTimestamp.slice(6, 8)
    }T${compactTimestamp.slice(9, 11)}:${compactTimestamp.slice(11, 13)}:${compactTimestamp.slice(13, 15)}.000Z`;
    const timestamp = Date.parse(isoTimestamp);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === isoTimestamp;
}

function isCanonicalLocalUtcTimestamp(compactTimestamp: string) {
    const isoTimestamp = `${compactTimestamp.slice(0, 4)}-${compactTimestamp.slice(4, 6)}-${
        compactTimestamp.slice(6, 8)
    }T${compactTimestamp.slice(9, 11)}:${compactTimestamp.slice(11, 13)}:${compactTimestamp.slice(13, 15)}.${
        compactTimestamp.slice(15, 18)
    }Z`;
    const timestamp = Date.parse(isoTimestamp);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === isoTimestamp;
}

function validateRtcBaselineObservationIdInput(observation: RtcBaselineObservationIdInputDto) {
    return [
        ...validateRtcBaselineSourceIdentity(observation),
        ...(!isPositiveSafeInteger(observation.githubRunId)
            ? [issue('$.githubRunId', 'invalid-run-id', 'GitHub run ID must be a positive safe integer.')]
            : []),
        ...(!isPositiveSafeInteger(observation.githubRunAttempt)
            ? [issue(
                '$.githubRunAttempt',
                'invalid-run-attempt',
                'GitHub run attempt must be a positive safe integer.'
            )]
            : [])
    ];
}

function validateRtcBaselineSourceIdentity(
    observation: Pick<RtcBaselineObservationIdInputDto, 'startedAt' | 'sourceCommit'>
) {
    return [
        ...(!isCanonicalIsoTimestamp(observation.startedAt)
            ? [issue('$.startedAt', 'invalid-started-at', 'Started time must be a canonical UTC timestamp.')]
            : []),
        ...(!fullCommitPattern.test(observation.sourceCommit)
            ? [issue('$.sourceCommit', 'invalid-source-commit', 'Source commit must be one full lowercase Git OID.')]
            : [])
    ];
}

function compactRtcBaselineTimestamp(startedAt: string) {
    return startedAt.slice(0, 19).replaceAll('-', '').replaceAll(':', '') + 'Z';
}

function compactRtcBaselineLocalTimestamp(startedAt: string) {
    return startedAt.slice(0, 23).replaceAll('-', '').replaceAll(':', '').replace('.', '') + 'Z';
}

function isCanonicalIsoTimestamp(isoTimestamp: string) {
    const timestamp = Date.parse(isoTimestamp);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === isoTimestamp;
}

function isPositiveSafeInteger(value: number | string) {
    const integer = Number(value);
    return Number.isSafeInteger(integer) && integer > 0;
}

function issue(path: string, code: string, message: string) {
    return { path, code, message };
}
