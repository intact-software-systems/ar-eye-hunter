import {
    decodeRallarBlackBoxTestResult,
    toRallarBlackBoxCompositeResultFlatEntries
} from '../composite-results.ts';
import type { ControlEventEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    isCommandIdentityConsistent,
    isCompositeAttributionConsistent,
    resolveControlExecutionCommand,
    toControlCommandAttribution
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
        if (command === undefined || command.kind !== envelope.result.kind) {
            continue;
        }
        const entries = toRallarBlackBoxCompositeResultFlatEntries([envelope.result]);
        const authored = toControlCommandAttribution(command, entries, new Map());
        const recoveredPaths = new Set<string>();
        for (const entry of entries) {
            const authoredCommand = authored.commands.get(entry.path);
            if (
                authoredCommand === undefined || entry.childDecodeIssues.length > 0 ||
                !isCommandIdentityConsistent(entry, authoredCommand) ||
                !isCompositeAttributionConsistent(entry, entries, authored.commands)
            ) {
                continue;
            }
            const recovered = entry.position.kind !== 'root' && recoveredPaths.has(entry.position.parentPath);
            if (
                recovered || (authoredCommand.kind === 'loop' && authoredCommand.until === 'first-success' &&
                    entry.ok && entry.status === 'ok')
            ) {
                recoveredPaths.add(entry.path);
            }
            if (recovered && !entry.ok) {
                const key = toPollingAttemptKey(envelope.runId, envelope.agentId, entry.result);
                if (key !== undefined) {
                    attempts.set(key, entry.result);
                }
            }
        }
    }
    return attempts;
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
