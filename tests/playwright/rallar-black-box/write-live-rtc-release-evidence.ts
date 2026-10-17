import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

import { readRecorderJsonlRows } from '@shared-test/black-box-runner/artifacts/read-recorder-jsonl-rows.ts';
import { decodeRallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/composite-results.ts';
import {
    canonicalControlRetentionJson,
    CONTROL_RETENTION_PLAN_LIMITS
} from '@shared-test/rallar-bb-test/control-retention-canonical.ts';
import {
    decodeResultReleaseArtifact,
    type ResultReleaseArtifact,
    type ResultReleaseArtifactOwner
} from '@shared-test/rallar-bb-test/result-release/decode-result-release-artifact.ts';
import {
    computeResultCaptureReceipts,
    isResultCaptureReceipt,
    type ResultCaptureReceipt
} from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type {
    RtcBaselineRawReferenceDto,
    RtcBaselineSampleDto
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import {
    resolveRtcB06DiagnosticSelection,
    resolveRtcB06ReleaseEnvironment
} from '../../../packages/shared-rtc-bench/baseline/observation/read-rtc-b06-diagnostic-selection.ts';
import { jsonRecord, normalizeJson } from './live-rtc-evidence-json.ts';
import { writeLiveRtcDurableArtifact } from './read-live-rtc-durable-journal.ts';
import type { WriteLiveRtcPerformanceEvidenceInput } from './write-live-rtc-performance-evidence.ts';

interface LiveRtcReleaseFailure {
    readonly references: readonly RtcBaselineRawReferenceDto[];
    readonly cause: Error;
}

interface LiveRtcReleaseRecovery {
    readonly references: readonly RtcBaselineRawReferenceDto[];
    readonly releasedRoots: number;
}

interface ReleasedRoot {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly captures: readonly ResultCaptureReceipt[];
    readonly receipts: ReadonlyMap<string, ResultCaptureReceipt>;
    readonly acknowledgements: readonly ResultReleaseArtifact[];
}

interface LiveRtcOwnedResultIdentity {
    readonly agentId: string;
    readonly commandId: string;
}

export async function writeLiveRtcReleaseEvidence(
    input: WriteLiveRtcPerformanceEvidenceInput,
    raw: string | undefined
): Promise<WriteLiveRtcPerformanceEvidenceInput['evidence']> {
    if (input.evidence.schema !== 'rallar.rtc-baseline.external-attempt.v1') {
        return input.evidence;
    }
    const samples: RtcBaselineSampleDto[] = [];
    for (const sample of input.evidence.samples) {
        samples.push(await writeReleaseSample(input, sample, raw));
    }
    return {
        ...input.evidence,
        samples,
        sampleOutcomes: samples.map(({ identity, outcome, issues }) => ({ identity, outcome, issues }))
    };
}

async function writeReleaseSample(
    input: WriteLiveRtcPerformanceEvidenceInput,
    sample: RtcBaselineSampleDto,
    raw: string | undefined
): Promise<RtcBaselineSampleDto> {
    const initialized = sample.runtimeObservation?.resolvedConfiguration ?? [];
    if (!initialized.some((entry) => entry.field === 'releaseResultsAfterCapture')) {
        return sample;
    }
    const selected = resolveRtcB06DiagnosticSelection(initialized, sample.identity);
    const observed = resolveRtcB06ReleaseEnvironment(sample.identity, raw);
    const enabled = observed.ok ? observed.value.value : null;
    const captured = selected.ok && selected.value.releaseResultsAfterCapture
        ? await writeReleaseRecovery(input, sample)
        : Either.ofRight<LiveRtcReleaseFailure, LiveRtcReleaseRecovery>({ references: [], releasedRoots: 0 });
    const references = captured.right?.references ?? captured.left!.references;
    const releasedRoots = captured.right?.releasedRoots ?? 0;
    const failure = captured.left?.cause.message ?? (
        !selected.ok || enabled === null || enabled !== selected.value.releaseResultsAfterCapture
            ? 'Actual producer release selection does not match initialized configuration.'
            : undefined
    );
    const issue = { path: '$.rawEvidence.resultRelease', code: 'result-release-unverified', message: failure ?? '' };
    return {
        ...sample,
        rawReferences: [...sample.rawReferences, ...references],
        outcome: failure === undefined ? sample.outcome : 'failed',
        issues: failure === undefined ? sample.issues : [...sample.issues, issue],
        rawEvidence: normalizeJson({
            ...jsonRecord(sample.rawEvidence),
            resultRelease: {
                raw: raw ?? null,
                enabled,
                status: failure === undefined ? 'verified' : 'failed',
                runId: input.runId,
                releasedRoots,
                sources: references,
                ...(failure === undefined ? {} : { reason: failure })
            }
        })
    };
}

async function writeReleaseRecovery(
    input: WriteLiveRtcPerformanceEvidenceInput,
    sample: RtcBaselineSampleDto
): Promise<Either<LiveRtcReleaseFailure, LiveRtcReleaseRecovery>> {
    const references: RtcBaselineRawReferenceDto[] = [];
    try {
        if (input.runId === null) {
            throw new Error('Release recovery requires the actual owned run.');
        }
        const identity = sample.identity;
        const storageDirectory =
            `${input.repoRoot}/tmp/perf/rtc-b06-recorder/${input.baselineId}/${identity.caseId}/${identity.intendedPhase}-${identity.outerOrdinal}`;
        const paths = new Map<string, string>();
        for (const fileName of ['results.jsonl', 'events.jsonl', 'result-receipts.jsonl'] as const) {
            const rawRelativePath = `artifacts/journals/${identity.sampleId}-${fileName}`;
            const rawPath = resolve(input.repoRoot, 'tmp/perf/rtc-baseline', input.baselineId, rawRelativePath);
            references.push(
                await writeLiveRtcDurableArtifact({
                    repoRoot: input.repoRoot,
                    storageDirectory,
                    rawRelativePath,
                    rawPath,
                    runId: input.runId,
                    boundaries: undefined,
                    fileName
                })
            );
            paths.set(fileName, rawPath);
        }
        const releasedRoots = await readReleasedRoots(paths, input.runId);
        return Either.ofRight({ references, releasedRoots });
    }
    catch (cause) {
        return Either.ofLeft({ references, cause: toError(cause) });
    }
}

async function readReleasedRoots(paths: ReadonlyMap<string, string>, runId: string): Promise<number> {
    const receipts = await readCapturedReceipts(paths.get('result-receipts.jsonl')!, runId);
    const acknowledgements = await readReleaseAcknowledgements(paths.get('events.jsonl')!, {
        runId,
        agentIds: new Set([...receipts.values()].map((receipt) => receipt.agentId))
    });
    const consumed = new Set<string>();
    let releasedRoots = 0;
    for await (const row of readArtifactRows(paths.get('results.jsonl')!)) {
        const identity = decodeOwnedResultIdentity(row, runId);
        if (identity.right === undefined) {
            throw new Error(identity.left);
        }
        if (row.action === 'agent.reload') {
            continue;
        }
        const { agentId, commandId } = identity.right;
        const captures = await computeResultCaptureReceipts(row.fullResult, { runId, agentId });
        assertReleasedRoot({ runId: runId, agentId, commandId, captures, receipts, acknowledgements });
        for (const receipt of captures) {
            consumed.add(canonicalControlRetentionJson([receipt.agentId, receipt.commandId, receipt.capture]));
        }
        releasedRoots++;
    }
    if (releasedRoots === 0 || consumed.size !== receipts.size || acknowledgements.length !== releasedRoots) {
        throw new Error('Complete release evidence has missing roots or unmatched receipts/acknowledgements.');
    }
    return releasedRoots;
}

function decodeOwnedResultIdentity(row: ApiJsonObject, runId: string): Either<string, LiveRtcOwnedResultIdentity> {
    const result = decodeRallarBlackBoxTestResult(row.fullResult).right;
    if (
        (row.runId !== undefined && row.runId !== runId) ||
        typeof row.agentId !== 'string' || row.agentId.length === 0 ||
        typeof row.commandId !== 'string' || row.commandId.length === 0 ||
        result === undefined || result.commandId !== row.commandId || result.kind !== row.action ||
        result.ok !== row.ok || row.status !== (result.ok ? 'SUCCESS' : 'FAILURE') ||
        row.resultKey !== `${row.agentId}:${row.commandId}` || row.name !== row.commandId ||
        typeof row.transport !== 'string' || row.transport.length === 0 ||
        typeof row.connection !== 'string' || row.connection.length === 0
    ) {
        return Either.ofLeft('Complete stored result has a foreign or malformed owned record.');
    }
    return Either.ofRight({ agentId: row.agentId, commandId: row.commandId });
}

function assertReleasedRoot(root: ReleasedRoot): void {
    if (
        !root.captures.some((receipt) =>
            receipt.commandId === root.commandId && receipt.capture.rootCommandId === root.commandId
        )
    ) {
        throw new Error('Original root capture is unavailable.');
    }
    for (const receipt of root.captures) {
        const stored = root.receipts.get(
            canonicalControlRetentionJson([receipt.agentId, receipt.commandId, receipt.capture])
        );
        if (!stored || stored.digest !== receipt.digest || receipt.capture.rootCommandId !== root.commandId) {
            throw new Error('Complete root/child result does not match its exact durable capture receipt.');
        }
    }
    const acknowledgements = root.acknowledgements.filter((row) => {
        const outcome = row.outcome;
        return row.agentId === root.agentId &&
            outcome.requestId.startsWith('retention-release-') && outcome.requestId.endsWith(`-${root.commandId}`) &&
            /^[1-9]\d*$/.test(outcome.requestId.slice('retention-release-'.length, -(root.commandId.length + 1)));
    });
    if (acknowledgements.length !== 1) {
        throw new Error('Exact release acknowledgement is missing or ambiguous.');
    }
    const outcome = acknowledgements[0]!.outcome;
    if (outcome.status !== 'released' || outcome.releasedResults !== root.captures.length) {
        throw new Error('Release acknowledgement does not prove all original results were released.');
    }
}

async function readCapturedReceipts(path: string, runId: string): Promise<ReadonlyMap<string, ResultCaptureReceipt>> {
    const receipts = new Map<string, ResultCaptureReceipt>();
    for await (const row of readArtifactRows(path)) {
        if (!isResultCaptureReceipt(row) || row.runId !== runId) {
            throw new Error('Durable result receipt has an invalid or foreign identity.');
        }
        const key = canonicalControlRetentionJson([row.agentId, row.commandId, row.capture]);
        const preceding = receipts.get(key);
        if (preceding && preceding.digest !== row.digest) {
            throw new Error('Contradictory durable result receipts.');
        }
        receipts.set(key, row);
    }
    return receipts;
}

async function readReleaseAcknowledgements(
    path: string,
    owner: ResultReleaseArtifactOwner
): Promise<readonly ResultReleaseArtifact[]> {
    const acknowledgements: ResultReleaseArtifact[] = [];
    for await (const row of readArtifactRows(path)) {
        if (row.runId !== undefined && row.runId !== owner.runId) {
            throw new Error('Release event belongs to a foreign run.');
        }
        const decoded = decodeResultReleaseArtifact(row, owner);
        if (decoded.left !== undefined) {
            throw new Error(decoded.left);
        }
        if (decoded.right !== null) {
            acknowledgements.push(decoded.right!);
        }
    }
    return acknowledgements;
}

async function* readArtifactRows(path: string): AsyncGenerator<ApiJsonObject> {
    let complete = false;
    for await (
        const read of readRecorderJsonlRows(createReadStream(path), CONTROL_RETENTION_PLAN_LIMITS.canonicalUtf8Bytes)
    ) {
        complete = read.right?.kind === 'complete';
        if (read.left) {
            throw new Error(`Complete release artifact is unreadable: ${read.left.code}.`);
        }
        if (read.right?.kind === 'row') {
            yield read.right.row;
        }
    }
    if (!complete) {
        throw new Error('Release artifact did not reach complete finite EOF.');
    }
}
