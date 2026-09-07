import { describe, expect, it } from 'vitest';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarRemoteBrowserRtcProvider,
    type RallarRemoteBrowserControlResultEnvelope
} from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

class CleanupControlServer {
    readonly results: RallarRemoteBrowserControlResultEnvelope[] = [];
    readonly closeOutcomes: readonly boolean[];
    isOpen = false;
    closeIndex = 0;

    constructor(closeOutcomes: readonly boolean[]) {
        this.closeOutcomes = closeOutcomes;
    }

    async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (init?.method !== 'POST') {
            return Response.json({ runId: 'cleanup-run', results: this.results, events: [] });
        }
        const submitted = JSON.parse(String(init.body));
        const { kind, commandId } = submitted.command;
        if (typeof kind !== 'string' || typeof commandId !== 'string') {
            return Response.json({ error: 'Invalid command' }, { status: 400 });
        }
        const ok = kind !== 'close' || this.closeOutcomes[this.closeIndex++] === true;
        if (kind === 'rtc.connect' || (kind === 'close' && ok)) {
            this.isOpen = kind === 'rtc.connect';
        }
        this.results.push({
            kind: 'result',
            runId: 'cleanup-run',
            agentId: 'agent',
            commandId,
            ok,
            ...(ok ? {} : { error: { code: 'close-rejected', message: 'Browser refused close' } })
        });
        return Response.json({ accepted: true }, { status: 202 });
    }
}

function rtcStep(action: string, number: number) {
    return {
        RTC: {
            request: { action, connection: 'alice', provider: 'remote-test', interactionExecutionNumber: number },
            response: {}
        },
        [action]: {}
    };
}

async function runCleanupScenario(control: CleanupControlServer, explicitClose: boolean) {
    const provider = createRallarRemoteBrowserRtcProvider({
        runId: 'cleanup-run',
        agentId: 'agent',
        fetch: control.fetch.bind(control),
        pollIntervalMs: 1,
        timeoutMs: 100
    });
    return executeBlackBox(
        explicitClose ? [rtcStep('connect', 1), rtcStep('close', 2)] : [rtcStep('connect', 1)],
        0,
        { rtcProviders: { 'remote-test': provider } }
    );
}

describe('remote-browser cleanup', () => {
    it('reports a refused automatic close as a cleanup failure', async () => {
        const control = new CleanupControlServer([false]);

        const report = await runCleanupScenario(control, false);

        expect(control.isOpen).toBe(true);
        expect(report.rtcCloseEvents.alice.at(-1)).toMatchObject({
            autoCloseRequested: true,
            autoCloseSucceeded: false,
            autoCloseFailed: true,
            exception: 'Browser refused close'
        });
    });

    it('retains cleanup ownership after a refused explicit close', async () => {
        const control = new CleanupControlServer([false, true]);

        const report = await runCleanupScenario(control, true);

        expect(report.resultsByName.close[0].status).toBe('FAILURE');
        expect(control.isOpen).toBe(false);
        expect(report.rtcCloseEvents.alice.at(-1)).toMatchObject({
            autoCloseRequested: true,
            autoCloseSucceeded: true
        });
    });
});
