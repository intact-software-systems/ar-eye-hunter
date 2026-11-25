import { expect, type APIRequestContext, type Page } from '@playwright/test';

import { computeCommandResultPollTimeoutMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    DIRECTOR_APPOINT_TIMEOUT_MS,
    DIRECTOR_CONNECT_TIMING,
    DIRECTOR_EVENT_POLL_TIMEOUT_MS,
    DIRECTOR_GROUP_REQUEST_TIMEOUT_MS,
    DIRECTOR_HEALTH_RESULT_POLL_TIMEOUT_MS,
    DIRECTOR_INTENT_RESULT_POLL_TIMEOUT_MS,
    DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS,
    DIRECTOR_RELAY_START_TIMEOUT_MS,
    DIRECTOR_STALE_HOLD_MS
} from './director-orchestration-waits.ts';
import { enqueueControlCommand, readControlRun } from './full-stack-helpers.ts';

/** How long a command's result is polled for once its own budget, if it names one, is spent. */
export const DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS = 45_000;

type AgentPrefix = 'A' | 'B' | 'C';

export namespace DirectorOrchestration {
    export interface Agent {
        readonly page: Pick<Page, 'waitForTimeout'>;
        readonly prefix: AgentPrefix;
        readonly agentId: string;
        readonly actor: string;
        readonly connection: string;
    }

    export interface CommandInput {
        readonly agentId: string;
        readonly commandId: string;
        readonly command: RallarBlackBoxTestCommand;
        /** The caller's own wait for the result, when it names one. */
        readonly timeout?: number;
    }

    export interface EventExpectation {
        readonly agentId: string;
        readonly topic: string;
        readonly contains: readonly string[];
    }

    /** The control run the scenario drives its agents through. */
    export interface Control {
        /** Enqueues a command, then polls for its result as long as `resolveDirectorCommandResultPollTimeoutMs` says. */
        executeResult(input: CommandInput): Promise<ControlResultEnvelope>;
        /** Polls the run until the agent reports the event, for up to the director event poll's limit. */
        waitForEvent(expectation: EventExpectation): Promise<void>;
    }

    export interface Room {
        readonly apiBaseUrl: string;
        readonly applicationId: string;
        readonly workspaceId: string;
        readonly groupId: string;
    }

    export interface Input {
        readonly control: Control;
        readonly room: Room;
        readonly agents: readonly [Agent, Agent, Agent];
        readonly topicId: string;
        readonly intentIds: Readonly<{ B: string; C: string; }>;
    }
}

type Sessions = Readonly<Record<AgentPrefix, string>>;

interface DirectorStatusReading {
    readonly role: string | undefined;
    readonly state: string | undefined;
    readonly isDirector: boolean | undefined;
    readonly appointment: Readonly<{ sessionId: string | undefined; epoch: number; }>;
}

interface ScenarioState extends DirectorOrchestration.Input {
    readonly sessions: Sessions;
}

const RELAY_HANDLE = 'director-relay';

/** How long the director's appointment stays fresh without a heartbeat; the stale hold outlasts it. */
const DIRECTOR_HEARTBEAT_TTL_MS = 1_200;

/** How often each relay sends its heartbeat. */
const DIRECTOR_HEARTBEAT_INTERVAL_MS = 300;

/** How often the director's relay sends its snapshot. */
const DIRECTOR_SNAPSHOT_INTERVAL_MS = 500;

/**
 * How long a command's result is polled for once it is enqueued: the wait its caller names, or else the command's own
 * budget and then the result poll.
 */
export function resolveDirectorCommandResultPollTimeoutMs(
    input: Readonly<{ command: RallarBlackBoxTestCommand; timeout?: number; }>
): number {
    return input.timeout ?? computeCommandResultPollTimeoutMs(input.command, DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);
}

/** The control run as the scenario reads it over HTTP. */
export function createDirectorControl(
    request: Pick<APIRequestContext, 'get' | 'post'>,
    runId: string
): DirectorOrchestration.Control {
    return {
        executeResult: async (input) => {
            await enqueueControlCommand({ request, runId, ...input });
            return await waitForCommandResult(request, runId, input);
        },
        waitForEvent: async (expectation) => await waitForDirectorEvent(request, runId, expectation)
    };
}

/**
 * The owner creates the room and every agent joins it; they connect and wait for their peers; A appoints itself,
 * every agent starts its relay, B and C relay intents and request syncs, and once A's relay stops they see it stale.
 */
export async function runDirectorOrchestration(input: DirectorOrchestration.Input): Promise<void> {
    await setupDirectorMembership(input);
    const scenario = { ...input, sessions: await connectDirectorAgents(input) };
    const epoch = await appointDirector(scenario);
    await startDirectorRelays(scenario);
    await relayDirectorIntents(scenario);
    await syncDirectorClients(scenario);
    await expectDirectorStale(scenario, epoch);
}

async function waitForCommandResult(
    request: Pick<APIRequestContext, 'get'>,
    runId: string,
    input: DirectorOrchestration.CommandInput
): Promise<ControlResultEnvelope> {
    let latest: ControlResultEnvelope | undefined;
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        latest = run.results.find((result) => result.commandId === input.commandId);
        return Boolean(latest);
    }, { timeout: resolveDirectorCommandResultPollTimeoutMs(input) }).toBe(true);
    if (!latest) {
        throw new Error(`Command ${input.commandId} did not return a result.`);
    }
    return latest;
}

async function waitForDirectorEvent(
    request: Pick<APIRequestContext, 'get'>,
    runId: string,
    input: DirectorOrchestration.EventExpectation
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return run.events.some((event) => {
            const payload = toDirectorRuntimeEventPayload(event);
            return event.agentId === input.agentId && payload.topic === input.topic &&
                input.contains.every((fragment) => JSON.stringify(payload).includes(fragment));
        });
    }, { timeout: DIRECTOR_EVENT_POLL_TIMEOUT_MS }).toBe(true);
}

async function executeOk(
    control: DirectorOrchestration.Control,
    input: DirectorOrchestration.CommandInput
): Promise<ControlResultEnvelope> {
    const result = await control.executeResult(input);
    expect(result.ok, JSON.stringify(result.error ?? result)).toBe(true);
    return result;
}

async function setupDirectorMembership(input: DirectorOrchestration.Input): Promise<void> {
    const statePrefix = `/api/state/apps/${encodeURIComponent(input.room.applicationId)}/workspaces/${
        encodeURIComponent(input.room.workspaceId)
    }`;
    // Group-state mutations are idempotent per requestId (20 to 128 characters), so each run names its own.
    const requestPrefix = `director-${crypto.randomUUID()}`;
    await executeOk(input.control, {
        agentId: input.agents[0].agentId,
        commandId: 'director-group-create',
        command: toDirectorGroupCreateCommand(statePrefix, requestPrefix, input.room.groupId)
    });
    const memberPath = `${statePrefix}/groups/${encodeURIComponent(input.room.groupId)}/members/{auth.clientId}`;
    for (const member of input.agents) {
        await executeOk(input.control, {
            agentId: member.agentId,
            commandId: `director-group-join-${member.prefix.toLowerCase()}`,
            command: {
                kind: 'http.request',
                request: {
                    path: `${memberPath}/requests/${requestPrefix}-member-${member.prefix.toLowerCase()}`,
                    method: 'PUT',
                    body: { status: 'active' }
                },
                response: { body: 'json', acceptedStatusCodes: [200, 201] },
                timeoutMs: DIRECTOR_GROUP_REQUEST_TIMEOUT_MS
            }
        });
    }
}

function toDirectorGroupCreateCommand(
    statePrefix: string,
    requestPrefix: string,
    groupId: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        request: {
            path: `${statePrefix}/groups/requests/${requestPrefix}-group`,
            method: 'POST',
            body: { groupId, displayName: groupId, kind: 'room', joinMode: 'open' }
        },
        response: { body: 'json', acceptedStatusCodes: [200, 201] },
        timeoutMs: DIRECTOR_GROUP_REQUEST_TIMEOUT_MS
    };
}

/** The agents connect side by side, then wait side by side until each has its two peers ready. */
async function connectDirectorAgents(input: DirectorOrchestration.Input): Promise<Sessions> {
    const [a, b, c] = await Promise.all(input.agents.map((agent) => connectDirectorAgent(input, agent)));
    const sessions = { A: a, B: b, C: c };
    await Promise.all(input.agents.map((agent) =>
        waitForDirectorPeerReadiness(
            input.control,
            agent,
            input.agents.filter((peer) => peer !== agent).map((peer) => sessions[peer.prefix])
        )
    ));
    return sessions;
}

async function connectDirectorAgent(
    input: DirectorOrchestration.Input,
    agent: DirectorOrchestration.Agent
): Promise<string> {
    const { room } = input;
    const commandId = `director-connect-${agent.prefix.toLowerCase()}`;
    const result = await executeOk(input.control, {
        agentId: agent.agentId,
        commandId,
        command: {
            ...DIRECTOR_CONNECT_TIMING,
            connection: agent.connection,
            actor: agent.actor,
            ...directorRoomFields(room),
            transport: 'realtime',
            rallar: {
                apiBaseUrl: room.apiBaseUrl,
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
                applicationId: room.applicationId,
                workspaceId: room.workspaceId,
                transport: 'realtime',
                timeoutMs: RALLAR_BLACK_BOX_RTC_CONNECT_ESTABLISHMENT_TIMEOUT_MS
            }
        }
    });
    const sessionId = resultValue(result).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`Connect result ${commandId} did not include a sessionId.`);
    }
    return sessionId;
}

async function waitForDirectorPeerReadiness(
    control: DirectorOrchestration.Control,
    agent: DirectorOrchestration.Agent,
    expectedPeerIds: readonly string[]
): Promise<void> {
    let attempt = 0;
    await expect.poll(async () => {
        const result = await control.executeResult({
            agentId: agent.agentId,
            commandId: `director-health-${agent.prefix.toLowerCase()}-${attempt++}`,
            command: { kind: 'health' },
            timeout: DIRECTOR_HEALTH_RESULT_POLL_TIMEOUT_MS
        }).catch(() => undefined);
        if (!result?.ok) {
            return [];
        }
        return stringArrayValue(requireRecord(requireRecord(resultValue(result).rallar).rtcStatus).readyPeerIds);
    }, { timeout: DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS }).toEqual(expect.arrayContaining([...expectedPeerIds]));
}

/** A appoints itself under its budget, then every agent reads its status; returns the appointment's epoch. */
async function appointDirector(scenario: ScenarioState): Promise<number> {
    const appoint = await executeOk(scenario.control, {
        agentId: scenario.agents[0].agentId,
        commandId: 'director-appoint-a',
        command: {
            kind: 'director.appoint',
            ...directorRoomFields(scenario.room),
            heartbeatTtlMs: DIRECTOR_HEARTBEAT_TTL_MS,
            timeoutMs: DIRECTOR_APPOINT_TIMEOUT_MS
        }
    });
    expect(directorStatusValue(appoint)).toMatchObject({ role: 'director', state: 'fresh', isDirector: true });
    const statuses: DirectorStatusReading[] = [];
    for (const agent of scenario.agents) {
        statuses.push(await readDirectorStatus(scenario, agent, `director-status-${agent.prefix.toLowerCase()}`));
    }
    const [statusA, ...clientStatuses] = statuses;
    const { epoch } = statusA.appointment;
    expect(statusA).toMatchObject({ role: 'director', isDirector: true });
    for (const status of clientStatuses) {
        expect(status).toMatchObject({ role: 'client', isDirector: false });
        expect(status.appointment).toMatchObject({ sessionId: scenario.sessions.A, epoch });
    }
    return epoch;
}

async function readDirectorStatus(
    scenario: ScenarioState,
    agent: DirectorOrchestration.Agent,
    commandId: string
): Promise<DirectorStatusReading> {
    const result = await executeOk(scenario.control, {
        agentId: agent.agentId,
        commandId,
        command: { kind: 'director.status', ...directorRoomFields(scenario.room), refresh: true }
    });
    return decodeDirectorStatusReading(resultValue(result).directorStatus).fold((issue) => {
        throw new Error(`Director status ${commandId}: ${issue}`);
    }, (reading) => reading);
}

/**
 * A director status read, its fields as the scenario checks them; a read without an appointment is refused, and so is
 * an appointment whose epoch is not a number, since two readings without one would otherwise match.
 */
function decodeDirectorStatusReading(value: unknown): Either<string, DirectorStatusReading> {
    const status = requireRecord(value);
    const appointment = requireRecord(status.appointment);
    if (typeof appointment.epoch !== 'number') {
        return Either.ofLeft('the appointment\'s epoch must be a number');
    }
    return Either.ofRight({
        role: typeof status.role === 'string' ? status.role : undefined,
        state: typeof status.state === 'string' ? status.state : undefined,
        isDirector: typeof status.isDirector === 'boolean' ? status.isDirector : undefined,
        appointment: {
            sessionId: typeof appointment.sessionId === 'string' ? appointment.sessionId : undefined,
            epoch: appointment.epoch
        }
    });
}

/** Each agent starts its relay under its budget, in turn. */
async function startDirectorRelays(scenario: ScenarioState): Promise<void> {
    for (const agent of scenario.agents) {
        await executeOk(scenario.control, {
            agentId: agent.agentId,
            commandId: `director-relay-start-${agent.prefix.toLowerCase()}`,
            command: {
                kind: 'director.relay.start',
                handle: RELAY_HANDLE,
                ...directorRoomFields(scenario.room),
                topicId: scenario.topicId,
                intentTypeId: `${scenario.topicId}.intent`,
                outputTypeId: `${scenario.topicId}.output`,
                heartbeatIntervalMs: DIRECTOR_HEARTBEAT_INTERVAL_MS,
                snapshotIntervalMs: DIRECTOR_SNAPSHOT_INTERVAL_MS,
                timeoutMs: DIRECTOR_RELAY_START_TIMEOUT_MS
            }
        });
    }
}

/** B and C relay an intent in turn; then A receives both, and B and C both outputs, side by side. */
async function relayDirectorIntents(scenario: ScenarioState): Promise<void> {
    const [agentA, ...clients] = scenario.agents;
    for (const [client, action] of [[clients[0], 'pose'], [clients[1], 'shot']] as const) {
        // A relay command reports sent only once the director's receipt arrives; it carries its one handle.
        expectDirectorConfirmed(
            await executeOk(scenario.control, {
                agentId: client.agentId,
                commandId: `director-intent-${client.prefix.toLowerCase()}`,
                command: {
                    kind: 'director.intent',
                    handle: RELAY_HANDLE,
                    intent: { intentId: toIntentId(scenario, client), actor: client.actor, action }
                },
                timeout: DIRECTOR_INTENT_RESULT_POLL_TIMEOUT_MS
            })
        );
    }
    const intentIds = clients.map((client) => toIntentId(scenario, client));
    await Promise.all([
        ...intentIds.map((intentId) => ({ agentId: agentA.agentId, topic: 'intent_received', intentId })),
        ...clients.flatMap((client) =>
            intentIds.map((intentId) => ({ agentId: client.agentId, topic: 'output_received', intentId }))
        )
    ].map(({ agentId, topic, intentId }) =>
        scenario.control.waitForEvent({ agentId, topic: `rallar.browser.director.${topic}`, contains: [intentId] })
    ));
}

/** B and C request a sync in turn, then their snapshots of both intents arrive side by side. */
async function syncDirectorClients(scenario: ScenarioState): Promise<void> {
    const clients = scenario.agents.slice(1);
    for (const client of clients) {
        expectDirectorConfirmed(
            await executeOk(scenario.control, {
                agentId: client.agentId,
                commandId: `director-sync-${client.prefix.toLowerCase()}`,
                command: {
                    kind: 'director.sync.request',
                    handle: RELAY_HANDLE,
                    payload: { reason: `black-box-${client.prefix.toLowerCase()}` }
                }
            })
        );
    }
    await Promise.all(clients.map((client) =>
        scenario.control.waitForEvent({
            agentId: client.agentId,
            topic: 'rallar.browser.director.snapshot_received',
            contains: clients.map((intentClient) => toIntentId(scenario, intentClient))
        })
    ));
}

/** A's relay stops; after the stale hold B and C read their status in turn, see A stale, then stop their relays. */
async function expectDirectorStale(scenario: ScenarioState, epoch: number): Promise<void> {
    const [agentA, ...clients] = scenario.agents;
    await stopDirectorRelay(scenario, agentA);
    await agentA.page.waitForTimeout(DIRECTOR_STALE_HOLD_MS);
    for (const client of clients) {
        const status = await readDirectorStatus(
            scenario,
            client,
            `director-status-${client.prefix.toLowerCase()}-stale`
        );
        expect(status).toMatchObject({ role: 'client', state: 'stale', isDirector: false });
        expect(status.appointment).toMatchObject({ sessionId: scenario.sessions.A, epoch });
    }
    for (const client of clients) {
        await stopDirectorRelay(scenario, client);
    }
}

async function stopDirectorRelay(scenario: ScenarioState, agent: DirectorOrchestration.Agent): Promise<void> {
    await executeOk(scenario.control, {
        agentId: agent.agentId,
        commandId: `director-relay-stop-${agent.prefix.toLowerCase()}`,
        command: { kind: 'director.relay.stop', handle: RELAY_HANDLE }
    });
}

function toIntentId(scenario: ScenarioState, client: DirectorOrchestration.Agent): string {
    return client.prefix === 'C' ? scenario.intentIds.C : scenario.intentIds.B;
}

function directorRoomFields(room: DirectorOrchestration.Room): Readonly<{
    roomId: string;
    applicationId: string;
    workspaceId: string;
    roomRef: GroupRef;
}> {
    return {
        roomId: room.groupId,
        applicationId: room.applicationId,
        workspaceId: room.workspaceId,
        roomRef: { applicationId: room.applicationId, workspaceId: room.workspaceId, groupId: room.groupId }
    };
}

function expectDirectorConfirmed(result: ControlResultEnvelope): void {
    const sendResult = requireRecord(resultValue(result).sendResult);
    expect(sendResult, JSON.stringify(sendResult)).toMatchObject({
        status: 'sent',
        receipt: { msgId: expect.any(String) }
    });
    expect(sendResult).not.toHaveProperty('rtc');
    expect(sendResult).not.toHaveProperty('ws');
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!isJsonRecordValue(value)) {
        throw new Error('Expected a JSON object in the control result/event.');
    }
    return value;
}

function stringArrayValue(value: unknown): readonly string[] {
    if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
        throw new Error('Expected string peer IDs.');
    }
    return value;
}

function resultValue(result: ControlResultEnvelope): Record<string, unknown> {
    return requireRecord(result.result?.value);
}

function directorStatusValue(result: ControlResultEnvelope): Record<string, unknown> {
    return requireRecord(resultValue(result).directorStatus);
}

/** The runtime payload an event carries, unwrapped from its envelope when it is nested. */
export function toDirectorRuntimeEventPayload(event: ControlEventEnvelope): Record<string, unknown> {
    const payload = requireRecord(event.payload);
    return typeof payload.kind === 'string' ? payload : requireRecord(payload.payload ?? payload);
}
