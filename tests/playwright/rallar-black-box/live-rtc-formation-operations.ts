import { expect } from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type {
    BlackBoxRallarFormationCommandInput,
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationSummary
} from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { RallarBlackBoxTestFormationCommandCommand } from '../../../packages/shared-test/rallar-bb-test/types.ts';
import type { GroupLifecycleState } from '../../../packages/shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '../../../packages/shared/api/group-types.ts';

import {
    openLiveRtcBrowserAgent,
    type LiveRtcBrowserAgentConfig,
    type LiveRtcBrowserContextFactory,
    type LiveRtcRestoredSession
} from './live-rtc-browser-agents.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';

/**
 * The browser-side formation surface as the acceptance spec drives it.
 *
 * Recorded diagnostics are read from the control run snapshot, and only from it. That snapshot is a
 * newest-first tail bounded at two thousand events across every agent in the run, so a scenario whose
 * evidence sits early in a long run can have it evicted before the read; nothing here falls back to
 * the run's artifact bundle. The snapshot decoder drops the control envelope's own timestamp, so
 * topic and time are read from the runtime event inside `payload`.
 */
export interface LiveRtcFormationOperations {
    /**
     * A control command id no earlier command in this process has used.
     *
     * The control server treats a repeated commandId carrying the same payload as already done: it
     * returns the first execution's envelope without queueing anything, skips dispatch because the
     * command is complete, and answers the caller from its commandId-keyed result map. A reused id
     * therefore reports the earlier execution's outcome while the agent is sent nothing at all, so
     * every issued command mints its own id — including each attempt of a retry or poll, and every
     * command sent to a page that was reopened under an agent's existing identity.
     */
    createCommandId(input: FormationCommandIdInput, name: string): string;
    command(
        input: FormationCommandInput
    ): Promise<BlackBoxRallarFormationSummary>;
    tryCommand(
        input: FormationCommandInput
    ): Promise<LiveRtcControlClient.Result>;
    readiness(input: FormationReadinessInput): Promise<FormationReadiness>;
    health(input: FormationAgentInput): Promise<FormationHealth>;
    waitForStage(input: FormationStageWaitInput): Promise<void>;
    countPeerCreated(input: FormationAgentInput): Promise<number>;
    readFormationDiagnostics(
        input: FormationDiagnosticsInput
    ): Promise<readonly FormationDiagnosticEvent[]>;
    reopen(input: FormationReopenInput): Promise<LiveRtcControlClient.Agent>;
}

/** Everything a command id is built from: the agent it addresses and the scenario it belongs to. */
export interface FormationCommandIdInput {
    readonly agent: Pick<LiveRtcControlClient.FormationAgent, 'prefix'>;
    readonly suffix: string;
}

export interface FormationAgentInput extends FormationCommandIdInput {
    readonly timeoutMs?: number;
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly roomRef: GroupRef;
}

export interface FormationReadinessInput extends FormationCommandIdInput {
    readonly timeoutMs?: number;
    readonly control: Pick<LiveRtcControlClient, 'executeOk' | 'resultValue'>;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.FormationAgent;
    readonly roomRef: GroupRef;
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
    let issuedCommandCount = 0;
    const createCommandId = (
        input: FormationCommandIdInput,
        name: string
    ): string => {
        issuedCommandCount += 1;
        return `formation-${name}-${input.agent.prefix}-${input.suffix}-${issuedCommandCount}`;
    };

    return {
        createCommandId,

        async command(input) {
            const commandId = createCommandId(input, input.input.command);
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId,
                command: {
                    kind: 'formation.command',
                    commandId,
                    ...toWireRoom(input),
                    ...toWireCommandFields(input.input),
                    ...(input.reason === undefined ? {} : { reason: input.reason })
                }
            });
            return decodeFormationSummary(
                record(input.control.resultValue(result)).formation,
                'formation.command'
            );
        },

        async tryCommand(input) {
            const commandId = createCommandId(input, input.input.command);
            return await input.control.executeResult({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId,
                command: {
                    kind: 'formation.command',
                    commandId,
                    ...toWireRoom(input),
                    ...toWireCommandFields(input.input),
                    ...(input.reason === undefined ? {} : { reason: input.reason })
                }
            });
        },

        async readiness(input) {
            const timeoutMs = input.timeoutMs ?? READINESS_TIMEOUT_MS;
            const startedAtMs = performance.now();
            await input.agent.refreshRoom({ timeoutMs });
            const remainingTimeoutMs = Math.max(
                0,
                timeoutMs - (performance.now() - startedAtMs)
            );
            const commandId = createCommandId(input, 'readiness');
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId,
                command: {
                    kind: 'formation.readiness',
                    commandId,
                    ...toWireRoom(input),
                    // The in-browser wait and the poll that awaits it are the same budget; without
                    // this the command falls back to its own default and gives up first.
                    timeoutMs: remainingTimeoutMs
                },
                timeoutMs: remainingTimeoutMs + 30_000
            });
            const value = record(input.control.resultValue(result));
            return {
                readyAtEpochMs: decodeNumber(
                    value.readyAtEpochMs,
                    'formation.readiness.readyAtEpochMs'
                ),
                formation: decodeFormationSummary(
                    value.formation,
                    'formation.readiness'
                )
            };
        },

        async health(input) {
            const commandId = createCommandId(input, 'health');
            const result = await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId,
                command: { kind: 'health', commandId }
            });
            const value = record(input.control.resultValue(result));
            const rallar = record(value.rallar);
            const rtcStatus = record(rallar.rtcStatus);
            return {
                // The whole block travels in the failure: a page that connected to the wrong scope
                // and one that never connected are indistinguishable from the missing field alone.
                formation: decodeFormationSummary(
                    rallar.formation ?? value.formation,
                    `health ${JSON.stringify(value)}`
                ),
                rtcStatus: {
                    knownPeerIds: decodeStringArray(rtcStatus.knownPeerIds),
                    activePeerIds: decodeStringArray(rtcStatus.activePeerIds),
                    readyPeerIds: decodeStringArray(rtcStatus.readyPeerIds)
                }
            };
        },

        async waitForStage(input) {
            const commandId = createCommandId(input, `stage-${input.stage}`);
            await input.control.executeOk({
                runId: input.runId,
                agentId: input.agent.agentId,
                commandId,
                command: {
                    kind: 'wait',
                    commandId,
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
            return events.filter(
                (event) =>
                    event.topic === PEER_CREATED_TOPIC &&
                    event.data.kind === 'peer-created'
            ).length;
        },

        async readFormationDiagnostics(input) {
            const events = await readAgentEvents(input);
            return events.filter(
                (event) => event.topic === input.topic && event.atEpochMs >= input.sinceEpochMs
            );
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
                groupId: input.roomRef.groupId
            });
            // Half of the same-session proof: the seed survived the page load. It says nothing about
            // what the runtime will authenticate with, because that is decided later inside
            // `rtc.connect` — the connect asserts its own session against this same stored value, and
            // the two together are what prove the returning member is the one the accepted layout
            // names. The caller only learns about the page it gets back, so a failing guard closes the
            // context it was handed rather than leaking it.
            try {
                const restored = await readRestoredSession(reopened);
                expect(
                    restored.sessionId,
                    `Agent ${input.agent.prefix} reopened with a new session instead of the restored one`
                ).toBe(session.sessionId);
            }
            catch (error) {
                await reopened.context.close();
                throw toError(error);
            }
            return reopened;
        }
    };
}

/** The room every formation command addresses, named exactly so the protocol's rule is satisfied. */
function toWireRoom(
    input: Pick<FormationAgentInput, 'roomRef'>
): LiveRtcJsonRecord {
    return {
        roomId: input.roomRef.groupId,
        applicationId: input.roomRef.applicationId,
        workspaceId: input.roomRef.workspaceId
    };
}

/** The wire command is flat: `command`, `layout` and `landing` sit on it, and the bridge lifts them. */
function toWireCommandFields(
    input: BlackBoxRallarFormationCommandInput
): Pick<RallarBlackBoxTestFormationCommandCommand, 'command' | 'layout' | 'landing'> {
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

async function readAgentEvents(
    input: FormationAgentInput
): Promise<readonly FormationDiagnosticEvent[]> {
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

/**
 * The session the page holds. A reopen reads it before the page closes so the returning page restores
 * it rather than logging in again, and a connect reads it to state which session the runtime is
 * required to come back as.
 */
export async function readRestoredSession(
    agent: Pick<LiveRtcControlClient.Agent, 'page' | 'prefix'>
): Promise<LiveRtcRestoredSession> {
    const stored = await agent.page.evaluate(() => window.localStorage.getItem('auth.session'));
    expect(
        stored,
        `Agent ${agent.prefix} holds no auth.session to restore`
    ).not.toBeNull();
    const session = record(JSON.parse(String(stored)));
    return {
        clientId: decodeString(session.clientId, 'auth.session.clientId'),
        accessToken: decodeString(session.accessToken, 'auth.session.accessToken'),
        username: decodeString(session.username, 'auth.session.username'),
        sessionId: decodeString(session.sessionId, 'auth.session.sessionId'),
        expiresAtEpochMs: decodeNumber(
            session.expiresAtEpochMs,
            'auth.session.expiresAtEpochMs'
        )
    };
}

/** The harness's own narrowing helper; an absent or non-record value reads as an empty record. */
function record(value: RtcBaselineJson | undefined): LiveRtcJsonRecord {
    return jsonRecord(value) ?? {};
}

function decodeStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

/**
 * The block is required, not optional: two scenarios assert that fields inside it are absent, so a
 * decoder that tolerated a missing block would let them pass while proving nothing.
 */
function decodeFormationSummary(
    value: unknown,
    source: string
): BlackBoxRallarFormationSummary {
    const summary: LiveRtcJsonRecord = typeof value === 'object' && value !== null
        ? (value as LiveRtcJsonRecord)
        : {};
    expect(
        typeof summary.stage === 'string',
        `${source} carried no formation summary: ${JSON.stringify(value)}`
    ).toBe(true);
    return value as BlackBoxRallarFormationSummary;
}

function decodeString(value: unknown, path: string): string {
    expect(typeof value, `${path} must be a string`).toBe('string');
    return String(value);
}

function decodeNumber(value: unknown, path: string): number {
    expect(typeof value, `${path} must be a number`).toBe('number');
    return Number(value);
}

export type {
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationSummary
};
