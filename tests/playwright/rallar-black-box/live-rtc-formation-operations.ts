import { expect } from '@playwright/test';
import type {
    BlackBoxRallarFormationCommandInput,
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationSummary
} from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { GroupLifecycleState } from '../../../packages/shared/api/group-lifecycle/group-lifecycle-policy.ts';

import {
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentConfig,
    type LiveRtcBrowserContextFactory,
    type LiveRtcRestoredSession
} from './live-rtc-browser-agents.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord, type LiveRtcJsonRecord } from './live-rtc-evidence-json.ts';

/**
 * The browser-side formation surface as the acceptance spec drives it.
 *
 * Recorded diagnostics are read from the control run snapshot. That snapshot is a newest-first tail
 * bounded at two thousand events across every agent in the run, so a scenario that must count events
 * from early in a long run reads the run's artifact bundle instead; `readFormationDiagnostics` says
 * which source it used. The snapshot decoder drops the control envelope's own timestamp, so topic and
 * time are read from the runtime event inside `payload`.
 */
export interface LiveRtcFormationOperations {
    command(input: FormationCommandInput): Promise<BlackBoxRallarFormationSummary>;
    tryCommand(input: FormationCommandInput): Promise<LiveRtcControlClient.Result>;
    readiness(input: FormationAgentInput): Promise<FormationReadiness>;
    health(input: FormationAgentInput): Promise<FormationHealth>;
    waitForStage(input: FormationStageWaitInput): Promise<void>;
    countPeerCreated(input: FormationAgentInput): Promise<number>;
    readFormationDiagnostics(input: FormationDiagnosticsInput): Promise<readonly FormationDiagnosticEvent[]>;
    reopen(input: FormationReopenInput): Promise<LiveRtcControlClient.Agent>;
}

export interface FormationAgentInput {
    readonly timeoutMs?: number;
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
}

export interface FormationCommandInput extends FormationAgentInput {
    readonly input: BlackBoxRallarFormationCommandInput;
    readonly reason?: string;
}

export interface FormationStageWaitInput extends FormationAgentInput {
    readonly stage: GroupLifecycleState;
    readonly timeoutMs: number;
    /** Ignore stage changes recorded before this stamp; a wait answers with the newest match. */
    readonly sinceEpochMs: number;
}

export interface FormationReadiness {
    readonly readyAtEpochMs: number;
    readonly formation: BlackBoxRallarFormationSummary;
}

export interface FormationHealth {
    readonly formation: BlackBoxRallarFormationSummary;
    readonly rtcStatus: Readonly<{
        knownPeerIds: readonly string[];
        activePeerIds: readonly string[];
        readyPeerIds: readonly string[];
    }>;
}

export type FormationDiagnosticTopic =
    | 'rallar.browser.formation.changed'
    | 'rallar.browser.formation.layout'
    | 'rallar.browser.formation.room-status'
    | 'rallar.browser.formation.ready';

export interface FormationDiagnosticsInput extends FormationAgentInput {
    readonly topic: FormationDiagnosticTopic;
    readonly sinceEpochMs: number;
}

export interface FormationDiagnosticEvent {
    readonly topic: string;
    readonly atEpochMs: number;
    readonly data: LiveRtcJsonRecord;
}

export interface FormationReopenInput extends FormationAgentInput {
    readonly browser: LiveRtcBrowserContextFactory;
    readonly config: LiveRtcBrowserAgentConfig;
    readonly transport: string;
}

const PEER_CREATED_TOPIC = 'rallar.browser.rtc.lifecycle';
const READINESS_TIMEOUT_MS = 60_000;

export function createLiveRtcFormationOperations(): LiveRtcFormationOperations {
    return {
        async command(input) {
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: formationCommandId(input, input.input.command),
                command: {
                    kind: 'formation.command',
                    commandId: formationCommandId(input, input.input.command),
                    ...toWireRoom(input),
                    ...toWireCommandFields(input.input),
                    ...(input.reason === undefined ? {} : { reason: input.reason })
                }
            });
            return requireSummary(record(input.control.resultValue(result)).formation, 'formation.command');
        },

        async tryCommand(input) {
            return await input.control.executeResult({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: formationCommandId(input, input.input.command),
                command: {
                    kind: 'formation.command',
                    commandId: formationCommandId(input, input.input.command),
                    ...toWireRoom(input),
                    ...toWireCommandFields(input.input),
                    ...(input.reason === undefined ? {} : { reason: input.reason })
                }
            });
        },

        async readiness(input) {
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: formationCommandId(input, 'readiness'),
                command: {
                    kind: 'formation.readiness',
                    commandId: formationCommandId(input, 'readiness'),
                    ...toWireRoom(input),
                    // The in-browser wait and the poll that awaits it are the same budget; without
                    // this the command falls back to its own default and gives up first.
                    timeoutMs: input.timeoutMs ?? READINESS_TIMEOUT_MS
                },
                timeoutMs: (input.timeoutMs ?? READINESS_TIMEOUT_MS) + 30_000
            });
            const value = record(input.control.resultValue(result));
            return {
                readyAtEpochMs: requireNumber(value.readyAtEpochMs, 'formation.readiness.readyAtEpochMs'),
                formation: requireSummary(value.formation, 'formation.readiness')
            };
        },

        async health(input) {
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: formationCommandId(input, 'health'),
                command: { kind: 'health', commandId: formationCommandId(input, 'health') }
            });
            const value = record(input.control.resultValue(result));
            const rallar = record(value.rallar);
            const rtcStatus = record(rallar.rtcStatus);
            return {
                // The whole block travels in the failure: a page that connected to the wrong scope
                // and one that never connected are indistinguishable from the missing field alone.
                formation: requireSummary(
                    rallar.formation ?? value.formation,
                    `health ${JSON.stringify(value)}`
                ),
                rtcStatus: {
                    knownPeerIds: stringArray(rtcStatus.knownPeerIds),
                    activePeerIds: stringArray(rtcStatus.activePeerIds),
                    readyPeerIds: stringArray(rtcStatus.readyPeerIds)
                }
            };
        },

        async waitForStage(input) {
            await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId: formationCommandId(input, `stage-${input.stage}`),
                command: {
                    kind: 'wait',
                    commandId: formationCommandId(input, `stage-${input.stage}`),
                    timeoutMs: input.timeoutMs,
                    match: {
                        kind: 'diagnostic',
                        topic: 'rallar.browser.formation.changed',
                        payloadPath: 'data.stage',
                        equals: input.stage,
                        sinceEpochMs: input.sinceEpochMs
                    }
                },
                timeoutMs: input.timeoutMs + 15_000
            });
        },

        async countPeerCreated(input) {
            const events = await readAgentEvents(input);
            return events.filter((event) => event.topic === PEER_CREATED_TOPIC && event.data.kind === 'peer-created')
                .length;
        },

        async readFormationDiagnostics(input) {
            const events = await readAgentEvents(input);
            return events.filter((event) => event.topic === input.topic && event.atEpochMs >= input.sinceEpochMs);
        },

        async reopen(input) {
            const session = await readRestoredSession(input.agent);
            await input.agent.context.close();
            const reopened = await openLiveRtcBrowserAgent(input.browser, {
                config: input.config,
                prefix: input.agent.prefix,
                auth: { kind: 'restore', session },
                runId: input.runId,
                agentId: input.agent.agentId,
                actor: input.agent.actor,
                connection: input.agent.connection,
                groupId: input.groupId
            });
            // The accepted layout names sessions as its peers, so a reopen that mints a new session
            // moves the returning member's identity out of the layout and every pin downstream reads
            // a member the group has never heard of.
            const restored = await readRestoredSession(reopened);
            expect(
                restored.sessionId,
                `Agent ${input.agent.prefix} reopened with a new session instead of the restored one`
            ).toBe(session.sessionId);
            return reopened;
        }
    };
}

/** The room every formation command addresses, named exactly so the protocol's rule is satisfied. */
function toWireRoom(input: FormationAgentInput): LiveRtcJsonRecord {
    return {
        roomId: input.groupId,
        applicationId: 'rallar-server',
        workspaceId: 'default'
    };
}

/** The wire command is flat: `command`, `layout` and `landing` sit on it, and the bridge lifts them. */
function toWireCommandFields(input: BlackBoxRallarFormationCommandInput): LiveRtcJsonRecord {
    if (input.command === 'connect') {
        return input.layout === undefined
            ? { command: input.command }
            : { command: input.command, layout: input.layout };
    }
    if (input.command === 'reconfigure') {
        return input.landing === undefined
            ? { command: input.command }
            : { command: input.command, landing: input.landing };
    }
    return { command: input.command };
}

function formationCommandId(input: FormationAgentInput, name: string): string {
    return `formation-${name}-${input.agent.prefix}-${input.suffix}`;
}

async function readAgentEvents(input: FormationAgentInput): Promise<readonly FormationDiagnosticEvent[]> {
    const snapshot = await input.control.fetchRun(input.runId);
    return snapshot.events
        .filter((event) => event.agentId === input.agent.agentId)
        .flatMap((event) => {
            const payload = record(event.payload);
            const topic = payload.topic;
            const atEpochMs = payload.atEpochMs;
            if (typeof topic !== 'string' || typeof atEpochMs !== 'number') {
                return [];
            }
            return [{ topic, atEpochMs, data: record(record(payload.payload).data) }];
        });
}

/** The session the page holds, read before it closes so the reopen restores it rather than re-logging in. */
async function readRestoredSession(agent: LiveRtcControlClient.Agent): Promise<LiveRtcRestoredSession> {
    const stored = await agent.page.evaluate(() => window.localStorage.getItem('auth.session'));
    expect(stored, `Agent ${agent.prefix} holds no auth.session to restore`).not.toBeNull();
    const session = record(JSON.parse(String(stored)));
    return {
        clientId: requireString(session.clientId, 'auth.session.clientId'),
        accessToken: requireString(session.accessToken, 'auth.session.accessToken'),
        username: requireString(session.username, 'auth.session.username'),
        sessionId: requireString(session.sessionId, 'auth.session.sessionId'),
        expiresAtEpochMs: requireNumber(session.expiresAtEpochMs, 'auth.session.expiresAtEpochMs')
    };
}

/** The harness's own narrowing helper; an absent or non-record value reads as an empty record. */
function record(value: RtcBaselineJson | undefined): LiveRtcJsonRecord {
    return jsonRecord(value) ?? {};
}

function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The block is required, not optional: two scenarios assert that fields inside it are absent, so a
 * decoder that tolerated a missing block would let them pass while proving nothing.
 */
function requireSummary(value: unknown, source: string): BlackBoxRallarFormationSummary {
    const summary = record(value);
    expect(
        typeof summary.stage === 'string',
        `${source} carried no formation summary: ${JSON.stringify(value)}`
    ).toBe(true);
    return summary as unknown as BlackBoxRallarFormationSummary;
}

function requireString(value: unknown, path: string): string {
    expect(typeof value, `${path} must be a string`).toBe('string');
    return String(value);
}

function requireNumber(value: unknown, path: string): number {
    expect(typeof value, `${path} must be a number`).toBe('number');
    return Number(value);
}

export type { BlackBoxRallarFormationRoomStatus, BlackBoxRallarFormationSummary };
