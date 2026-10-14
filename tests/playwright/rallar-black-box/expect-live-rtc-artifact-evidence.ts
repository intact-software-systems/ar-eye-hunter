import { Either } from '@shared/resilience/Either.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    normalizeJson,
    requiredJsonArray,
    requiredJsonRecord,
    requiredString,
    stringValue,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';
import { readLiveRtcBrowserEvent, readLiveRtcRecorderJsonl } from './live-rtc-recorder-reader.ts';
import {
    computeLiveRtcRecorderScanWindow,
    toLiveRtcRecorderLines,
    toLiveRtcRecorderRow
} from './live-rtc-recorder-rows.ts';

export async function expectLiveRtcArtifactEvidence(
    bundle: LiveRtcJsonRecord,
    input: LiveRtcControlClient.ArtifactBundleInput,
    baseUrl: string
): Promise<void> {
    const previewIssues = validateLiveRtcArtifactPreview(bundle, input.runId);
    if (previewIssues.length > 0) {
        throw new Error(previewIssues.join('; '));
    }
    if (!input.commandIds.length || input.commandIds.some((commandId) => !commandId.trim())) {
        throw new Error('Artifact evidence requires nonempty executed command IDs.');
    }
    const endpoint = `${baseUrl}/runs/${encodeURIComponent(input.runId)}`;
    const read = await readLiveRtcRecorderJsonl(`${endpoint}/results.jsonl`);
    if (!read.right) {
        throw new Error(`Durable results unavailable: ${read.left?.code}.`);
    }
    if (read.right.retainedPrefixDropped || read.right.transportTruncated) {
        throw new Error('Durable results incomplete within the recorder input/transport limit.');
    }
    const receipts = toLiveRtcExecutedCommandEvidence(read.right.jsonl, input.commandIds);
    if (receipts.left) {
        throw new Error(receipts.left);
    }
    const browserEvent = await readLiveRtcBrowserEvent(`${endpoint}/events.jsonl`);
    if (browserEvent.left) {
        throw new Error(`Durable browser event unavailable: ${browserEvent.left.code}.`);
    }
}

function validateLiveRtcArtifactPreview(bundle: LiveRtcJsonRecord, runId: string): readonly string[] {
    try {
        const issues: string[] = [];
        if (bundle.runId !== runId) {
            issues.push('Artifact bundle belongs to a different run.');
        }
        const files = requiredJsonRecord(bundle.files, 'Artifact preview files');
        const report = requiredJsonRecord(
            normalizeJson(JSON.parse(requiredString(files['report.json'], 'Artifact report preview'))),
            'Artifact report preview'
        );
        const outputs = requiredJsonRecord(report.outputs, 'Artifact report outputs');
        const summary = requiredJsonRecord(report.summary, 'Artifact report summary');
        const results = requiredJsonArray(report.resultsList, 'Artifact report results');
        const indexed = requiredJsonRecord(report.results, 'Artifact indexed results');
        if (outputs.runId !== runId) {
            issues.push('Artifact report belongs to a different run.');
        }
        if (
            results.length > 200 || summary.total !== results.length || Object.keys(indexed).length !== results.length
        ) {
            issues.push('Artifact report must contain a consistent bounded result preview.');
        }
        if (results.some((row) => !isLiveRtcResultReceipt(jsonRecord(row)))) {
            issues.push('Artifact report contains malformed result evidence.');
        }
        const preview = files['events.jsonl'];
        if (
            typeof preview !== 'string' ||
            preview.split('\n').some((line) => line.trim() && !toLiveRtcRecorderRow(line))
        ) {
            issues.push('Artifact event preview must contain JSONL records.');
        }
        return issues;
    }
    catch {
        return ['Artifact preview is unavailable or malformed.'];
    }
}

function toLiveRtcExecutedCommandEvidence(jsonl: string, commandIds: readonly string[]): Either<string, true> {
    const scan = { jsonl, retainedPrefixDropped: false, transportTruncated: false };
    if (computeLiveRtcRecorderScanWindow(scan).rowLimitReached) {
        return Either.ofLeft('Durable result evidence exceeds the recorder scan limit.');
    }
    const missing = new Set(commandIds);
    for (const { line } of toLiveRtcRecorderLines(scan)) {
        const row = toLiveRtcRecorderRow(line);
        if (!isLiveRtcResultReceipt(row)) {
            return Either.ofLeft('Durable results contain malformed result evidence.');
        }
        missing.delete(String(row?.commandId));
    }
    return missing.size
        ? Either.ofLeft(`Durable evidence missing executed commands: ${[...missing].join(', ')}.`)
        : Either.ofRight(true);
}

function isLiveRtcResultReceipt(row: LiveRtcJsonRecord | null): boolean {
    if (!row || row.kind !== undefined) {
        return false;
    }
    const commandId = stringValue(row.commandId);
    const agentId = stringValue(row.agentId);
    return commandId !== undefined && agentId !== undefined &&
        row.name === commandId && row.resultKey === `${agentId}:${commandId}` &&
        typeof row.ok === 'boolean' && row.status === (row.ok ? 'SUCCESS' : 'FAILURE');
}
