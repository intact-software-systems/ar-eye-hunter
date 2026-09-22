import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo
} from '@playwright/test';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcConnectReadiness
} from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject, ApiJsonValue } from '../../../packages/shared/api/api-json-value.ts';

import type {
    BrowserRallarSmokeConfig,
    SmokeAgentAuth,
    SmokeTransport
} from './browser-rallar-smoke-config.ts';

const SPA_BASE_URL = 'http://127.0.0.1:5176';
const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

interface ControlResult {
    readonly commandId: string | undefined;
    readonly ok: boolean;
    readonly value: ApiJsonValue | undefined;
}

interface ControlEvent {
    readonly agentId: string | undefined;
    readonly payload: ApiJsonValue | undefined;
}

interface ControlRunSnapshot {
    readonly agentIds: readonly (string | undefined)[];
    readonly results: readonly ControlResult[];
    readonly events: readonly ControlEvent[];
    readonly stats: readonly ControlEvent[];
    readonly reports: readonly ControlEvent[];
}

interface MessageExpectation {
    readonly agentId: string;
    readonly transport: SmokeTransport;
    readonly smokeId: string;
    readonly direction: string;
}

interface HealthSnapshot {
    readonly phase: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly value: ApiJsonValue | undefined;
}

export namespace BrowserRallarTwoAgentSmoke {
    export interface Dependencies {
        readonly browser: Browser;
        readonly request: APIRequestContext;
        readonly config: BrowserRallarSmokeConfig;
        readonly transport: SmokeTransport;
        readonly suffix: string;
        readonly runId: string;
    }

    export interface Agent {
        readonly page: Page;
        readonly agentId: string;
        readonly actor: string;
        readonly connection: string;
    }

    export interface ConnectedAgent {
        readonly agent: Agent;
        readonly sessionId: string;
    }

    export interface ConnectionConfig {
        readonly rallar: RallarBlackBoxTestRecord;
        readonly readiness: RallarBlackBoxTestRtcConnectReadiness | undefined;
    }

    export interface Delivery {
        readonly sender: ConnectedAgent;
        readonly receiver: ConnectedAgent;
        readonly commandId: string;
        readonly smokeId: string;
        readonly direction: string;
        readonly topic: string;
        readonly timeoutMs: number;
        readonly visibleInbox: boolean;
    }

    export interface HealthExpectation {
        readonly phase: string;
        readonly connected: boolean;
        readonly readyPeerId: string | undefined;
        readonly reconnectSuppressed: boolean;
    }

    export interface ControlCommand {
        readonly agent: Agent;
        readonly commandId: string;
        readonly command: RallarBlackBoxTestCommand;
    }
}

export class BrowserRallarTwoAgentSmoke {
    private readonly dependencies: BrowserRallarTwoAgentSmoke.Dependencies;
    private readonly contexts: BrowserContext[] = [];
    private readonly agents: BrowserRallarTwoAgentSmoke.Agent[] = [];
    private readonly commandIds: string[] = [];
    private readonly messages: MessageExpectation[] = [];
    private readonly snapshots: HealthSnapshot[] = [];

    constructor(dependencies: BrowserRallarTwoAgentSmoke.Dependencies) {
        this.dependencies = dependencies;
    }

    async openAgent(side: 'a' | 'b'): Promise<BrowserRallarTwoAgentSmoke.Agent> {
        const { browser, config, suffix } = this.dependencies;
        const auth = side === 'a' ? config.agentAAuth : config.agentBAuth;
        if (!auth) {
            throw new Error(`Agent ${side} requires configured authentication.`);
        }
        const context = await browser.newContext();
        this.contexts.push(context);
        const page = await context.newPage();
        const agent = {
            page,
            agentId: `real-rallar-${side}-${suffix}`,
            actor: (side === 'a' ? config.agentAActor : config.agentBActor) ?? `agent-${side}-${suffix}`,
            connection: `agent-${side}-rtc-${suffix}`
        };
        this.agents.push(agent);
        if (auth.kind === 'restore') {
            await page.addInitScript((session) => {
                window.localStorage.setItem('auth.session', JSON.stringify(session));
            }, auth.session);
        }
        await page.goto(this.toAgentUrl(agent, auth));
        if (auth.kind === 'login') {
            await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
            await page.getByRole('button', { name: 'Sign in' }).click();
        }
        await expect(page.getByRole('button', { name: 'Local Workbench', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Local Workbench', exact: true }).click();
        await expect(page.locator('#panel-local-workbench .control-panel')).toContainText('registered');
        return agent;
    }

    async joinRoom(owner: BrowserRallarTwoAgentSmoke.Agent): Promise<void> {
        const { config, suffix } = this.dependencies;
        const groupId = config.roomId!;
        await this.writeCommand({
            agent: owner,
            commandId: `group-create-${suffix}`,
            command: {
                kind: 'http.request',
                request: {
                    path: `/api/state/apps/ar-eye-hunter/workspaces/default/groups/requests/${
                        encodeURIComponent(`group-create-${suffix}`)
                    }`,
                    method: 'POST',
                    body: {
                        groupId,
                        displayName: groupId,
                        description: 'Created by rallar-black-box two-agent smoke',
                        kind: 'room',
                        joinMode: 'open',
                        createdByPrincipalId: '{auth.clientId}',
                        metadata: { source: 'rallar-black-box', smoke: 'two-agent' }
                    }
                },
                response: { body: 'json' },
                timeoutMs: 5_000
            }
        });
        for (const agent of this.agents) {
            await this.writeCommand({
                agent,
                commandId: `group-join-${agent.agentId}-${suffix}`,
                command: {
                    kind: 'http.request',
                    request: {
                        path: `/api/state/apps/ar-eye-hunter/workspaces/default/groups/${
                            encodeURIComponent(groupId)
                        }/members/{auth.clientId}/requests/${
                            encodeURIComponent(`group-join-${agent.agentId}-${suffix}`)
                        }`,
                        method: 'PUT',
                        body: { status: 'active' }
                    },
                    response: { body: 'json' },
                    timeoutMs: 5_000
                }
            });
        }
    }

    async connect(
        agent: BrowserRallarTwoAgentSmoke.Agent,
        commandId: string,
        connectionConfig: BrowserRallarTwoAgentSmoke.ConnectionConfig
    ): Promise<BrowserRallarTwoAgentSmoke.ConnectedAgent> {
        const { config, transport } = this.dependencies;
        const result = await this.writeCommand({
            agent,
            commandId,
            command: {
                kind: 'rtc.connect',
                connection: agent.connection,
                actor: agent.actor,
                roomId: config.roomId,
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                transport,
                rallar: connectionConfig.rallar,
                readiness: connectionConfig.readiness,
                timeoutMs: 30_000
            }
        });
        const sessionId = toStringValue(toRecord(result.value).sessionId);
        if (!sessionId) {
            throw new Error(`Connect result ${commandId} did not include a sessionId.`);
        }
        return { agent, sessionId };
    }

    async deliver(delivery: BrowserRallarTwoAgentSmoke.Delivery): Promise<void> {
        const { transport, runId } = this.dependencies;
        await this.writeCommand({
            agent: delivery.sender.agent,
            commandId: delivery.commandId,
            command: {
                kind: 'rtc.send',
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                connection: delivery.sender.agent.connection,
                transport,
                timeoutMs: delivery.timeoutMs,
                send: this.toSendPayload(delivery.receiver.sessionId, {
                    topic: delivery.topic,
                    smokeId: delivery.smokeId,
                    direction: delivery.direction,
                    transport,
                    runId
                })
            }
        });
        const message = {
            agentId: delivery.receiver.agent.agentId,
            transport,
            smokeId: delivery.smokeId,
            direction: delivery.direction
        };
        this.messages.push(message);
        await expect.poll(async () => {
            const run = await this.readRun();
            return run.events.some((event) => isMessageFor(event, message));
        }, { timeout: 45_000 }).toBe(true);
        if (delivery.visibleInbox) {
            const page = delivery.receiver.agent.page;
            await page.getByRole('button', { name: 'Manual Rallar', exact: true }).click();
            await expect(page.locator('#panel-manual-rallar .received-inbox-panel')).toContainText(delivery.smokeId);
        }
    }

    async expectHealth(
        connectedAgent: BrowserRallarTwoAgentSmoke.ConnectedAgent,
        expected: BrowserRallarTwoAgentSmoke.HealthExpectation
    ): Promise<void> {
        const { agent, sessionId } = connectedAgent;
        const commandId = `health-${agent.agentId}-${expected.phase}-${this.dependencies.suffix}`;
        const result = await this.writeCommand({ agent, commandId, command: { kind: 'health' } });
        this.snapshots.push({ phase: expected.phase, agentId: agent.agentId, commandId, value: result.value });
        const rallar = toRecord(toRecord(result.value).rallar);
        expect(rallar.connected).toBe(expected.connected);
        if (expected.reconnectSuppressed) {
            const wsStatus = toRecord(rallar.wsStatus);
            expect(wsStatus.readyState).toBe('missing');
            expect(wsStatus.reconnecting).toBe(false);
            expect(wsStatus.reconnectEnabled).toBe(false);
            expect(wsStatus.reconnectExhausted).toBe(false);
            return;
        }
        expect(toStringValue(toRecord(rallar.session).sessionId)).toBe(sessionId);
        if (expected.readyPeerId !== undefined) {
            const readyPeerIds = toRecord(rallar.rtcStatus).readyPeerIds;
            expect(Array.isArray(readyPeerIds) ? readyPeerIds.filter((value) => typeof value === 'string') : [])
                .toContain(expected.readyPeerId);
        }
    }

    async reloadAgent(agent: BrowserRallarTwoAgentSmoke.Agent): Promise<void> {
        await agent.page.reload({ waitUntil: 'domcontentloaded' });
        await expect(agent.page.getByRole('button', { name: 'Local Workbench', exact: true })).toBeVisible({
            timeout: 30_000
        });
        await agent.page.getByRole('button', { name: 'Local Workbench', exact: true }).click();
        await expect(agent.page.locator('#panel-local-workbench .control-panel'))
            .toContainText('registered', { timeout: 30_000 });
    }

    async disconnectAgent(agent: BrowserRallarTwoAgentSmoke.Agent): Promise<void> {
        const result = await this.writeCommand({
            agent,
            commandId: `close-b-${this.dependencies.suffix}`,
            command: { kind: 'close' }
        });
        expect(toRecord(toRecord(result.value).rallar)).toMatchObject({ status: 'closed', disconnected: true });
        await agent.page.waitForTimeout(1_000);
    }

    async finalizeAgent(agent: BrowserRallarTwoAgentSmoke.Agent): Promise<void> {
        const { suffix } = this.dependencies;
        await this.writeCommand({ agent, commandId: `health-${agent.agentId}-${suffix}`, command: { kind: 'health' } });
        await this.writeCommand({ agent, commandId: `stats-${agent.agentId}-${suffix}`, command: { kind: 'stats' } });
        await this.writeCommand({
            agent,
            commandId: `report-${agent.agentId}-${suffix}`,
            command: {
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: `two-agent-final-report-${agent.agentId}-${suffix}`,
                    commands: [{ kind: 'health', commandId: `report-health-${agent.agentId}-${suffix}` }]
                }
            }
        });
        await this.writeCommand({ agent, commandId: `close-${agent.agentId}-${suffix}`, command: { kind: 'close' } });
        await this.writeCommand({ agent, commandId: `reset-${agent.agentId}-${suffix}`, command: { kind: 'reset' } });
    }

    async expectEvidence(kind: 'delivery' | 'reload' | 'disconnect'): Promise<void> {
        await expect.poll(async () => {
            const run = await this.readRun();
            const resultIds = new Set(run.results.filter((result) => result.ok).map((result) => result.commandId));
            const deliveryMessages = run.events.filter((event) =>
                this.messages.some((message) => isMessageFor(event, message))
            );
            const evidence = {
                resultsComplete: this.commandIds.every((commandId) => resultIds.has(commandId)),
                messagesReceived: deliveryMessages.length >= (kind === 'reload' ? 3 : 2)
            };
            if (kind === 'disconnect') {
                return evidence;
            }
            const agentIds = new Set(this.agents.map((agent) => agent.agentId));
            const topology = {
                agents: run.agentIds.filter((agentId) => agentId !== undefined && agentIds.has(agentId)).length,
                fakeTopicCount: run.events.filter((event) =>
                    toStringValue(toRecord(event.payload).topic)?.startsWith('rallar.bb.fake.')
                ).length
            };
            if (kind === 'reload') {
                return { ...evidence, ...topology };
            }
            return {
                ...evidence,
                ...topology,
                statsAgents: new Set(
                    run.stats.map((event) =>
                        event.agentId
                    ).filter((id) => id !== undefined && agentIds.has(id))
                ).size,
                reportAgents: new Set(
                    run.reports.map((event) => event.agentId).filter((id) => id !== undefined && agentIds.has(id))
                ).size
            };
        }, { timeout: 20_000 }).toEqual({
            resultsComplete: true,
            messagesReceived: true,
            ...(kind !== 'disconnect' ? { agents: 2, fakeTopicCount: 0 } : {}),
            ...(kind === 'delivery' ? { statsAgents: 2, reportAgents: 2 } : {})
        });
    }

    async close(testInfo: TestInfo, attachmentName: string | undefined): Promise<void> {
        try {
            if (attachmentName !== undefined && this.snapshots.length > 0) {
                await testInfo.attach(attachmentName, {
                    body: JSON.stringify(
                        {
                            runId: this.dependencies.runId,
                            transport: this.dependencies.transport,
                            snapshots: this.snapshots
                        },
                        null,
                        2
                    ),
                    contentType: 'application/json'
                });
            }
        }
        finally {
            await Promise.all(this.contexts.map((context) => context.close()));
        }
    }

    toConnectConfig(): RallarBlackBoxTestRecord {
        const { config, transport } = this.dependencies;
        return {
            ...(config.register !== undefined ? { register: config.register } : {}),
            ...(config.logoutOnClose ? { logoutOnClose: true } : {}),
            ...(config.leaveRoomOnClose !== undefined ? { leaveRoomOnClose: config.leaveRoomOnClose } : {}),
            ...(transport === 'messages.rtc'
                ? { typeId: config.messagesRtcTypeId, topicId: config.messagesRtcTopicId }
                : {})
        };
    }

    private toAgentUrl(agent: BrowserRallarTwoAgentSmoke.Agent, auth: SmokeAgentAuth): string {
        const { config, transport, runId } = this.dependencies;
        const query = new URLSearchParams({
            mode: 'control',
            provider: 'browser-rallar',
            autoConnect: '1',
            tab: 'local-workbench',
            controlUrl: CONTROL_WS_URL,
            runId,
            agentId: agent.agentId,
            apiBaseUrl: config.apiBaseUrl ?? '',
            roomId: config.roomId ?? '',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            actor: agent.actor,
            sessionId: agent.agentId,
            transport,
            statsIntervalMs: '2000',
            ...(auth.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
            ...(auth.kind === 'login' ? { rallarUsername: auth.username, rallarPassword: auth.password } : {})
        });
        return `${SPA_BASE_URL}/?${query.toString()}`;
    }

    private toSendPayload(targetSessionId: string, payload: ApiJsonObject): RallarBlackBoxTestRecord {
        const { config, transport } = this.dependencies;
        return transport === 'messages.rtc'
            ? {
                roomId: config.roomId,
                nextHopPeerIds: [targetSessionId],
                typeId: config.messagesRtcTypeId,
                topicId: config.messagesRtcTopicId,
                payload
            }
            : { roomId: config.roomId, peerIds: [targetSessionId], openTimeoutMs: 20_000, data: payload };
    }

    private async writeCommand(controlCommand: BrowserRallarTwoAgentSmoke.ControlCommand): Promise<ControlResult> {
        const { request, runId } = this.dependencies;
        const { agent, commandId, command } = controlCommand;
        this.commandIds.push(commandId);
        const response = await request.post(
            `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
                encodeURIComponent(agent.agentId)
            }/commands`,
            { data: { commandId, command } }
        );
        expect(response.status()).toBe(202);
        let latest: ControlResult | undefined;
        await expect.poll(async () => {
            const run = await this.readRun();
            latest = run.results.find((result) => result.commandId === commandId);
            return latest?.ok === true;
        }, { timeout: 45_000 }).toBe(true);
        if (!latest) {
            throw new Error(`Command ${commandId} did not return a result.`);
        }
        return latest;
    }

    private async readRun(): Promise<ControlRunSnapshot> {
        const { request, runId } = this.dependencies;
        const response = await request.get(`${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`);
        expect(response.ok()).toBe(true);
        const run = toRecord(await response.json());
        return {
            agentIds: toRecords(run.agents).map((agent) => toStringValue(agent.agentId)),
            results: toRecords(run.results).map((result) => ({
                commandId: toStringValue(result.commandId),
                ok: result.ok === true,
                value: toRecord(result.result).value
            })),
            events: toControlEvents(run.events),
            stats: toControlEvents(run.stats),
            reports: toControlEvents(run.reports)
        };
    }
}

function toRecord(value: ApiJsonValue | undefined): ApiJsonObject {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiJsonObject : {};
}

function toRecords(value: ApiJsonValue | undefined): readonly ApiJsonObject[] {
    return Array.isArray(value) ? value.map(toRecord) : [];
}

function toStringValue(value: ApiJsonValue | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toControlEvents(value: ApiJsonValue | undefined): readonly ControlEvent[] {
    return toRecords(value).map((event) => ({ agentId: toStringValue(event.agentId), payload: event.payload }));
}

function isMessageFor(event: ControlEvent, message: MessageExpectation): boolean {
    const payload = toRecord(event.payload);
    const data = toRecord(toRecord(payload.payload).data);
    return event.agentId === message.agentId && payload.kind === 'message' &&
        payload.transport === message.transport && data.smokeId === message.smokeId &&
        data.direction === message.direction;
}
