import { decodeScenarioNumber, decodeScenarioText } from '../scenario-value-decoding.ts';

export interface ScenarioOutcomeMetrics {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly successRatio: number;
}

export interface ScenarioLatencyMetrics {
    readonly count: number;
    readonly min?: number;
    readonly max?: number;
    readonly avg?: number;
    readonly p50?: number;
    readonly p95?: number;
    readonly p99?: number;
}

export interface ScenarioDiagnosticMetrics {
    readonly total: number;
    readonly bySeverity: Readonly<Record<string, number>>;
    readonly byTopic: Readonly<Record<string, number>>;
}

export interface ScenarioMetrics {
    readonly byTransport: Readonly<Record<string, number>>;
    readonly byAction: Readonly<Record<string, number>>;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly sends: ScenarioOutcomeMetrics;
    readonly waits: ScenarioOutcomeMetrics;
    readonly latencyMs: ScenarioLatencyBreakdown;
    readonly failures: ScenarioFailureMetrics;
    readonly reconnects: number;
    readonly diagnostics: ScenarioDiagnosticMetrics;
    readonly cleanup: ScenarioCleanupMetrics;
}

export interface ScenarioSoakMetrics extends ScenarioMetrics {
    readonly sameConnection: true;
    readonly iterationsObserved: number;
    readonly events: Readonly<Record<string, number>>;
}

interface ScenarioScaleRunObservation {
    readonly summary?: unknown;
    readonly report?: unknown;
}

interface ScenarioLatencyBreakdown {
    readonly stepDuration: ScenarioLatencyMetrics;
    readonly connect: ScenarioLatencyMetrics;
    readonly send: ScenarioLatencyMetrics;
    readonly firstPayload: ScenarioLatencyMetrics;
    readonly runDuration?: ScenarioLatencyMetrics;
}

interface ScenarioFailureMetrics {
    readonly total: number;
    readonly missingExpectedMessages: number;
    readonly missingExpectedDiagnostics: number;
    readonly runs?: number;
}

interface ScenarioCleanupMetrics {
    readonly closeSteps: number;
    readonly closeSuccess: number;
    readonly closeFailure: number;
    readonly rtcCloseEvents: number;
    readonly wsCloseEvents: number;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function latencyMetric(values: number[]): ScenarioLatencyMetrics {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

    if (sorted.length <= 0) {
        return {
            count: 0
        };
    }

    const percentile = (p: number): number => {
        const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
        );
        return sorted[index];
    };

    const sum = sorted.reduce((acc, value) => acc + value, 0);

    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: Number((sum / sorted.length).toFixed(2)),
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99)
    };
}

function incrementCount(target: Record<string, number>, key: unknown): void {
    const normalized = decodeScenarioText(key || 'unknown') ?? 'unknown';
    target[normalized] = (target[normalized] || 0) + 1;
}

function countReconnects(results: readonly Record<string, unknown>[]): number {
    const seen = new Set<string>();
    let reconnects = 0;

    results.forEach((result) => {
        const action = (decodeScenarioText(result.action) ?? '').toLowerCase();
        if (action !== 'connect' && action !== 'open') {
            return;
        }

        const connection = decodeScenarioText(result.connection || asRecord(result.actual).connection);
        if (!connection) {
            return;
        }

        const key = [decodeScenarioText(result.runIndex), decodeScenarioText(result.transport), connection].join(':');
        if (seen.has(key)) {
            reconnects++;
            return;
        }

        seen.add(key);
    });

    return reconnects;
}

function countArrayValues(store: unknown): number {
    return Object.values(asRecord(store))
        .reduce<number>((count, values) => count + (Array.isArray(values) ? values.length : 0), 0);
}

function ratio(numerator: number, denominator: number): number {
    return denominator > 0
        ? Number((numerator / denominator).toFixed(4))
        : 1;
}

function resultOutcomeMetrics(matching: readonly Record<string, unknown>[]): ScenarioOutcomeMetrics {
    const succeeded = matching.filter((result) => result.status === 'SUCCESS').length;
    const failed = matching.filter((result) => result.status === 'FAILURE').length;

    return {
        attempted: matching.length,
        succeeded,
        failed,
        successRatio: ratio(succeeded, matching.length)
    };
}

function flattenStoreValues(store: unknown): unknown[] {
    return Object.values(asRecord(store))
        .flatMap((values) => Array.isArray(values) ? values : []);
}

function diagnosticSeverity(value: unknown): string {
    const severity = (decodeScenarioText(asRecord(value).severity) ?? '').toLowerCase();
    if (severity === 'warn') {
        return 'warning';
    }
    return severity || 'unknown';
}

function diagnosticTopic(value: unknown): string {
    return decodeScenarioText(asRecord(value).topic || 'unknown') ?? 'unknown';
}

function diagnosticMetricsFromValues(values: readonly unknown[]): ScenarioDiagnosticMetrics {
    const bySeverity: Record<string, number> = Object.assign(Object.create(null), {
        debug: 0,
        info: 0,
        warning: 0,
        error: 0,
        unknown: 0
    });
    const byTopic: Record<string, number> = Object.create(null);

    values.forEach((value) => {
        incrementCount(bySeverity, diagnosticSeverity(value));
        incrementCount(byTopic, diagnosticTopic(value));
    });

    return {
        total: values.length,
        bySeverity,
        byTopic
    };
}

function diagnosticMetricsFromReport(report: Record<string, unknown>): ScenarioDiagnosticMetrics {
    return diagnosticMetricsFromValues(flattenStoreValues(report.rtcDiagnostics));
}

function countNestedArrayValues(results: readonly Record<string, unknown>[], fieldName: string): number {
    return results.reduce((count, result) => {
        const actualValues = asRecord(result.actual);
        const detailValues = asRecord(result.details);
        const actualValue = actualValues[fieldName];
        const detailValue = detailValues[fieldName];
        return count +
            (Array.isArray(actualValue) ? actualValue.length : 0) +
            (Array.isArray(detailValue) ? detailValue.length : 0);
    }, 0);
}

export function computeScenarioMetrics(report: Record<string, unknown>): ScenarioMetrics {
    const results = Array.isArray(report.resultsList) ? report.resultsList.map(asRecord) : [];
    const byTransport: Record<string, number> = Object.create(null);
    const byAction: Record<string, number> = Object.create(null);
    const byStatus: Record<string, number> = Object.create(null);
    const closeResults = results.filter((result) =>
        (decodeScenarioText(result.action) ?? '').toLowerCase() === 'close'
    );

    results.forEach((result) => {
        incrementCount(byTransport, result.transport);
        incrementCount(byAction, result.action || result.method || result.transport);
        incrementCount(byStatus, result.status);
    });

    return {
        byTransport,
        byAction,
        byStatus,
        sends: resultOutcomeMetrics(
            results.filter((result) => (decodeScenarioText(result.action) ?? '').toLowerCase() === 'send')
        ),
        waits: resultOutcomeMetrics(
            results.filter((result) =>
                ['wait', 'expect'].includes((decodeScenarioText(result.action) ?? '').toLowerCase())
            )
        ),
        latencyMs: computeScenarioLatencies(results),
        failures: {
            total: results.filter((result) => result.status === 'FAILURE').length,
            missingExpectedMessages: countNestedArrayValues(results, 'missingMessages'),
            missingExpectedDiagnostics: countNestedArrayValues(results, 'missingDiagnostics')
        },
        reconnects: countReconnects(results),
        diagnostics: diagnosticMetricsFromReport(report),
        cleanup: {
            closeSteps: closeResults.length,
            closeSuccess: closeResults.filter((result) => result.status === 'SUCCESS').length,
            closeFailure: closeResults.filter((result) => result.status === 'FAILURE').length,
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents),
            wsCloseEvents: countArrayValues(report.wsCloseEvents)
        }
    };
}

function computeScenarioLatencies(results: readonly Record<string, unknown>[]): ScenarioLatencyBreakdown {
    return {
        stepDuration: latencyMetric(
            results.map((result) => decodeScenarioNumber(result.durationMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        connect: latencyMetric(
            results.map((result) => decodeScenarioNumber(asRecord(result.actual).connectLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        send: latencyMetric(
            results.map((result) => decodeScenarioNumber(asRecord(result.actual).sendLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        firstPayload: latencyMetric(
            results.map((result) => decodeScenarioNumber(asRecord(result.actual).firstPayloadLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        )
    };
}

export function withScenarioMetrics<T extends Record<string, unknown>>(
    report: T
): T & { readonly metrics: Readonly<Record<string, unknown>>; } {
    return {
        ...report,
        metrics: {
            ...computeScenarioMetrics(report),
            ...asRecord(report.metrics)
        }
    };
}

function uniqueRepeatIndexes(results: readonly Record<string, unknown>[]): number[] {
    return [
        ...new Set(
            results
                .map((result) => Number.parseInt(decodeScenarioText(result.repeatIndex) ?? '', 10))
                .filter((value: number) => Number.isFinite(value) && value > 0)
        )
    ].sort((a, b) => a - b);
}

export function computeScenarioScaleMetrics(
    results: readonly Record<string, unknown>[],
    runs: readonly ScenarioScaleRunObservation[]
): ScenarioMetrics {
    const metrics = computeScenarioMetrics({ resultsList: results });
    return {
        ...metrics,
        latencyMs: {
            ...metrics.latencyMs,
            runDuration: latencyMetric(
                runs.map((run) => decodeScenarioNumber(asRecord(run.summary).durationMs))
                    .filter((value): value is number => value !== undefined)
            )
        },
        failures: {
            ...metrics.failures,
            runs: runs.filter((run) => (decodeScenarioNumber(asRecord(run.summary).failure) ?? 0) > 0).length
        },
        diagnostics: diagnosticMetricsFromValues(
            runs.flatMap((run) => flattenStoreValues(asRecord(run.report).rtcDiagnostics))
        ),
        cleanup: {
            ...metrics.cleanup,
            rtcCloseEvents: runs.reduce(
                (count, run) => count + countArrayValues(asRecord(run.report).rtcCloseEvents),
                0
            ),
            wsCloseEvents: runs.reduce((count, run) => count + countArrayValues(asRecord(run.report).wsCloseEvents), 0)
        }
    };
}

export function computeScenarioSoakMetrics(report: Record<string, unknown>): ScenarioSoakMetrics {
    const results = Array.isArray(report.resultsList) ? report.resultsList.map(asRecord) : [];
    return {
        ...computeScenarioMetrics(report),
        sameConnection: true,
        iterationsObserved: uniqueRepeatIndexes(results).length,
        events: {
            wsMessages: countArrayValues(report.wsMessages),
            wsCloseEvents: countArrayValues(report.wsCloseEvents),
            rtcMessages: countArrayValues(report.rtcMessages),
            rtcDiagnostics: countArrayValues(report.rtcDiagnostics),
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents)
        }
    };
}
