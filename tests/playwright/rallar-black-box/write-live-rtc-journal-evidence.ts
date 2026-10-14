import { toRtcB06EventHistoryEvidence } from '../../../packages/shared-rtc-bench/baseline/acceptance/to-rtc-b06-event-history.ts';
import { toRtcB06BrowserRecordingReadings } from '../../../packages/shared-rtc-bench/baseline/acceptance/validate-rtc-b06-browser-recording.ts';
import type {
    RtcBaselineExternalAttemptDto,
    RtcBaselineExternalCohortDto,
    RtcBaselineRawReferenceDto,
    RtcBaselineSampleDto
} from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { resolveRtcB06DiagnosticSelection } from '../../../packages/shared-rtc-bench/baseline/observation/read-rtc-b06-diagnostic-selection.ts';

import { jsonRecord, normalizeJson } from './live-rtc-evidence-json.ts';
import { readLiveRtcDurableJournal, type LiveRtcDurableJournal } from './read-live-rtc-durable-journal.ts';
import type { WriteLiveRtcPerformanceEvidenceInput } from './write-live-rtc-performance-evidence.ts';

export async function writeLiveRtcJournalEvidence(
    input: WriteLiveRtcPerformanceEvidenceInput
): Promise<RtcBaselineExternalAttemptDto | RtcBaselineExternalCohortDto> {
    const attempt = input.evidence;
    if (
        attempt.schema !== 'rallar.rtc-baseline.external-attempt.v1' || attempt.locator.caseId !== 'retention-100' ||
        attempt.locator.environmentId !== 'E3-memory' || attempt.samples.length !== 1
    ) {
        return attempt;
    }
    const sample = attempt.samples[0]!;
    const selection = resolveRtcB06DiagnosticSelection(
        sample.runtimeObservation?.resolvedConfiguration ?? [],
        sample.identity
    );
    if (!selection.ok || selection.value.eventHistory.mode !== 'recent') {
        return attempt;
    }
    const completed = await writeJournalSample(input, sample);
    return {
        ...attempt,
        samples: [completed],
        sampleOutcomes: [{ identity: completed.identity, outcome: completed.outcome, issues: completed.issues }]
    };
}

async function writeJournalSample(
    input: WriteLiveRtcPerformanceEvidenceInput,
    sample: RtcBaselineSampleDto
): Promise<RtcBaselineSampleDto> {
    const raw = jsonRecord(sample.rawEvidence);
    const checkpoints = jsonRecord(raw?.retention)?.checkpoints;
    const terminal = Array.isArray(checkpoints)
        ? checkpoints.find((checkpoint) => jsonRecord(checkpoint)?.cycle === 100)
        : undefined;
    const boundaries = terminal === undefined ? undefined : toRtcB06BrowserRecordingReadings(terminal);
    if (input.runId === null) {
        return toJournalFailure(sample, 'journal-owned-run-unavailable', null);
    }
    const identity = sample.identity;
    const storageDirectory =
        `${input.repoRoot}/tmp/perf/rtc-b06-recorder/${input.baselineId}/retention-100/${identity.intendedPhase}-${identity.outerOrdinal}`;
    const rawRelativePath = `artifacts/journals/${identity.sampleId}.jsonl`;
    const result = await readLiveRtcDurableJournal({
        repoRoot: input.repoRoot,
        storageDirectory,
        rawRelativePath,
        rawPath: `${input.repoRoot}/tmp/perf/rtc-baseline/${input.baselineId}/${rawRelativePath}`,
        runId: input.runId,
        boundaries
    });
    if (result.left !== undefined) {
        return toJournalFailure(sample, result.left.reason, result.left.source);
    }
    return toJournalSample(sample, result.right!);
}

function toJournalSample(sample: RtcBaselineSampleDto, journal: LiveRtcDurableJournal): RtcBaselineSampleDto {
    const raw = jsonRecord(sample.rawEvidence);
    const rawReferences = [...sample.rawReferences, {
        relativePath: journal.source.relativePath,
        bytes: journal.source.bytes,
        sha256: journal.source.sha256
    }];
    return {
        ...sample,
        rawReferences,
        rawEvidence: normalizeJson({
            ...raw,
            journal: {
                status: journal.status,
                ...journal.proof,
                source: journal.source,
                agents: journal.proof.agents.map((agent) => ({
                    ...agent,
                    initialHistory: toRtcB06EventHistoryEvidence(agent.initialHistory),
                    terminalHistory: toRtcB06EventHistoryEvidence(agent.terminalHistory)
                }))
            }
        })
    };
}

function toJournalFailure(
    sample: RtcBaselineSampleDto,
    reason: string,
    source: RtcBaselineRawReferenceDto | null
): RtcBaselineSampleDto {
    const issue = { path: '$.rawEvidence.journal', code: 'journal-unverified', message: reason };
    return {
        ...sample,
        rawReferences: source === null ? sample.rawReferences : [...sample.rawReferences, source],
        outcome: 'failed',
        issues: [...sample.issues, issue],
        rawEvidence: normalizeJson({ ...jsonRecord(sample.rawEvidence), journal: { status: 'failed', reason } })
    };
}
