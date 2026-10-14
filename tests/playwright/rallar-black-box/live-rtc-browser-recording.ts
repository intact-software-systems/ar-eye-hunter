import {
    isSameEventHistoryPolicy,
    type RallarBlackBoxEventHistory,
    type RallarBlackBoxEventHistoryPolicy
} from '@shared-test/rallar-bb-test/runtime/event-history.ts';

import {
    toBrowserDiagnosticsReceipt,
    validateBrowserDiagnosticsLifetime,
    type BrowserDiagnosticsReceipt,
    type RallarBlackBoxRoutineBrowserDiagnostics
} from '@shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';

import {
    isRtcB06EventHistoryContinuous,
    toRtcB06EventHistory,
    toRtcB06EventHistoryEvidence,
    type RtcB06EventHistoryEvidenceDto
} from '../../../packages/shared-rtc-bench/baseline/acceptance/to-rtc-b06-event-history.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord } from './live-rtc-evidence-json.ts';

export namespace LiveRtcBrowserRecording {
    export interface Agent {
        readonly agentId: string;
        readonly page: object;
        readonly eventHistory?: RallarBlackBoxEventHistoryPolicy;
    }
    export interface Admission {
        readonly runId: string;
        readonly agentId: string;
        readonly commandId: string;
        readonly receipt: BrowserDiagnosticsReceipt;
        readonly eventHistory: RallarBlackBoxEventHistory;
    }
    export interface AdmitInput {
        readonly runId: string;
        readonly agents: readonly Agent[];
        readonly mode: RallarBlackBoxRoutineBrowserDiagnostics;
    }
    export interface AdmissionEvidence extends Omit<Admission, 'eventHistory'> {
        readonly eventHistory: RtcB06EventHistoryEvidenceDto;
    }
    export interface Evidence {
        readonly eventHistory: RtcB06EventHistoryEvidenceDto;
        readonly browserDiagnosticsAdmission: AdmissionEvidence;
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
        readonly eventHistory: RallarBlackBoxEventHistory;
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
            const health = jsonRecord(result.result?.value);
            const receipt = toBrowserDiagnosticsReceipt(health?.browserDiagnostics);
            if (
                !result.ok || result.agentId !== agent.agentId || result.commandId !== commandId ||
                receipt === undefined || receipt.routineBrowserDiagnostics !== input.mode ||
                this.#lifetimes.has(agent.agentId)
            ) {
                throw new Error('Browser recording admission requires attributed actual Health in the selected mode.');
            }
            const eventHistory = toRtcB06EventHistory(jsonRecord(health?.stats)?.eventHistory);
            if (
                eventHistory === undefined ||
                !isSameEventHistoryPolicy(agent.eventHistory ?? { mode: 'full' }, eventHistory.policy) ||
                eventHistory.capture.status !== 'continuous' ||
                eventHistory.capture.identity.runId !== input.runId ||
                eventHistory.capture.identity.agentId !== agent.agentId ||
                admitted.some((lifetime) => lifetime.eventHistory.runtimeId === eventHistory.runtimeId)
            ) {
                throw new Error(
                    'Browser recording admission requires the selected history on distinct attributed runtimes.'
                );
            }
            admitted.push({
                page: agent.page,
                admission: {
                    runId: input.runId,
                    agentId: result.agentId,
                    commandId: result.commandId,
                    receipt,
                    eventHistory
                },
                current: receipt,
                eventHistory
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
        const health = jsonRecord(result.result?.value);
        const receipt = toBrowserDiagnosticsReceipt(health?.browserDiagnostics);
        if (
            !result.ok || runId !== lifetime.admission.runId || receipt === undefined ||
            validateBrowserDiagnosticsLifetime(lifetime.current, receipt).length > 0
        ) {
            throw new Error('Browser recording Health does not preserve the admitted adapter lifetime.');
        }
        const eventHistory = toRtcB06EventHistory(jsonRecord(health?.stats)?.eventHistory);
        if (
            eventHistory === undefined ||
            !isRtcB06EventHistoryContinuous(lifetime.eventHistory, eventHistory)
        ) {
            throw new Error(
                'Browser recording Health does not preserve admitted event history publication continuity.'
            );
        }
        this.#lifetimes.set(lifetime.admission.agentId, { ...lifetime, current: receipt, eventHistory });
        return {
            eventHistory: toRtcB06EventHistoryEvidence(eventHistory),
            browserDiagnosticsAdmission: {
                ...lifetime.admission,
                eventHistory: toRtcB06EventHistoryEvidence(lifetime.admission.eventHistory)
            },
            browserDiagnosticsHealth: { runId, agentId: lifetime.admission.agentId, commandId: result.commandId }
        };
    }
}
