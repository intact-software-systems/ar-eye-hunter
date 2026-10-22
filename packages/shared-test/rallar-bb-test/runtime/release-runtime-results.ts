import type { ControlClientIdentity } from '../control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import {
    computeResultCaptureReceipt,
    toCanonicalResultCaptureJson,
    type ResultCaptureReceipt,
    type ResultReleaseOutcome,
    type ResultReleaseRequest
} from '../result-release/result-release-protocol.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export interface RuntimeResultsReleased {
    readonly state: RallarBlackBoxTestState;
    readonly receipts: readonly ResultCaptureReceipt[];
    readonly ownedResultEvents: readonly RallarBlackBoxTestEvent[];
}

export interface RuntimeResultReleaseAdmission {
    readonly controlIdentity: ControlClientIdentity | undefined;
    readonly runtimeId: string;
    readonly generation: number;
    readonly assignment: number;
    readonly activeExecutionCount: number;
    readonly recipeLeaseCount: number;
}

export function resolveRuntimeResultReleaseRefusal(
    request: ResultReleaseRequest,
    admission: RuntimeResultReleaseAdmission
): ResultReleaseOutcome | undefined {
    if (
        request.runId !== admission.controlIdentity?.runId || request.agentId !== admission.controlIdentity?.agentId ||
        request.receipts.some((receipt) =>
            receipt.capture.runtimeId !== admission.runtimeId ||
            receipt.capture.generation !== admission.generation ||
            receipt.capture.assignment !== admission.assignment
        )
    ) {
        return toResultReleaseOutcome(
            request.requestId,
            'rejected',
            'Result capture belongs to another runtime assignment or generation.'
        );
    }
    if (admission.activeExecutionCount > 0 || admission.recipeLeaseCount > 0) {
        return toResultReleaseOutcome(
            request.requestId,
            'deferred',
            'Active executions or recipe leases still own runtime references.'
        );
    }
    return undefined;
}

export async function readVerifiedRuntimeRelease(
    state: RallarBlackBoxTestState,
    request: ResultReleaseRequest
): Promise<readonly ResultCaptureReceipt[] | undefined> {
    const receipts = new Map(request.receipts.map((receipt) => [receipt.capture.ordinal, receipt]));
    if (
        request.receipts.some((receipt) =>
            toCanonicalResultCaptureJson(receipts.get(receipt.capture.ordinal)) !==
                toCanonicalResultCaptureJson(receipt)
        )
    ) {
        return undefined;
    }
    const selected = state.commandHistory.filter((result) => result.capture && receipts.has(result.capture.ordinal));
    const roots = new Set(selected.map((result) => toRootIdentity(result.capture!)));
    const owned = state.commandHistory.filter((result) => result.capture && roots.has(toRootIdentity(result.capture)));
    if (owned.length !== selected.length) {
        return undefined;
    }
    for (const result of selected) {
        const verified = await computeResultCaptureReceipt(result, request);
        const receipt = receipts.get(result.capture!.ordinal)!;
        if (!verified || toCanonicalResultCaptureJson(verified) !== toCanonicalResultCaptureJson(receipt)) {
            return undefined;
        }
    }
    return selected.map((result) => receipts.get(result.capture!.ordinal)!);
}

export function computeReleasedRuntimeResults(
    state: RallarBlackBoxTestState,
    verifiedReceipts: readonly ResultCaptureReceipt[],
    ownedResultEvents: WeakSet<RallarBlackBoxTestEvent>
): RuntimeResultsReleased | undefined {
    const receipts = new Map(verifiedReceipts.map((receipt) => [receipt.capture.ordinal, receipt]));
    const selected = state.commandHistory.filter((result) => result.capture && receipts.has(result.capture.ordinal));
    const selectedOrdinals = new Set(selected.map((result) => result.capture!.ordinal));
    const selectedResults = new Map(selected.map((result) => [
        toCanonicalResultCaptureJson(result.capture),
        toCanonicalResultCaptureJson(result)
    ]));
    const commandHistory = state.commandHistory.filter((result) =>
        !selectedOrdinals.has(result.capture?.ordinal ?? -1)
    );
    if (
        commandHistory.some((result) => containsReleasedResult(result, selectedResults)) ||
        state.events.some((event) =>
            !ownedResultEvents.has(event) && containsReleasedResult(event.payload, selectedResults)
        )
    ) {
        return undefined;
    }
    const releasedEvents = state.events.map((event) =>
        containsReleasedResult(event.payload, selectedResults)
            ? { ...event, payload: toReleasedResultMarkers(event.payload, selectedResults) }
            : event
    );
    return {
        state: {
            ...state,
            commandHistory,
            failures: state.failures.filter((result) => !selectedOrdinals.has(result.capture?.ordinal ?? -1)),
            resultCache: Object.fromEntries(
                Object.entries(state.resultCache).filter(([, result]) =>
                    !selectedOrdinals.has(result.capture?.ordinal ?? -1)
                )
            ),
            events: releasedEvents,
            resultHistory: {
                ...state.resultHistory,
                releasedResults: state.resultHistory.releasedResults + selected.length
            }
        },
        receipts: selected.map((result) => receipts.get(result.capture!.ordinal)!),
        ownedResultEvents: releasedEvents.filter((event, index) => ownedResultEvents.has(state.events[index]))
    };
}

function containsReleasedResult(value: unknown, selectedResults: ReadonlyMap<string, string>): boolean {
    if (Array.isArray(value)) {
        return value.some((child) => containsReleasedResult(child, selectedResults));
    }
    if (!isJsonRecordValue(value)) {
        return false;
    }
    return isSelectedResult(value, selectedResults) ||
        Object.values(value).some((child) => containsReleasedResult(child, selectedResults));
}

function isSelectedResult(value: Record<string, unknown>, selectedResults: ReadonlyMap<string, string>): boolean {
    if (!isJsonRecordValue(value.capture)) {
        return false;
    }
    const captured = selectedResults.get(toCanonicalResultCaptureJson(value.capture));
    return captured !== undefined && captured === toCanonicalResultCaptureJson(value);
}

function toReleasedResultMarkers(value: unknown, selectedResults: ReadonlyMap<string, string>): unknown {
    if (Array.isArray(value)) {
        return value.map((child) => toReleasedResultMarkers(child, selectedResults));
    }
    if (!isJsonRecordValue(value)) {
        return value;
    }
    if (isSelectedResult(value, selectedResults)) {
        return {
            resultUnavailable: 'released-after-durable-capture',
            commandId: value.commandId,
            capture: value.capture
        };
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, toReleasedResultMarkers(child, selectedResults)])
    );
}

function toRootIdentity(capture: ResultCaptureReceipt['capture']): string {
    return JSON.stringify([capture.runtimeId, capture.generation, capture.assignment, capture.rootCommandId]);
}

export function toReleasedRuntimeReplay(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>,
    atEpochMs: number
): RallarBlackBoxTestResult {
    return {
        commandId: command.commandId,
        kind: command.kind,
        status: 'failed',
        ok: false,
        startedAtEpochMs: atEpochMs,
        endedAtEpochMs: atEpochMs,
        durationMs: 0,
        replayed: true,
        error: {
            code: 'RALLAR_BLACK_BOX_RESULT_RELEASED',
            message: 'The full result was released after durable capture and is unavailable.'
        }
    };
}

export function toResultReleaseOutcome(
    requestId: string,
    status: ResultReleaseOutcome['status'],
    reason: string
): ResultReleaseOutcome {
    return { requestId, status, reason, releasedResults: 0 };
}
