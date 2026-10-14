import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LiveRtcJsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';

const RUN_ID = 'artifact-history-run';
const COMMAND_IDS = ['initial-group-create', 'required-connect', 'final-reset'];

function createResultReceipt(commandId: string): LiveRtcJsonRecord {
    return {
        resultKey: `agent-a:${commandId}`,
        name: commandId,
        status: 'SUCCESS',
        transport: 'control',
        action: 'health',
        connection: 'agent-a',
        agentId: 'agent-a',
        commandId,
        replayed: false,
        ok: true,
        actual: { status: 'ok' }
    };
}

function createBrowserEvent(): LiveRtcJsonRecord {
    return {
        kind: 'rtc-diagnostic',
        name: 'browser-event',
        status: 'event',
        transport: 'control',
        action: 'health',
        agentId: 'agent-a',
        connection: 'agent-a',
        atEpochMs: 100,
        value: { topic: 'rallar.browser.rtc.status', payload: { kind: 'status' } }
    };
}

function toJsonl(rows: readonly LiveRtcJsonRecord[]): string {
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function setCompleteEvidence(fixture: LiveRtcControlHttpFixture): void {
    const filler = Array.from({ length: 201 }, (_, index) => createResultReceipt(`later-${index}`));
    const receipts = [createResultReceipt('initial-group-create'), createResultReceipt('required-connect'), ...filler, createResultReceipt('final-reset')];
    const preview = receipts.slice(-200);
    fixture.state.artifactRunId = RUN_ID;
    fixture.state.artifactBundle = {
        runId: RUN_ID,
        files: {
            'report.json': JSON.stringify({
                schemaVersion: 1,
                artifactSchemaVersion: 1,
                summary: { total: 200, success: 200, failure: 0, commandCount: 200, eventCount: 200, agentCount: 1, reportCount: 0 },
                results: Object.fromEntries(preview.map((row) => [String(row.resultKey), row])),
                resultsList: preview,
                outputs: { runId: RUN_ID },
                metrics: { heartbeats: 0, stats: 0 }
            }),
            'events.jsonl': toJsonl([{ kind: 'step-result', name: 'final-reset', status: 'SUCCESS', commandId: 'final-reset', agentId: 'agent-a' }])
        }
    };
    fixture.state.resultsJsonl = toJsonl(receipts);
    fixture.state.recorderJsonl = toJsonl([createBrowserEvent()]);
}

describe('live RTC durable artifact evidence', () => {
    let fixture: LiveRtcControlHttpFixture;
    beforeEach(async () => {
        fixture = await createDefaultLiveRtcControlHttpFixture();
        setCompleteEvidence(fixture);
    });
    afterEach(async () => {
        try {
            await fixture.expectControlResponsesReleased();
        }
        finally {
            await fixture.close();
        }
    });

    it.each([
        { variant: 'status', status: 503, body: '{"error":"artifact-unavailable"}', error: /toBe/ },
        { variant: 'JSON parse', status: 200, body: '{malformed}', error: /JSON|Unexpected token/ },
        { variant: 'bundle decode', status: 200, body: '[]', error: /artifactBundle/ }
    ])('releases the artifact response after its $variant failure without changing the error', async ({ status, body, error }) => {
        fixture.state.responseOverrides.set(`GET /runs/${RUN_ID}/artifacts`, { status, body });
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(error);
    });

    it('accepts initial and final executed receipts beyond the bounded 200-result preview', async () => {
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).resolves.toBeUndefined();
    });

    it.each(COMMAND_IDS)('fails when durable evidence omits the executed %s receipt', async (missing) => {
        fixture.state.resultsJsonl = toJsonl(COMMAND_IDS.filter((id) => id !== missing).map(createResultReceipt));
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/missing.*command|command.*missing/i);
    });

    it.each(['substring', 'nested', 'event-kind', 'wrong-name', 'wrong-key', 'wrong-status', 'missing-ok'])(
        'refuses %s lookalike receipt evidence',
        async (variant) => {
            const initial = createResultReceipt('initial-group-create');
            if (variant === 'substring') {
                initial.commandId = 'initial-group-create-lookalike';
            }
            if (variant === 'nested') {
                initial.commandId = 'unrelated';
                initial.actual = { commandId: 'initial-group-create' };
            }
            if (variant === 'event-kind') {
                initial.kind = 'step-result';
            }
            if (variant === 'wrong-name') {
                initial.name = 'unrelated';
            }
            if (variant === 'wrong-key') {
                initial.resultKey = 'foreign:initial-group-create';
            }
            if (variant === 'wrong-status') {
                initial.status = 'FAILURE';
            }
            if (variant === 'missing-ok') {
                delete initial.ok;
            }
            fixture.state.resultsJsonl = toJsonl([initial, ...COMMAND_IDS.slice(1).map(createResultReceipt)]);
            await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow();
        }
    );

    it('accepts a recorded prescribed failure without reclassifying the workload outcome', async () => {
        const failed = createResultReceipt('required-connect');
        failed.ok = false;
        failed.status = 'FAILURE';
        failed.actual = { code: 'PRESCRIBED_NEGATIVE_CONTROL' };
        fixture.state.resultsJsonl = toJsonl([createResultReceipt('initial-group-create'), failed, createResultReceipt('final-reset')]);
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).resolves.toBeUndefined();
    });

    it.each(['absent', 'substring', 'nested', 'step-result', 'wrong-status', 'missing-agent'])(
        'refuses %s browser-event presence evidence',
        async (variant) => {
            const event = createBrowserEvent();
            if (variant === 'substring') {
                event.value = { topic: 'foreign.rallar.browser.rtc.status' };
            }
            if (variant === 'nested') {
                event.value = { topic: 'foreign', payload: { topic: 'rallar.browser.rtc.status' } };
            }
            if (variant === 'step-result') {
                event.kind = 'step-result';
                event.actual = event.value;
            }
            if (variant === 'wrong-status') {
                event.status = 'SUCCESS';
            }
            if (variant === 'missing-agent') {
                delete event.agentId;
            }
            fixture.state.recorderJsonl = variant === 'absent' ? toJsonl([{ kind: 'step-result', actual: 'rallar.browser.rtc.status' }]) : toJsonl([event]);
            await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/browser.*event|event.*browser/i);
        }
    );

    it.each(['results', 'events'])('fails unavailable durable %s', async (stream) => {
        if (stream === 'results') {
            fixture.state.resultsStatus = 404;
        }
        else {
            fixture.state.recorderStatus = 503;
        }
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/unavailable/i);
    });

    it.each(['results', 'events'])('fails malformed durable %s before required proof', async (stream) => {
        if (stream === 'results') {
            fixture.state.resultsJsonl = '{malformed}\n' + fixture.state.resultsJsonl;
        }
        else {
            fixture.state.recorderJsonl = '{malformed}\n' + fixture.state.recorderJsonl;
        }
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/malformed/i);
    });

    it.each(['results', 'events'])('fails empty durable %s', async (stream) => {
        if (stream === 'results') {
            fixture.state.resultsJsonl = '';
        }
        else {
            fixture.state.recorderJsonl = '';
        }
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow();
    });

    it.each(['empty-commands', 'empty-id', 'foreign-bundle', 'foreign-report', 'malformed-report', 'missing-preview-events'])(
        'fails %s despite complete durable proof',
        async (variant) => {
            const bundle = fixture.state.artifactBundle!;
            const files = bundle.files as LiveRtcJsonRecord;
            let commandIds = COMMAND_IDS;
            if (variant === 'empty-commands') {
                commandIds = [];
            }
            if (variant === 'empty-id') {
                commandIds = [''];
            }
            if (variant === 'foreign-bundle') {
                bundle.runId = 'foreign-run';
            }
            if (variant === 'foreign-report') {
                const report = JSON.parse(String(files['report.json']));
                report.outputs.runId = 'foreign-run';
                files['report.json'] = JSON.stringify(report);
            }
            if (variant === 'malformed-report') {
                files['report.json'] = '{malformed}';
            }
            if (variant === 'missing-preview-events') {
                delete files['events.jsonl'];
            }
            await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds })).rejects.toThrow();
        }
    );

    it.each(['results', 'events'])('fails truncated %s before proof within the existing 8 MiB retained-input budget', async (stream) => {
        const prefix = ' '.repeat(8_388_609);
        if (stream === 'results') {
            fixture.state.resultsJsonl = prefix + '\n' + fixture.state.resultsJsonl;
        }
        else {
            fixture.state.recorderJsonl = prefix + '\n' + fixture.state.recorderJsonl;
        }
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/limit|truncat|incomplete/i);
    });

    it.each(['newline', 'final-row'])('rejects browser proof beyond the scan limit with %s framing', async (framing) => {
        const prefix = '{"kind":"step-result","name":"unrelated"}\n'.repeat(20_000);
        fixture.state.recorderJsonl = prefix + JSON.stringify(createBrowserEvent()) + (framing === 'newline' ? '\n' : '');
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).rejects.toThrow(/limit/i);
    });

    it('closes an unfinished event stream immediately after structured browser-event proof', async () => {
        fixture.state.recorderOpenEnded = true;
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).resolves.toBeUndefined();
        await expect.poll(() => fixture.state.recorderClosed).toBe(true);
    });

    it('preserves Unicode content and accepts a complete final result row without a newline', async () => {
        const initial = createResultReceipt('initial-group-create');
        initial.actual = { name: 'blåbær' };
        fixture.state.resultsJsonl = toJsonl([initial, createResultReceipt('required-connect'), createResultReceipt('final-reset')]).trimEnd();
        await expect(fixture.control.expectArtifactBundle({ runId: RUN_ID, commandIds: COMMAND_IDS })).resolves.toBeUndefined();
    });
});
