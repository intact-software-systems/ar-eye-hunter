import type { TrafficPlanArtifact } from '../recipes/scenario-workload.ts';
import { decodeScenarioPositiveInteger, decodeScenarioText } from '../scenario-value-decoding.ts';

interface JsonRecord {
    [key: string]: unknown;
}

interface ArtifactEventRecord extends JsonRecord {
    kind: string;
    sequence: number;
}

export interface ArtifactEventSelection {
    allEvents: ArtifactEventRecord[];
    emittedEvents: ArtifactEventRecord[];
    index: ArtifactIndex;
}

interface ArtifactEventCounts {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
    readonly byTransport: Readonly<Record<string, number>>;
    readonly byStatus: Readonly<Record<string, number>>;
}

interface ArtifactSuccessSummary {
    readonly name: unknown;
    readonly transport: string;
    readonly action: unknown;
    readonly connection: string | undefined;
    readonly status: 'SUCCESS';
    count: number;
    readonly firstSequence: number;
    lastSequence: number;
}

interface ArtifactRunSummary {
    readonly runIndex: string;
    total: number;
    success: number;
    failure: number;
    emitted: number;
    omitted: number;
}

interface ArtifactConnectionSummary {
    readonly connection: string;
    total: number;
    emitted: number;
    omitted: number;
    readonly byKind: Record<string, number>;
    readonly byTransport: Record<string, number>;
    readonly byStatus: Record<string, number>;
}

interface ArtifactTruncation {
    readonly truncated: boolean;
    readonly totalEvents: number;
    readonly emittedEvents: number;
    readonly omittedEvents: number;
    readonly omittedByKind: Readonly<Record<string, number>>;
    readonly maxEvents: number | undefined;
    readonly maxEventsByKind: Readonly<Record<string, number>>;
    readonly preservedFailureEvents: number;
    readonly preservedDiagnosticEvents: number;
}

interface ArtifactIndex {
    readonly schemaVersion: 1;
    readonly kind: 'black-box-runner.artifact-index';
    readonly generatedAtEpochMs: number;
    readonly runnerRunId: unknown;
    readonly correlation: unknown;
    readonly summary: unknown;
    readonly counts: {
        readonly total: ArtifactEventCounts;
        readonly emitted: ArtifactEventCounts;
        readonly omitted: ArtifactEventCounts;
    };
    readonly firstFailure: JsonRecord | undefined;
    readonly stepResults: readonly JsonRecord[];
    readonly perRun: readonly ArtifactRunSummary[];
    readonly perConnection: readonly ArtifactConnectionSummary[];
    readonly compaction: {
        readonly compacted: boolean;
        readonly repeatedSuccessSummaries: readonly ArtifactSuccessSummary[];
    };
    readonly truncation: ArtifactTruncation;
}

interface ArtifactReportSummary {
    readonly eventCount: number;
    readonly maxEvents: number | undefined;
    readonly maxEventsByKind: Readonly<Record<string, number>>;
    readonly emittedEvents: number;
    readonly omittedEvents: number;
    readonly omittedByKind: Readonly<Record<string, number>>;
    readonly truncated: boolean;
    readonly compactedSuccessGroups: number;
}

interface ArtifactLimitConfig {
    maxEvents?: number;
    maxEventsByKind: Record<string, number>;
}

interface BuildArtifactIndexInput {
    report: JsonRecord;
    generatedAtEpochMs: number;
    allEvents: readonly ArtifactEventRecord[];
    emittedEvents: readonly ArtifactEventRecord[];
    omittedEvents: readonly ArtifactEventRecord[];
    limits: ArtifactLimitConfig;
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeEventKindCaps(value: unknown): Record<string, number> {
    return Object.fromEntries(
        Object.entries(asRecord(value))
            .flatMap(([kind, limit]) => {
                const parsed = decodeScenarioPositiveInteger([limit]);
                return parsed === undefined ? [] : [[kind, parsed]];
            })
    );
}

function incrementCount(target: Record<string, number>, key: unknown): void {
    const normalizedKey = decodeScenarioText(key || 'unknown') ?? 'unknown';
    target[normalizedKey] = (target[normalizedKey] || 0) + 1;
}

export function artifactPath(dir: string, name: string): string {
    return dir.replace(/\/+$/, '') + '/' + name;
}

export function toJsonLine(value: unknown): string {
    return JSON.stringify(value) + '\n';
}

function resultEvents(report: JsonRecord): unknown[] {
    return (Array.isArray(report.resultsList) ? report.resultsList.map(asRecord) : []).map((result) => ({
        kind: 'step-result',
        name: result.name,
        status: result.status,
        transport: result.transport,
        action: result.action,
        connection: result.connection,
        result: result.result,
        runnerRunId: result.runnerRunId,
        runnerStepId: result.runnerStepId,
        correlation: result.correlation,
        runIndex: result.runIndex,
        stepResultKey: result.stepResultKey,
        scenarioExecutionNumber: result.scenarioExecutionNumber,
        interactionExecutionNumber: result.interactionExecutionNumber,
        repeatIndex: result.repeatIndex,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        actual: result.actual
    }));
}

function postRunAssertionEvents(report: JsonRecord): unknown[] {
    const rawResults = asRecord(report.postRunAssertions).results;
    const results = Array.isArray(rawResults) ? rawResults.map(asRecord) : [];

    return results.map((result) => ({
        kind: 'post-run-assertion',
        name: result.name,
        status: result.status,
        path: result.path,
        operator: result.operator,
        runnerRunId: report.runnerRunId ?? asRecord(report.correlation).runnerRunId,
        correlation: report.correlation,
        expected: result.expected,
        actual: result.actual,
        result: result.result,
        details: result.details
    }));
}

function keyedStoreEvents(kind: string, store: unknown): unknown[] {
    return Object.entries(asRecord(store)).flatMap(([connection, values]) => {
        return Array.isArray(values)
            ? values.map((value) => ({
                kind,
                connection,
                value
            }))
            : [];
    });
}

function artifactEvents(report: JsonRecord): unknown[] {
    return [
        ...resultEvents(report),
        ...postRunAssertionEvents(report),
        ...keyedStoreEvents('ws-message', report.wsMessages),
        ...keyedStoreEvents('ws-close', report.wsCloseEvents),
        ...keyedStoreEvents('rtc-message', report.rtcMessages),
        ...keyedStoreEvents('rtc-diagnostic', report.rtcDiagnostics),
        ...keyedStoreEvents('rtc-close', report.rtcCloseEvents)
    ];
}

function artifactEventKind(event: JsonRecord): string {
    return stringValue(event.kind) ?? 'unknown';
}

function artifactEventStatus(event: JsonRecord): string {
    return decodeScenarioText(event.status || asRecord(event.result).status || 'unknown') ?? 'unknown';
}

function artifactEventTransport(event: JsonRecord): string {
    return decodeScenarioText(event.transport || asRecord(event.value).transport || 'unknown') ?? 'unknown';
}

function artifactEventConnection(event: JsonRecord): string | undefined {
    return stringValue(event.connection) ?? stringValue(asRecord(event.value).connection);
}

function artifactEventRunIndex(event: JsonRecord): string {
    const runIndex = event.runIndex ?? asRecord(event.result).runIndex;
    return runIndex === undefined || runIndex === null
        ? 'unknown'
        : decodeScenarioText(runIndex) ?? 'unknown';
}

function isFailureArtifactEvent(event: JsonRecord): boolean {
    return (event.kind === 'step-result' || event.kind === 'post-run-assertion') &&
        artifactEventStatus(event) === 'FAILURE';
}

function isDiagnosticArtifactEvent(event: JsonRecord): boolean {
    return event.kind === 'rtc-diagnostic';
}

function shouldPreserveArtifactEvent(event: JsonRecord): boolean {
    return isFailureArtifactEvent(event) || isDiagnosticArtifactEvent(event);
}

function eventPointer(event: ArtifactEventRecord): JsonRecord {
    return {
        sequence: event.sequence,
        kind: event.kind,
        name: event.name,
        status: event.status,
        transport: event.transport,
        action: event.action,
        connection: event.connection,
        runnerRunId: event.runnerRunId,
        runnerStepId: event.runnerStepId,
        runIndex: event.runIndex,
        stepResultKey: event.stepResultKey,
        scenarioExecutionNumber: event.scenarioExecutionNumber,
        interactionExecutionNumber: event.interactionExecutionNumber,
        repeatIndex: event.repeatIndex
    };
}

function eventCounts(events: readonly ArtifactEventRecord[]): ArtifactEventCounts {
    const byKind: Record<string, number> = Object.create(null);
    const byTransport: Record<string, number> = Object.create(null);
    const byStatus: Record<string, number> = Object.create(null);

    events.forEach((event) => {
        incrementCount(byKind, artifactEventKind(event));
        incrementCount(byTransport, artifactEventTransport(event));
        incrementCount(byStatus, artifactEventStatus(event));
    });

    return {
        total: events.length,
        byKind,
        byTransport,
        byStatus
    };
}

function toArtifactEventRecords(report: JsonRecord): ArtifactEventRecord[] {
    return artifactEvents(report).map((event, index) => ({
        ...asRecord(event),
        kind: stringValue(asRecord(event).kind) ?? 'unknown',
        sequence: index + 1
    }));
}

function artifactLimitConfig(report: JsonRecord): ArtifactLimitConfig {
    return {
        maxEvents: decodeScenarioPositiveInteger([
            asRecord(report.artifactLimits).maxEvents,
            asRecord(asRecord(report.summary).soak).maxArtifactEvents
        ]),
        maxEventsByKind: normalizeEventKindCaps(asRecord(report.artifactLimits).maxEventsByKind)
    };
}

export function selectArtifactEvents(report: JsonRecord, generatedAtEpochMs: number): ArtifactEventSelection {
    const allEvents = toArtifactEventRecords(report);
    const limits = artifactLimitConfig(report);
    const emittedEvents: ArtifactEventRecord[] = [];
    const omittedEvents: ArtifactEventRecord[] = [];
    const emittedByKind: Record<string, number> = Object.create(null);

    allEvents.forEach((event) => {
        const kind = artifactEventKind(event);
        const preserve = shouldPreserveArtifactEvent(event);
        const kindLimit = limits.maxEventsByKind[kind];
        const kindCapAllows = preserve || kindLimit === undefined || (emittedByKind[kind] || 0) < kindLimit;
        const globalCapAllows = preserve || limits.maxEvents === undefined || emittedEvents.length < limits.maxEvents;

        if (kindCapAllows && globalCapAllows) {
            emittedEvents.push(event);
            incrementCount(emittedByKind, kind);
            return;
        }

        omittedEvents.push(event);
    });

    return {
        allEvents,
        emittedEvents,
        index: buildArtifactIndex({ report, generatedAtEpochMs, allEvents, emittedEvents, omittedEvents, limits })
    };
}

export function artifactEventsWithTruncation(selection: ArtifactEventSelection): unknown[] {
    const { omittedEvents } = selection.index.truncation;
    if (omittedEvents <= 0) {
        return selection.emittedEvents;
    }

    const truncation = selection.index.truncation;
    return [
        ...selection.emittedEvents,
        {
            kind: 'artifact-truncated',
            totalEvents: truncation.totalEvents,
            emittedEvents: truncation.emittedEvents,
            omittedEvents: truncation.omittedEvents,
            maxEvents: truncation.maxEvents,
            maxEventsByKind: truncation.maxEventsByKind,
            omittedByKind: truncation.omittedByKind
        }
    ];
}

function compactSuccessSummaries(omittedEvents: readonly ArtifactEventRecord[]): ArtifactSuccessSummary[] {
    const groups = new Map<string, ArtifactSuccessSummary>();

    omittedEvents
        .filter((event) => event.kind === 'step-result' && artifactEventStatus(event) === 'SUCCESS')
        .forEach((event) => {
            const key = JSON.stringify([
                event.name,
                artifactEventTransport(event),
                event.action,
                artifactEventConnection(event) || 'unknown'
            ]);
            const existing = groups.get(key) || {
                name: event.name,
                transport: artifactEventTransport(event),
                action: event.action,
                connection: artifactEventConnection(event),
                status: 'SUCCESS' as const,
                count: 0,
                firstSequence: event.sequence,
                lastSequence: event.sequence
            };

            existing.count += 1;
            existing.lastSequence = event.sequence;
            groups.set(key, existing);
        });

    return [...groups.values()];
}

function perRunSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>
): ArtifactRunSummary[] {
    const runs = new Map<string, ArtifactRunSummary>();

    allEvents
        .filter((event) => event.kind === 'step-result')
        .forEach((event) => {
            const runIndex = artifactEventRunIndex(event);
            const status = artifactEventStatus(event);
            const summary = runs.get(runIndex) || {
                runIndex,
                total: 0,
                success: 0,
                failure: 0,
                emitted: 0,
                omitted: 0
            };

            summary.total += 1;
            if (status === 'SUCCESS') {
                summary.success += 1;
            }
            if (status === 'FAILURE') {
                summary.failure += 1;
            }
            if (emittedSequences.has(event.sequence)) {
                summary.emitted += 1;
            }
            else {
                summary.omitted += 1;
            }

            runs.set(runIndex, summary);
        });

    return [...runs.values()];
}

function perConnectionSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>
): ArtifactConnectionSummary[] {
    const connections = new Map<string, ArtifactConnectionSummary>();

    allEvents.forEach((event) => {
        const connection = artifactEventConnection(event);
        if (!connection) {
            return;
        }

        const summary = connections.get(connection) || {
            connection,
            total: 0,
            emitted: 0,
            omitted: 0,
            byKind: Object.create(null),
            byTransport: Object.create(null),
            byStatus: Object.create(null)
        };

        summary.total += 1;
        if (emittedSequences.has(event.sequence)) {
            summary.emitted += 1;
        }
        else {
            summary.omitted += 1;
        }
        incrementCount(summary.byKind, artifactEventKind(event));
        incrementCount(summary.byTransport, artifactEventTransport(event));
        incrementCount(summary.byStatus, artifactEventStatus(event));

        connections.set(connection, summary);
    });

    return [...connections.values()];
}

function buildArtifactIndex(input: BuildArtifactIndexInput): ArtifactIndex {
    const { report, allEvents, emittedEvents, omittedEvents, limits } = input;
    const emittedSequences = new Set(emittedEvents.map((event) => event.sequence));
    const omittedByKind = eventCounts(omittedEvents).byKind;
    const firstFailure = allEvents.find(isFailureArtifactEvent);
    const stepResults = allEvents
        .filter((event) => event.kind === 'step-result')
        .map((event) => ({
            ...eventPointer(event),
            emitted: emittedSequences.has(event.sequence)
        }));
    const compactSummaries = compactSuccessSummaries(omittedEvents);

    return {
        schemaVersion: 1,
        kind: 'black-box-runner.artifact-index',
        generatedAtEpochMs: input.generatedAtEpochMs,
        runnerRunId: report.runnerRunId,
        correlation: report.correlation,
        summary: report.summary,
        counts: {
            total: eventCounts(allEvents),
            emitted: eventCounts(emittedEvents),
            omitted: eventCounts(omittedEvents)
        },
        firstFailure: firstFailure ? eventPointer(firstFailure) : undefined,
        stepResults,
        perRun: perRunSummaries(allEvents, emittedSequences),
        perConnection: perConnectionSummaries(allEvents, emittedSequences),
        compaction: {
            compacted: omittedEvents.length > 0,
            repeatedSuccessSummaries: compactSummaries
        },
        truncation: {
            truncated: omittedEvents.length > 0,
            totalEvents: allEvents.length,
            emittedEvents: emittedEvents.length,
            omittedEvents: omittedEvents.length,
            omittedByKind,
            maxEvents: limits.maxEvents,
            maxEventsByKind: limits.maxEventsByKind,
            preservedFailureEvents: emittedEvents.filter(isFailureArtifactEvent).length,
            preservedDiagnosticEvents: emittedEvents.filter(isDiagnosticArtifactEvent).length
        }
    };
}

export function withArtifactReport<T extends Record<string, unknown>>(
    report: T,
    generatedAtEpochMs: number
): T & { readonly artifact: ArtifactReportSummary; } {
    const selection = selectArtifactEvents(report, generatedAtEpochMs);
    const truncation = selection.index.truncation;

    return {
        ...report,
        artifact: {
            ...asRecord(report.artifact),
            eventCount: truncation.totalEvents,
            maxEvents: truncation.maxEvents,
            maxEventsByKind: truncation.maxEventsByKind,
            emittedEvents: truncation.emittedEvents,
            omittedEvents: truncation.omittedEvents,
            omittedByKind: truncation.omittedByKind,
            truncated: truncation.truncated,
            compactedSuccessGroups: selection.index.compaction.repeatedSuccessSummaries.length
        }
    };
}

export function failureBundle(report: JsonRecord): unknown {
    const failures = (Array.isArray(report.resultsList) ? report.resultsList.map(asRecord) : [])
        .filter((result) => result.status === 'FAILURE')
        .map((result) => ({
            resultKey: result.resultKey,
            name: result.name,
            transport: result.transport,
            action: result.action,
            connection: result.connection,
            result: result.result,
            exception: result.exception,
            runnerRunId: result.runnerRunId,
            runnerStepId: result.runnerStepId,
            correlation: result.correlation,
            method: result.method,
            path: result.path,
            expected: result.expected,
            actual: result.actual,
            details: result.details,
            runIndex: result.runIndex,
            stepResultKey: result.stepResultKey,
            scenarioExecutionNumber: result.scenarioExecutionNumber,
            interactionExecutionNumber: result.interactionExecutionNumber,
            repeatIndex: result.repeatIndex
        }));
    const rawPostRunResults = asRecord(report.postRunAssertions).results;
    const postRunAssertionFailures = (Array.isArray(rawPostRunResults) ? rawPostRunResults.map(asRecord) : [])
        .filter((result) => result.status === 'FAILURE');

    return {
        summary: report.summary,
        failures,
        postRunAssertionFailures,
        postRunAssertions: report.postRunAssertions,
        outputs: report.outputs
    };
}

export function withExpandedPlanCorrelation(artifact: TrafficPlanArtifact, report: JsonRecord): unknown {
    return {
        ...artifact,
        runnerRunId: report.runnerRunId,
        correlation: report.correlation,
        replayRecipe: {
            ...artifact.replayRecipe,
            execution: {
                ...asRecord(artifact.replayRecipe.execution),
                correlation: {
                    ...asRecord(asRecord(artifact.replayRecipe.execution).correlation),
                    runnerRunId: report.runnerRunId,
                    runId: report.runnerRunId
                }
            }
        }
    };
}
