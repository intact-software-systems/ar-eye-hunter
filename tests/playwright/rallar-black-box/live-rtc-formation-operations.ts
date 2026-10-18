import { expect } from '@playwright/test';

import { arrayEquals } from '@shared/repository/state-utils.ts';
import { settleAll } from '@shared/resilience/settle-all.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { TryWithExhaustedError, TryWithPolicy } from '@shared/resilience/try-with-policy.ts';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type {
    BlackBoxRallarFormationCommandInput,
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationSummary
} from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { RallarBlackBoxTestFormationCommandCommand } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
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
    /** Absent when the caller only requires readiness of the current accepted layout. */
    readonly expectedPeerIds?: readonly string[];
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

export interface FormationReopenInput extends Pick<FormationAgentInput, 'runId' | 'agent' | 'roomRef' | 'suffix'> {
    readonly browser: LiveRtcBrowserContextFactory;
    readonly config: LiveRtcBrowserAgentConfig;
    readonly transport: string;
}

const PEER_CREATED_TOPIC = 'rallar.browser.rtc.lifecycle';
const READINESS_TIMEOUT_MS = 60_000;

export class LiveRtcFormationOperations {
    private issuedCommandCount = 0;

    createCommandId(input: FormationCommandIdInput, name: string): string {
        this.issuedCommandCount += 1;
        return `formation-${name}-${input.agent.prefix}-${input.suffix}-${this.issuedCommandCount}`;
    }

    async command(input: FormationCommandInput): Promise<BlackBoxRallarFormationSummary> {
        const commandId = this.createCommandId(input, input.input.command);
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
    }

    async tryCommand(input: FormationCommandInput): Promise<LiveRtcControlClient.Result> {
        const commandId = this.createCommandId(input, input.input.command);
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
    }

    async readiness(input: FormationReadinessInput): Promise<FormationReadiness> {
        const timeoutMs = input.timeoutMs ?? READINESS_TIMEOUT_MS;
        const deadlineMs = performance.now() + timeoutMs;
        await input.agent.refreshRoom({ refresh: 'always', timeoutMs });
        return await this.waitForFormationPeers(input, deadlineMs);
    }

    private async waitForFormationPeers(
        input: FormationReadinessInput,
        deadlineMs: number
    ): Promise<FormationReadiness> {
        let lastMismatch: FormationPeerMismatch | undefined;
        let terminalFailure: Error | undefined;
        const policy = TryWithPolicy.defaults({
            nowEpochMs: () => performance.now(),
            randomUnit: () => 0.5,
            wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
        }).retryIntervalMsecs(100).maxRetryIntervalMsecs(100).backoffFactor(1).jitterRatio(0)
            .maxElapsedMsecs(Math.max(0, deadlineMs - performance.now())).fitDelayToElapsedBudget()
            .retryIf((failure) => failure instanceof FormationPeerMismatch);
        try {
            return await policy.run(async () => {
                const remainingTimeoutMs = Math.max(0, deadlineMs - performance.now());
                if (remainingTimeoutMs === 0) {
                    throw lastMismatch ?? new Error('Formation readiness deadline expired during room refresh.');
                }
                const readiness = await readFormationReadiness(
                    input,
                    remainingTimeoutMs,
                    this.createCommandId(input, 'readiness')
                ).catch((failure) => {
                    terminalFailure = toError(failure);
                    throw terminalFailure;
                });
                const mismatch = toFormationPeerMismatch(input, readiness);
                if (mismatch) {
                    lastMismatch = mismatch;
                    throw mismatch;
                }
                return readiness;
            });
        }
        catch (failure) {
            if (terminalFailure) {
                throw terminalFailure;
            }
            if (failure instanceof TryWithExhaustedError) {
                throw toError(failure.cause);
            }
            throw failure;
        }
    }

    async health(input: FormationAgentInput): Promise<FormationHealth> {
        const commandId = this.createCommandId(input, 'health');
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
    }

    async waitForStage(input: FormationStageWaitInput): Promise<void> {
        const commandId = this.createCommandId(input, `stage-${input.stage}`);
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
    }

    async countPeerCreated(input: FormationAgentInput): Promise<number> {
        const events = await readAgentEvents(input);
        return events.filter(
            (event) =>
                event.topic === PEER_CREATED_TOPIC &&
                event.data.kind === 'peer-created'
        ).length;
    }

    async readFormationDiagnostics(input: FormationDiagnosticsInput): Promise<readonly FormationDiagnosticEvent[]> {
        const events = await readAgentEvents(input);
        return events.filter(
            (event) => event.topic === input.topic && event.atEpochMs >= input.sinceEpochMs
        );
    }

    async reopen(input: FormationReopenInput): Promise<LiveRtcControlClient.Agent> {
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
            await settleAll([
                Promise.reject(error),
                Promise.resolve().then(() => reopened.context.close())
            ]);
            throw error;
        }
        return reopened;
    }
}

export function createLiveRtcFormationOperations(): LiveRtcFormationOperations {
    return new LiveRtcFormationOperations();
}

class FormationPeerMismatch extends Error {}

async function readFormationReadiness(
    input: FormationReadinessInput,
    timeoutMs: number,
    commandId: string
): Promise<FormationReadiness> {
    const result = await input.control.executeOk({
        runId: input.runId,
        agentId: input.agent.agentId,
        commandId,
        command: { kind: 'formation.readiness', commandId, ...toWireRoom(input), timeoutMs },
        timeoutMs: timeoutMs + 30_000
    });
    const value = record(input.control.resultValue(result));
    return {
        readyAtEpochMs: decodeNumber(value.readyAtEpochMs, 'formation.readiness.readyAtEpochMs'),
        formation: decodeFormationSummary(value.formation, 'formation.readiness')
    };
}

function toFormationPeerMismatch(
    input: FormationReadinessInput,
    readiness: FormationReadiness
): FormationPeerMismatch | undefined {
    if (input.expectedPeerIds === undefined) {
        return undefined;
    }
    const room = readiness.formation.room;
    const expected = [...new Set(input.expectedPeerIds)].sort();
    const desired = [...new Set(room.desiredPeerIds)].sort();
    const ready = [...new Set(room.readyPeerIds)].sort();
    if (arrayEquals(desired, expected) && arrayEquals(ready, expected)) {
        return undefined;
    }
    return new FormationPeerMismatch(
        `Expected ${input.agent.agentId} to target the exact peers and have the exact ready peers for ${input.suffix}: ` +
            `expected=${JSON.stringify(expected)}, desired=${JSON.stringify(desired)}, ready=${JSON.stringify(ready)}`
    );
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
