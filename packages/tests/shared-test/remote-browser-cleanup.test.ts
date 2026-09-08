import {
    describe,
    expect,
    it
} from 'vitest';
import type { ControlResultEnvelope } from '../../shared-test/rallar-bb-test/control-protocol.ts';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarRemoteBrowserRtcProvider
} from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

class CleanupControlServer {
    readonly results: ControlResultEnvelope[] = [];
    readonly closeOutcomes: readonly (boolean | 'throw')[];
    readonly closeStarted = Promise.withResolvers<void>();
    readonly closeGate: Promise<void> | undefined;
    isOpen = false;
    closeIndex = 0;

    constructor(closeOutcomes: readonly (boolean | 'throw')[], closeGate?: Promise<void>) {
        this.closeOutcomes = closeOutcomes;
        this.closeGate = closeGate;
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
        const closing = kind === 'close' || kind === 'ws.close';
        const outcome = closing ? this.closeOutcomes[this.closeIndex++] : true;
        if (closing) {
            this.closeStarted.resolve();
            await this.closeGate;
        }
        if (outcome === 'throw') {
            throw new Error('Control connection lost');
        }
        const ok = outcome === true;
        if (kind === 'rtc.connect' || kind === 'ws.open' || (closing && ok)) {
            this.isOpen = !closing;
        }
        this.results.push({
            kind: 'result',
            protocolVersion: 1,
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

function wsStep(action: string, number: number) {
    return {
        WS: {
            request: {
                action,
                connection: 'socket',
                provider: 'rallar-remote-browser',
                url: 'ws://browser.invalid/socket',
                interactionExecutionNumber: number
            },
            response: {}
        },
        [action]: {}
    };
}

function runWsCleanupScenario(control: CleanupControlServer, explicitClose: boolean) {
    return executeBlackBox(
        explicitClose ? [wsStep('open', 1), wsStep('close', 2)] : [wsStep('open', 1)],
        0,
        {
            rallarRemoteBrowser: {
                runId: 'cleanup-run',
                agentId: 'agent',
                fetch: control.fetch.bind(control),
                pollIntervalMs: 1,
                timeoutMs: 100
            }
        }
    );
}

describe('remote WebSocket cleanup', () => {
    it.each([false, 'throw'] as const)('retains ownership after explicit close %j so automatic cleanup can close it', async (failure) => {
        const control = new CleanupControlServer([failure, true]);
        const report = await runWsCleanupScenario(control, true);
        expect(report.resultsByName.close[0].status).toBe('FAILURE');
        expect(control.closeIndex).toBe(2);
        expect(control.isOpen).toBe(false);
        expect(report.wsCloseEvents.socket.at(-1)).toMatchObject({
            autoCloseRequested: true,
            autoCloseSucceeded: true
        });
    });

    it.each([false, 'throw'] as const)('surfaces automatic close %j in cleanup diagnostics', async (failure) => {
        const control = new CleanupControlServer([failure]);
        const report = await runWsCleanupScenario(control, false);
        expect(control.isOpen).toBe(true);
        expect(report.wsCloseEvents.socket.at(-1)).toMatchObject({
            autoCloseRequested: true,
            autoCloseSucceeded: false,
            autoCloseFailed: true,
            exception: failure === false ? 'Browser refused close' : 'Control connection lost'
        });
    });

    it('waits for automatic close before returning the run report', async () => {
        const gate = Promise.withResolvers<void>();
        const control = new CleanupControlServer([true], gate.promise);
        let settled = false;
        const running = runWsCleanupScenario(control, false).finally(() => {
            settled = true;
        });
        try {
            await control.closeStarted.promise;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(settled).toBe(false);
        }
        finally {
            gate.resolve();
            await running;
        }
        expect(control.isOpen).toBe(false);
        expect((await running).wsCloseEvents.socket.at(-1)).toMatchObject({ autoCloseSucceeded: true });
    });
});
