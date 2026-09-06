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

function numberFromPath(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? parsed
        : undefined;
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
    const normalized = String(key || 'unknown');
    target[normalized] = (target[normalized] || 0) + 1;
}

function countReconnects(results: any[]): number {
    const seen = new Set<string>();
    let reconnects = 0;

    results.forEach((result) => {
        const action = String(result.action || '').toLowerCase();
        if (action !== 'connect' && action !== 'open') {
            return;
        }

        const connection = result.connection || result.actual?.connection;
        if (!connection) {
            return;
        }

        const key = [result.runIndex, result.transport, connection].join(':');
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

function resultOutcomeMetrics(matching: any[]): ScenarioOutcomeMetrics {
    const succeeded = matching.filter((result) => result.status === 'SUCCESS').length;
    const failed = matching.filter((result) => result.status === 'FAILURE').length;

    return {
        attempted: matching.length,
        succeeded,
        failed,
        successRatio: ratio(succeeded, matching.length)
    };
}

function flattenStoreValues(store: unknown): any[] {
    return Object.values(asRecord(store))
        .flatMap((values) => Array.isArray(values) ? values : []);
}

function diagnosticSeverity(value: unknown): string {
    const severity = String(asRecord(value).severity || '').toLowerCase();
    if (severity === 'warn') {
        return 'warning';
    }
    return severity || 'unknown';
}

function diagnosticTopic(value: unknown): string {
    return String(asRecord(value).topic || 'unknown');
}

function diagnosticMetricsFromValues(values: any[]): ScenarioDiagnosticMetrics {
    const bySeverity: Record<string, number> = {
        debug: 0,
        info: 0,
        warning: 0,
        error: 0,
        unknown: 0
    };
    const byTopic: Record<string, number> = {};

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

function diagnosticMetricsFromReport(report: any): ScenarioDiagnosticMetrics {
    return diagnosticMetricsFromValues(flattenStoreValues(report.rtcDiagnostics));
}

function countNestedArrayValues(results: any[], fieldName: string): number {
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

export function computeScenarioMetrics(report: any): ScenarioMetrics {
    const results = Array.isArray(report.resultsList) ? report.resultsList : [];
    const byTransport: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const closeResults = results.filter((result: any) => String(result.action || '').toLowerCase() === 'close');

    results.forEach((result: any) => {
        incrementCount(byTransport, result.transport);
        incrementCount(byAction, result.action || result.method || result.transport);
        incrementCount(byStatus, result.status);
    });

    return {
        byTransport,
        byAction,
        byStatus,
        sends: resultOutcomeMetrics(
            results.filter((result: any) => String(result.action || '').toLowerCase() === 'send')
        ),
        waits: resultOutcomeMetrics(
            results.filter((result: any) => ['wait', 'expect'].includes(String(result.action || '').toLowerCase()))
        ),
        latencyMs: computeScenarioLatencies(results),
        failures: {
            total: results.filter((result: any) => result.status === 'FAILURE').length,
            missingExpectedMessages: countNestedArrayValues(results, 'missingMessages'),
            missingExpectedDiagnostics: countNestedArrayValues(results, 'missingDiagnostics')
        },
        reconnects: countReconnects(results),
        diagnostics: diagnosticMetricsFromReport(report),
        cleanup: {
            closeSteps: closeResults.length,
            closeSuccess: closeResults.filter((result: any) => result.status === 'SUCCESS').length,
            closeFailure: closeResults.filter((result: any) => result.status === 'FAILURE').length,
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents),
            wsCloseEvents: countArrayValues(report.wsCloseEvents)
        }
    };
}

function computeScenarioLatencies(results: any[]): ScenarioLatencyBreakdown {
    return {
        stepDuration: latencyMetric(
            results.map((result: any) => numberFromPath(result.durationMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        connect: latencyMetric(
            results.map((result: any) => numberFromPath(result.actual?.connectLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        send: latencyMetric(
            results.map((result: any) => numberFromPath(result.actual?.sendLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        ),
        firstPayload: latencyMetric(
            results.map((result: any) => numberFromPath(result.actual?.firstPayloadLatencyMs)).filter((
                value: number | undefined
            ): value is number => value !== undefined)
        )
    };
}

export function withScenarioMetrics(report: any): any {
    return {
        ...report,
        metrics: {
            ...computeScenarioMetrics(report),
            ...asRecord(report.metrics)
        }
    };
}

function uniqueRepeatIndexes(results: any[]): number[] {
    return [
        ...new Set(
            results
                .map((result: any) => Number.parseInt(String(result.repeatIndex), 10))
                .filter((value: number) => Number.isFinite(value) && value > 0)
        )
    ].sort((a, b) => a - b);
}

export function computeScenarioScaleMetrics(results: any[], runs: any[]): ScenarioMetrics {
    const metrics = computeScenarioMetrics({ resultsList: results });
    return {
        ...metrics,
        latencyMs: {
            ...metrics.latencyMs,
            runDuration: latencyMetric(
                runs.map((run) => numberFromPath(run.summary?.durationMs))
                    .filter((value): value is number => value !== undefined)
            )
        },
        failures: {
            ...metrics.failures,
            runs: runs.filter((run) => (run.summary?.failure || 0) > 0).length
        },
        diagnostics: diagnosticMetricsFromValues(runs.flatMap((run) => flattenStoreValues(run.report?.rtcDiagnostics))),
        cleanup: {
            ...metrics.cleanup,
            rtcCloseEvents: runs.reduce((count, run) => count + countArrayValues(run.report?.rtcCloseEvents), 0),
            wsCloseEvents: runs.reduce((count, run) => count + countArrayValues(run.report?.wsCloseEvents), 0)
        }
    };
}

export function computeScenarioSoakMetrics(report: any): ScenarioSoakMetrics {
    const results = Array.isArray(report.resultsList) ? report.resultsList : [];
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
