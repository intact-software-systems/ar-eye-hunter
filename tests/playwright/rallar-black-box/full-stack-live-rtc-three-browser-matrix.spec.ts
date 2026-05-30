import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo,
} from '@playwright/test';

const SPA_BASE_URL = 'http://localhost:5176';
const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

type TransportUnderTest = 'realtime' | 'messages.rtc';
type AgentPrefix = 'A' | 'B' | 'C';
type DeliveryMode = 'direct' | 'multicast' | 'broadcast';

type RestoredSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
}>;

type AgentAuth =
    | Readonly<{
    kind: 'login';
    username: string;
    password: string;
}>
    | Readonly<{
    kind: 'restore';
    session: RestoredSession;
}>;

type AgentHandle = Readonly<{
    context: BrowserContext;
    page: Page;
    prefix: AgentPrefix;
    agentId: string;
    actor: string;
    connection: string;
}>;

type ControlResult = Readonly<{
    agentId?: string;
    commandId?: string;
    ok?: boolean;
    result?: Readonly<{
        value?: unknown;
    }>;
    error?: unknown;
}>;

type ControlEvent = Readonly<{
    kind?: string;
    agentId?: string;
    payload?: unknown;
}>;

type ControlRunSnapshot = Readonly<{
    agents?: readonly Readonly<{ agentId?: string }>[];
    results?: readonly ControlResult[];
    events?: readonly ControlEvent[];
}>;

type DeliveryScenarioRecord = Readonly<{
    matrixId: string;
    transport: TransportUnderTest;
    deliveryMode: DeliveryMode;
    senderAgentId: string;
    expectedAgentIds: readonly string[];
    allowedAgentIds: readonly string[];
}>;

const apiBaseUrl = envValue('VITE_RALLAR_API_BASE_URL');
const roomSeed = firstEnvValue('VITE_RALLAR_ROOM_ID', 'VITE_RALLAR_GROUP_ID');
const applicationId = envValue('VITE_RALLAR_APPLICATION_ID') ?? 'ar-eye-hunter';
const workspaceId = envValue('VITE_RALLAR_WORKSPACE_ID') ?? 'default';
const messagesRtcTypeId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TYPE_ID',
    'VITE_RALLAR_TYPE_ID',
) ?? 'manual.type';
const messagesRtcTopicId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TOPIC_ID',
    'VITE_RALLAR_TOPIC_ID',
) ?? 'manual.topic';
const fullStackEnabled = booleanEnv('RALLAR_BLACK_BOX_FULL_STACK');
const liveMatrixEnabled = booleanEnv('RALLAR_BLACK_BOX_LIVE_RTC_MATRIX');
const liveAllScenariosEnabled = booleanEnv('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS');
const agentAAuth = resolveAgentAuth('A');
const agentBAuth = resolveAgentAuth('B');
const agentCAuth = resolveAgentAuth('C');
const hasThreeAgentConfig = Boolean(
    fullStackEnabled &&
    liveMatrixEnabled &&
    apiBaseUrl &&
    roomSeed &&
    agentAAuth &&
    agentBAuth &&
    agentCAuth,
);

function envValue(key: string): string | undefined {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function firstEnvValue(...keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envValue(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function booleanEnv(key: string): boolean {
    const normalized = envValue(key)?.toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function numberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveAgentAuth(prefix: AgentPrefix): AgentAuth | undefined {
    const genericUsername = prefix === 'A' ? ['VITE_RALLAR_USERNAME'] : [];
    const genericPassword = prefix === 'A' ? ['VITE_RALLAR_PASSWORD'] : [];
    const username = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        ...genericUsername,
    );
    const password = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        ...genericPassword,
    );
    if (username && password) {
        return {
            kind: 'login',
            username,
            password,
        };
    }

    const restoreUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
    );
    const token = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_TOKEN`,
        `VITE_RALLAR_${prefix}_TOKEN`,
    );
    const clientId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_CLIENT_ID`,
        `VITE_RALLAR_${prefix}_CLIENT_ID`,
    );
    const sessionId = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_SESSION_ID`,
        `VITE_RALLAR_${prefix}_SESSION_ID`,
    );
    if (!restoreUsername || !token || !clientId || !sessionId) {
        return undefined;
    }

    return {
        kind: 'restore',
        session: {
            clientId,
            accessToken: token,
            username: restoreUsername,
            sessionId,
            expiresAtEpochMs: numberEnv(`VITE_RALLAR_AGENT_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                numberEnv(`VITE_RALLAR_${prefix}_EXPIRES_AT_EPOCH_MS`) ??
                Date.now() + 30 * 60 * 1000,
        },
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

function transportSlug(transport: TransportUnderTest): string {
    return transport.replace('.', '-');
}

function agentAuth(prefix: AgentPrefix): AgentAuth {
    const auth = prefix === 'A' ? agentAAuth : prefix === 'B' ? agentBAuth : agentCAuth;
    if (!auth) {
        throw new Error(`Missing auth for agent ${prefix}.`);
    }
    return auth;
}

function apiWebSocketUrl(): string {
    const url = new URL(apiBaseUrl ?? 'http://localhost:8080');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/ws/{auth.sessionId}';
    url.search = 'ticket={auth.wsTicket}';
    return url.toString();
}

function actorFor(prefix: AgentPrefix, suffix: string): string {
    return firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_ACTOR`,
        `VITE_RALLAR_${prefix}_ACTOR`,
    ) ?? `agent-${prefix.toLowerCase()}-${suffix}`;
}

async function fetchRun(
    request: APIRequestContext,
    runId: string,
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`,
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ControlRunSnapshot;
}

async function enqueueCommand(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown,
): Promise<void> {
    const response = await request.post(
        `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
            encodeURIComponent(agentId)
        }/commands`,
        {
            data: {
                commandId,
                command,
            },
        },
    );
    expect(response.status()).toBe(202);
}

async function waitForCommandResult(
    request: APIRequestContext,
    runId: string,
    commandId: string,
    timeout = 45_000,
): Promise<ControlResult> {
    let latest: ControlResult | undefined;
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        latest = run.results?.find(result => result.commandId === commandId);
        return Boolean(latest);
    }, {
        timeout,
    }).toBe(true);

    if (!latest) {
        throw new Error(`Command ${commandId} did not return a result.`);
    }
    return latest;
}

async function executeResult(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown,
    timeout?: number,
): Promise<ControlResult> {
    await enqueueCommand(request, runId, agentId, commandId, command);
    return await waitForCommandResult(request, runId, commandId, timeout);
}

async function executeOk(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown,
    timeout?: number,
): Promise<ControlResult> {
    const result = await executeResult(request, runId, agentId, commandId, command, timeout);
    expect(result.ok).toBe(true);
    return result;
}

function resultValue(result: ControlResult): Record<string, unknown> {
    return asRecord(result.result?.value);
}

function requireSessionId(result: ControlResult, commandId: string): string {
    const sessionId = stringValue(resultValue(result).sessionId);
    if (!sessionId) {
        throw new Error(`Connect result ${commandId} did not include a sessionId.`);
    }
    return sessionId;
}

function eventPayload(event: ControlEvent): Record<string, unknown> {
    return asRecord(event.payload);
}

function runtimeEventPayload(event: ControlEvent): Record<string, unknown> {
    const payload = eventPayload(event);
    return asRecord(payload.payload ?? payload);
}

function messageData(event: ControlEvent): Record<string, unknown> {
    const runtimeEvent = runtimeEventPayload(event);
    const runtimePayload = asRecord(runtimeEvent.payload);
    return asRecord(runtimePayload.data ?? runtimeEvent.data);
}

function isMessageFor(
    event: ControlEvent,
    input: Readonly<{
        agentId: string;
        transport: TransportUnderTest;
        matrixId: string;
        deliveryMode: string;
    }>,
): boolean {
    const runtimeEvent = runtimeEventPayload(event);
    const data = messageData(event);
    return event.agentId === input.agentId &&
        runtimeEvent.kind === 'message' &&
        runtimeEvent.transport === input.transport &&
        data.matrixId === input.matrixId &&
        data.deliveryMode === input.deliveryMode;
}

async function waitForMessage(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        agentId: string;
        transport: TransportUnderTest;
        matrixId: string;
        deliveryMode: string;
    }>,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.events?.some(event => isMessageFor(event, input)) ?? false;
    }, {
        timeout: 60_000,
    }).toBe(true);
}

function rallarConnectConfig(transport: TransportUnderTest): Record<string, unknown> {
    return {
        apiBaseUrl,
        restoreSession: true,
        logoutOnClose: false,
        leaveRoomOnClose: false,
        ...(transport === 'messages.rtc'
            ? {
                typeId: messagesRtcTypeId,
                topicId: messagesRtcTopicId,
            }
            : {}),
    };
}

function sendPayload(
    transport: TransportUnderTest,
    groupId: string,
    targetSessionIds: readonly string[] | undefined,
    payload: Record<string, unknown>,
    minSnapshotVersion?: number,
): Record<string, unknown> {
    if (transport === 'messages.rtc') {
        return {
            roomId: groupId,
            ...(targetSessionIds ? { nextHopPeerIds: targetSessionIds } : {}),
            typeId: messagesRtcTypeId,
            topicId: messagesRtcTopicId,
            ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {}),
            payload,
        };
    }

    return {
        roomId: groupId,
        ...(targetSessionIds ? { peerIds: targetSessionIds } : {}),
        openTimeoutMs: 20_000,
        data: payload,
    };
}

async function openAgent(
    browser: Browser,
    input: Readonly<{
        prefix: AgentPrefix;
        auth: AgentAuth;
        runId: string;
        agentId: string;
        actor: string;
        connection: string;
        groupId: string;
    }>,
): Promise<AgentHandle> {
    const context = await browser.newContext();
    const page = await context.newPage();

    if (input.auth.kind === 'restore') {
        await page.addInitScript((session) => {
            window.localStorage.setItem('auth.session', JSON.stringify(session));
        }, input.auth.session);
    }

    const query = new URLSearchParams({
        mode: 'control',
        provider: 'browser-rallar',
        autoConnect: '1',
        tab: 'local-workbench',
        controlUrl: CONTROL_WS_URL,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: apiBaseUrl ?? '',
        roomId: input.groupId,
        actor: input.actor,
        sessionId: input.agentId,
        transport: 'realtime',
        statsIntervalMs: '2000',
        rallarLeaveRoomOnClose: '0',
        ...(booleanEnv('VITE_RALLAR_REGISTER') ? { rallarRegister: '1' } : {}),
        ...(input.auth.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
        ...(input.auth.kind === 'login'
            ? {
                rallarUsername: input.auth.username,
                rallarPassword: input.auth.password,
            }
            : {}),
    });

    await page.goto(`${SPA_BASE_URL}/?${query.toString()}`);

    if (input.auth.kind === 'login') {
        await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
        await page.getByRole('button', { name: 'Sign in' }).click();
    }

    await expect(page.getByRole('tab', { name: 'Local Workbench' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    await expect(page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered', { timeout: 30_000 });

    return {
        context,
        page,
        prefix: input.prefix,
        agentId: input.agentId,
        actor: input.actor,
        connection: input.connection,
    };
}

async function setupGroupMembership(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        owner: AgentHandle;
        members: readonly AgentHandle[];
        groupId: string;
        suffix: string;
    }>,
): Promise<readonly string[]> {
    const groupSegment = pathSegment(input.groupId);
    const createCommandId = `group-create-${input.suffix}`;
    const joinCommandIds: string[] = [];

    await executeOk(request, runId, input.owner.agentId, createCommandId, {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                pathSegment(workspaceId)
            }/groups`,
            method: 'POST',
            body: {
                groupId: input.groupId,
                displayName: input.groupId,
                description: 'Created by rallar-black-box live three-browser matrix',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: '{auth.clientId}',
                metadata: {
                    source: 'rallar-black-box',
                    matrix: 'live-three-browser',
                    suffix: input.suffix,
                },
            },
        },
        response: {
            body: 'json',
        },
        timeoutMs: 10_000,
    });

    for (const member of input.members) {
        const commandId = `group-join-${member.agentId}-${input.suffix}`;
        joinCommandIds.push(commandId);
        await executeOk(request, runId, member.agentId, commandId, {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                    pathSegment(workspaceId)
                }/groups/${groupSegment}/members/{auth.clientId}`,
                method: 'PUT',
                body: {
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
            timeoutMs: 10_000,
        });
    }

    return [createCommandId, ...joinCommandIds];
}

async function verifyGroupStateReadback(
    request: APIRequestContext,
    runId: string,
    owner: AgentHandle,
    input: Readonly<{
        groupId: string;
        suffix: string;
    }>,
): Promise<readonly string[]> {
    const groupSegment = pathSegment(input.groupId);
    const readCommandId = `group-read-${input.suffix}`;
    const eventsCommandId = `group-events-${input.suffix}`;
    const readResult = await executeOk(request, runId, owner.agentId, readCommandId, {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                pathSegment(workspaceId)
            }/groups/${groupSegment}`,
            method: 'GET',
        },
        response: {
            body: 'json',
        },
        timeoutMs: 10_000,
    });
    expect(resultValue(readResult).status).toBe(200);

    const eventsResult = await executeOk(request, runId, owner.agentId, eventsCommandId, {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${
                pathSegment(workspaceId)
            }/groups/${groupSegment}/events/page?limit=20`,
            method: 'GET',
        },
        response: {
            body: 'json',
        },
        timeoutMs: 10_000,
    });
    expect(resultValue(eventsResult).status).toBe(200);
    return [readCommandId, eventsCommandId];
}

async function configureAgentForServerCommands(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    input: Readonly<{
        groupId: string;
        suffix: string;
    }>,
): Promise<string> {
    const commandId = `configure-server-${agent.prefix.toLowerCase()}-${input.suffix}`;
    await executeOk(request, runId, agent.agentId, commandId, {
        kind: 'configure',
        config: {
            runId,
            agentId: agent.agentId,
            apiBaseUrl,
            actor: agent.actor,
            sessionId: agent.agentId,
            roomId: input.groupId,
            control: {
                mode: 'live-all-scenarios',
                providerMode: 'browser-rallar',
            },
            defaults: {
                connection: agent.connection,
                providerMode: 'browser-rallar',
            },
            rallar: {
                apiBaseUrl,
                restoreSession: true,
                leaveRoomOnClose: false,
            },
        },
    });
    return commandId;
}

async function runWebSocketOpenSendCloseMatrix(
    request: APIRequestContext,
    runId: string,
    agents: readonly AgentHandle[],
    input: Readonly<{
        groupId: string;
        suffix: string;
    }>,
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    for (const agent of agents) {
        commandIds.push(await configureAgentForServerCommands(request, runId, agent, input));
        const connection = `ws-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const openCommandId = `ws-open-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const sendCommandId = `ws-send-${agent.prefix.toLowerCase()}-${input.suffix}`;
        const closeCommandId = `ws-close-${agent.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(openCommandId, sendCommandId, closeCommandId);
        await executeOk(request, runId, agent.agentId, openCommandId, {
            kind: 'ws.open',
            connection,
            url: apiWebSocketUrl(),
            timeoutMs: 15_000,
        }, 30_000);
        await executeOk(request, runId, agent.agentId, sendCommandId, {
            kind: 'ws.send',
            connection,
            data: {
                topic: 'rallar.black-box.live-three-browser.ws',
                matrixId: `ws-${agent.prefix.toLowerCase()}-${input.suffix}`,
                agentId: agent.agentId,
                groupId: input.groupId,
                runId,
            },
        });
        await executeOk(request, runId, agent.agentId, closeCommandId, {
            kind: 'ws.close',
            connection,
            code: 1000,
            reason: 'live-all-scenarios-complete',
        });
    }
    return commandIds;
}

async function connectAgent(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    input: Readonly<{
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
    }>,
): Promise<Readonly<{ commandId: string; sessionId: string }>> {
    const commandId = `connect-${agent.prefix.toLowerCase()}-${input.transport.replace('.', '-')}-${input.suffix}`;
    const result = await executeOk(request, runId, agent.agentId, commandId, {
        kind: 'rtc.connect',
        connection: `${agent.connection}-${input.transport.replace('.', '-')}`,
        actor: agent.actor,
        roomId: input.groupId,
        applicationId,
        workspaceId,
        roomRef: {
            applicationId,
            workspaceId,
            groupId: input.groupId,
        },
        transport: input.transport,
        rallar: rallarConnectConfig(input.transport),
        timeoutMs: 45_000,
    }, 60_000);

    return {
        commandId,
        sessionId: requireSessionId(result, commandId),
    };
}

async function sendMatrixPayload(
    request: APIRequestContext,
    runId: string,
    sender: AgentHandle,
    input: Readonly<{
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
        deliveryMode: 'direct' | 'multicast' | 'broadcast';
        targetSessionIds?: readonly string[];
        matrixId: string;
    }>,
): Promise<string> {
    const commandId = `send-${input.deliveryMode}-${input.transport.replace('.', '-')}-${input.suffix}`;
    await executeOk(request, runId, sender.agentId, commandId, {
        kind: 'rtc.send',
        connection: `${sender.connection}-${input.transport.replace('.', '-')}`,
        transport: input.transport,
        applicationId,
        workspaceId,
        roomRef: {
            applicationId,
            workspaceId,
            groupId: input.groupId,
        },
        timeoutMs: 60_000,
        send: sendPayload(input.transport, input.groupId, input.targetSessionIds, {
            topic: 'rallar.black-box.live-three-browser',
            matrixId: input.matrixId,
            deliveryMode: input.deliveryMode,
            transport: input.transport,
            runId,
            groupId: input.groupId,
        }),
    }, 70_000);
    return commandId;
}

async function runDeliveryMatrix(
    request: APIRequestContext,
    runId: string,
    agents: readonly [AgentHandle, AgentHandle, AgentHandle],
    input: Readonly<{
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
    }>,
): Promise<Readonly<{
    commandIds: readonly string[];
    sessions: Readonly<Record<AgentPrefix, string>>;
    matrixIds: readonly string[];
}>> {
    const connectResults = await Promise.all(
        agents.map(agent => connectAgent(request, runId, agent, input)),
    );
    const sessions: Readonly<Record<AgentPrefix, string>> = {
        A: connectResults[0].sessionId,
        B: connectResults[1].sessionId,
        C: connectResults[2].sessionId,
    };
    expect(new Set(Object.values(sessions)).size).toBe(3);

    const [agentA, agentB, agentC] = agents;
    const directMatrixId = `direct-${input.transport}-${input.suffix}`;
    const multicastMatrixId = `multicast-${input.transport}-${input.suffix}`;
    const broadcastMatrixId = `broadcast-${input.transport}-${input.suffix}`;
    const sendDirect = await sendMatrixPayload(request, runId, agentA, {
        ...input,
        deliveryMode: 'direct',
        targetSessionIds: [sessions.B],
        matrixId: directMatrixId,
    });
    await waitForMessage(request, runId, {
        agentId: agentB.agentId,
        transport: input.transport,
        matrixId: directMatrixId,
        deliveryMode: 'direct',
    });
    await agentB.page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await expect(agentB.page.locator('#panel-manual-rallar .received-inbox-panel'))
        .toContainText(directMatrixId, { timeout: 30_000 });

    const sendMulticast = await sendMatrixPayload(request, runId, agentA, {
        ...input,
        deliveryMode: 'multicast',
        targetSessionIds: [sessions.B, sessions.C],
        matrixId: multicastMatrixId,
    });
    await Promise.all([
        waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport: input.transport,
            matrixId: multicastMatrixId,
            deliveryMode: 'multicast',
        }),
        waitForMessage(request, runId, {
            agentId: agentC.agentId,
            transport: input.transport,
            matrixId: multicastMatrixId,
            deliveryMode: 'multicast',
        }),
    ]);

    const sendBroadcast = await sendMatrixPayload(request, runId, agentA, {
        ...input,
        deliveryMode: 'broadcast',
        matrixId: broadcastMatrixId,
    });
    await Promise.all([
        waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport: input.transport,
            matrixId: broadcastMatrixId,
            deliveryMode: 'broadcast',
        }),
        waitForMessage(request, runId, {
            agentId: agentC.agentId,
            transport: input.transport,
            matrixId: broadcastMatrixId,
            deliveryMode: 'broadcast',
        }),
    ]);
    await agentC.page.getByRole('tab', { name: 'Manual Rallar' }).click();
    await expect(agentC.page.locator('#panel-manual-rallar .received-inbox-panel'))
        .toContainText(broadcastMatrixId, { timeout: 30_000 });

    if (input.transport === 'realtime') {
        const healthA = await executeOk(request, runId, agentA.agentId, `health-a-${input.suffix}`, {
            kind: 'health',
        });
        const readyPeerIds = stringArrayValue(
            asRecord(asRecord(resultValue(healthA).rallar).rtcStatus).readyPeerIds,
        );
        expect(readyPeerIds).toEqual(expect.arrayContaining([sessions.B, sessions.C]));
    }

    return {
        commandIds: [
            ...connectResults.map(result => result.commandId),
            sendDirect,
            sendMulticast,
            sendBroadcast,
        ],
        sessions,
        matrixIds: [directMatrixId, multicastMatrixId, broadcastMatrixId],
    };
}

async function runAllDeliveryPermutations(
    request: APIRequestContext,
    runId: string,
    agents: readonly [AgentHandle, AgentHandle, AgentHandle],
    input: Readonly<{
        transport: TransportUnderTest;
        groupId: string;
        suffix: string;
    }>,
): Promise<Readonly<{
    commandIds: readonly string[];
    sessions: Readonly<Record<AgentPrefix, string>>;
    scenarios: readonly DeliveryScenarioRecord[];
}>> {
    const slug = transportSlug(input.transport);
    const connectResults = await Promise.all(
        agents.map(agent => connectAgent(request, runId, agent, input)),
    );
    const sessions: Readonly<Record<AgentPrefix, string>> = {
        A: connectResults[0].sessionId,
        B: connectResults[1].sessionId,
        C: connectResults[2].sessionId,
    };
    expect(new Set(Object.values(sessions)).size).toBe(3);

    const commandIds = connectResults.map(result => result.commandId);
    const scenarios: DeliveryScenarioRecord[] = [];

    for (const sender of agents) {
        const receivers = agents.filter(agent => agent.agentId !== sender.agentId);

        for (const receiver of receivers) {
            const matrixId = `${slug}-direct-${sender.prefix.toLowerCase()}-to-${
                receiver.prefix.toLowerCase()
            }-${input.suffix}`;
            commandIds.push(await sendMatrixPayload(request, runId, sender, {
                ...input,
                deliveryMode: 'direct',
                targetSessionIds: [sessions[receiver.prefix]],
                matrixId,
            }));
            await waitForMessage(request, runId, {
                agentId: receiver.agentId,
                transport: input.transport,
                matrixId,
                deliveryMode: 'direct',
            });
            scenarios.push({
                matrixId,
                transport: input.transport,
                deliveryMode: 'direct',
                senderAgentId: sender.agentId,
                expectedAgentIds: [receiver.agentId],
                allowedAgentIds: [receiver.agentId],
            });
        }

        const multicastMatrixId = `${slug}-multicast-${sender.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(await sendMatrixPayload(request, runId, sender, {
            ...input,
            deliveryMode: 'multicast',
            targetSessionIds: receivers.map(receiver => sessions[receiver.prefix]),
            matrixId: multicastMatrixId,
        }));
        await Promise.all(receivers.map(receiver => waitForMessage(request, runId, {
            agentId: receiver.agentId,
            transport: input.transport,
            matrixId: multicastMatrixId,
            deliveryMode: 'multicast',
        })));
        scenarios.push({
            matrixId: multicastMatrixId,
            transport: input.transport,
            deliveryMode: 'multicast',
            senderAgentId: sender.agentId,
            expectedAgentIds: receivers.map(receiver => receiver.agentId),
            allowedAgentIds: receivers.map(receiver => receiver.agentId),
        });

        const broadcastMatrixId = `${slug}-broadcast-${sender.prefix.toLowerCase()}-${input.suffix}`;
        commandIds.push(await sendMatrixPayload(request, runId, sender, {
            ...input,
            deliveryMode: 'broadcast',
            matrixId: broadcastMatrixId,
        }));
        await Promise.all(receivers.map(receiver => waitForMessage(request, runId, {
            agentId: receiver.agentId,
            transport: input.transport,
            matrixId: broadcastMatrixId,
            deliveryMode: 'broadcast',
        })));
        scenarios.push({
            matrixId: broadcastMatrixId,
            transport: input.transport,
            deliveryMode: 'broadcast',
            senderAgentId: sender.agentId,
            expectedAgentIds: receivers.map(receiver => receiver.agentId),
            allowedAgentIds: agents.map(agent => agent.agentId),
        });
    }

    return {
        commandIds,
        sessions,
        scenarios,
    };
}

async function expectNoUnexpectedDeliveries(
    request: APIRequestContext,
    runId: string,
    scenarios: readonly DeliveryScenarioRecord[],
): Promise<void> {
    const run = await fetchRun(request, runId);
    const scenarioById = new Map(scenarios.map(scenario => [scenario.matrixId, scenario]));
    const unexpected = (run.events ?? [])
        .map(event => {
            const data = messageData(event);
            const matrixId = stringValue(data.matrixId);
            const scenario = matrixId ? scenarioById.get(matrixId) : undefined;
            if (!scenario || !event.agentId || scenario.allowedAgentIds.includes(event.agentId)) {
                return undefined;
            }
            return {
                matrixId,
                transport: scenario.transport,
                deliveryMode: scenario.deliveryMode,
                senderAgentId: scenario.senderAgentId,
                unexpectedAgentId: event.agentId,
                expectedAgentIds: scenario.expectedAgentIds,
            };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    expect(unexpected).toEqual([]);
}

async function runNackProbe(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    input: Readonly<{
        groupId: string;
        suffix: string;
        targetSessionId: string;
    }>,
): Promise<string> {
    const commandId = `nack-not-yet-in-sync-${input.suffix}`;
    const result = await executeResult(request, runId, agent.agentId, commandId, {
        kind: 'rtc.send',
        connection: `${agent.connection}-messages-rtc`,
        transport: 'messages.rtc',
        applicationId,
        workspaceId,
        roomRef: {
            applicationId,
            workspaceId,
            groupId: input.groupId,
        },
        minSnapshotVersion: 9_999_999,
        timeoutMs: 45_000,
        send: sendPayload('messages.rtc', input.groupId, [input.targetSessionId], {
            topic: 'rallar.black-box.live-three-browser.nack',
            matrixId: `nack-${input.suffix}`,
            deliveryMode: 'nack',
            transport: 'messages.rtc',
            runId,
            groupId: input.groupId,
        }, 9_999_999),
    }, 60_000);
    const run = await fetchRun(request, runId);
    const evidence = JSON.stringify({
        result,
        events: run.events?.filter(event => event.agentId === agent.agentId).slice(-12),
    }).toLowerCase();
    expect(
        evidence.includes('not-yet-in-sync') ||
            evidence.includes('nack') ||
            (result.ok === true && evidence.includes('minsnapshotversion')),
    ).toBe(true);
    return commandId;
}

async function expectClosedTransportFailure(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    input: Readonly<{
        groupId: string;
        suffix: string;
        targetSessionId: string;
    }>,
): Promise<readonly string[]> {
    const closeCommandId = `close-before-stale-send-${agent.prefix.toLowerCase()}-${input.suffix}`;
    await executeOk(request, runId, agent.agentId, closeCommandId, { kind: 'close' }, 45_000);

    const staleSendCommandId = `stale-send-${agent.prefix.toLowerCase()}-${input.suffix}`;
    const staleResult = await executeResult(request, runId, agent.agentId, staleSendCommandId, {
        kind: 'rtc.send',
        connection: `${agent.connection}-messages-rtc`,
        transport: 'messages.rtc',
        timeoutMs: 10_000,
        send: sendPayload('messages.rtc', input.groupId, [input.targetSessionId], {
            topic: 'rallar.black-box.live-three-browser.stale-send',
            matrixId: `stale-send-${input.suffix}`,
            deliveryMode: 'stale-send',
            transport: 'messages.rtc',
            runId,
        }),
    }, 30_000);
    expect(staleResult.ok).toBe(false);
    expect(JSON.stringify(staleResult).toLowerCase()).toMatch(/not connected|runtime|closed|connect/);
    return [closeCommandId, staleSendCommandId];
}

async function closeAndResetAgents(
    request: APIRequestContext,
    runId: string,
    agents: readonly AgentHandle[],
    suffix: string,
): Promise<readonly string[]> {
    const commandIds: string[] = [];
    for (const agent of agents) {
        const closeCommandId = `close-${agent.prefix.toLowerCase()}-${suffix}`;
        const resetCommandId = `reset-${agent.prefix.toLowerCase()}-${suffix}`;
        commandIds.push(closeCommandId, resetCommandId);
        await executeResult(request, runId, agent.agentId, closeCommandId, { kind: 'close' }, 45_000);
        await executeResult(request, runId, agent.agentId, resetCommandId, { kind: 'reset' }, 30_000);
    }
    return commandIds;
}

async function expectArtifactBundle(
    request: APIRequestContext,
    runId: string,
    commandIds: readonly string[],
): Promise<void> {
    const response = await request.get(`${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/artifacts`);
    expect(response.ok()).toBe(true);
    const bundle = await response.json() as {
        files?: Record<string, string>;
    };
    const report = bundle.files?.['report.json'] ?? '';
    const events = bundle.files?.['events.jsonl'] ?? '';
    expect(report).toContain(commandIds[0]);
    expect(events).toContain('rallar.browser');
}

async function attachRunSummary(
    request: APIRequestContext,
    testInfo: TestInfo,
    runId: string,
): Promise<void> {
    const run = await fetchRun(request, runId);
    await testInfo.attach('live-rtc-three-browser-run-summary.json', {
        body: JSON.stringify({
            runId,
            agents: run.agents?.map(agent => agent.agentId),
            resultCount: run.results?.length ?? 0,
            eventCount: run.events?.length ?? 0,
        }, null, 2),
        contentType: 'application/json',
    });
}

test.describe('full-stack live three-browser RTC matrix', () => {
    test.skip(
        !hasThreeAgentConfig,
        [
            'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1,',
            'VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and three agent credentials or restored sessions:',
            'VITE_RALLAR_AGENT_A_USERNAME/PASSWORD, VITE_RALLAR_AGENT_B_USERNAME/PASSWORD,',
            'and VITE_RALLAR_AGENT_C_USERNAME/PASSWORD.',
        ].join(' '),
    );

    test('proves direct, multicast, broadcast, NACK, stale-send, and artifact evidence with real data', async ({
        browser,
        request,
    }, testInfo) => {
        test.setTimeout(360_000);

        const suffix = `live3-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const runId = `rallar-live-three-browser-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const handles: AgentHandle[] = [];
        const commandIds: string[] = [];

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                const agent = await openAgent(browser, {
                    prefix,
                    auth: agentAuth(prefix),
                    runId,
                    agentId: `live-${prefix.toLowerCase()}-${suffix}`,
                    actor: actorFor(prefix, suffix),
                    connection: `live-${prefix.toLowerCase()}-${suffix}`,
                    groupId,
                });
                handles.push(agent);
            }

            const agents = handles as [AgentHandle, AgentHandle, AgentHandle];
            commandIds.push(...await setupGroupMembership(request, runId, {
                owner: agents[0],
                members: agents,
                groupId,
                suffix,
            }));

            const realtime = await runDeliveryMatrix(request, runId, agents, {
                transport: 'realtime',
                groupId,
                suffix,
            });
            commandIds.push(...realtime.commandIds);
            commandIds.push(...await closeAndResetAgents(request, runId, agents, `${suffix}-after-realtime`));

            const messages = await runDeliveryMatrix(request, runId, agents, {
                transport: 'messages.rtc',
                groupId,
                suffix,
            });
            commandIds.push(...messages.commandIds);
            commandIds.push(await runNackProbe(request, runId, agents[0], {
                groupId,
                suffix,
                targetSessionId: messages.sessions.B,
            }));
            commandIds.push(...await expectClosedTransportFailure(request, runId, agents[2], {
                groupId,
                suffix,
                targetSessionId: messages.sessions.B,
            }));
            commandIds.push(...await closeAndResetAgents(request, runId, [agents[0], agents[1]], `${suffix}-final`));

            await expectArtifactBundle(request, runId, commandIds);

            await expect.poll(async () => {
                const run = await fetchRun(request, runId);
                const resultIds = new Set((run.results ?? [])
                    .filter(result => result.ok === true)
                    .map(result => result.commandId));
                const topics = (run.events ?? [])
                    .map(event => stringValue(runtimeEventPayload(event).topic))
                    .filter((topic): topic is string => Boolean(topic));
                return {
                    agents: (run.agents ?? [])
                        .filter(agent => handles.some(handle => handle.agentId === agent.agentId))
                        .length,
                    keyCommandsComplete: commandIds
                        .filter(commandId => !commandId.startsWith('stale-send-'))
                        .filter(commandId => !commandId.startsWith('close-before-stale-send-'))
                        .filter(commandId => !commandId.startsWith('nack-not-yet-in-sync-'))
                        .every(commandId => resultIds.has(commandId)),
                    fakeTopicCount: topics.filter(topic => topic.startsWith('rallar.bb.fake.')).length,
                };
            }, {
                timeout: 20_000,
            }).toEqual({
                agents: 3,
                keyCommandsComplete: true,
                fakeTopicCount: 0,
            });
        } finally {
            if (handles.length > 0) {
                await attachRunSummary(request, testInfo, runId).catch(() => undefined);
            }
            await Promise.all(handles.map(async handle => {
                await executeResult(
                    request,
                    runId,
                    handle.agentId,
                    `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                    { kind: 'close' },
                    15_000,
                ).catch(() => undefined);
                await handle.context.close();
            }));
        }
    });

    test('runs every three-browser live sender and receiver scenario', async ({
        browser,
        request,
    }, testInfo) => {
        test.skip(
            !liveAllScenariosEnabled,
            'Set RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 to run the exhaustive three-browser live matrix.',
        );
        test.setTimeout(720_000);

        const suffix = `live3-all-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const runId = `rallar-live-three-browser-all-${suffix}`;
        const groupId = `${roomSeed}-${suffix}`;
        const handles: AgentHandle[] = [];
        const commandIds: string[] = [];
        const scenarios: DeliveryScenarioRecord[] = [];

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                const agent = await openAgent(browser, {
                    prefix,
                    auth: agentAuth(prefix),
                    runId,
                    agentId: `live-all-${prefix.toLowerCase()}-${suffix}`,
                    actor: actorFor(prefix, suffix),
                    connection: `live-all-${prefix.toLowerCase()}-${suffix}`,
                    groupId,
                });
                handles.push(agent);
            }

            const agents = handles as [AgentHandle, AgentHandle, AgentHandle];
            commandIds.push(...await setupGroupMembership(request, runId, {
                owner: agents[0],
                members: agents,
                groupId,
                suffix,
            }));
            commandIds.push(...await verifyGroupStateReadback(request, runId, agents[0], {
                groupId,
                suffix,
            }));
            commandIds.push(...await runWebSocketOpenSendCloseMatrix(request, runId, agents, {
                groupId,
                suffix,
            }));

            const realtime = await runAllDeliveryPermutations(request, runId, agents, {
                transport: 'realtime',
                groupId,
                suffix,
            });
            commandIds.push(...realtime.commandIds);
            scenarios.push(...realtime.scenarios);
            await expectNoUnexpectedDeliveries(request, runId, realtime.scenarios);
            commandIds.push(...await closeAndResetAgents(request, runId, agents, `${suffix}-after-realtime-all`));

            const messages = await runAllDeliveryPermutations(request, runId, agents, {
                transport: 'messages.rtc',
                groupId,
                suffix,
            });
            commandIds.push(...messages.commandIds);
            scenarios.push(...messages.scenarios);
            await expectNoUnexpectedDeliveries(request, runId, messages.scenarios);

            commandIds.push(await runNackProbe(request, runId, agents[0], {
                groupId,
                suffix,
                targetSessionId: messages.sessions.B,
            }));
            commandIds.push(...await expectClosedTransportFailure(request, runId, agents[2], {
                groupId,
                suffix,
                targetSessionId: messages.sessions.B,
            }));

            const reconnectC = await connectAgent(request, runId, agents[2], {
                transport: 'messages.rtc',
                groupId,
                suffix: `${suffix}-reconnect-c`,
            });
            commandIds.push(reconnectC.commandId);
            const reconnectMatrixId = `messages-rtc-reconnect-b-to-c-${suffix}`;
            commandIds.push(await sendMatrixPayload(request, runId, agents[1], {
                transport: 'messages.rtc',
                groupId,
                suffix,
                deliveryMode: 'direct',
                targetSessionIds: [reconnectC.sessionId],
                matrixId: reconnectMatrixId,
            }));
            await waitForMessage(request, runId, {
                agentId: agents[2].agentId,
                transport: 'messages.rtc',
                matrixId: reconnectMatrixId,
                deliveryMode: 'direct',
            });

            commandIds.push(...await closeAndResetAgents(request, runId, agents, `${suffix}-final-all`));
            await expectNoUnexpectedDeliveries(request, runId, scenarios);
            await expectArtifactBundle(request, runId, commandIds);

            await expect.poll(async () => {
                const run = await fetchRun(request, runId);
                const resultIds = new Set((run.results ?? [])
                    .filter(result => result.ok === true)
                    .map(result => result.commandId));
                const topics = (run.events ?? [])
                    .map(event => stringValue(runtimeEventPayload(event).topic))
                    .filter((topic): topic is string => Boolean(topic));
                return {
                    agents: (run.agents ?? [])
                        .filter(agent => handles.some(handle => handle.agentId === agent.agentId))
                        .length,
                    keyCommandsComplete: commandIds
                        .filter(commandId => !commandId.startsWith('stale-send-'))
                        .filter(commandId => !commandId.startsWith('close-before-stale-send-'))
                        .filter(commandId => !commandId.startsWith('nack-not-yet-in-sync-'))
                        .every(commandId => resultIds.has(commandId)),
                    fakeTopicCount: topics.filter(topic => topic.startsWith('rallar.bb.fake.')).length,
                    scenarioCount: scenarios.length,
                };
            }, {
                timeout: 20_000,
            }).toEqual({
                agents: 3,
                keyCommandsComplete: true,
                fakeTopicCount: 0,
                scenarioCount: 24,
            });
        } finally {
            if (handles.length > 0) {
                await attachRunSummary(request, testInfo, runId).catch(() => undefined);
            }
            await Promise.all(handles.map(async handle => {
                await executeResult(
                    request,
                    runId,
                    handle.agentId,
                    `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                    { kind: 'close' },
                    15_000,
                ).catch(() => undefined);
                await handle.context.close();
            }));
        }
    });
});
