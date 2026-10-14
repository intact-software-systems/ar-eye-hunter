import {
    toBrowserDiagnosticsReceipt,
    validateBrowserDiagnosticsLifetime,
    type BrowserDiagnosticsReceipt,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '@shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord } from './live-rtc-evidence-json.ts';

export namespace LiveRtcBrowserRecording {
    export interface Agent {
        readonly agentId: string;
        readonly page: object;
    }
    export interface Admission {
        readonly runId: string;
        readonly agentId: string;
        readonly commandId: string;
        readonly receipt: BrowserDiagnosticsReceipt;
    }
    export interface AdmitInput {
        readonly runId: string;
        readonly agents: readonly Agent[];
        readonly mode: RallarBlackBoxRoutineBrowserDiagnostics;
    }
    export interface Evidence {
        readonly browserDiagnosticsAdmission: Admission;
        readonly browserDiagnosticsHealth: {
            readonly runId: string;
            readonly agentId: string;
            readonly commandId: string;
        };
    }
    export interface Lifetime {
        readonly page: object;
        readonly admission: Admission;
        readonly current: BrowserDiagnosticsReceipt;
    }
}

export class LiveRtcBrowserRecording {
    readonly #control: Pick<LiveRtcControlClient, 'executeOk'>;
    readonly #lifetimes = new Map<string, LiveRtcBrowserRecording.Lifetime>();

    constructor(control: Pick<LiveRtcControlClient, 'executeOk'>) {
        this.#control = control;
    }

    async admit(input: LiveRtcBrowserRecording.AdmitInput): Promise<readonly string[]> {
        if (
            input.agents.length !== 3 || new Set(input.agents.map((agent) => agent.agentId)).size !== 3 ||
            new Set(input.agents.map((agent) => agent.page)).size !== 3
        ) {
            throw new Error('Browser recording admission requires three distinct actual agents and pages.');
        }
        const admitted: LiveRtcBrowserRecording.Lifetime[] = [];
        for (const agent of input.agents) {
            const commandId = `browser-recording-admission-${agent.agentId}`;
            const result = await this.#control.executeOk({
                runId: input.runId,
                agentId: agent.agentId,
                commandId,
                command: { kind: 'health' }
            });
            const receipt = toBrowserDiagnosticsReceipt(jsonRecord(result.result?.value)?.browserDiagnostics);
            if (
                !result.ok || result.agentId !== agent.agentId || result.commandId !== commandId ||
                receipt === undefined || receipt.routineBrowserDiagnostics !== input.mode ||
                this.#lifetimes.has(agent.agentId)
            ) {
                throw new Error('Browser recording admission requires attributed actual Health in the selected mode.');
            }
            admitted.push({
                page: agent.page,
                admission: { runId: input.runId, agentId: result.agentId, commandId: result.commandId, receipt },
                current: receipt
            });
        }
        for (const lifetime of admitted) {
            this.#lifetimes.set(lifetime.admission.agentId, lifetime);
        }
        return admitted.map((lifetime) => lifetime.admission.commandId);
    }

    assertAgent(agent: { readonly agentId: string; readonly page?: object; }): void {
        const lifetime = this.#lifetimes.get(agent.agentId);
        if (lifetime !== undefined && lifetime.page !== agent.page) {
            throw new Error('Browser recording requires fresh admission for this actual page.');
        }
    }

    observe(runId: string, result: LiveRtcControlClient.Result): LiveRtcBrowserRecording.Evidence | undefined {
        const lifetime = result.agentId === undefined ? undefined : this.#lifetimes.get(result.agentId);
        if (lifetime === undefined) {
            return undefined;
        }
        const receipt = toBrowserDiagnosticsReceipt(jsonRecord(result.result?.value)?.browserDiagnostics);
        if (
            !result.ok || runId !== lifetime.admission.runId || receipt === undefined ||
            validateBrowserDiagnosticsLifetime(lifetime.current, receipt).length > 0
        ) {
            throw new Error('Browser recording Health does not preserve the admitted adapter lifetime.');
        }
        this.#lifetimes.set(lifetime.admission.agentId, { ...lifetime, current: receipt });
        return {
            browserDiagnosticsAdmission: lifetime.admission,
            browserDiagnosticsHealth: { runId, agentId: lifetime.admission.agentId, commandId: result.commandId }
        };
    }
}
