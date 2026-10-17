import type { ControlClientIdentity } from '../control-protocol.ts';
import { canonicalControlRetentionJson } from '../control-retention-canonical.ts';
import { computeCanonicalDigest } from '../distributed-artifact-evidence/compute-canonical-digest.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export interface ResultCaptureIdentity {
    readonly runtimeId: string;
    readonly generation: number;
    readonly assignment: number;
    readonly ordinal: number;
    readonly rootCommandId: string;
}

export interface ResultCaptureReceipt extends ControlClientIdentity {
    readonly capture: ResultCaptureIdentity;
    readonly commandId: string;
    readonly digest: string;
}

export interface ResultReleaseRequest extends ControlClientIdentity {
    readonly requestId: string;
    readonly receipts: readonly ResultCaptureReceipt[];
}

export interface ResultReleaseOutcome {
    readonly requestId: string;
    readonly status: 'released' | 'deferred' | 'rejected';
    readonly releasedResults: number;
    readonly reason: string;
}

export interface ResultReleaseEnvelope extends ResultReleaseRequest {
    readonly kind: 'results.release';
    readonly protocolVersion: 1;
}

export async function computeResultCaptureReceipt(
    result: RallarBlackBoxTestResult,
    identity: ControlClientIdentity
): Promise<ResultCaptureReceipt | undefined> {
    if (!result.capture) {
        return undefined;
    }
    const { replayed: _replayed, ...fullResult } = result;
    return {
        runId: identity.runId,
        agentId: identity.agentId,
        capture: result.capture,
        commandId: result.commandId,
        digest: await computeCanonicalDigest(canonicalControlRetentionJson(fullResult))
    };
}

export function decodeResultReleaseEnvelope(message: unknown): ResultReleaseEnvelope | undefined {
    let value: unknown;
    try {
        value = typeof message === 'string' ? JSON.parse(message) : message;
    }
    catch {
        return undefined;
    }
    if (
        !isJsonRecordValue(value) || value.kind !== 'results.release' || value.protocolVersion !== 1 ||
        typeof value.runId !== 'string' || typeof value.agentId !== 'string' ||
        typeof value.requestId !== 'string' || !Array.isArray(value.receipts) ||
        !value.receipts.every(isResultCaptureReceipt)
    ) {
        return undefined;
    }
    return {
        kind: 'results.release',
        protocolVersion: 1,
        runId: value.runId,
        agentId: value.agentId,
        requestId: value.requestId,
        receipts: value.receipts
    };
}

export function isResultCaptureReceipt(value: unknown): value is ResultCaptureReceipt {
    if (!isJsonRecordValue(value) || !isJsonRecordValue(value.capture)) {
        return false;
    }
    const capture = value.capture;
    return typeof value.runId === 'string' && typeof value.agentId === 'string' &&
        typeof value.commandId === 'string' && typeof value.digest === 'string' &&
        typeof capture.runtimeId === 'string' && typeof capture.rootCommandId === 'string' &&
        Number.isSafeInteger(capture.generation) && Number.isSafeInteger(capture.assignment) &&
        Number.isSafeInteger(capture.ordinal);
}
