import {
    toBrowserDiagnosticsReceipt,
    validateBrowserDiagnosticsLifetime,
    type BrowserDiagnosticsReceipt,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '../../../shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';

import type {
    RtcBaselineIssueDto,
    RtcBaselineJson,
    RtcBaselineSampleDto
} from '../contracts/rtc-baseline-contracts.ts';

interface BrowserRecordingReading {
    readonly agentId: string;
    readonly runId: string;
    readonly admissionCommandId: string;
    readonly healthCommandId: string;
    readonly initial: BrowserDiagnosticsReceipt;
    readonly current: BrowserDiagnosticsReceipt;
}

export function validateRtcB06BrowserRecording(
    sample: RtcBaselineSampleDto,
    mode: RallarBlackBoxRoutineBrowserDiagnostics,
    captures: readonly RtcBaselineJson[]
): readonly RtcBaselineIssueDto[] {
    const raw = toRecord(sample.rawEvidence);
    const expected = new Map<string, string>();
    for (const capture of captures) {
        const value = toRecord(capture);
        if (
            typeof value?.agentId !== 'string' || typeof value.runId !== 'string' ||
            (expected.has(value.agentId) && expected.get(value.agentId) !== value.runId)
        ) {
            return recordingIssue();
        }
        expected.set(value.agentId, value.runId);
    }
    const diagnostics = raw?.diagnostics;
    if (!Array.isArray(diagnostics) || !hasVerifiedCheckpointReadings(diagnostics, expected, mode)) {
        return recordingIssue();
    }
    if (sample.identity.caseId === 'retention-100') {
        const checkpoints = toRecord(raw?.retention)?.checkpoints;
        if (
            expected.size !== 3 || !Array.isArray(checkpoints) || checkpoints.length !== 11 ||
            checkpoints.some((checkpoint, index) => toRecord(checkpoint)?.cycle !== index * 10) ||
            !hasVerifiedCheckpointReadings(checkpoints, expected, mode) ||
            !hasMatchingCheckpointEvidence(diagnostics, checkpoints)
        ) {
            return recordingIssue();
        }
    }
    return [];
}

function hasMatchingCheckpointEvidence(
    diagnostics: readonly RtcBaselineJson[],
    checkpoints: readonly RtcBaselineJson[]
): boolean {
    return checkpoints.every((checkpoint) => {
        const retained = toRecord(checkpoint);
        const matches = diagnostics.filter((value) => toRecord(value)?.cycle === retained?.cycle);
        const currentAgents = toRecord(matches[0])?.agents;
        const retainedAgents = retained?.agents;
        if (matches.length !== 1 || !Array.isArray(currentAgents) || !Array.isArray(retainedAgents)) {
            return false;
        }
        const current = currentAgents.map(toBrowserRecordingReading).sort((left, right) =>
            (left?.agentId ?? '').localeCompare(right?.agentId ?? '')
        );
        const stored = retainedAgents.map(toBrowserRecordingReading).sort((left, right) =>
            (left?.agentId ?? '').localeCompare(right?.agentId ?? '')
        );
        return JSON.stringify(current) === JSON.stringify(stored);
    });
}

function hasVerifiedCheckpointReadings(
    checkpoints: readonly RtcBaselineJson[],
    expected: ReadonlyMap<string, string>,
    mode: RallarBlackBoxRoutineBrowserDiagnostics
): boolean {
    const previous = new Map<string, BrowserRecordingReading>();
    const commandIds = new Set<string>();
    const admissionCommandIds = new Set<string>();
    for (const checkpoint of checkpoints) {
        const agents = toRecord(checkpoint)?.agents;
        if (!Array.isArray(agents) || agents.length !== 3) {
            return false;
        }
        const readings = agents.map(toBrowserRecordingReading);
        if (
            readings.some((reading) => reading === undefined) ||
            new Set(readings.map((reading) => reading?.agentId)).size !== 3
        ) {
            return false;
        }
        for (const reading of readings) {
            if (
                reading === undefined || expected.get(reading.agentId) !== reading.runId ||
                reading.initial.routineBrowserDiagnostics !== mode ||
                reading.current.routineBrowserDiagnostics !== mode ||
                validateBrowserDiagnosticsLifetime(reading.initial, reading.current).length > 0 ||
                commandIds.has(reading.healthCommandId) || admissionCommandIds.has(reading.healthCommandId)
            ) {
                return false;
            }
            const prior = previous.get(reading.agentId);
            if (
                prior === undefined &&
                (admissionCommandIds.has(reading.admissionCommandId) || commandIds.has(reading.admissionCommandId))
            ) {
                return false;
            }
            if (
                prior !== undefined && (prior.admissionCommandId !== reading.admissionCommandId ||
                    JSON.stringify(prior.initial) !== JSON.stringify(reading.initial) ||
                    validateBrowserDiagnosticsLifetime(prior.current, reading.current).length > 0)
            ) {
                return false;
            }
            previous.set(reading.agentId, reading);
            commandIds.add(reading.healthCommandId);
            admissionCommandIds.add(reading.admissionCommandId);
        }
    }
    return previous.size === expected.size &&
        [...previous.values()].every((reading) =>
            mode === 'enabled' ||
            reading.current.omittedRoutineBrowserDiagnostics > reading.initial.omittedRoutineBrowserDiagnostics
        );
}

function toBrowserRecordingReading(agent: RtcBaselineJson): BrowserRecordingReading | undefined {
    const record = toRecord(agent);
    const details = toRecord(record?.details);
    const admission = toRecord(details?.browserDiagnosticsAdmission);
    const health = toRecord(details?.browserDiagnosticsHealth);
    const initial = toBrowserDiagnosticsReceipt(admission?.receipt);
    const current = toBrowserDiagnosticsReceipt(details?.browserDiagnostics);
    if (
        typeof record?.agentId !== 'string' || record.agentId.length === 0 || admission?.agentId !== record.agentId ||
        health?.agentId !== record.agentId || typeof admission?.runId !== 'string' || admission.runId.length === 0 ||
        health?.runId !== admission.runId || typeof admission.commandId !== 'string' ||
        admission.commandId.length === 0 ||
        typeof health.commandId !== 'string' || health.commandId.length === 0 ||
        health.commandId === admission.commandId ||
        initial === undefined || current === undefined
    ) {
        return undefined;
    }
    return {
        agentId: record.agentId,
        runId: admission.runId,
        admissionCommandId: admission.commandId,
        healthCommandId: health.commandId,
        initial,
        current
    };
}

function toRecord(value: RtcBaselineJson | undefined): { readonly [key: string]: RtcBaselineJson; } | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function recordingIssue(): readonly RtcBaselineIssueDto[] {
    return [{
        path: '$.rawEvidence.diagnostics',
        code: 'browser-recording-unverified',
        message:
            'Actual attributed Health must prove the initialized recording mode and the same adapter lifetime at every required checkpoint.'
    }];
}
