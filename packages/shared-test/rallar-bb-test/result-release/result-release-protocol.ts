import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

import { decodeRallarBlackBoxTestResult } from '../composite-results.ts';
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

export function decodeResultCaptureJournal(
    text: string,
    identity: ControlClientIdentity,
    commandIds: readonly string[]
): Either<string, readonly ResultCaptureReceipt[]> {
    try {
        const receipts = new Map<string, ResultCaptureReceipt>();
        for (const line of text.split('\n').filter(Boolean)) {
            const receipt: ApiJsonValue = JSON.parse(line);
            if (!isResultCaptureReceipt(receipt)) {
                return Either.ofLeft('Durable receipt journal contains an invalid receipt.');
            }
            if (
                receipt.runId === identity.runId && receipt.agentId === identity.agentId &&
                commandIds.includes(receipt.capture.rootCommandId)
            ) {
                receipts.set(JSON.stringify(receipt.capture), receipt);
            }
        }
        if (
            commandIds.some((commandId) => ![...receipts.values()].some((receipt) => receipt.commandId === commandId))
        ) {
            return Either.ofLeft('A selected command has no durable full-result capture.');
        }
        const latestRoots = new Map<string, ResultCaptureReceipt>();
        for (const receipt of receipts.values()) {
            if (receipt.commandId === receipt.capture.rootCommandId) {
                latestRoots.set(receipt.commandId, receipt);
            }
        }
        return Either.ofRight([...receipts.values()].filter((receipt) => {
            const root = latestRoots.get(receipt.capture.rootCommandId)?.capture;
            return root?.runtimeId === receipt.capture.runtimeId &&
                root.generation === receipt.capture.generation &&
                root.assignment === receipt.capture.assignment;
        }));
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

export async function computeResultCaptureReceipts(
    value: ApiJsonValue | undefined,
    identity: ControlClientIdentity
): Promise<readonly ResultCaptureReceipt[]> {
    const receipts: ResultCaptureReceipt[] = [];
    await collectCaptureReceipts(value, identity, receipts);
    return [...new Map(receipts.map((receipt) => [JSON.stringify(receipt.capture), receipt])).values()];
}

async function collectCaptureReceipts(
    value: ApiJsonValue | undefined,
    identity: ControlClientIdentity,
    receipts: ResultCaptureReceipt[]
): Promise<void> {
    if (Array.isArray(value)) {
        for (const child of value) {
            await collectCaptureReceipts(child, identity, receipts);
        }
        return;
    }
    if (!isJsonRecordValue(value)) {
        return;
    }
    const result = decodeRallarBlackBoxTestResult(value).right;
    if (result) {
        const receipt = await computeResultCaptureReceipt(result, identity);
        if (receipt && isResultCaptureReceipt(receipt)) {
            receipts.push(receipt);
        }
    }
    for (const child of Object.values(value)) {
        await collectCaptureReceipts(child, identity, receipts);
    }
}
