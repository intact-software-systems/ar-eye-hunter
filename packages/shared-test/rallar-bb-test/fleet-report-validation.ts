import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES } from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION,
    type ControlFleetAgentRunOutcome,
    type ControlFleetAggregateReport,
    type ControlFleetFailureSignature,
    type ControlFleetRegionSummary,
    type ControlFleetReportBundle,
    type ControlFleetRunReport,
    type ControlFleetTimingDistribution
} from './fleet-report.ts';

export const RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES = 64;
export const RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH = 512;
export const RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES = 16 * 1_024 * 1_024;
export const RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES = 48 * 1_024 * 1_024;

const FLEET_REPORT_BUNDLE_FILE_NAMES = [
    'fleet-report.json',
    'summary.md',
    'agent-results.csv',
    'failure-signatures.csv'
] as const;

const FLEET_AGENT_STATES = new Set([
    'passed',
    'failed',
    'missing',
    'running',
    'cancelled',
    'timed-out',
    'unknown'
]);

const FLEET_FAILURE_CATEGORIES = new Set([
    'targeting',
    'readiness',
    'barrier',
    'command',
    'diagnostic',
    'runtime',
    'unknown'
]);

const DISTRIBUTED_RUN_STATES = new Set<string>(
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES
);

export type ControlFleetReportValidationIssueCode =
    | 'invalid-type'
    | 'invalid-value'
    | 'invalid-coordinate'
    | 'unsupported-schema-version'
    | 'duplicate-distributed-run-id'
    | 'bundle-run-id-mismatch'
    | 'missing-bundle-file'
    | 'unexpected-bundle-file'
    | 'bundle-file-too-large'
    | 'bundle-too-large';

export type ControlFleetReportValidationIssue = Readonly<{
    source: 'response' | 'report' | 'aggregate' | 'bundle';
    code: ControlFleetReportValidationIssueCode;
    path: string;
    message: string;
    distributedRunId?: string;
}>;

type ValidationSummary = Readonly<{
    issues: readonly ControlFleetReportValidationIssue[];
    omittedIssueCount: number;
}>;

export type ControlFleetRunReportValidationResult =
    & ValidationSummary
    & Readonly<{
        ok: boolean;
        report?: ControlFleetRunReport;
        sourceCount: 1;
        acceptedCount: 0 | 1;
        quarantinedCount: 0 | 1;
    }>;

export type ControlFleetReportsResponseValidationResult =
    & ValidationSummary
    & Readonly<{
        ok: boolean;
        reports: readonly ControlFleetRunReport[];
        aggregate?: ControlFleetAggregateReport;
        sourceCount: number;
        acceptedCount: number;
        quarantinedCount: number;
    }>;

export type ControlFleetRunReportCollectionValidationResult =
    & ValidationSummary
    & Readonly<{
        ok: boolean;
        reports: readonly ControlFleetRunReport[];
        sourceCount: number;
        acceptedCount: number;
        quarantinedCount: number;
    }>;

export type ControlFleetReportBundleValidationResult =
    & ValidationSummary
    & Readonly<{
        ok: boolean;
        bundle?: ControlFleetReportBundle;
    }>;

type ValidationIssueInput =
    & Omit<ControlFleetReportValidationIssue, 'path' | 'message'>
    & Readonly<{
        path: string;
        message: string;
    }>;

type ValidationIssueCollector = Readonly<{
    add(issue: ValidationIssueInput): void;
    count(): number;
    finish(): ValidationSummary;
}>;

export function validateControlFleetRunReport(
    value: unknown
): ControlFleetRunReportValidationResult {
    const collector = createValidationIssueCollector();
    const report = normalizeControlFleetRunReport(
        value,
        '$',
        collectorForDistributedRun(
            collector,
            candidateDistributedRunId(value)
        )
    );
    const summary = collector.finish();
    return {
        ok: report !== undefined,
        report,
        sourceCount: 1,
        acceptedCount: report === undefined ? 0 : 1,
        quarantinedCount: report === undefined ? 1 : 0,
        ...summary
    };
}

export function validateControlFleetReportsResponse(
    value: unknown
): ControlFleetReportsResponseValidationResult {
    const collector = createValidationIssueCollector();
    if (!isRecord(value)) {
        collector.add({
            source: 'response',
            code: 'invalid-type',
            path: '$',
            message: 'Fleet reports response must be an object.'
        });
        return collectionResult([], undefined, 0, collector);
    }

    const aggregate = normalizeControlFleetAggregateReport(
        value.aggregate,
        '$.aggregate',
        collector
    );
    const collection = normalizeFleetRunReportCollection(
        value.reports,
        collector
    );

    return collectionResult(
        collection.reports,
        aggregate,
        collection.sourceCount,
        collector
    );
}

export function validateControlFleetRunReportCollection(
    value: unknown
): ControlFleetRunReportCollectionValidationResult {
    const collector = createValidationIssueCollector();
    const collection = normalizeFleetRunReportCollection(value, collector);
    const summary = collector.finish();
    return {
        ok: collector.count() === 0,
        reports: collection.reports,
        sourceCount: collection.sourceCount,
        acceptedCount: collection.reports.length,
        quarantinedCount: collection.sourceCount - collection.reports.length,
        ...summary
    };
}

export function validateControlFleetReportBundle(
    value: unknown,
    requestedDistributedRunId: string
): ControlFleetReportBundleValidationResult {
    const collector = createValidationIssueCollector();
    if (!isRecord(value)) {
        collector.add({
            source: 'bundle',
            code: 'invalid-type',
            path: '$',
            message: 'Fleet report bundle must be an object.'
        });
        return bundleResult(undefined, collector);
    }

    validateFleetSchemaVersion(value.fleetReportSchemaVersion, '$.fleetReportSchemaVersion', collector, 'bundle');
    const distributedRunId = value.distributedRunId;
    const validDistributedRunId = validateNonEmptyString(
        distributedRunId,
        '$.distributedRunId',
        collector,
        'bundle'
    );
    if (
        validDistributedRunId &&
        distributedRunId !== requestedDistributedRunId
    ) {
        collector.add({
            source: 'bundle',
            code: 'bundle-run-id-mismatch',
            path: '$.distributedRunId',
            message: `Bundle distributedRunId ${JSON.stringify(distributedRunId)} does not match requested run ${
                JSON.stringify(requestedDistributedRunId)
            }.`,
            distributedRunId
        });
    }
    validateNonNegativeInteger(value.generatedAtEpochMs, '$.generatedAtEpochMs', collector, 'bundle');

    let totalBytes = 0;
    if (!isRecord(value.files)) {
        collector.add({
            source: 'bundle',
            code: 'invalid-type',
            path: '$.files',
            message: 'Bundle files must be an object.'
        });
    }
    else {
        const expected = new Set<string>(FLEET_REPORT_BUNDLE_FILE_NAMES);
        for (const fileName of FLEET_REPORT_BUNDLE_FILE_NAMES) {
            const path = `$.files[${JSON.stringify(fileName)}]`;
            if (!Object.hasOwn(value.files, fileName)) {
                collector.add({
                    source: 'bundle',
                    code: 'missing-bundle-file',
                    path,
                    message: `Bundle is missing required file ${JSON.stringify(fileName)}.`
                });
                continue;
            }
            const fileText = value.files[fileName];
            if (typeof fileText !== 'string') {
                collector.add({
                    source: 'bundle',
                    code: 'invalid-type',
                    path,
                    message: `Bundle file ${JSON.stringify(fileName)} must be text.`
                });
                continue;
            }
            const fileBytes = new TextEncoder().encode(fileText).byteLength;
            totalBytes += fileBytes;
            if (fileBytes > RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES) {
                collector.add({
                    source: 'bundle',
                    code: 'bundle-file-too-large',
                    path,
                    message: `Bundle file ${
                        JSON.stringify(fileName)
                    } is ${fileBytes} UTF-8 bytes; the limit is ${RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES}.`
                });
            }
        }
        for (const fileName of Object.keys(value.files)) {
            if (expected.has(fileName)) {
                continue;
            }
            collector.add({
                source: 'bundle',
                code: 'unexpected-bundle-file',
                path: `$.files[${JSON.stringify(fileName)}]`,
                message: `Bundle contains unexpected file ${JSON.stringify(fileName)}.`
            });
        }
    }
    if (totalBytes > RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES) {
        collector.add({
            source: 'bundle',
            code: 'bundle-too-large',
            path: '$.files',
            message:
                `Bundle files total ${totalBytes} UTF-8 bytes; the limit is ${RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES}.`
        });
    }

    const bundle = collector.count() === 0
        ? value as unknown as ControlFleetReportBundle
        : undefined;
    return bundleResult(bundle, collector);
}

function normalizeControlFleetRunReport(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): ControlFleetRunReport | undefined {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet run report must be an object.'
        });
        return undefined;
    }

    const issueCountBefore = collector.count();
    validateFleetSchemaVersion(value.fleetReportSchemaVersion, `${path}.fleetReportSchemaVersion`, collector, 'report');
    validateNonEmptyString(value.distributedRunId, `${path}.distributedRunId`, collector, 'report');
    validateNonEmptyString(value.controlRunId, `${path}.controlRunId`, collector, 'report');
    validateNonNegativeInteger(value.generatedAtEpochMs, `${path}.generatedAtEpochMs`, collector, 'report');
    validateEnumString(value.state, DISTRIBUTED_RUN_STATES, `${path}.state`, collector, 'report');
    validateBoolean(value.ok, `${path}.ok`, collector, 'report');
    validateGroup(value.group, `${path}.group`, collector);
    validateStringArray(value.recipeIds, `${path}.recipeIds`, collector, 'report');
    validateOptionalNumber(value.runDurationMs, `${path}.runDurationMs`, collector, 'report');
    validateSummary(value.summary, `${path}.summary`, collector);
    validateReportTiming(value.timing, `${path}.timing`, collector);
    const agents = normalizeAgents(value.agents, `${path}.agents`, collector);
    validateRegions(value.regions, `${path}.regions`, collector, 'report');
    validateFailureSignatures(
        value.failureSignatures,
        `${path}.failureSignatures`,
        collector,
        'report'
    );
    validateArtifactRefs(value.artifactRefs, `${path}.artifactRefs`, collector);

    if (collector.count() !== issueCountBefore || agents === undefined) {
        return undefined;
    }
    return {
        ...value,
        agents
    } as unknown as ControlFleetRunReport;
}

function normalizeControlFleetAggregateReport(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): ControlFleetAggregateReport | undefined {
    if (!isRecord(value)) {
        collector.add({
            source: 'aggregate',
            code: 'invalid-type',
            path,
            message: 'Fleet aggregate report must be an object.'
        });
        return undefined;
    }
    const issueCountBefore = collector.count();
    for (
        const key of [
            'generatedAtEpochMs',
            'reportCount',
            'runCount',
            'agentCount',
            'regionCount',
            'staleAgentCount',
            'flakyAgentCount',
            'failureGroupCount'
        ] as const
    ) {
        validateNonNegativeInteger(value[key], `${path}.${key}`, collector, 'aggregate');
    }
    validateFiniteNumber(value.passRate, `${path}.passRate`, collector, 'aggregate');
    if (!isRecord(value.timing)) {
        collector.add({
            source: 'aggregate',
            code: 'invalid-type',
            path: `${path}.timing`,
            message: 'Aggregate timing must be an object.'
        });
    }
    else {
        validateTimingDistribution(value.timing.runs, `${path}.timing.runs`, collector, 'aggregate');
        validateTimingDistribution(value.timing.commands, `${path}.timing.commands`, collector, 'aggregate');
    }
    validateRegions(value.regions, `${path}.regions`, collector, 'aggregate');
    validateFailureSignatures(
        value.failureSignatures,
        `${path}.failureSignatures`,
        collector,
        'aggregate'
    );
    return collector.count() === issueCountBefore
        ? value as unknown as ControlFleetAggregateReport
        : undefined;
}

function normalizeAgents(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): readonly ControlFleetAgentRunOutcome[] | undefined {
    if (!Array.isArray(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet report agents must be an array.'
        });
        return undefined;
    }
    const agents: ControlFleetAgentRunOutcome[] = [];
    let valid = true;
    for (let index = 0; index < value.length; index += 1) {
        const agent = normalizeAgent(value[index], `${path}[${index}]`, collector);
        if (agent === undefined) {
            valid = false;
        }
        else {
            agents.push(agent);
        }
    }
    return valid ? agents : undefined;
}

function normalizeAgent(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): ControlFleetAgentRunOutcome | undefined {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet agent outcome must be an object.'
        });
        return undefined;
    }
    const issueCountBefore = collector.count();
    const validAgentId = validateNonEmptyString(value.agentId, `${path}.agentId`, collector, 'report');
    const label = normalizeAgentLabel(
        value.label,
        validAgentId ? value.agentId as string : undefined,
        `${path}.label`,
        collector
    );
    validateEnumString(value.state, FLEET_AGENT_STATES, `${path}.state`, collector, 'report');
    for (const key of ['ok', 'missing', 'flaky', 'stale'] as const) {
        validateBoolean(value[key], `${path}.${key}`, collector, 'report');
    }
    for (
        const key of [
            'commandCount',
            'failedCommandCount',
            'resultCount',
            'eventCount',
            'diagnosticCount',
            'reconnectCount'
        ] as const
    ) {
        validateNonNegativeInteger(value[key], `${path}.${key}`, collector, 'report');
    }
    validateOptionalNumber(value.durationMs, `${path}.durationMs`, collector, 'report');
    validateOptionalNonNegativeInteger(
        value.lastHeartbeatAtEpochMs,
        `${path}.lastHeartbeatAtEpochMs`,
        collector,
        'report'
    );
    validateStringArray(
        value.failureSignatureIds,
        `${path}.failureSignatureIds`,
        collector,
        'report'
    );
    if (collector.count() !== issueCountBefore || label === undefined) {
        return undefined;
    }
    return {
        ...value,
        label
    } as unknown as ControlFleetAgentRunOutcome;
}

function normalizeAgentLabel(
    value: unknown,
    outerAgentId: string | undefined,
    path: string,
    collector: ValidationIssueCollector
): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet agent label must be an object.'
        });
        return undefined;
    }
    const issueCountBefore = collector.count();
    if (value.agentId !== undefined) {
        const validLabelAgentId = validateNonEmptyString(
            value.agentId,
            `${path}.agentId`,
            collector,
            'report'
        );
        if (
            validLabelAgentId &&
            outerAgentId !== undefined &&
            value.agentId !== outerAgentId
        ) {
            collector.add({
                source: 'report',
                code: 'invalid-value',
                path: `${path}.agentId`,
                message: 'Fleet agent label agentId must match the outer agentId.',
                distributedRunId: undefined
            });
        }
    }
    for (
        const key of [
            'region',
            'provider',
            'datacenter',
            'hostId',
            'agentPoolId',
            'deploymentId',
            'browserName',
            'browserVersion',
            'os'
        ] as const
    ) {
        validateOptionalString(value[key], `${path}.${key}`, collector, 'report');
    }
    if (value.tags !== undefined) {
        validateStringArray(value.tags, `${path}.tags`, collector, 'report');
    }
    if (value.location !== undefined) {
        validateLocation(value.location, `${path}.location`, collector);
    }
    if (collector.count() !== issueCountBefore || outerAgentId === undefined) {
        return undefined;
    }
    return {
        ...value,
        agentId: value.agentId ?? outerAgentId
    };
}

function validateLocation(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): boolean {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet agent location must be an object.'
        });
        return false;
    }
    let valid = true;
    if (
        typeof value.latitude !== 'number' ||
        !Number.isFinite(value.latitude) ||
        value.latitude < -90 ||
        value.latitude > 90
    ) {
        collector.add({
            source: 'report',
            code: 'invalid-coordinate',
            path: `${path}.latitude`,
            message: 'Latitude must be a finite number from -90 through 90.'
        });
        valid = false;
    }
    if (
        typeof value.longitude !== 'number' ||
        !Number.isFinite(value.longitude) ||
        value.longitude < -180 ||
        value.longitude > 180
    ) {
        collector.add({
            source: 'report',
            code: 'invalid-coordinate',
            path: `${path}.longitude`,
            message: 'Longitude must be a finite number from -180 through 180.'
        });
        valid = false;
    }
    validateOptionalString(value.label, `${path}.label`, collector, 'report');
    if (
        value.precision !== undefined &&
        value.precision !== 'exact' &&
        value.precision !== 'approximate'
    ) {
        collector.add({
            source: 'report',
            code: 'invalid-value',
            path: `${path}.precision`,
            message: 'Location precision must be exact or approximate.'
        });
        valid = false;
    }
    return valid;
}

function validateGroup(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): boolean {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet report group must be an object.'
        });
        return false;
    }
    let valid = true;
    for (const key of ['applicationId', 'workspaceId', 'groupId'] as const) {
        valid = validateNonEmptyString(value[key], `${path}.${key}`, collector, 'report') && valid;
    }
    return valid;
}

function validateSummary(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): boolean {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet report summary must be an object.'
        });
        return false;
    }
    let valid = true;
    for (
        const key of [
            'agents',
            'regions',
            'passed',
            'failed',
            'missing',
            'flaky',
            'stale',
            'failureGroups'
        ] as const
    ) {
        valid = validateNonNegativeInteger(value[key], `${path}.${key}`, collector, 'report') && valid;
    }
    valid = validateFiniteNumber(value.passRate, `${path}.passRate`, collector, 'report') && valid;
    return valid;
}

function validateReportTiming(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): boolean {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet report timing must be an object.'
        });
        return false;
    }
    const runValid = validateTimingDistribution(value.run, `${path}.run`, collector, 'report');
    const commandsValid = validateTimingDistribution(
        value.commands,
        `${path}.commands`,
        collector,
        'report'
    );
    return runValid && commandsValid;
}

function validateTimingDistribution(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is ControlFleetTimingDistribution {
    if (!isRecord(value)) {
        collector.add({
            source,
            code: 'invalid-type',
            path,
            message: 'Fleet timing distribution must be an object.'
        });
        return false;
    }
    let valid = validateNonNegativeInteger(value.count, `${path}.count`, collector, source);
    for (const key of ['minMs', 'p50Ms', 'p90Ms', 'p95Ms', 'maxMs'] as const) {
        valid = validateOptionalNumber(value[key], `${path}.${key}`, collector, source) && valid;
    }
    return valid;
}

function validateRegions(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: 'report' | 'aggregate'
): value is readonly ControlFleetRegionSummary[] {
    if (!Array.isArray(value)) {
        collector.add({
            source,
            code: 'invalid-type',
            path,
            message: 'Fleet regions must be an array.'
        });
        return false;
    }
    let valid = true;
    for (let index = 0; index < value.length; index += 1) {
        const region = value[index];
        const regionPath = `${path}[${index}]`;
        if (!isRecord(region)) {
            collector.add({
                source,
                code: 'invalid-type',
                path: regionPath,
                message: 'Fleet region summary must be an object.'
            });
            valid = false;
            continue;
        }
        valid = validateNonEmptyString(region.region, `${regionPath}.region`, collector, source) && valid;
        valid = validateOptionalString(region.provider, `${regionPath}.provider`, collector, source) && valid;
        for (const key of ['agentCount', 'passed', 'failed', 'missing', 'flaky', 'stale'] as const) {
            valid = validateNonNegativeInteger(region[key], `${regionPath}.${key}`, collector, source) && valid;
        }
        valid = validateFiniteNumber(region.passRate, `${regionPath}.passRate`, collector, source) && valid;
        valid = validateTimingDistribution(region.timing, `${regionPath}.timing`, collector, source) && valid;
        valid = validateOptionalString(
            region.dominantFailureSignatureId,
            `${regionPath}.dominantFailureSignatureId`,
            collector,
            source
        ) && valid;
    }
    return valid;
}

function validateFailureSignatures(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: 'report' | 'aggregate'
): value is readonly ControlFleetFailureSignature[] {
    if (!Array.isArray(value)) {
        collector.add({
            source,
            code: 'invalid-type',
            path,
            message: 'Fleet failure signatures must be an array.'
        });
        return false;
    }
    let valid = true;
    for (let index = 0; index < value.length; index += 1) {
        const failure = value[index];
        const failurePath = `${path}[${index}]`;
        if (!isRecord(failure)) {
            collector.add({
                source,
                code: 'invalid-type',
                path: failurePath,
                message: 'Fleet failure signature must be an object.'
            });
            valid = false;
            continue;
        }
        for (
            const key of [
                'signatureId',
                'title',
                'normalizedMessage',
                'likelyCause',
                'nextAction'
            ] as const
        ) {
            valid = validateNonEmptyString(failure[key], `${failurePath}.${key}`, collector, source) && valid;
        }
        valid = validateEnumString(
            failure.category,
            FLEET_FAILURE_CATEGORIES,
            `${failurePath}.category`,
            collector,
            source
        ) && valid;
        for (
            const key of [
                'code',
                'recipeId',
                'commandKind',
                'diagnosticTypeId',
                'transport'
            ] as const
        ) {
            valid = validateOptionalString(failure[key], `${failurePath}.${key}`, collector, source) && valid;
        }
        valid = validateNonNegativeInteger(failure.count, `${failurePath}.count`, collector, source) && valid;
        valid = validateOptionalNonNegativeInteger(
            failure.firstSeenAtEpochMs,
            `${failurePath}.firstSeenAtEpochMs`,
            collector,
            source
        ) && valid;
        valid = validateOptionalNonNegativeInteger(
            failure.lastSeenAtEpochMs,
            `${failurePath}.lastSeenAtEpochMs`,
            collector,
            source
        ) && valid;
        for (const key of ['affectedAgents', 'affectedRegions', 'affectedRuns'] as const) {
            valid = validateStringArray(failure[key], `${failurePath}.${key}`, collector, source) && valid;
        }
    }
    return valid;
}

function validateArtifactRefs(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector
): boolean {
    if (!isRecord(value)) {
        collector.add({
            source: 'report',
            code: 'invalid-type',
            path,
            message: 'Fleet artifact references must be an object.'
        });
        return false;
    }
    let valid = true;
    for (const key of ['distributedRun', 'controlRun', 'fleetReport'] as const) {
        valid = validateNonEmptyString(value[key], `${path}.${key}`, collector, 'report') && valid;
    }
    return valid;
}

function validateFleetSchemaVersion(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: 'report' | 'bundle'
): boolean {
    if (value === RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION) {
        return true;
    }
    collector.add({
        source,
        code: 'unsupported-schema-version',
        path,
        message: `Fleet report schema version must be ${RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION}.`
    });
    return false;
}

function validateEnumString(
    value: unknown,
    allowed: ReadonlySet<string>,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is string {
    if (typeof value === 'string' && allowed.has(value)) {
        return true;
    }
    collector.add({
        source,
        code: 'invalid-value',
        path,
        message: 'Value is not one of the supported strings.'
    });
    return false;
}

function validateNonEmptyString(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is string {
    if (typeof value === 'string' && value.trim().length > 0) {
        return true;
    }
    collector.add({
        source,
        code: typeof value === 'string' ? 'invalid-value' : 'invalid-type',
        path,
        message: 'Value must be a non-empty string.'
    });
    return false;
}

function validateOptionalString(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is string | undefined {
    if (value === undefined || typeof value === 'string') {
        return true;
    }
    collector.add({
        source,
        code: 'invalid-type',
        path,
        message: 'Optional value must be a string when present.'
    });
    return false;
}

function validateStringArray(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is readonly string[] {
    if (!Array.isArray(value)) {
        collector.add({
            source,
            code: 'invalid-type',
            path,
            message: 'Value must be an array of strings.'
        });
        return false;
    }
    let valid = true;
    for (let index = 0; index < value.length; index += 1) {
        if (typeof value[index] === 'string') {
            continue;
        }
        collector.add({
            source,
            code: 'invalid-type',
            path: `${path}[${index}]`,
            message: 'Array entry must be a string.'
        });
        valid = false;
    }
    return valid;
}

function validateBoolean(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is boolean {
    if (typeof value === 'boolean') {
        return true;
    }
    collector.add({
        source,
        code: 'invalid-type',
        path,
        message: 'Value must be a boolean.'
    });
    return false;
}

function validateFiniteNumber(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return true;
    }
    collector.add({
        source,
        code: typeof value === 'number' ? 'invalid-value' : 'invalid-type',
        path,
        message: 'Value must be a finite number.'
    });
    return false;
}

function validateOptionalNumber(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is number | undefined {
    if (value === undefined) {
        return true;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return true;
    }
    collector.add({
        source,
        code: typeof value === 'number' ? 'invalid-value' : 'invalid-type',
        path,
        message: 'Optional value must be a finite number when present.'
    });
    return false;
}

function validateNonNegativeInteger(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is number {
    if (Number.isSafeInteger(value) && (value as number) >= 0) {
        return true;
    }
    collector.add({
        source,
        code: typeof value === 'number' ? 'invalid-value' : 'invalid-type',
        path,
        message: 'Value must be a non-negative safe integer.'
    });
    return false;
}

function validateOptionalNonNegativeInteger(
    value: unknown,
    path: string,
    collector: ValidationIssueCollector,
    source: ControlFleetReportValidationIssue['source']
): value is number | undefined {
    return value === undefined ||
        validateNonNegativeInteger(value, path, collector, source);
}

function createValidationIssueCollector(): ValidationIssueCollector {
    let totalIssueCount = 0;
    const retained: ControlFleetReportValidationIssue[] = [];
    return {
        add(input) {
            totalIssueCount += 1;
            retained.push({
                ...input,
                path: boundedIssueText(input.path),
                message: boundedIssueText(input.message),
                distributedRunId: input.distributedRunId === undefined
                    ? undefined
                    : boundedIssueText(input.distributedRunId)
            });
            retained.sort(compareValidationIssues);
            if (
                retained.length >
                    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES
            ) {
                retained.pop();
            }
        },
        count() {
            return totalIssueCount;
        },
        finish() {
            return {
                issues: retained,
                omittedIssueCount: totalIssueCount - retained.length
            };
        }
    };
}

function boundedIssueText(value: string): string {
    if (
        value.length <=
            RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH
    ) {
        return value;
    }
    return `${
        value.slice(
            0,
            RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH - 1
        )
    }…`;
}

function compareValidationIssues(
    left: ControlFleetReportValidationIssue,
    right: ControlFleetReportValidationIssue
): number {
    return compareText(left.code, right.code) ||
        compareText(left.path, right.path) ||
        compareText(left.message, right.message) ||
        compareText(left.source, right.source) ||
        compareText(left.distributedRunId ?? '', right.distributedRunId ?? '');
}

function compareFleetReports(
    left: ControlFleetRunReport,
    right: ControlFleetRunReport
): number {
    return right.generatedAtEpochMs - left.generatedAtEpochMs ||
        compareText(left.distributedRunId, right.distributedRunId);
}

function compareText(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

function normalizeFleetRunReportCollection(
    value: unknown,
    collector: ValidationIssueCollector
): Readonly<{
    reports: readonly ControlFleetRunReport[];
    sourceCount: number;
}> {
    if (!Array.isArray(value)) {
        collector.add({
            source: 'response',
            code: 'invalid-type',
            path: '$.reports',
            message: 'Fleet reports must be an array.'
        });
        return { reports: [], sourceCount: 0 };
    }

    const duplicateCounts = new Map<string, number>();
    for (const candidate of value) {
        const distributedRunId = candidateDistributedRunId(candidate);
        if (distributedRunId !== undefined) {
            duplicateCounts.set(
                distributedRunId,
                (duplicateCounts.get(distributedRunId) ?? 0) + 1
            );
        }
    }
    const duplicatedIds = new Set<string>();
    for (const [distributedRunId, count] of duplicateCounts) {
        if (count < 2) {
            continue;
        }
        duplicatedIds.add(distributedRunId);
        collector.add({
            source: 'report',
            code: 'duplicate-distributed-run-id',
            path: collectionReportPath(distributedRunId),
            message: `Every report for the duplicated distributedRunId was quarantined (${count} reports).`,
            distributedRunId
        });
    }

    const reports: ControlFleetRunReport[] = [];
    for (const candidate of value) {
        const distributedRunId = candidateDistributedRunId(candidate);
        const normalized = normalizeControlFleetRunReport(
            candidate,
            collectionReportPath(distributedRunId),
            collectorForDistributedRun(collector, distributedRunId)
        );
        if (
            normalized !== undefined &&
            !duplicatedIds.has(normalized.distributedRunId)
        ) {
            reports.push(normalized);
        }
    }
    reports.sort(compareFleetReports);
    return { reports, sourceCount: value.length };
}

function candidateDistributedRunId(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    return typeof value.distributedRunId === 'string' &&
            value.distributedRunId.trim().length > 0
        ? value.distributedRunId
        : undefined;
}

function collectorForDistributedRun(
    collector: ValidationIssueCollector,
    distributedRunId: string | undefined
): ValidationIssueCollector {
    if (distributedRunId === undefined) {
        return collector;
    }
    return {
        add: (issue) =>
            collector.add({
                ...issue,
                distributedRunId: issue.distributedRunId ?? distributedRunId
            }),
        count: collector.count,
        finish: collector.finish
    };
}

function collectionReportPath(distributedRunId: string | undefined): string {
    return distributedRunId === undefined
        ? '$.reports[unidentified]'
        : `$.reports[distributedRunId=${JSON.stringify(distributedRunId)}]`;
}

function collectionResult(
    reports: readonly ControlFleetRunReport[],
    aggregate: ControlFleetAggregateReport | undefined,
    sourceCount: number,
    collector: ValidationIssueCollector
): ControlFleetReportsResponseValidationResult {
    const summary = collector.finish();
    const acceptedCount = reports.length;
    return {
        ok: collector.count() === 0,
        reports,
        aggregate,
        sourceCount,
        acceptedCount,
        quarantinedCount: sourceCount - acceptedCount,
        ...summary
    };
}

function bundleResult(
    bundle: ControlFleetReportBundle | undefined,
    collector: ValidationIssueCollector
): ControlFleetReportBundleValidationResult {
    return {
        ok: bundle !== undefined,
        bundle,
        ...collector.finish()
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
