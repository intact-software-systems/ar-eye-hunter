import {
    decodeRallarBlackBoxTestResult,
    toRallarBlackBoxCompositeResultFlatEntries,
    type RallarBlackBoxCompositeResultFlatEntry
} from '../composite-results.ts';
import type { ControlEventEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    isCommandIdentityConsistent,
    isCompositeAttributionConsistent,
    resolveControlExecutionCommand,
    toControlCommandAttribution,
    toControlCommandRequirements
} from './control-command-attribution.ts';

/** Only retained authored until-loops and their completed results can explain failed polling attempts. */
export function toSuccessfulPollingAttempts(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot | undefined
): ReadonlyMap<string, RallarBlackBoxTestResult> {
    const attempts = new Map<string, RallarBlackBoxTestResult>();
    if (controlRun === undefined || controlRun.runId !== distributedRun.controlRunId) {
        return attempts;
    }
    for (const envelope of controlRun.results) {
        const linked = distributedRun.commandLinks.some((link) =>
            link.commandId === envelope.commandId && link.agentId === envelope.agentId
        );
        if (!linked || !envelope.ok || envelope.runId !== controlRun.runId || envelope.result?.ok !== true) {
            continue;
        }
        const queued = controlRun.commands.find((candidate) =>
            candidate.envelope.commandId === envelope.commandId && candidate.envelope.runId === envelope.runId &&
            candidate.envelope.agentId === envelope.agentId
        )?.envelope;
        const command = resolveControlExecutionCommand({
            command: queued,
            envelope,
            commands: controlRun.commands,
            results: controlRun.results
        });
        if (
            command === undefined || command.kind !== envelope.result.kind ||
            envelope.result.commandId !== envelope.commandId || envelope.attribution?.status === 'unavailable'
        ) {
            continue;
        }
        for (const result of toRecoveredPollingResults(command, envelope.result)) {
            const key = toPollingAttemptKey(envelope.runId, envelope.agentId, result);
            if (key !== undefined) {
                attempts.set(key, result);
            }
        }
    }
    return attempts;
}

function toRecoveredPollingResults(
    command: RallarBlackBoxTestCommand,
    result: RallarBlackBoxTestResult
): readonly RallarBlackBoxTestResult[] {
    const entries = toRallarBlackBoxCompositeResultFlatEntries([result]);
    const authored = toControlCommandAttribution(command, entries, toControlCommandRequirements(command).references);
    const finalIterations = toSuccessfulLoopIterations(entries, authored.commands);
    const recoveredPaths = new Set<string>();
    const recoveredResults: RallarBlackBoxTestResult[] = [];
    for (const entry of entries) {
        const authoredCommand = authored.commands.get(entry.path);
        if (
            authoredCommand === undefined || entry.childDecodeIssues.length > 0 ||
            !isCommandIdentityConsistent(entry, authoredCommand) ||
            !isCompositeAttributionConsistent(entry, entries, authored.commands)
        ) {
            continue;
        }
        const position = entry.position;
        const recovered = (position.kind !== 'root' && recoveredPaths.has(position.parentPath)) ||
            (!entry.ok && position.kind === 'loop-child' &&
                position.iteration < (finalIterations.get(position.parentPath) ?? 0));
        if (recovered) {
            recoveredPaths.add(entry.path);
        }
        if (recovered && !entry.ok) {
            recoveredResults.push(entry.result);
        }
    }
    return recoveredResults;
}

function toSuccessfulLoopIterations(
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[],
    commands: ReadonlyMap<string, RallarBlackBoxTestCommand>
): ReadonlyMap<string, number> {
    const finalIterations = new Map<string, number>();
    for (const entry of entries) {
        const command = commands.get(entry.path);
        if (
            command?.kind !== 'loop' || command.until !== 'first-success' || !entry.ok ||
            entry.status !== 'ok' || entry.childDecodeIssues.length > 0
        ) {
            continue;
        }
        const children = entries.filter((child) =>
            child.position.kind === 'loop-child' &&
            child.position.parentPath === entry.path
        );
        const last = Math.max(
            ...children.map((child) => child.position.kind === 'loop-child' ? child.position.iteration : 0)
        );
        const finalChildren = children.filter((child) =>
            child.position.kind === 'loop-child' && child.position.iteration === last
        );
        if (finalChildren.length === command.commands.length && finalChildren.every((child) => child.ok)) {
            finalIterations.set(entry.path, last);
        }
    }
    return finalIterations;
}

/** Event windows may omit the successful loop event; the retained full root result remains the evidence owner. */
export function isSuccessfulPollingAttempt(
    event: ControlEventEnvelope,
    attempts: ReadonlyMap<string, RallarBlackBoxTestResult>
): boolean {
    if (
        !isJsonRecordValue(event.payload) || event.payload.kind !== 'result' ||
        event.payload.topic !== 'rallar.bb.command.result'
    ) {
        return false;
    }
    const result = decodeRallarBlackBoxTestResult(event.payload.payload).right;
    if (result === undefined || result.ok) {
        return false;
    }
    const key = toPollingAttemptKey(event.runId, event.agentId, result);
    const recorded = key === undefined ? undefined : attempts.get(key);
    return recorded !== undefined && recorded.commandId === result.commandId && recorded.kind === result.kind &&
        recorded.status === result.status && recorded.startedAtEpochMs === result.startedAtEpochMs &&
        recorded.endedAtEpochMs === result.endedAtEpochMs && recorded.error?.code === result.error?.code;
}

function toPollingAttemptKey(runId: string, agentId: string, result: RallarBlackBoxTestResult): string | undefined {
    const capture = result.capture;
    if (
        !capture || typeof capture.runtimeId !== 'string' || typeof capture.rootCommandId !== 'string' ||
        !Number.isSafeInteger(capture.generation) || !Number.isSafeInteger(capture.assignment) ||
        !Number.isSafeInteger(capture.ordinal)
    ) {
        return undefined;
    }
    return JSON.stringify([
        runId,
        agentId,
        capture.runtimeId,
        capture.generation,
        capture.assignment,
        capture.rootCommandId,
        capture.ordinal
    ]);
}
