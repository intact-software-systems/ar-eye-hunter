import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';

import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    cleanupRallarPage,
    enqueueControlCommand,
    exportControlRunArtifacts,
    openBrowserControlAgent,
    readControlRun,
    readFullStackConfig,
    uniqueAgentId,
    uniqueGroupId,
    uniqueRunId
} from './full-stack-helpers.ts';

type AgentPrefix = 'A' | 'B' | 'C';

interface AgentHandle {
    context: BrowserContext;
    page: Page;
    prefix: AgentPrefix;
    agentId: string;
    actor: string;
    readonly connection: string;
}

interface WaitForCommandResultInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly commandId: string;
    readonly timeout?: number;
}

interface ExecuteCommandInput extends WaitForCommandResultInput {
    readonly agentId: string;
    readonly command: RallarBlackBoxTestCommand;
}

interface OpenAgentsInput {
    readonly browser: Browser;
    readonly runId: string;
    readonly groupId: string;
    readonly testInfo: TestInfo;
}

interface DirectorConnection {
    readonly commandId: string;
    readonly sessionId: string;
}

interface ConnectAgentInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agent: AgentHandle;
    readonly groupId: string;
}

interface WaitForPeerReadinessInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agent: AgentHandle;
    readonly expectedPeerIds: readonly string[];
}

interface GroupMembershipInput {
    readonly owner: AgentHandle;
    readonly members: readonly AgentHandle[];
    readonly groupId: string;
}

interface DirectorEventExpectation {
    readonly agentId: string;
    readonly topic: string;
    readonly contains: readonly string[];
}

interface DirectorRoomFields {
    readonly roomId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly roomRef: import('@shared/api/group-types.ts').GroupRef;
}

const config = readFullStackConfig();
const directorEnabled = booleanEnv('RALLAR_BLACK_BOX_DIRECTOR');
const hasDirectorConfig = config.enabled && directorEnabled;

test.describe('full-stack SPA-appointed director orchestration', () => {
    test.skip(
        !hasDirectorConfig,
        'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_DIRECTOR=1 to run the full-stack director orchestration scenario.'
    );

    test('appoints A as director, relays B/C intents, snapshots, and marks stale without auto-election', async ({
        browser,
        request
    }, testInfo) => {
        test.setTimeout(300_000);

        const runId = uniqueRunId(testInfo);
        const groupId = uniqueGroupId(testInfo);
        const topicId = `app.black-box.director.${Date.now()}`;
        const intentTypeId = `${topicId}.intent`;
        const outputTypeId = `${topicId}.output`;
        const relayHandle = 'director-relay';
        const intentB = `intent-b-${Date.now()}`;
        const intentC = `intent-c-${Date.now()}`;
        const agents = await openAgents({ browser, runId, groupId, testInfo });
        const [agentA, agentB, agentC] = agents;

        try {
            await setupGroupMembership(request, runId, {
                owner: agentA,
                members: agents,
                groupId
            });

            const connectResults = await Promise.all(
                agents.map((agent) => connectAgent({ request, runId, agent, groupId }))
            );
            const sessions = {
                A: connectResults[0].sessionId,
                B: connectResults[1].sessionId,
                C: connectResults[2].sessionId
            };

            await Promise.all([
                waitForPeerReadiness({ request, runId, agent: agentA, expectedPeerIds: [sessions.B, sessions.C] }),
                waitForPeerReadiness({ request, runId, agent: agentB, expectedPeerIds: [sessions.A, sessions.C] }),
                waitForPeerReadiness({ request, runId, agent: agentC, expectedPeerIds: [sessions.A, sessions.B] })
            ]);

            const appoint = await executeOk({
                request,
                runId,
                agentId: agentA.agentId,
                commandId: 'director-appoint-a',
                command: {
                    kind: 'director.appoint',
                    ...directorRoomFields(groupId),
                    heartbeatTtlMs: 1_200,
                    timeoutMs: 20_000
                },
                timeout: 30_000
            });
            expect(directorStatusValue(appoint)).toMatchObject({
                role: 'director',
                state: 'fresh',
                isDirector: true
            });

            const statusA = await executeOk({
                request,
                runId,
                agentId: agentA.agentId,
                commandId: 'director-status-a',
                command: {
                    kind: 'director.status',
                    ...directorRoomFields(groupId),
                    refresh: true
                }
            });
            const statusB = await executeOk({
                request,
                runId,
                agentId: agentB.agentId,
                commandId: 'director-status-b',
                command: {
                    kind: 'director.status',
                    ...directorRoomFields(groupId),
                    refresh: true
                }
            });
            const statusC = await executeOk({
                request,
                runId,
                agentId: agentC.agentId,
                commandId: 'director-status-c',
                command: {
                    kind: 'director.status',
                    ...directorRoomFields(groupId),
                    refresh: true
                }
            });
            const epoch = requireRecord(directorStatusValue(statusA).appointment).epoch;
            expect(directorStatusValue(statusA)).toMatchObject({ role: 'director', isDirector: true });
            expect(directorStatusValue(statusB)).toMatchObject({ role: 'client', isDirector: false });
            expect(directorStatusValue(statusC)).toMatchObject({ role: 'client', isDirector: false });
            expect(requireRecord(directorStatusValue(statusB).appointment)).toMatchObject({
                sessionId: sessions.A,
                epoch
            });
            expect(requireRecord(directorStatusValue(statusC).appointment)).toMatchObject({
                sessionId: sessions.A,
                epoch
            });

            for (const agent of agents) {
                await executeOk({
                    request,
                    runId,
                    agentId: agent.agentId,
                    commandId: `director-relay-start-${agent.prefix.toLowerCase()}`,
                    command: {
                        kind: 'director.relay.start',
                        handle: relayHandle,
                        ...directorRoomFields(groupId),
                        topicId,
                        intentTypeId,
                        outputTypeId,
                        heartbeatIntervalMs: 300,
                        snapshotIntervalMs: 500,
                        timeoutMs: 20_000
                    }
                });
            }

            const sentB = await executeOk({
                request,
                runId,
                agentId: agentB.agentId,
                commandId: 'director-intent-b',
                command: {
                    kind: 'director.intent',
                    handle: relayHandle,
                    intent: {
                        intentId: intentB,
                        actor: agentB.actor,
                        action: 'pose'
                    }
                },
                timeout: 30_000
            });
            const sentC = await executeOk({
                request,
                runId,
                agentId: agentC.agentId,
                commandId: 'director-intent-c',
                command: {
                    kind: 'director.intent',
                    handle: relayHandle,
                    intent: {
                        intentId: intentC,
                        actor: agentC.actor,
                        action: 'shot'
                    }
                },
                timeout: 30_000
            });
            // A relay command reports sent only once the director's receipt arrives; it carries its one handle.
            expectDirectorConfirmed(sentB);
            expectDirectorConfirmed(sentC);

            await Promise.all([
                waitForDirectorEvent(request, runId, {
                    agentId: agentA.agentId,
                    topic: 'rallar.browser.director.intent_received',
                    contains: [intentB]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentA.agentId,
                    topic: 'rallar.browser.director.intent_received',
                    contains: [intentC]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentB.agentId,
                    topic: 'rallar.browser.director.output_received',
                    contains: [intentB]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentB.agentId,
                    topic: 'rallar.browser.director.output_received',
                    contains: [intentC]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentC.agentId,
                    topic: 'rallar.browser.director.output_received',
                    contains: [intentB]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentC.agentId,
                    topic: 'rallar.browser.director.output_received',
                    contains: [intentC]
                })
            ]);

            const syncB = await executeOk({
                request,
                runId,
                agentId: agentB.agentId,
                commandId: 'director-sync-b',
                command: {
                    kind: 'director.sync.request',
                    handle: relayHandle,
                    payload: {
                        reason: 'black-box-b'
                    }
                }
            });
            const syncC = await executeOk({
                request,
                runId,
                agentId: agentC.agentId,
                commandId: 'director-sync-c',
                command: {
                    kind: 'director.sync.request',
                    handle: relayHandle,
                    payload: {
                        reason: 'black-box-c'
                    }
                }
            });
            expectDirectorConfirmed(syncB);
            expectDirectorConfirmed(syncC);
            await Promise.all([
                waitForDirectorEvent(request, runId, {
                    agentId: agentB.agentId,
                    topic: 'rallar.browser.director.snapshot_received',
                    contains: [intentB, intentC]
                }),
                waitForDirectorEvent(request, runId, {
                    agentId: agentC.agentId,
                    topic: 'rallar.browser.director.snapshot_received',
                    contains: [intentB, intentC]
                })
            ]);

            await executeOk({
                request,
                runId,
                agentId: agentA.agentId,
                commandId: 'director-relay-stop-a',
                command: {
                    kind: 'director.relay.stop',
                    handle: relayHandle
                }
            });
            await agentA.page.waitForTimeout(1_900);

            const staleB = await executeOk({
                request,
                runId,
                agentId: agentB.agentId,
                commandId: 'director-status-b-stale',
                command: {
                    kind: 'director.status',
                    ...directorRoomFields(groupId),
                    refresh: true
                }
            });
            const staleC = await executeOk({
                request,
                runId,
                agentId: agentC.agentId,
                commandId: 'director-status-c-stale',
                command: {
                    kind: 'director.status',
                    ...directorRoomFields(groupId),
                    refresh: true
                }
            });
            expect(directorStatusValue(staleB)).toMatchObject({
                role: 'client',
                state: 'stale',
                isDirector: false
            });
            expect(directorStatusValue(staleC)).toMatchObject({
                role: 'client',
                state: 'stale',
                isDirector: false
            });
            expect(requireRecord(directorStatusValue(staleB).appointment)).toMatchObject({
                sessionId: sessions.A,
                epoch
            });
            expect(requireRecord(directorStatusValue(staleC).appointment)).toMatchObject({
                sessionId: sessions.A,
                epoch
            });

            await executeOk({
                request,
                runId,
                agentId: agentB.agentId,
                commandId: 'director-relay-stop-b',
                command: {
                    kind: 'director.relay.stop',
                    handle: relayHandle
                }
            });
            await executeOk({
                request,
                runId,
                agentId: agentC.agentId,
                commandId: 'director-relay-stop-c',
                command: {
                    kind: 'director.relay.stop',
                    handle: relayHandle
                }
            });

            const run = await readControlRun(request, runId);
            const appointEvents = run.events.filter((event) =>
                runtimeEventPayload(event).topic === 'rallar.browser.director.appointed'
            );
            expect(appointEvents.map((event) => event.agentId)).toEqual([agentA.agentId]);

            // The bundle keeps the latest 200 events, which the periodic heartbeats and snapshots fill, so the
            // early intent_received events (awaited above) can fall out of it; the later sync requests stay.
            const artifacts = await exportControlRunArtifacts(request, runId);
            expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.sync_request_received');
            expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.snapshot_received');
        }
        finally {
            await closeAgents(agents);
        }
    });
});

function booleanEnv(key: string): boolean {
    const normalized = process.env[key]?.trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!isJsonRecordValue(value)) {
        throw new Error('Expected a JSON object in the control result/event.');
    }
    return value;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function eventPayload(event: ControlEventEnvelope): Record<string, unknown> {
    return requireRecord(event.payload);
}

function runtimeEventPayload(event: ControlEventEnvelope): Record<string, unknown> {
    const payload = eventPayload(event);
    return typeof payload.kind === 'string'
        ? payload
        : requireRecord(payload.payload ?? payload);
}

function runtimeEventText(event: ControlEventEnvelope): string {
    return JSON.stringify(runtimeEventPayload(event));
}

function directorRoomFields(groupId: string): DirectorRoomFields {
    return {
        roomId: groupId,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        roomRef: {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId
        }
    };
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
            body: {
                groupId: groupId,
                displayName: groupId,
                kind: 'room',
                joinMode: 'open'
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201]
        },
        timeoutMs: 10_000
    };
}

async function waitForCommandResult(input: WaitForCommandResultInput): Promise<ControlResultEnvelope> {
    const { request, runId, commandId, timeout = 45_000 } = input;
    let latest: ControlResultEnvelope | undefined;
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        latest = run.results.find((result) => result.commandId === commandId);
        return Boolean(latest);
    }, {
        timeout
    }).toBe(true);

    if (!latest) {
        throw new Error(`Command ${commandId} did not return a result.`);
    }
    return latest;
}

async function executeResult(input: ExecuteCommandInput): Promise<ControlResultEnvelope> {
    const { request, runId, agentId, commandId, command, timeout } = input;
    await enqueueControlCommand({ request, runId, agentId, commandId, command });
    return await waitForCommandResult({ request, runId, commandId, timeout });
}

async function executeOk(input: ExecuteCommandInput): Promise<ControlResultEnvelope> {
    const { request, runId, agentId, commandId, command, timeout } = input;
    const result = await executeResult({ request, runId, agentId, commandId, command, timeout });
    expect(result.ok, JSON.stringify(result.error ?? result)).toBe(true);
    return result;
}

async function waitForDirectorEvent(
    request: APIRequestContext,
    runId: string,
    input: DirectorEventExpectation
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return run.events.some((event) => {
            const payload = runtimeEventPayload(event);
            const text = runtimeEventText(event);
            return event.agentId === input.agentId &&
                payload.topic === input.topic &&
                input.contains.every((fragment) => text.includes(fragment));
        });
    }, {
        timeout: 60_000
    }).toBe(true);
}

async function openAgents(input: OpenAgentsInput): Promise<readonly [AgentHandle, AgentHandle, AgentHandle]> {
    const { browser, runId, groupId, testInfo } = input;
    const users = {
        A: config.userA,
        B: config.userB,
        C: config.userC
    } as const;
    const handles: AgentHandle[] = [];
    try {
        for (const prefix of ['A', 'B', 'C'] as const) {
            const agentId = uniqueAgentId(testInfo, `director-${prefix.toLowerCase()}`);
            const opened = await openBrowserControlAgent({
                browser,
                config,
                user: users[prefix],
                runId,
                agentId,
                groupId
            });
            handles.push({
                context: opened.context,
                page: opened.page,
                prefix,
                agentId,
                actor: users[prefix].actor,
                connection: `${agentId}-director`
            });
        }
        const [first, second, third] = handles;
        if (!first || !second || !third) {
            throw new Error('The director scenario requires three agents.');
        }
        return [first, second, third];
    }
    catch (error) {
        try {
            await closeAgents(handles);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Director acquisition and cleanup failed.', {
                cause: error
            });
        }
        throw error;
    }
}

async function closeAgents(agents: readonly AgentHandle[]): Promise<void> {
    await Promise.all(agents.map(async (agent) => {
        try {
            await cleanupRallarPage(agent.page);
        }
        finally {
            await agent.context.close();
        }
    }));
}

async function setupGroupMembership(
    request: APIRequestContext,
    runId: string,
    input: GroupMembershipInput
): Promise<void> {
    const statePrefix = `/api/state/apps/${encodeURIComponent(config.applicationId)}/workspaces/${
        encodeURIComponent(config.workspaceId)
    }`;
    // Group-state mutations are idempotent per requestId (20 to 128 characters), so each run names its own.
    const requestPrefix = `director-${crypto.randomUUID()}`;
    await executeOk({
        request,
        runId,
        agentId: input.owner.agentId,
        commandId: 'director-group-create',
        command: toDirectorGroupCreateCommand(statePrefix, requestPrefix, input.groupId)
    });

    for (const member of input.members) {
        const memberPath = `${statePrefix}/groups/${encodeURIComponent(input.groupId)}/members/{auth.clientId}`;
        await executeOk({
            request,
            runId,
            agentId: member.agentId,
            commandId: `director-group-join-${member.prefix.toLowerCase()}`,
            command: {
                kind: 'http.request',
                request: {
                    path: `${memberPath}/requests/${requestPrefix}-member-${member.prefix.toLowerCase()}`,
                    method: 'PUT',
                    body: {
                        status: 'active'
                    }
                },
                response: {
                    body: 'json',
                    acceptedStatusCodes: [200, 201]
                },
                timeoutMs: 10_000
            }
        });
    }
}

async function connectAgent(input: ConnectAgentInput): Promise<DirectorConnection> {
    const { request, runId, agent, groupId } = input;
    const commandId = `director-connect-${agent.prefix.toLowerCase()}`;
    const result = await executeOk({
        request,
        runId,
        agentId: agent.agentId,
        commandId,
        command: {
            kind: 'rtc.connect',
            connection: agent.connection,
            actor: agent.actor,
            roomId: groupId,
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            roomRef: {
                applicationId: config.applicationId,
                workspaceId: config.workspaceId,
                groupId
            },
            transport: 'realtime',
            rallar: {
                apiBaseUrl: config.apiBaseUrl,
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
                applicationId: config.applicationId,
                workspaceId: config.workspaceId,
                transport: 'realtime'
            },
            timeoutMs: 45_000
        },
        timeout: 60_000
    });
    const sessionId = stringValue(resultValue(result).sessionId);
    if (!sessionId) {
        throw new Error(`Connect result ${commandId} did not include a sessionId.`);
    }
    return { commandId, sessionId };
}

async function waitForPeerReadiness(input: WaitForPeerReadinessInput): Promise<void> {
    const { request, runId, agent, expectedPeerIds } = input;
    let attempt = 0;
    await expect.poll(async () => {
        const result = await executeResult({
            request,
            runId,
            agentId: agent.agentId,
            commandId: `director-health-${agent.prefix.toLowerCase()}-${attempt++}`,
            command: { kind: 'health' },
            timeout: 15_000
        }).catch(() => undefined);
        if (!result?.ok) {
            return [];
        }
        return stringArrayValue(
            requireRecord(requireRecord(resultValue(result).rallar).rtcStatus).readyPeerIds
        );
    }, {
        timeout: 60_000
    }).toEqual(expect.arrayContaining([...expectedPeerIds]));
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
