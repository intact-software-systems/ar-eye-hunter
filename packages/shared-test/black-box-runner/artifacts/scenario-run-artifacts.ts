import type { TrafficPlanArtifact } from '../recipes/scenario-workload.ts';
import { firstPositiveInteger } from '../recipes/scenario-workload.ts';

// deno-lint-ignore-file no-explicit-any

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
    index: JsonRecord;
}

interface ArtifactLimitConfig {
    maxEvents?: number;
    maxEventsByKind: Record<string, number>;
}

interface BuildArtifactIndexInput {
    report: any;
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

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeEventKindCaps(value: unknown): Record<string, number> {
    return Object.fromEntries(
        Object.entries(asRecord(value))
            .map(([kind, limit]) => [kind, Number.parseInt(String(limit), 10)] as const)
            .filter((entry) => Number.isFinite(entry[1]) && entry[1] > 0)
    );
}

function incrementCount(target: Record<string, number>, key: unknown): void {
    const normalizedKey = String(key || 'unknown');
    target[normalizedKey] = (target[normalizedKey] || 0) + 1;
}

export function artifactPath(dir: string, name: string): string {
    return dir.replace(/\/+$/, '') + '/' + name;
}

export function toJsonLine(value: unknown): string {
    return JSON.stringify(value) + '\n';
}

function resultEvents(report: any): unknown[] {
    return (report.resultsList || []).map((result: any) => ({
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

function postRunAssertionEvents(report: any): unknown[] {
    const results = Array.isArray(report.postRunAssertions?.results)
        ? report.postRunAssertions.results
        : [];

    return results.map((result: any) => ({
        kind: 'post-run-assertion',
        name: result.name,
        status: result.status,
        path: result.path,
        operator: result.operator,
        runnerRunId: report.runnerRunId ?? report.correlation?.runnerRunId,
        correlation: report.correlation,
        expected: result.expected,
        actual: result.actual,
        result: result.result,
        details: result.details
    }));
}

function keyedStoreEvents(kind: string, store: any): unknown[] {
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

function artifactEvents(report: any): unknown[] {
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
    return String(event.status || asRecord(event.result).status || 'unknown');
}

function artifactEventTransport(event: JsonRecord): string {
    return String(event.transport || asRecord(event.value).transport || 'unknown');
}

function artifactEventConnection(event: JsonRecord): string | undefined {
    return stringValue(event.connection) ?? stringValue(asRecord(event.value).connection);
}

function artifactEventRunIndex(event: JsonRecord): string {
    const runIndex = event.runIndex ?? asRecord(event.result).runIndex;
    return runIndex === undefined || runIndex === null
        ? 'unknown'
        : String(runIndex);
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

function eventCounts(events: readonly ArtifactEventRecord[]): JsonRecord {
    const byKind: Record<string, number> = {};
    const byTransport: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

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

function toArtifactEventRecords(report: any): ArtifactEventRecord[] {
    return artifactEvents(report).map((event, index) => ({
        ...asRecord(event),
        kind: stringValue(asRecord(event).kind) ?? 'unknown',
        sequence: index + 1
    }));
}

function artifactLimitConfig(report: any): ArtifactLimitConfig {
    return {
        maxEvents: firstPositiveInteger([report?.artifactLimits?.maxEvents, report?.summary?.soak?.maxArtifactEvents]),
        maxEventsByKind: normalizeEventKindCaps(report?.artifactLimits?.maxEventsByKind)
    };
}

export function selectArtifactEvents(report: any): ArtifactEventSelection {
    const allEvents = toArtifactEventRecords(report);
    const limits = artifactLimitConfig(report);
    const emittedEvents: ArtifactEventRecord[] = [];
    const omittedEvents: ArtifactEventRecord[] = [];
    const emittedByKind: Record<string, number> = {};

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
        index: buildArtifactIndex({ report, allEvents, emittedEvents, omittedEvents, limits })
    };
}

export function artifactEventsWithTruncation(selection: ArtifactEventSelection): unknown[] {
    const omittedEvents = Number(asRecord(selection.index.truncation).omittedEvents || 0);
    if (omittedEvents <= 0) {
        return selection.emittedEvents;
    }

    const truncation = asRecord(selection.index.truncation);
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

function compactSuccessSummaries(omittedEvents: readonly ArtifactEventRecord[]): JsonRecord[] {
    const groups = new Map<string, JsonRecord>();

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
                status: 'SUCCESS',
                count: 0,
                firstSequence: event.sequence,
                lastSequence: event.sequence
            };

            existing.count = Number(existing.count || 0) + 1;
            existing.lastSequence = event.sequence;
            groups.set(key, existing);
        });

    return [...groups.values()];
}

function perRunSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>
): JsonRecord[] {
    const runs = new Map<string, JsonRecord>();

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

            summary.total = Number(summary.total || 0) + 1;
            if (status === 'SUCCESS') {
                summary.success = Number(summary.success || 0) + 1;
            }
            if (status === 'FAILURE') {
                summary.failure = Number(summary.failure || 0) + 1;
            }
            if (emittedSequences.has(event.sequence)) {
                summary.emitted = Number(summary.emitted || 0) + 1;
            }
            else {
                summary.omitted = Number(summary.omitted || 0) + 1;
            }

            runs.set(runIndex, summary);
        });

    return [...runs.values()];
}

function perConnectionSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>
): JsonRecord[] {
    const connections = new Map<string, JsonRecord>();

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
            byKind: {},
            byTransport: {},
            byStatus: {}
        };

        summary.total = Number(summary.total || 0) + 1;
        if (emittedSequences.has(event.sequence)) {
            summary.emitted = Number(summary.emitted || 0) + 1;
        }
        else {
            summary.omitted = Number(summary.omitted || 0) + 1;
        }
        incrementCount(summary.byKind as Record<string, number>, artifactEventKind(event));
        incrementCount(summary.byTransport as Record<string, number>, artifactEventTransport(event));
        incrementCount(summary.byStatus as Record<string, number>, artifactEventStatus(event));

        connections.set(connection, summary);
    });

    return [...connections.values()];
}

function buildArtifactIndex(input: BuildArtifactIndexInput): JsonRecord {
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
        generatedAtEpochMs: Date.now(),
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

export function withArtifactReport(report: any): any {
    const selection = selectArtifactEvents(report);
    const truncation = asRecord(selection.index.truncation);

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
            compactedSuccessGroups: asArray(asRecord(selection.index.compaction).repeatedSuccessSummaries).length
        }
    };
}

export function failureBundle(report: any): unknown {
    const failures = (report.resultsList || [])
        .filter((result: any) => result.status === 'FAILURE')
        .map((result: any) => ({
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
    const postRunAssertionFailures = (report.postRunAssertions?.results || [])
        .filter((result: any) => result.status === 'FAILURE');

    return {
        summary: report.summary,
        failures,
        postRunAssertionFailures,
        postRunAssertions: report.postRunAssertions,
        outputs: report.outputs
    };
}

export function withExpandedPlanCorrelation(artifact: TrafficPlanArtifact, report: any): unknown {
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
