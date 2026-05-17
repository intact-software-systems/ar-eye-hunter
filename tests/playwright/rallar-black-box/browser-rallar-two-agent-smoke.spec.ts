import {
    expect,
    test,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo,
} from '@playwright/test';

const SPA_BASE_URL = 'http://127.0.0.1:5176';
const CONTROL_BASE_URL = 'http://127.0.0.1:5180';
const CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';

type ControlResult = Readonly<{
    agentId?: string;
    commandId?: string;
    ok?: boolean;
    result?: Readonly<{
        value?: unknown;
    }>;
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
    stats?: readonly ControlEvent[];
    reports?: readonly ControlEvent[];
}>;

type TransportUnderTest = 'realtime' | 'messages.rtc';

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

type RestoredSession = Readonly<{
    clientId: string;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
}>;

type AgentHandle = Readonly<{
    context: BrowserContext;
    page: Page;
    agentId: string;
    actor: string;
    connection: string;
}>;

type RtcReloadHealthSnapshot = Readonly<{
    phase: string;
    agentId: string;
    commandId: string;
    value: unknown;
}>;

const apiBaseUrl = envValue('VITE_RALLAR_API_BASE_URL');
const roomId = envValue('VITE_RALLAR_ROOM_ID');
const messagesRtcTypeId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TYPE_ID',
    'VITE_RALLAR_TYPE_ID',
) ?? 'manual.type';
const messagesRtcTopicId = firstEnvValue(
    'VITE_RALLAR_MESSAGES_RTC_TOPIC_ID',
    'VITE_RALLAR_TOPIC_ID',
) ?? 'manual.topic';

const agentAAuth = resolveAgentAuth('A');
const agentBAuth = resolveAgentAuth('B');
const hasTwoAgentConfig = Boolean(apiBaseUrl && roomId && agentAAuth && agentBAuth);

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

function registerMode(): boolean | 'if-needed' | undefined {
    const value = envValue('VITE_RALLAR_REGISTER')?.toLowerCase();
    if (value === 'if-needed') {
        return 'if-needed';
    }
    return booleanEnv('VITE_RALLAR_REGISTER') ? true : undefined;
}

function numberEnv(key: string): number | undefined {
    const parsed = Number.parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveAgentAuth(prefix: 'A' | 'B'): AgentAuth | undefined {
    const username = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        'VITE_RALLAR_USERNAME',
    );
    const password = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        'VITE_RALLAR_PASSWORD',
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

function pathSegment(value: string): string {
    return encodeURIComponent(value);
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

async function waitForCommandOk(
    request: APIRequestContext,
    runId: string,
    commandId: string,
    timeout = 45_000,
): Promise<ControlResult> {
    let latest: ControlResult | undefined;
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        latest = run.results?.find(result => result.commandId === commandId);
        return latest?.ok === true;
    }, {
        timeout,
    }).toBe(true);

    if (!latest) {
        throw new Error(`Command ${commandId} did not return a result.`);
    }
    return latest;
}

async function executeOk(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown,
    timeout?: number,
): Promise<ControlResult> {
    await enqueueCommand(request, runId, agentId, commandId, command);
    return await waitForCommandOk(request, runId, commandId, timeout);
}

function resultValue(result: ControlResult): Record<string, unknown> {
    return asRecord(result.result?.value);
}

function rallarHealthValue(result: ControlResult): Record<string, unknown> {
    return asRecord(resultValue(result).rallar);
}

function rtcStatusValue(result: ControlResult): Record<string, unknown> {
    return asRecord(rallarHealthValue(result).rtcStatus);
}

function wsStatusValue(result: ControlResult): Record<string, unknown> {
    return asRecord(rallarHealthValue(result).wsStatus);
}

function stringArrayValue(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function expectRallarHealthConnected(
    result: ControlResult,
    expected: boolean,
): void {
    expect(rallarHealthValue(result).connected).toBe(expected);
}

function expectRallarHealthSession(
    result: ControlResult,
    expectedSessionId: string,
): void {
    expect(stringValue(asRecord(rallarHealthValue(result).session).sessionId))
        .toBe(expectedSessionId);
}

function expectRtcPeerReady(
    result: ControlResult,
    expectedPeerId: string,
): void {
    expect(stringArrayValue(rtcStatusValue(result).readyPeerIds))
        .toContain(expectedPeerId);
}

function expectWsReconnectSuppressed(result: ControlResult): void {
    const wsStatus = wsStatusValue(result);
    expect(rallarHealthValue(result).connected).toBe(false);
    expect(wsStatus.readyState).toBe('missing');
    expect(wsStatus.reconnecting).toBe(false);
    expect(wsStatus.reconnectEnabled).toBe(false);
    expect(wsStatus.reconnectExhausted).toBe(false);
}

function requireSessionId(result: ControlResult, commandId: string): string {
    const sessionId = stringValue(resultValue(result).sessionId);
    if (!sessionId) {
        throw new Error(`Connect result ${commandId} did not include a sessionId.`);
    }
    return sessionId;
}

async function openAgent(
    browser: Browser,
    input: Readonly<{
        auth: AgentAuth;
        runId: string;
        agentId: string;
        actor: string;
        connection: string;
        transport: TransportUnderTest;
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
        roomId: roomId ?? '',
        actor: input.actor,
        sessionId: input.agentId,
        transport: input.transport,
        statsIntervalMs: '2000',
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

    await expect(page.getByRole('tab', { name: 'Local Workbench' })).toBeVisible();
    await page.getByRole('tab', { name: 'Local Workbench' }).click();
    await expect(page.locator('#panel-local-workbench .control-panel')).toContainText('registered');

    return {
        context,
        page,
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
        suffix: string;
    }>,
): Promise<readonly string[]> {
    const groupId = roomId!;
    const groupSegment = pathSegment(groupId);
    const createCommandId = `group-create-${input.suffix}`;
    const joinCommandIds: string[] = [];

    await executeOk(request, runId, input.owner.agentId, createCommandId, {
        kind: 'http.request',
        request: {
            path: '/api/state/apps/ar-eye-hunter/workspaces/default/groups',
            method: 'POST',
            body: {
                groupId,
                displayName: groupId,
                description: 'Created by rallar-black-box two-agent smoke',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: '{auth.clientId}',
                metadata: {
                    source: 'rallar-black-box',
                    smoke: 'two-agent',
                },
            },
        },
        response: {
            body: 'json',
        },
        timeoutMs: 5_000,
    });

    for (const member of input.members) {
        const commandId = `group-join-${member.agentId}-${input.suffix}`;
        joinCommandIds.push(commandId);
        await executeOk(request, runId, member.agentId, commandId, {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/ar-eye-hunter/workspaces/default/groups/${groupSegment}/members/{auth.clientId}`,
                method: 'PUT',
                body: {
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
            timeoutMs: 5_000,
        });
    }

    return [
        createCommandId,
        ...joinCommandIds,
    ];
}

function rallarConnectConfig(transport: TransportUnderTest): Record<string, unknown> {
    const rallar: Record<string, unknown> = {};
    const register = registerMode();
    if (register !== undefined) {
        rallar.register = register;
    }
    if (booleanEnv('VITE_RALLAR_LOGOUT_ON_CLOSE')) {
        rallar.logoutOnClose = true;
    }
    if (envValue('VITE_RALLAR_LEAVE_ROOM_ON_CLOSE')) {
        rallar.leaveRoomOnClose = booleanEnv('VITE_RALLAR_LEAVE_ROOM_ON_CLOSE');
    }
    if (transport === 'messages.rtc') {
        rallar.typeId = messagesRtcTypeId;
        rallar.topicId = messagesRtcTopicId;
    }
    return rallar;
}

function rallarRestoreConnectConfig(
    transport: TransportUnderTest,
    expectedSessionId: string,
): Record<string, unknown> {
    return {
        ...rallarConnectConfig(transport),
        username: null,
        password: null,
        restoreSession: true,
        expectedSessionId,
    };
}

function sendPayload(
    transport: TransportUnderTest,
    targetSessionId: string,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    if (transport === 'messages.rtc') {
        return {
            roomId,
            nextHopPeerIds: [targetSessionId],
            typeId: messagesRtcTypeId,
            topicId: messagesRtcTopicId,
            payload,
        };
    }

    return {
        roomId,
        peerIds: [targetSessionId],
        openTimeoutMs: 20_000,
        data: payload,
    };
}

function eventPayload(event: ControlEvent): Record<string, unknown> {
    return asRecord(event.payload);
}

function messageData(event: ControlEvent): Record<string, unknown> {
    return asRecord(asRecord(eventPayload(event).payload).data);
}

function isMessageFor(
    event: ControlEvent,
    input: Readonly<{
        agentId: string;
        transport: TransportUnderTest;
        smokeId: string;
        direction: string;
    }>,
): boolean {
    const payload = eventPayload(event);
    const data = messageData(event);
    return event.agentId === input.agentId &&
        payload.kind === 'message' &&
        payload.transport === input.transport &&
        data.smokeId === input.smokeId &&
        data.direction === input.direction;
}

async function waitForMessage(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        agentId: string;
        transport: TransportUnderTest;
        smokeId: string;
        direction: string;
    }>,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchRun(request, runId);
        return run.events?.some(event => isMessageFor(event, input)) ?? false;
    }, {
        timeout: 45_000,
    }).toBe(true);
}

async function reloadAgent(agent: AgentHandle): Promise<void> {
    await agent.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(agent.page.getByRole('tab', { name: 'Local Workbench' }))
        .toBeVisible({ timeout: 30_000 });
    await agent.page.getByRole('tab', { name: 'Local Workbench' }).click();
    await expect(agent.page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered', { timeout: 30_000 });
}

async function captureHealthSnapshot(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    input: Readonly<{
        phase: string;
        suffix: string;
        snapshots: RtcReloadHealthSnapshot[];
        commandIds: string[];
    }>,
): Promise<ControlResult> {
    const commandId = `health-${agent.agentId}-${input.phase}-${input.suffix}`;
    const result = await executeOk(request, runId, agent.agentId, commandId, {
        kind: 'health',
    });
    input.commandIds.push(commandId);
    input.snapshots.push({
        phase: input.phase,
        agentId: agent.agentId,
        commandId,
        value: result.result?.value,
    });
    return result;
}

async function runFinalizationCommands(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    suffix: string,
): Promise<readonly string[]> {
    const commandIds = [
        `health-${agent.agentId}-${suffix}`,
        `stats-${agent.agentId}-${suffix}`,
        `report-${agent.agentId}-${suffix}`,
        `close-${agent.agentId}-${suffix}`,
        `reset-${agent.agentId}-${suffix}`,
    ];

    await executeOk(request, runId, agent.agentId, commandIds[0], { kind: 'health' });
    await executeOk(request, runId, agent.agentId, commandIds[1], { kind: 'stats' });
    await executeOk(request, runId, agent.agentId, commandIds[2], {
        kind: 'recipe.run',
        recipe: {
            recipeId: `two-agent-final-report-${agent.agentId}-${suffix}`,
            commands: [
                {
                    kind: 'health',
                    commandId: `report-health-${agent.agentId}-${suffix}`,
                },
            ],
        },
    });
    await executeOk(request, runId, agent.agentId, commandIds[3], { kind: 'close' });
    await executeOk(request, runId, agent.agentId, commandIds[4], { kind: 'reset' });

    return commandIds;
}

async function runTwoAgentReloadDelivery(
    browser: Browser,
    request: APIRequestContext,
    transport: TransportUnderTest,
    testInfo: TestInfo,
): Promise<void> {
    const suffix = `${transport.replace('.', '-')}-reload-${Date.now()}-${
        Math.random().toString(16).slice(2)
    }`;
    const runId = `real-rallar-two-agent-reload-${suffix}`;
    const agentAId = `real-rallar-a-${suffix}`;
    const agentBId = `real-rallar-b-${suffix}`;
    const handles: AgentHandle[] = [];
    const healthSnapshots: RtcReloadHealthSnapshot[] = [];
    const healthSnapshotCommandIds: string[] = [];

    try {
        const agentA = await openAgent(browser, {
            auth: agentAAuth!,
            runId,
            agentId: agentAId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_A_ACTOR', 'VITE_RALLAR_A_ACTOR') ??
                `agent-a-${suffix}`,
            connection: `agent-a-rtc-${suffix}`,
            transport,
        });
        handles.push(agentA);

        const agentB = await openAgent(browser, {
            auth: agentBAuth!,
            runId,
            agentId: agentBId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_B_ACTOR', 'VITE_RALLAR_B_ACTOR') ??
                `agent-b-${suffix}`,
            connection: `agent-b-rtc-${suffix}`,
            transport,
        });
        handles.push(agentB);

        const setupCommandIds = await setupGroupMembership(request, runId, {
            owner: agentA,
            members: [agentA, agentB],
            suffix,
        });

        const connectACommandId = `connect-a-${suffix}`;
        const connectBCommandId = `connect-b-${suffix}`;
        const connectA = await executeOk(request, runId, agentA.agentId, connectACommandId, {
            kind: 'rtc.connect',
            connection: agentA.connection,
            actor: agentA.actor,
            roomId,
            transport,
            rallar: {
                ...rallarConnectConfig(transport),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        const connectB = await executeOk(request, runId, agentB.agentId, connectBCommandId, {
            kind: 'rtc.connect',
            connection: agentB.connection,
            actor: agentB.actor,
            roomId,
            transport,
            rallar: {
                ...rallarConnectConfig(transport),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        const sessionA = requireSessionId(connectA, connectACommandId);
        const sessionB = requireSessionId(connectB, connectBCommandId);
        expect(sessionA).not.toBe(sessionB);

        const beforeReloadSmokeId = `before-reload-${suffix}`;
        const sendBeforeReloadCommandId = `send-before-reload-${suffix}`;
        await executeOk(request, runId, agentA.agentId, sendBeforeReloadCommandId, {
            kind: 'rtc.send',
            connection: agentA.connection,
            transport,
            timeoutMs: 30_000,
            send: sendPayload(transport, sessionB, {
                topic: 'rallar.black-box.reload',
                smokeId: beforeReloadSmokeId,
                direction: 'a-to-b-before-reload',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport,
            smokeId: beforeReloadSmokeId,
            direction: 'a-to-b-before-reload',
        });

        const healthABeforeReload = await captureHealthSnapshot(request, runId, agentA, {
            phase: 'before-reload-ready',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        const healthBBeforeReload = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'before-reload-ready',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthABeforeReload, true);
        expectRallarHealthConnected(healthBBeforeReload, true);
        expectRallarHealthSession(healthABeforeReload, sessionA);
        expectRallarHealthSession(healthBBeforeReload, sessionB);
        expectRtcPeerReady(healthABeforeReload, sessionB);
        expectRtcPeerReady(healthBBeforeReload, sessionA);

        await reloadAgent(agentB);

        const healthBAfterPageReload = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'after-page-reload-before-reconnect',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthBAfterPageReload, false);
        expectRallarHealthSession(healthBAfterPageReload, sessionB);

        const reconnectBCommandId = `connect-b-after-reload-${suffix}`;
        const reconnectB = await executeOk(request, runId, agentB.agentId, reconnectBCommandId, {
            kind: 'rtc.connect',
            connection: agentB.connection,
            actor: agentB.actor,
            roomId,
            transport,
            rallar: {
                ...rallarRestoreConnectConfig(transport, sessionB),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        expect(requireSessionId(reconnectB, reconnectBCommandId)).toBe(sessionB);

        const healthBAfterReconnect = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'after-reconnect',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthBAfterReconnect, true);
        expectRallarHealthSession(healthBAfterReconnect, sessionB);

        const afterReloadAtoBSmokeId = `after-reload-a-to-b-${suffix}`;
        const sendAfterReloadACommandId = `send-after-reload-a-to-b-${suffix}`;
        await executeOk(request, runId, agentA.agentId, sendAfterReloadACommandId, {
            kind: 'rtc.send',
            connection: agentA.connection,
            transport,
            timeoutMs: 45_000,
            send: sendPayload(transport, sessionB, {
                topic: 'rallar.black-box.reload',
                smokeId: afterReloadAtoBSmokeId,
                direction: 'a-to-b-after-reload',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport,
            smokeId: afterReloadAtoBSmokeId,
            direction: 'a-to-b-after-reload',
        });
        await agentB.page.getByRole('tab', { name: 'Manual Rallar' }).click();
        await expect(agentB.page.locator('#panel-manual-rallar .received-inbox-panel'))
            .toContainText(afterReloadAtoBSmokeId);

        const afterReloadBtoASmokeId = `after-reload-b-to-a-${suffix}`;
        const sendAfterReloadBCommandId = `send-after-reload-b-to-a-${suffix}`;
        await executeOk(request, runId, agentB.agentId, sendAfterReloadBCommandId, {
            kind: 'rtc.send',
            connection: agentB.connection,
            transport,
            timeoutMs: 45_000,
            send: sendPayload(transport, sessionA, {
                topic: 'rallar.black-box.reload',
                smokeId: afterReloadBtoASmokeId,
                direction: 'b-to-a-after-reload',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentA.agentId,
            transport,
            smokeId: afterReloadBtoASmokeId,
            direction: 'b-to-a-after-reload',
        });
        await agentA.page.getByRole('tab', { name: 'Manual Rallar' }).click();
        await expect(agentA.page.locator('#panel-manual-rallar .received-inbox-panel'))
            .toContainText(afterReloadBtoASmokeId);

        const healthAAfterReloadDelivery = await captureHealthSnapshot(request, runId, agentA, {
            phase: 'after-reload-delivery-ready',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        const healthBAfterReloadDelivery = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'after-reload-delivery-ready',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthAAfterReloadDelivery, true);
        expectRallarHealthConnected(healthBAfterReloadDelivery, true);
        expectRallarHealthSession(healthAAfterReloadDelivery, sessionA);
        expectRallarHealthSession(healthBAfterReloadDelivery, sessionB);
        expectRtcPeerReady(healthAAfterReloadDelivery, sessionB);
        expectRtcPeerReady(healthBAfterReloadDelivery, sessionA);

        const finalizedCommandIds = [
            ...(await runFinalizationCommands(request, runId, agentA, suffix)),
            ...(await runFinalizationCommands(request, runId, agentB, suffix)),
        ];
        const expectedCommandIds = [
            ...setupCommandIds,
            connectACommandId,
            connectBCommandId,
            sendBeforeReloadCommandId,
            reconnectBCommandId,
            sendAfterReloadACommandId,
            sendAfterReloadBCommandId,
            ...healthSnapshotCommandIds,
            ...finalizedCommandIds,
        ];

        await expect.poll(async () => {
            const run = await fetchRun(request, runId);
            const resultIds = new Set((run.results ?? [])
                .filter(result => result.ok === true)
                .map(result => result.commandId));
            const topics = (run.events ?? [])
                .map(event => stringValue(eventPayload(event).topic))
                .filter((topic): topic is string => Boolean(topic));
            const deliveryMessages = (run.events ?? [])
                .filter(event =>
                    isMessageFor(event, {
                        agentId: agentB.agentId,
                        transport,
                        smokeId: beforeReloadSmokeId,
                        direction: 'a-to-b-before-reload',
                    }) ||
                    isMessageFor(event, {
                        agentId: agentB.agentId,
                        transport,
                        smokeId: afterReloadAtoBSmokeId,
                        direction: 'a-to-b-after-reload',
                    }) ||
                    isMessageFor(event, {
                        agentId: agentA.agentId,
                        transport,
                        smokeId: afterReloadBtoASmokeId,
                        direction: 'b-to-a-after-reload',
                    })
                ).length;
            return {
                agents: (run.agents ?? [])
                    .filter(agent => agent.agentId === agentA.agentId || agent.agentId === agentB.agentId)
                    .length,
                resultsComplete: expectedCommandIds.every(commandId => resultIds.has(commandId)),
                messagesReceived: deliveryMessages >= 3,
                fakeTopicCount: topics.filter(topic => topic.startsWith('rallar.bb.fake.')).length,
            };
        }, {
            timeout: 20_000,
        }).toEqual({
            agents: 2,
            resultsComplete: true,
            messagesReceived: true,
            fakeTopicCount: 0,
        });
    } finally {
        if (healthSnapshots.length > 0) {
            await testInfo.attach(`rallar-rtc-reload-snapshots-${transport}.json`, {
                body: JSON.stringify({
                    runId,
                    transport,
                    snapshots: healthSnapshots,
                }, null, 2),
                contentType: 'application/json',
            });
        }
        await Promise.all(handles.map(handle => handle.context.close()));
    }
}

async function runTwoAgentDelivery(
    browser: Browser,
    request: APIRequestContext,
    transport: TransportUnderTest,
): Promise<void> {
    const suffix = `${transport.replace('.', '-')}-${Date.now()}-${
        Math.random().toString(16).slice(2)
    }`;
    const runId = `real-rallar-two-agent-${suffix}`;
    const agentAId = `real-rallar-a-${suffix}`;
    const agentBId = `real-rallar-b-${suffix}`;
    const handles: AgentHandle[] = [];

    try {
        const agentA = await openAgent(browser, {
            auth: agentAAuth!,
            runId,
            agentId: agentAId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_A_ACTOR', 'VITE_RALLAR_A_ACTOR') ??
                `agent-a-${suffix}`,
            connection: `agent-a-rtc-${suffix}`,
            transport,
        });
        handles.push(agentA);

        const agentB = await openAgent(browser, {
            auth: agentBAuth!,
            runId,
            agentId: agentBId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_B_ACTOR', 'VITE_RALLAR_B_ACTOR') ??
                `agent-b-${suffix}`,
            connection: `agent-b-rtc-${suffix}`,
            transport,
        });
        handles.push(agentB);

        const setupCommandIds = await setupGroupMembership(request, runId, {
            owner: agentA,
            members: [agentA, agentB],
            suffix,
        });

        const connectACommandId = `connect-a-${suffix}`;
        const connectBCommandId = `connect-b-${suffix}`;
        const connectA = await executeOk(request, runId, agentA.agentId, connectACommandId, {
            kind: 'rtc.connect',
            connection: agentA.connection,
            actor: agentA.actor,
            roomId,
            transport,
            rallar: {
                ...rallarConnectConfig(transport),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        const connectB = await executeOk(request, runId, agentB.agentId, connectBCommandId, {
            kind: 'rtc.connect',
            connection: agentB.connection,
            actor: agentB.actor,
            roomId,
            transport,
            rallar: {
                ...rallarConnectConfig(transport),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        const sessionA = requireSessionId(connectA, connectACommandId);
        const sessionB = requireSessionId(connectB, connectBCommandId);
        expect(sessionA).not.toBe(sessionB);

        const smokeAtoB = `a-to-b-${suffix}`;
        const sendACommandId = `send-a-to-b-${suffix}`;
        await executeOk(request, runId, agentA.agentId, sendACommandId, {
            kind: 'rtc.send',
            connection: agentA.connection,
            transport,
            timeoutMs: 30_000,
            send: sendPayload(transport, sessionB, {
                topic: 'rallar.black-box.two-agent',
                smokeId: smokeAtoB,
                direction: 'a-to-b',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport,
            smokeId: smokeAtoB,
            direction: 'a-to-b',
        });
        await agentB.page.getByRole('tab', { name: 'Manual Rallar' }).click();
        await expect(agentB.page.locator('#panel-manual-rallar .received-inbox-panel'))
            .toContainText(smokeAtoB);

        const smokeBtoA = `b-to-a-${suffix}`;
        const sendBCommandId = `send-b-to-a-${suffix}`;
        await executeOk(request, runId, agentB.agentId, sendBCommandId, {
            kind: 'rtc.send',
            connection: agentB.connection,
            transport,
            timeoutMs: 30_000,
            send: sendPayload(transport, sessionA, {
                topic: 'rallar.black-box.two-agent',
                smokeId: smokeBtoA,
                direction: 'b-to-a',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentA.agentId,
            transport,
            smokeId: smokeBtoA,
            direction: 'b-to-a',
        });
        await agentA.page.getByRole('tab', { name: 'Manual Rallar' }).click();
        await expect(agentA.page.locator('#panel-manual-rallar .received-inbox-panel'))
            .toContainText(smokeBtoA);

        const finalizedCommandIds = [
            ...(await runFinalizationCommands(request, runId, agentA, suffix)),
            ...(await runFinalizationCommands(request, runId, agentB, suffix)),
        ];
        const expectedCommandIds = [
            ...setupCommandIds,
            connectACommandId,
            connectBCommandId,
            sendACommandId,
            sendBCommandId,
            ...finalizedCommandIds,
        ];

        await expect.poll(async () => {
            const run = await fetchRun(request, runId);
            const resultIds = new Set((run.results ?? [])
                .filter(result => result.ok === true)
                .map(result => result.commandId));
            const topics = (run.events ?? [])
                .map(event => stringValue(eventPayload(event).topic))
                .filter((topic): topic is string => Boolean(topic));
            const statsAgents = new Set((run.stats ?? [])
                .map(event => event.agentId)
                .filter(agentId => agentId === agentA.agentId || agentId === agentB.agentId));
            const reportAgents = new Set((run.reports ?? [])
                .map(event => event.agentId)
                .filter(agentId => agentId === agentA.agentId || agentId === agentB.agentId));
            const deliveryMessages = (run.events ?? [])
                .filter(event =>
                    isMessageFor(event, {
                        agentId: agentA.agentId,
                        transport,
                        smokeId: smokeBtoA,
                        direction: 'b-to-a',
                    }) ||
                    isMessageFor(event, {
                        agentId: agentB.agentId,
                        transport,
                        smokeId: smokeAtoB,
                        direction: 'a-to-b',
                    })
                ).length;
            return {
                agents: (run.agents ?? [])
                    .filter(agent => agent.agentId === agentA.agentId || agent.agentId === agentB.agentId)
                    .length,
                resultsComplete: expectedCommandIds.every(commandId => resultIds.has(commandId)),
                messagesReceived: deliveryMessages >= 2,
                statsAgents: statsAgents.size,
                reportAgents: reportAgents.size,
                fakeTopicCount: topics.filter(topic => topic.startsWith('rallar.bb.fake.')).length,
            };
        }, {
            timeout: 20_000,
        }).toEqual({
            agents: 2,
            resultsComplete: true,
            messagesReceived: true,
            statsAgents: 2,
            reportAgents: 2,
            fakeTopicCount: 0,
        });
    } finally {
        await Promise.all(handles.map(handle => handle.context.close()));
    }
}

async function runTwoAgentDisconnectReconnect(
    browser: Browser,
    request: APIRequestContext,
    testInfo: TestInfo,
): Promise<void> {
    const transport: TransportUnderTest = 'realtime';
    const suffix = `disconnect-reconnect-${Date.now()}-${
        Math.random().toString(16).slice(2)
    }`;
    const runId = `real-rallar-two-agent-disconnect-${suffix}`;
    const agentAId = `real-rallar-a-${suffix}`;
    const agentBId = `real-rallar-b-${suffix}`;
    const handles: AgentHandle[] = [];
    const healthSnapshots: RtcReloadHealthSnapshot[] = [];
    const healthSnapshotCommandIds: string[] = [];

    try {
        const agentA = await openAgent(browser, {
            auth: agentAAuth!,
            runId,
            agentId: agentAId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_A_ACTOR', 'VITE_RALLAR_A_ACTOR') ??
                `agent-a-${suffix}`,
            connection: `agent-a-rtc-${suffix}`,
            transport,
        });
        handles.push(agentA);

        const agentB = await openAgent(browser, {
            auth: agentBAuth!,
            runId,
            agentId: agentBId,
            actor: firstEnvValue('VITE_RALLAR_AGENT_B_ACTOR', 'VITE_RALLAR_B_ACTOR') ??
                `agent-b-${suffix}`,
            connection: `agent-b-rtc-${suffix}`,
            transport,
        });
        handles.push(agentB);

        const setupCommandIds = await setupGroupMembership(request, runId, {
            owner: agentA,
            members: [agentA, agentB],
            suffix,
        });

        const connectACommandId = `connect-a-${suffix}`;
        const connectBCommandId = `connect-b-${suffix}`;
        const connectA = await executeOk(request, runId, agentA.agentId, connectACommandId, {
            kind: 'rtc.connect',
            connection: agentA.connection,
            actor: agentA.actor,
            roomId,
            transport,
            rallar: rallarConnectConfig(transport),
            timeoutMs: 30_000,
        });
        const connectB = await executeOk(request, runId, agentB.agentId, connectBCommandId, {
            kind: 'rtc.connect',
            connection: agentB.connection,
            actor: agentB.actor,
            roomId,
            transport,
            rallar: rallarConnectConfig(transport),
            timeoutMs: 30_000,
        });
        const sessionA = requireSessionId(connectA, connectACommandId);
        const sessionB = requireSessionId(connectB, connectBCommandId);
        expect(sessionA).not.toBe(sessionB);

        const smokeBeforeClose = `before-close-${suffix}`;
        const sendBeforeCloseCommandId = `send-before-close-${suffix}`;
        await executeOk(request, runId, agentA.agentId, sendBeforeCloseCommandId, {
            kind: 'rtc.send',
            connection: agentA.connection,
            transport,
            timeoutMs: 30_000,
            send: sendPayload(transport, sessionB, {
                topic: 'rallar.black-box.disconnect',
                smokeId: smokeBeforeClose,
                direction: 'a-to-b-before-close',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport,
            smokeId: smokeBeforeClose,
            direction: 'a-to-b-before-close',
        });

        const healthBBeforeClose = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'before-close',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthBBeforeClose, true);
        expectRallarHealthSession(healthBBeforeClose, sessionB);
        expectRtcPeerReady(healthBBeforeClose, sessionA);

        const closeBCommandId = `close-b-${suffix}`;
        const closeB = await executeOk(request, runId, agentB.agentId, closeBCommandId, {
            kind: 'close',
        });
        expect(asRecord(resultValue(closeB).rallar)).toMatchObject({
            status: 'closed',
            disconnected: true,
        });

        await agentB.page.waitForTimeout(1_000);
        const healthBAfterClose = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'after-close',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectWsReconnectSuppressed(healthBAfterClose);

        const reconnectBCommandId = `reconnect-b-${suffix}`;
        const reconnectB = await executeOk(request, runId, agentB.agentId, reconnectBCommandId, {
            kind: 'rtc.connect',
            connection: agentB.connection,
            actor: agentB.actor,
            roomId,
            transport,
            rallar: {
                ...rallarRestoreConnectConfig(transport, sessionB),
                logoutOnClose: false,
            },
            timeoutMs: 30_000,
        });
        expect(requireSessionId(reconnectB, reconnectBCommandId)).toBe(sessionB);

        const smokeAfterReconnect = `after-reconnect-${suffix}`;
        const sendAfterReconnectCommandId = `send-after-reconnect-${suffix}`;
        await executeOk(request, runId, agentA.agentId, sendAfterReconnectCommandId, {
            kind: 'rtc.send',
            connection: agentA.connection,
            transport,
            timeoutMs: 30_000,
            send: sendPayload(transport, sessionB, {
                topic: 'rallar.black-box.disconnect',
                smokeId: smokeAfterReconnect,
                direction: 'a-to-b-after-reconnect',
                transport,
                runId,
            }),
        });
        await waitForMessage(request, runId, {
            agentId: agentB.agentId,
            transport,
            smokeId: smokeAfterReconnect,
            direction: 'a-to-b-after-reconnect',
        });

        const healthBAfterReconnect = await captureHealthSnapshot(request, runId, agentB, {
            phase: 'after-reconnect',
            suffix,
            snapshots: healthSnapshots,
            commandIds: healthSnapshotCommandIds,
        });
        expectRallarHealthConnected(healthBAfterReconnect, true);
        expectRallarHealthSession(healthBAfterReconnect, sessionB);
        expectRtcPeerReady(healthBAfterReconnect, sessionA);

        const finalizedCommandIds = [
            ...(await runFinalizationCommands(request, runId, agentA, suffix)),
            ...(await runFinalizationCommands(request, runId, agentB, suffix)),
        ];
        const expectedCommandIds = [
            ...setupCommandIds,
            connectACommandId,
            connectBCommandId,
            sendBeforeCloseCommandId,
            ...healthSnapshotCommandIds,
            closeBCommandId,
            reconnectBCommandId,
            sendAfterReconnectCommandId,
            ...finalizedCommandIds,
        ];

        await expect.poll(async () => {
            const run = await fetchRun(request, runId);
            const resultIds = new Set((run.results ?? [])
                .filter(result => result.ok === true)
                .map(result => result.commandId));
            const deliveryMessages = (run.events ?? [])
                .filter(event =>
                    isMessageFor(event, {
                        agentId: agentB.agentId,
                        transport,
                        smokeId: smokeBeforeClose,
                        direction: 'a-to-b-before-close',
                    }) ||
                    isMessageFor(event, {
                        agentId: agentB.agentId,
                        transport,
                        smokeId: smokeAfterReconnect,
                        direction: 'a-to-b-after-reconnect',
                    })
                ).length;
            return {
                resultsComplete: expectedCommandIds.every(commandId => resultIds.has(commandId)),
                messagesReceived: deliveryMessages >= 2,
            };
        }, {
            timeout: 20_000,
        }).toEqual({
            resultsComplete: true,
            messagesReceived: true,
        });
    } finally {
        if (healthSnapshots.length > 0) {
            await testInfo.attach('rallar-ws-disconnect-reconnect-snapshots.json', {
                contentType: 'application/json',
                body: JSON.stringify({
                    runId,
                    transport,
                    snapshots: healthSnapshots,
                }, null, 2),
            });
        }
        await Promise.all(handles.map(handle => handle.context.close()));
    }
}

test('browser-rallar provider delivers realtime payloads between two real agents', async ({
    browser,
    request,
                                                                                        }) => {
    test.setTimeout(120_000);
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live two-agent realtime smoke.',
    );

    await runTwoAgentDelivery(browser, request, 'realtime');
});

test('browser-rallar provider delivers messages.rtc payloads between two real agents', async ({
                                                                                                 browser,
                                                                                                 request,
                                                                                             }) => {
    test.setTimeout(120_000);
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live two-agent messages.rtc smoke.',
    );

    await runTwoAgentDelivery(browser, request, 'messages.rtc');
});

test('browser-rallar provider delivers realtime after reloading one real agent', async ({
                                                                                           browser,
                                                                                           request,
                                                                                       }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live reload realtime smoke.',
    );

    await runTwoAgentReloadDelivery(browser, request, 'realtime', testInfo);
});

test('browser-rallar provider delivers messages.rtc after reloading one real agent', async ({
                                                                                               browser,
                                                                                               request,
                                                                                           }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live reload messages.rtc smoke.',
    );

    await runTwoAgentReloadDelivery(browser, request, 'messages.rtc', testInfo);
});

test('browser-rallar provider suppresses WS reconnect after intentional disconnect and reconnects explicitly', async ({
    browser,
    request,
}, testInfo) => {
    test.skip(
        !hasTwoAgentConfig,
        'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and two-agent Rallar login or restore config to run the live disconnect/reconnect smoke.',
    );

    await runTwoAgentDisconnectReconnect(browser, request, testInfo);
});
