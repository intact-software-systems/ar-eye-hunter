import type {
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineSampleDto
} from '../contracts/rtc-baseline-contracts.ts';
import type { RtcB06DiagnosticSelection } from '../observation/read-rtc-b06-diagnostic-selection.ts';
import {
    isRtcB06EventHistoryContinuous,
    isRtcB06EventHistoryEqual,
    toRtcB06EventHistory
} from './to-rtc-b06-event-history.ts';
import {
    toRtcB06BrowserRecordingReadings,
    type RtcB06BrowserRecordingReading
} from './validate-rtc-b06-browser-recording.ts';

export function validateRtcB06JournalEvidence(
    sample: RtcBaselineSampleDto,
    selection: RtcB06DiagnosticSelection
): readonly RtcBaselineIssueDto[] {
    if (sample.identity.caseId !== 'retention-100' || selection.eventHistory.mode !== 'recent') {
        return [];
    }
    if (selection.eventHistory.maxEvents !== 64) {
        return journalIssue();
    }
    const raw = toRecord(sample.rawEvidence);
    const checkpoints = toRecord(raw?.retention)?.checkpoints;
    const terminal = Array.isArray(checkpoints)
        ? checkpoints.find((checkpoint) => toRecord(checkpoint)?.cycle === 100)
        : undefined;
    const boundaries = terminal === undefined ? undefined : toRtcB06BrowserRecordingReadings(terminal);
    if (boundaries === undefined || validateRtcB06JournalBoundaries(boundaries).length > 0) {
        return journalIssue();
    }
    const journal = toRtcB06JournalEvidence(raw?.journal, sample, boundaries);
    if (journal === undefined) {
        return journalIssue();
    }
    const requiredRows = boundaries.reduce((sum, boundary) =>
        sum + boundary.currentHistory.totalEvents -
        (boundary.initialHistory.capture.status === 'continuous' ? boundary.initialHistory.capture.start.ordinal : 0) +
        1, 6);
    if (journal.rows < requiredRows) {
        return journalIssue();
    }
    const complete = boundaries.every((boundary) => {
        const proof = toRecord(journal.agents.find((agent) => toRecord(agent)?.agentId === boundary.agentId));
        const first = toRtcB06EventHistory(proof?.initialHistory);
        const last = toRtcB06EventHistory(proof?.terminalHistory);
        const counts = toRecord(proof?.countsAfterFirstHealth);
        const capture = boundary.initialHistory.capture;
        return proof?.runId === boundary.runId && proof.admissionCommandId === boundary.admissionCommandId &&
            proof.healthCommandId === boundary.healthCommandId && capture.status === 'continuous' &&
            isRtcB06EventHistoryEqual(first, boundary.initialHistory) &&
            isRtcB06EventHistoryEqual(last, boundary.currentHistory) &&
            proof.capturedRows === boundary.currentHistory.totalEvents - capture.start.ordinal + 1 &&
            counts !== undefined && Object.keys(counts).length === 7 &&
            Object.keys(boundary.currentHistory.countsByKind).every((kind) =>
                counts[kind] ===
                    Reflect.get(boundary.currentHistory.countsByKind, kind) -
                        Reflect.get(boundary.initialHistory.countsByKind, kind)
            );
    });
    return complete ? [] : journalIssue();
}

interface RtcB06JournalEvidence {
    readonly rows: number;
    readonly agents: readonly RtcBaselineJson[];
}

function toRtcB06JournalEvidence(
    value: RtcBaselineJson | undefined,
    sample: RtcBaselineSampleDto,
    boundaries: readonly RtcB06BrowserRecordingReading[]
): RtcB06JournalEvidence | undefined {
    const journal = toRecord(value);
    const reference = toRecord(journal?.source);
    const agents = journal?.agents;
    if (
        journal?.status !== 'durable-prefix' || reference?.kind !== 'owned-recorder-file' ||
        typeof reference.relativePath !== 'string' ||
        reference.relativePath !== `artifacts/journals/${sample.identity.sampleId}.jsonl` ||
        typeof reference.bytes !== 'number' || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 ||
        typeof reference.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reference.sha256) ||
        reference.runId !== boundaries[0]?.runId ||
        reference.endpoint !== `/runs/${boundaries[0]?.runId}/events.jsonl` ||
        journal.bytes !== reference.bytes || typeof journal.rows !== 'number' || !Number.isSafeInteger(journal.rows) ||
        !Array.isArray(agents) || agents.length !== 3 ||
        new Set(agents.map((agent) => toRecord(agent)?.agentId)).size !== 3 ||
        !sample.rawReferences.some((rawReference) =>
            rawReference.relativePath === reference.relativePath &&
            rawReference.bytes === reference.bytes && rawReference.sha256 === reference.sha256
        )
    ) {
        return undefined;
    }
    return { rows: journal.rows as number, agents: agents as readonly RtcBaselineJson[] };
}

function toRecord(value: RtcBaselineJson | undefined): Readonly<Record<string, RtcBaselineJson>> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function journalIssue(): readonly RtcBaselineIssueDto[] {
    return [{
        path: '$.rawEvidence.journal',
        code: 'journal-unverified',
        message:
            'Recent retention requires complete owned disk journal evidence through all attributed cycle-100 Health markers.'
    }];
}

export function validateRtcB06JournalBoundaries(
    boundaries: readonly RtcB06BrowserRecordingReading[]
): readonly string[] {
    if (
        boundaries.length !== 3 || new Set(boundaries.map((boundary) => boundary.agentId)).size !== 3 ||
        new Set(boundaries.map((boundary) => boundary.initialHistory.runtimeId)).size !== 3 ||
        new Set(boundaries.map((boundary) => boundary.runId)).size !== 1
    ) {
        return ['journal-requires-three-attributed-runtimes'];
    }
    const terminalCommands = boundaries.map((boundary) =>
        /^rtc-diagnostics-([abc])-retention-100-(.+)$/.exec(boundary.healthCommandId)
    );
    if (
        terminalCommands.some((command) => command === null) ||
        new Set(terminalCommands.map((command) => command?.[1])).size !== 3 ||
        new Set(terminalCommands.map((command) => command?.[2])).size !== 1
    ) {
        return ['journal-terminal-health-not-cycle-100'];
    }
    return boundaries.every((boundary) => {
            const first = boundary.initialHistory;
            const last = boundary.currentHistory;
            return first.policy.mode === 'recent' && first.policy.maxEvents === 64 &&
                isRtcB06EventHistoryContinuous(first, last) &&
                first.capture.status === 'continuous' && first.capture.identity.runId === boundary.runId &&
                first.capture.identity.agentId === boundary.agentId;
        })
        ? []
        : ['journal-boundary-not-admitted'];
}
