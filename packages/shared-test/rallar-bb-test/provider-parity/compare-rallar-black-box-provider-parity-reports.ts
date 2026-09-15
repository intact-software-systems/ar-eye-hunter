import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import type {
    RallarBlackBoxProviderParityComparison,
    RallarBlackBoxProviderParityReport,
    RallarBlackBoxProviderParityStep
} from './provider-parity-contracts.ts';
import { toOperationFromCommand } from './to-parity-command-metadata.ts';

function toOperationFromResult(result: RallarBlackBoxTestResult): string {
    return toOperationFromCommand(result);
}

function toOperationFromRunnerResult(result: RallarBlackBoxTestRecord): string {
    const name = typeof result.name === 'string' ? result.name.toLowerCase() : '';
    if (name.includes('receive') && name.includes('broadcast')) {
        return 'receive.broadcast';
    }
    if (name.includes('receive') && name.includes('multicast')) {
        return 'receive.multicast';
    }
    if (name.includes('receive') && name.includes('direct')) {
        return 'receive.direct';
    }
    if (name.includes('broadcast')) {
        return 'send.broadcast';
    }
    if (name.includes('multicast')) {
        return 'send.multicast';
    }
    if (name.includes('direct')) {
        return 'send.direct';
    }
    if (name.includes('connect')) {
        return 'connect';
    }
    if (name.includes('close')) {
        return 'close';
    }
    return name || 'unknown';
}

function toStepKey(operation: string, commandId: string | undefined, index: number): string {
    return commandId ? `${operation}:${commandId}` : `${operation}:${index + 1}`;
}

function decodeParityStatus(value: unknown): RallarBlackBoxProviderParityStep['status'] {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
        return 'failed';
    }
    if (value === 'SUCCESS' || value === 'ok' || value === true) {
        return 'ok';
    }
    if (value === 'cancelled') {
        return 'cancelled';
    }
    if (value === 'skipped') {
        return 'skipped';
    }
    return 'failed';
}

export function normalizeRallarBlackBoxRuntimeParityReport(
    input:
        | readonly RallarBlackBoxTestResult[]
        | Readonly<{
            results?: readonly RallarBlackBoxTestResult[];
            commandHistory?: readonly RallarBlackBoxTestResult[];
            events?: readonly RallarBlackBoxTestEvent[];
        }>
): RallarBlackBoxProviderParityReport {
    const reportInput = input as Readonly<{
        results?: readonly RallarBlackBoxTestResult[];
        commandHistory?: readonly RallarBlackBoxTestResult[];
    }>;
    const results: readonly RallarBlackBoxTestResult[] = Array.isArray(input)
        ? input as readonly RallarBlackBoxTestResult[]
        : reportInput.results ?? reportInput.commandHistory ?? [];
    return {
        source: 'rallar-bb-test',
        steps: results.map(toRuntimeParityStep),
        providerSpecificFields: ['startedAtEpochMs', 'endedAtEpochMs', 'durationMs', 'value', 'error']
    };
}

export function normalizeBlackBoxRunnerParityReport(
    report: Readonly<{
        resultsList?: readonly RallarBlackBoxTestRecord[];
    }>
): RallarBlackBoxProviderParityReport {
    return {
        source: 'black-box-runner',
        steps: (report.resultsList ?? []).map(toRunnerParityStep),
        providerSpecificFields: [
            'name',
            'actual',
            'expected',
            'result',
            'exception',
            'startedAtEpochMs',
            'endedAtEpochMs',
            'durationMs'
        ]
    };
}

function toRuntimeParityStep(result: RallarBlackBoxTestResult, index: number): RallarBlackBoxProviderParityStep {
    const operation = toOperationFromCommand(result);
    return {
        key: toStepKey(operation, result.commandId, index),
        operation,
        status: decodeParityStatus(result.status),
        commandId: result.commandId,
        kind: result.kind,
        comparable: {
            operation,
            commandId: result.commandId,
            kind: result.kind,
            status: decodeParityStatus(result.status)
        },
        providerSpecific: {
            startedAtEpochMs: result.startedAtEpochMs,
            endedAtEpochMs: result.endedAtEpochMs,
            durationMs: result.durationMs,
            value: result.value,
            error: result.error
        }
    };
}

function toRunnerParityStep(result: RallarBlackBoxTestRecord, index: number): RallarBlackBoxProviderParityStep {
    const operation = toOperationFromRunnerResult(result);
    const actual: RallarBlackBoxTestRecord = result.actual && typeof result.actual === 'object'
        ? result.actual as RallarBlackBoxTestRecord
        : {};
    const commandId = decodeText(actual.commandId) ?? decodeText(result.commandId);
    return {
        key: toStepKey(operation, commandId, index),
        operation,
        status: decodeParityStatus(result.status),
        commandId,
        kind: decodeText(result.transport),
        action: decodeText(result.action),
        connection: decodeText(result.connection),
        transport: decodeText(result.transport),
        comparable: {
            operation,
            commandId,
            status: decodeParityStatus(result.status),
            action: result.action,
            connection: result.connection,
            transport: result.transport
        },
        providerSpecific: {
            name: result.name,
            actual,
            expected: result.expected,
            result: result.result,
            exception: result.exception,
            startedAtEpochMs: result.startedAtEpochMs,
            endedAtEpochMs: result.endedAtEpochMs,
            durationMs: result.durationMs
        }
    };
}

function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function compareRallarBlackBoxProviderParityReports(
    left: RallarBlackBoxProviderParityReport,
    right: RallarBlackBoxProviderParityReport
): RallarBlackBoxProviderParityComparison {
    const leftByKey = new Map(left.steps.map((step) => [step.key, step]));
    const rightByKey = new Map(right.steps.map((step) => [step.key, step]));
    const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])];
    const matchedKeys: string[] = [];
    const missingLeft: string[] = [];
    const missingRight: string[] = [];
    const statusMismatches: Array<Readonly<{ key: string; left: string; right: string; }>> = [];

    keys.forEach((key) => {
        const leftStep = leftByKey.get(key);
        const rightStep = rightByKey.get(key);
        if (!leftStep) {
            missingLeft.push(key);
            return;
        }
        if (!rightStep) {
            missingRight.push(key);
            return;
        }
        matchedKeys.push(key);
        if (leftStep.status !== rightStep.status) {
            statusMismatches.push({
                key,
                left: leftStep.status,
                right: rightStep.status
            });
        }
    });

    return {
        ok: missingLeft.length === 0 && missingRight.length === 0 && statusMismatches.length === 0,
        matchedKeys,
        missingLeft,
        missingRight,
        statusMismatches
    };
}
