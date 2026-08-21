import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Page,
    test,
    type TestInfo,
} from '@playwright/test';
import {
    FULL_STACK_CONTROL_BASE_URL,
    FULL_STACK_CONTROL_WS_URL,
    FULL_STACK_SPA_ORIGIN,
    readFullStackConfig,
    uniqueSuffix,
} from './full-stack-helpers.ts';
import {
    type ControlCommandEnvelope,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/types.ts';
import {
    createRallarBlackBoxEnsureGroupRequestId,
    createRallarBlackBoxRtcRealtimeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
} from '../../../apps/rallar-black-box/src/recipe-fixtures.ts';
import {
    deriveDistributedRunMonitor,
    deriveDistributedRunWarningRegressionReport,
} from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import type {
    ControlDistributedRunArtifactBundle as AppControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot as AppControlDistributedRunSnapshot,
    ControlRunSnapshot as AppControlRunSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';

type ProviderUnderTest = 'simulated' | 'browser-rallar';
type AgentPrefix = 'A' | 'B' | 'C';

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

type ConsoleArtifactEntry = Readonly<{
    agentId: string;
    type: 'warning' | 'error' | 'pageerror';
    text: string;
    location?: Readonly<{
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
    }>;
    atEpochMs: number;
    knownHarmless: boolean;
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
    commandId?: string;
    eventId?: string;
    atEpochMs?: number;
    payload?: unknown;
}>;

type ControlRunSnapshot = Readonly<{
    agents?: readonly Readonly<{
        agentId?: string;
        connected?: boolean;
        identity?: Readonly<{
            applicationId?: string;
            workspaceId?: string;
            groupId?: string;
        }>;
    }>[];
    commands?: readonly Readonly<{
        envelope?: Readonly<{
            agentId?: string;
            commandId?: string;
        }>;
        completedAtEpochMs?: number;
    }>[];
    results?: readonly ControlResult[];
    events?: readonly ControlEvent[];
}>;

type DistributedRunSnapshot = Readonly<{
    distributedRunId: string;
    controlRunId: string;
    state: string;
    targetAgentIds: readonly string[];
    commandLinks: readonly Readonly<{
        phase: string;
        agentId: string;
        commandId: string;
        recipeId?: string;
    }>[];
    rollup: Readonly<{
        ok: boolean;
        failures: readonly Readonly<{
            kind: string;
            key: string;
            state: string;
            error?: Readonly<{
                code?: string;
                message?: string;
            }>;
        }>[];
        summary: Readonly<{
            participants: number;
            readyParticipants: number;
            passedParticipants: number;
            failedParticipants: number;
            passedRecipes: number;
            failedRecipes: number;
        }>;
    }>;
    error?: Readonly<{
        code?: string;
        message?: string;
    }>;
}>;

const config = readFullStackConfig();
const liveDistributedEnabled = booleanEnv('RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES') ||
    booleanEnv('RALLAR_BLACK_BOX_LIVE_DISTRIBUTED_RECIPES');
const liveAgentAAuth = resolveAgentAuth('A');
const liveAgentBAuth = resolveAgentAuth('B');
const liveAgentCAuth = resolveAgentAuth('C');
const hasLiveDistributedConfig = Boolean(
    config.enabled &&
    liveDistributedEnabled &&
    envValue('VITE_RALLAR_API_BASE_URL') &&
    liveAgentAAuth &&
    liveAgentBAuth &&
    liveAgentCAuth,
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

const HARMLESS_LIVE_CONSOLE_WARNING_PATTERNS: readonly RegExp[] = [
    /Unhandled WS message/i,
    /No callback for typeId/i,
    /Received data channel for different data channel name/i,
    /does not match peerId/i,
    /No channel for peer/i,
    /Ignoring self-connection attempt/i,
];

function createConsoleArtifactRecorder(): Readonly<{
    entries: ConsoleArtifactEntry[];
    watch(page: Page, agentId: string): void;
    highSeverityEntries(): readonly ConsoleArtifactEntry[];
}> {
    const entries: ConsoleArtifactEntry[] = [];
    return {
        entries,
        watch(page, agentId) {
            page.on('console', message => {
                const type = message.type();
                if (type !== 'warning' && type !== 'error') {
                    return;
                }
                const text = message.text();
                entries.push({
                    agentId,
                    type,
                    text,
                    location: message.location(),
                    atEpochMs: Date.now(),
                    knownHarmless: isKnownHarmlessConsoleWarning(text),
                });
            });
            page.on('pageerror', error => {
                entries.push({
                    agentId,
                    type: 'pageerror',
                    text: error.message,
                    atEpochMs: Date.now(),
                    knownHarmless: false,
                });
            });
        },
        highSeverityEntries() {
            return entries.filter(entry =>
                entry.type === 'pageerror' ||
                (entry.type === 'error' && !entry.knownHarmless)
            );
        },
    };
}

function isKnownHarmlessConsoleWarning(text: string): boolean {
    return HARMLESS_LIVE_CONSOLE_WARNING_PATTERNS.some(pattern => pattern.test(text));
}

async function attachConsoleArtifacts(
    testInfo: TestInfo,
    entries: readonly ConsoleArtifactEntry[],
): Promise<void> {
    await testInfo.attach('distributed-live-console-warnings.json', {
        body: JSON.stringify({
            entries,
            highSeverityEntries: entries.filter(entry =>
                entry.type === 'pageerror' ||
                (entry.type === 'error' && !entry.knownHarmless)
            ),
        }, null, 2),
        contentType: 'application/json',
    });
}

function resolveAgentAuth(prefix: AgentPrefix): AgentAuth | undefined {
    const fallbackUser = prefix === 'A'
        ? config.userA
        : prefix === 'B'
            ? config.userB
            : config.userC;
    const genericUsername = prefix === 'A' ? ['VITE_RALLAR_USERNAME'] : [];
    const genericPassword = prefix === 'A' ? ['VITE_RALLAR_PASSWORD'] : [];
    const configuredUsername = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_USERNAME`,
        `VITE_RALLAR_${prefix}_USERNAME`,
        ...genericUsername,
    );
    const configuredPassword = firstEnvValue(
        `VITE_RALLAR_AGENT_${prefix}_PASSWORD`,
        `VITE_RALLAR_${prefix}_PASSWORD`,
        ...genericPassword,
    );
    const username = configuredUsername ??
        fallbackUser.username;
    const password = configuredPassword ??
        fallbackUser.password;
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

function agentAuth(prefix: AgentPrefix): AgentAuth {
    const auth = prefix === 'A' ? liveAgentAAuth : prefix === 'B' ? liveAgentBAuth : liveAgentCAuth;
    if (!auth) {
        throw new Error(`Missing live auth for agent ${prefix}.`);
    }
    return auth;
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resultValue(result: ControlResult): Record<string, unknown> {
    return asRecord(result.result?.value);
}

function eventPayload(event: ControlEvent): Record<string, unknown> {
    return asRecord(event.payload);
}

function runtimeEventPayload(event: ControlEvent): Record<string, unknown> {
    const payload = eventPayload(event);
    if (
        payload.kind !== undefined ||
        payload.topic !== undefined ||
        payload.transport !== undefined
    ) {
        return payload;
    }
    return asRecord(payload.payload ?? payload);
}

function messageData(event: ControlEvent): Record<string, unknown> {
    const runtimeEvent = runtimeEventPayload(event);
    const runtimePayload = asRecord(runtimeEvent.payload);
    return asRecord(runtimePayload.data ?? runtimeEvent.data);
}

async function openControlAgent(
    browser: Browser,
    input: Readonly<{
        provider: ProviderUnderTest;
        prefix: AgentPrefix;
        runId: string;
        agentId: string;
        actor: string;
        connection: string;
        group: RallarBlackBoxDistributedGroupRef;
        auth?: AgentAuth;
    }>,
): Promise<AgentHandle> {
    const context = await browser.newContext();
    const page = await context.newPage();

    if (input.auth?.kind === 'restore') {
        await page.addInitScript((session) => {
            window.localStorage.setItem('auth.session', JSON.stringify(session));
        }, input.auth.session);
    }

    const query = new URLSearchParams({
        mode: 'control',
        workspace: 'black-box-runner',
        tab: 'local-workbench',
        provider: input.provider,
        autoConnect: '1',
        controlUrl: FULL_STACK_CONTROL_WS_URL,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: config.apiBaseUrl,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomId: input.group.groupId,
        actor: input.actor,
        sessionId: input.agentId,
        heartbeatIntervalMs: '250',
        statsIntervalMs: '1000',
        rallarLeaveRoomOnClose: '0',
        ...(input.auth?.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
        ...(input.auth?.kind === 'login'
            ? {
                rallarUsername: input.auth.username,
                rallarPassword: input.auth.password,
            }
            : {}),
    });

    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
    if (input.auth?.kind === 'login') {
        await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
        await page.getByRole('button', { name: 'Sign in' }).click();
    }
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 30_000 },
    );
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

async function openScriptedControlAgent(input: Readonly<{
    runId: string;
    agentId: string;
    group: RallarBlackBoxDistributedGroupRef;
    providerMode?: string;
    onCommand?: (command: ControlCommandEnvelope) => unknown;
}>): Promise<WebSocket> {
    const socket = new WebSocket(FULL_STACK_CONTROL_WS_URL);
    socket.addEventListener('message', event => {
        let envelope: ControlCommandEnvelope | undefined;
        try {
            envelope = JSON.parse(String(event.data)) as ControlCommandEnvelope;
        } catch {
            return;
        }
        if (envelope?.kind !== 'command') {
            return;
        }
        const response = input.onCommand?.(envelope);
        if (response !== undefined && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
        }
    });
    await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;

        function cleanup() {
            clearTimeout(timeout);
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('error', handleError);
        }

        function handleOpen() {
            socket.send(JSON.stringify({
                kind: 'register',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: input.runId,
                agentId: input.agentId,
                atEpochMs: Date.now(),
                identity: {
                    principalId: input.agentId,
                    clientId: input.agentId,
                    username: input.agentId,
                    sessionId: input.agentId,
                    clientInstanceId: input.agentId,
                    applicationId: input.group.applicationId,
                    workspaceId: input.group.workspaceId,
                    groupId: input.group.groupId,
                    providerMode: input.providerMode ?? 'scripted-control',
                    browserLabel: input.agentId,
                    updatedAtEpochMs: Date.now(),
                },
                resume: {
                    completedCommandIds: [],
                },
            }));
            cleanup();
            resolve();
        }

        function handleError() {
            cleanup();
            reject(new Error(`Scripted control agent ${input.agentId} WebSocket failed.`));
        }

        timeout = setTimeout(() => {
            cleanup();
            socket.close();
            reject(new Error(`Scripted control agent ${input.agentId} did not open.`));
        }, 10_000);
        socket.addEventListener('open', handleOpen);
        socket.addEventListener('error', handleError);
    });
    return socket;
}

function scriptedControlResult(input: Readonly<{
    runId: string;
    agentId: string;
    command: ControlCommandEnvelope;
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
}>): Readonly<Record<string, unknown>> {
    const now = Date.now();
    const error = input.ok
        ? undefined
        : {
            code: input.errorCode ?? 'SCRIPTED_CONTROL_FAILURE',
            message: input.errorMessage ?? 'Scripted control-agent failure.',
        };
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: input.runId,
        agentId: input.agentId,
        commandId: input.command.commandId,
        ok: input.ok,
        result: {
            commandId: input.command.commandId,
            kind: input.command.command.kind,
            status: input.ok ? 'ok' : 'failed',
            ok: input.ok,
            startedAtEpochMs: now,
            endedAtEpochMs: now + 1,
            durationMs: 1,
            value: {
                scripted: true,
                commandKind: input.command.command.kind,
            },
            error,
        },
        error,
    };
}

async function fetchControlRun(
    request: APIRequestContext,
    runId: string,
): Promise<ControlRunSnapshot> {
    const response = await request.get(`${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`);
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
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
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
        const run = await fetchControlRun(request, runId);
        latest = run.results?.find(result => result.commandId === commandId);
        return Boolean(latest);
    }, { timeout }).toBe(true);
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
    const result = await waitForCommandResult(request, runId, commandId, timeout);
    expect(result.ok).toBe(true);
    return result;
}

async function waitForAgentsInGroup(
    request: APIRequestContext,
    runId: string,
    agentIds: readonly string[],
    group: RallarBlackBoxDistributedGroupRef,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return agentIds.every(agentId => {
            const agent = run.agents?.find(candidate => candidate.agentId === agentId);
            return agent?.connected === true &&
                agent.identity?.applicationId === group.applicationId &&
                agent.identity.workspaceId === group.workspaceId &&
                agent.identity.groupId === group.groupId;
        });
    }, { timeout: 20_000 }).toBe(true);
}

async function configureAgentForDistributedGroup(
    request: APIRequestContext,
    runId: string,
    agent: AgentHandle,
    provider: ProviderUnderTest,
    group: RallarBlackBoxDistributedGroupRef,
    suffix: string,
): Promise<void> {
    await executeOk(request, runId, agent.agentId, `configure-distributed-${agent.prefix.toLowerCase()}-${suffix}`, {
        kind: 'configure',
        config: {
            runId,
            agentId: agent.agentId,
            apiBaseUrl: config.apiBaseUrl,
            actor: agent.actor,
            sessionId: agent.agentId,
            roomId: group.groupId,
            control: {
                mode: 'distributed-recipes',
                providerMode: provider,
            },
            defaults: {
                connection: agent.connection,
                providerMode: provider,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
            },
            rallar: {
                apiBaseUrl: config.apiBaseUrl,
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
                roomRef: group,
                scope: {
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                },
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
            },
        },
    }, 20_000);
}

async function configureAgentsForDistributedGroup(
    request: APIRequestContext,
    runId: string,
    handles: readonly AgentHandle[],
    provider: ProviderUnderTest,
    group: RallarBlackBoxDistributedGroupRef,
    suffix: string,
): Promise<void> {
    for (const handle of handles) {
        await configureAgentForDistributedGroup(request, runId, handle, provider, group, suffix);
    }
}

async function createDistributedRun(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest,
): Promise<DistributedRunSnapshot> {
    const response = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
        data: { manifest },
    });
    expect(response.status()).toBe(201);
    return await response.json() as DistributedRunSnapshot;
}

async function fetchDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
): Promise<DistributedRunSnapshot> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}`,
    );
    expect(response.ok()).toBe(true);
    return await response.json() as DistributedRunSnapshot;
}

async function mutateDistributedRun(
    request: APIRequestContext,
    distributedRunId: string,
    action: 'stage' | 'start' | 'cancel',
): Promise<DistributedRunSnapshot> {
    const response = await request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}/${action}`,
        action === 'cancel' ? { data: { reason: 'Playwright distributed recipe QA cleanup.' } } : undefined,
    );
    expect(response.status()).toBe(202);
    return await response.json() as DistributedRunSnapshot;
}

async function waitForDistributedState(
    request: APIRequestContext,
    distributedRunId: string,
    state: string,
    timeout = 45_000,
): Promise<DistributedRunSnapshot> {
    let latest: DistributedRunSnapshot | undefined;
    try {
        await expect.poll(async () => {
            latest = await fetchDistributedRun(request, distributedRunId);
            return latest.state;
        }, { timeout }).toBe(state);
    } catch (error) {
        const snapshot = latest
            ? JSON.stringify({
                distributedRunId: latest.distributedRunId,
                state: latest.state,
                targetAgentIds: latest.targetAgentIds,
                commandLinks: latest.commandLinks,
                error: latest.error,
                rollup: latest.rollup,
            }, null, 2)
            : 'none';
        throw new Error(
            `Distributed run ${distributedRunId} did not reach ${state}. Latest snapshot: ${snapshot}`,
            { cause: error },
        );
    }
    if (!latest) {
        throw new Error(`Distributed run ${distributedRunId} did not reach ${state}.`);
    }
    return latest;
}

async function fetchDistributedArtifact(
    request: APIRequestContext,
    distributedRunId: string,
): Promise<Readonly<{ files?: Record<string, string> }>> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/distributed-runs/${encodeURIComponent(distributedRunId)}/artifacts`,
    );
    expect(response.ok()).toBe(true);
    return await response.json() as Readonly<{ files?: Record<string, string> }>;
}

function healthRecipe(recipeId: string): RallarBlackBoxTestRecipe {
    return {
        recipeId,
        name: recipeId,
        commands: [{
            kind: 'health',
            commandId: `${recipeId}-health`,
        }],
    };
}

function compositeEvidenceRecipe(recipeId: string): RallarBlackBoxTestRecipe {
    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
        entry.fixtureId === 'composite-evidence'
    );
    if (!fixture) {
        return healthRecipe(recipeId);
    }

    return {
        ...fixture.recipe,
        recipeId,
        name: recipeId,
    };
}

function distributedManifest(input: Readonly<{
    distributedRunId: string;
    controlRunId: string;
    group: RallarBlackBoxDistributedGroupRef;
    recipes: RallarBlackBoxDistributedRunManifest['recipes'];
    targetPolicy: RallarBlackBoxDistributedRunManifest['targetPolicy'];
    roleAssignments?: RallarBlackBoxDistributedRunManifest['roleAssignments'];
    ackTimeoutMs?: number;
    displayName?: string;
}>): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: input.displayName ?? input.distributedRunId,
        group: input.group,
        recipes: input.recipes,
        targetPolicy: input.targetPolicy,
        ...(input.roleAssignments ? { roleAssignments: input.roleAssignments } : {}),
        ackTimeoutMs: input.ackTimeoutMs ?? 10_000,
        startMode: 'manual',
        artifactPolicy: {
            retainArtifacts: true,
            includeEventJsonl: true,
            includeFailureBundle: true,
            includeDistributedMetadata: true,
        },
        metadata: {
            source: 'full-stack-distributed-recipes',
        },
    };
}

async function runToPassed(
    request: APIRequestContext,
    manifest: RallarBlackBoxDistributedRunManifest,
): Promise<DistributedRunSnapshot> {
    await createDistributedRun(request, manifest);
    await mutateDistributedRun(request, manifest.distributedRunId, 'stage');
    await waitForDistributedState(request, manifest.distributedRunId, 'ready');
    await mutateDistributedRun(request, manifest.distributedRunId, 'start');
    return await waitForDistributedState(request, manifest.distributedRunId, 'passed');
}

async function setupGroupMembership(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        owner: AgentHandle;
        members: readonly AgentHandle[];
        group: RallarBlackBoxDistributedGroupRef;
        suffix: string;
    }>,
): Promise<void> {
    const groupSegment = pathSegment(input.group.groupId);
    const createResult = await executeOk(request, runId, input.owner.agentId, `group-create-${input.suffix}`, {
        kind: 'http.request',
        request: {
            path: `/api/state/apps/${pathSegment(input.group.applicationId)}/workspaces/${
                pathSegment(input.group.workspaceId)
            }/groups/requests/${createRallarBlackBoxEnsureGroupRequestId({
                requestPrefix: 'rtc-realtime',
                group: input.group,
            })}`,
            method: 'POST',
            body: {
                groupId: input.group.groupId,
                displayName: input.group.groupId,
                description: 'Created by rallar-black-box distributed recipe QA',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: '{auth.clientId}',
                metadata: {
                    source: 'rallar-black-box',
                    matrix: 'distributed-recipes',
                    suffix: input.suffix,
                },
            },
        },
        response: {
            body: 'json',
        },
        timeoutMs: 15_000,
    }, 45_000);
    expect(Number(resultValue(createResult).status)).toBe(201);

    for (const member of input.members) {
        const joinResult = await executeOk(request, runId, member.agentId, `group-join-${member.agentId}-${input.suffix}`, {
            kind: 'http.request',
            request: {
                path: `/api/state/apps/${pathSegment(input.group.applicationId)}/workspaces/${
                    pathSegment(input.group.workspaceId)
                }/groups/${groupSegment}/members/{auth.clientId}/requests/${crypto.randomUUID()}`,
                method: 'PUT',
                body: {
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
            timeoutMs: 15_000,
        }, 45_000);
        expect(Number(resultValue(joinResult).status)).toBeLessThan(400);
    }
}

function browserMessageMatches(
    event: ControlEvent,
    input: Readonly<{
        agentId: string;
        transport: 'ws' | 'realtime';
        messageId: string;
    }>,
): boolean {
    const runtimeEvent = runtimeEventPayload(event);
    const data = messageData(event);
    return event.agentId === input.agentId &&
        runtimeEvent.kind === 'message' &&
        runtimeEvent.transport === input.transport &&
        data.messageId === input.messageId;
}

async function waitForBrowserMessage(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        agentId: string;
        transport: 'ws' | 'realtime';
        messageId: string;
    }>,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return run.events?.some(event => browserMessageMatches(event, input)) ?? false;
    }, { timeout: 75_000 }).toBe(true);
}

function eventReferencesText(event: ControlEvent, text: string): boolean {
    try {
        return JSON.stringify(event.payload).includes(text);
    } catch {
        return false;
    }
}

function runtimeDiagnosticTypeId(event: ControlEvent): string | undefined {
    const runtimeEvent = runtimeEventPayload(event);
    const payload = asRecord(runtimeEvent.payload);
    return stringValue(payload.diagnosticTypeId) ??
        stringValue(runtimeEvent.diagnosticTypeId) ??
        stringValue(payload.topic) ??
        stringValue(runtimeEvent.topic);
}

async function waitForRuntimeDiagnostic(
    request: APIRequestContext,
    runId: string,
    input: Readonly<{
        distributedRunId: string;
        diagnosticTypeId: string;
    }>,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return run.events?.some(event =>
            event.kind === 'diagnostic' &&
            runtimeDiagnosticTypeId(event) === input.diagnosticTypeId &&
            eventReferencesText(event, input.distributedRunId)
        ) ?? false;
    }, { timeout: 30_000 }).toBe(true);
}

async function emitKnownLiveWarningDiagnostics(
    agents: readonly AgentHandle[],
    input: Readonly<{
        distributedRunId: string;
        group: RallarBlackBoxDistributedGroupRef;
    }>,
): Promise<void> {
    await agents[1].page.evaluate(({ distributedRunId, groupId }) => {
        console.warn('Unhandled WS message', {
            distributedRunId,
            groupId,
            typeId: 'room.rallar-black-box.distributed.warning',
            topicId: 'room.rallar-black-box.distributed.warning',
        });
    }, {
        distributedRunId: input.distributedRunId,
        groupId: input.group.groupId,
    });
    await agents[2].page.evaluate(({ distributedRunId, groupId }) => {
        console.warn('Received data channel for different data channel name.', {
            distributedRunId,
            groupId,
            expectedChannelLabel: 'rtcRealtime',
            observedChannelLabel: 'rtc-data-channel',
        });
    }, {
        distributedRunId: input.distributedRunId,
        groupId: input.group.groupId,
    });
}

async function waitForRealtimePositionPayload(
    request: APIRequestContext,
    runId: string,
    distributedRunId: string,
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return run.events?.some(event => {
            const runtimeEvent = runtimeEventPayload(event);
            const data = messageData(event);
            return runtimeEvent.kind === 'message' &&
                runtimeEvent.transport === 'realtime' &&
                data.distributedRunId === distributedRunId &&
                data.topic === 'room.black-box.rtc-realtime.position';
        }) ?? false;
    }, { timeout: 75_000 }).toBe(true);
}

function retainedRealtimeRecipeEvidence(
    run: ControlRunSnapshot,
    distributedRun: DistributedRunSnapshot,
): Readonly<{
    compactedStartResults: readonly Readonly<{
        agentId: string;
        ok: boolean | undefined;
        resultCount: number | undefined;
        failureCount: number | undefined;
        resultsOmitted: boolean;
    }>[];
    loopStats: readonly Readonly<{
        agentId: string;
        latestLoopCommandId: string | undefined;
        plannedIterations: number | undefined;
        completedIterations: number | undefined;
        sendCount: number | undefined;
        succeeded: number | undefined;
        failed: number | undefined;
    }>[];
}> {
    const compactedStartResults = distributedRun.commandLinks
        .filter(link => link.phase === 'start')
        .map(link => {
            const result = run.results?.find(candidate =>
                candidate.commandId === link.commandId &&
                candidate.agentId === link.agentId
            );
            const value = result ? resultValue(result) : {};
            return {
                agentId: link.agentId,
                ok: result?.ok,
                resultCount: numberValue(value.resultCount),
                failureCount: numberValue(value.failureCount),
                resultsOmitted: value.resultsOmitted === true,
            };
        });
    const loopStats = distributedRun.targetAgentIds.map(agentId => {
        const matchingStats = (run.events ?? []).flatMap(event => {
            if (event.agentId !== agentId || event.kind !== 'stats') {
                return [];
            }
            const runtimeEvent = runtimeEventPayload(event);
            const stats = asRecord(runtimeEvent.payload);
            const load = asRecord(stats.load);
            if (load.latestLoopCommandId !== 'rtc-realtime-position-loop') {
                return [];
            }
            const pacing = asRecord(load.latestPacing);
            const sends = asRecord(load.latestSends);
            return [{
                agentId,
                latestLoopCommandId: stringValue(load.latestLoopCommandId),
                plannedIterations: numberValue(pacing.plannedIterations),
                completedIterations: numberValue(pacing.completedIterations),
                sendCount: numberValue(sends.sendCount),
                succeeded: numberValue(sends.succeeded),
                failed: numberValue(sends.failed),
            }];
        });
        return matchingStats.at(-1) ?? {
            agentId,
            latestLoopCommandId: undefined,
            plannedIterations: undefined,
            completedIterations: undefined,
            sendCount: undefined,
            succeeded: undefined,
            failed: undefined,
        };
    });

    return { compactedStartResults, loopStats };
}

function wsSendRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef,
    input: Readonly<{
        typeId: string;
        topicId: string;
        messageId: string;
        role: string;
        distributedRunId?: string;
    }>,
): RallarBlackBoxTestRecipe {
    return {
        recipeId,
        commands: [{
            kind: 'ws.send',
            commandId: `${recipeId}-send`,
            connection: `ws-${input.role}`,
            data: {
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                roomId: group.groupId,
                roomRef: group,
                typeId: input.typeId,
                topicId: input.topicId,
                contextId: group.groupId,
                resourceId: `${input.messageId}-{auth.clientId}`,
                payload: {
                    distributedRunId: input.distributedRunId,
                    messageId: input.messageId,
                    role: input.role,
                    from: '{auth.clientId}',
                },
            },
            timeoutMs: 45_000,
        }],
    };
}

function rtcConnectRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef,
): RallarBlackBoxTestRecipe {
    return {
        recipeId,
        commands: [{
            kind: 'rtc.connect',
            commandId: `${recipeId}-connect`,
            connection: 'distributed-rtc',
            actor: '{auth.clientId}',
            roomId: group.groupId,
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            roomRef: group,
            transport: 'realtime',
            rallar: {
                apiBaseUrl: config.apiBaseUrl,
                restoreSession: true,
                logoutOnClose: false,
                leaveRoomOnClose: false,
            },
            timeoutMs: 45_000,
        }],
    };
}

function rtcSendRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef,
    messageId: string,
    distributedRunId?: string,
): RallarBlackBoxTestRecipe {
    return {
        recipeId,
        commands: [{
            kind: 'rtc.send',
            commandId: `${recipeId}-send`,
            connection: 'distributed-rtc',
            transport: 'realtime',
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            roomRef: group,
            send: {
                roomId: group.groupId,
                openTimeoutMs: 20_000,
                data: {
                    topic: 'rallar.black-box.distributed.recipe.qa',
                    distributedRunId,
                    messageId,
                    deliveryMode: 'broadcast',
                    transport: 'realtime',
                    groupId: group.groupId,
                },
            },
            timeoutMs: 60_000,
        }],
    };
}

function rtcRealtimeDistributedRecipe(
    recipeId: string,
    group: RallarBlackBoxDistributedGroupRef,
    distributedRunId: string,
): RallarBlackBoxTestRecipe {
    const base = createRallarBlackBoxRtcRealtimeRecipe({
        durationSeconds: 1,
        group,
    });
    return {
        ...base,
        recipeId,
        name: recipeId,
        commands: base.commands.map(command => {
            if (command.kind !== 'loop') {
                return command;
            }
            return {
                ...command,
                commands: command.commands.map(child => {
                    if (child.kind !== 'rtc.send') {
                        return child;
                    }
                    const send = asRecord(child.send);
                    const data = asRecord(send.data);
                    return {
                        ...child,
                        send: {
                            ...send,
                            data: {
                                ...data,
                                distributedRunId,
                                messageId: `rtc-realtime-${distributedRunId}`,
                            },
                        },
                    };
                }),
            };
        }),
    };
}

async function attachDistributedRunSummary(
    request: APIRequestContext,
    testInfo: TestInfo,
    runId: string,
): Promise<void> {
    const run = await fetchControlRun(request, runId);
    const distributedResponse = await request.get(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`);
    const distributed = distributedResponse.ok()
        ? await distributedResponse.json() as Readonly<{ distributedRuns?: readonly DistributedRunSnapshot[] }>
        : undefined;
    await testInfo.attach('distributed-recipe-run-summary.json', {
        body: JSON.stringify({
            runId,
            agents: run.agents?.map(agent => ({
                agentId: agent.agentId,
                connected: agent.connected,
                identity: agent.identity,
            })),
            resultCount: run.results?.length ?? 0,
            eventCount: run.events?.length ?? 0,
            distributedRuns: distributed?.distributedRuns
                ?.filter(item => item.controlRunId === runId)
                .map(item => ({
                    distributedRunId: item.distributedRunId,
                    state: item.state,
                    targets: item.targetAgentIds,
                    failures: item.rollup.failures,
                })),
        }, null, 2),
        contentType: 'application/json',
    });
}

async function attachDistributedWarningRegressionReport(
    testInfo: TestInfo,
    name: string,
    report: unknown,
): Promise<void> {
    await testInfo.attach(`${name}.json`, {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
    });
}

test.describe('full-stack distributed recipes with simulated agents', () => {
    test.skip(!config.enabled, config.skipReason);

    test('runs all-agent ACK through group target resolution and shows artifacts/history', async ({
                                                                                                      browser,
                                                                                                      request,
                                                                                                  }, testInfo) => {
        test.setTimeout(120_000);
        const suffix = uniqueSuffix();
        const runId = `dist-sim-ack-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `dist-sim-group-${suffix}`,
        };
        const handles: AgentHandle[] = [];

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                handles.push(await openControlAgent(browser, {
                    provider: 'simulated',
                    prefix,
                    runId,
                    agentId: `dist-sim-${prefix.toLowerCase()}-${suffix}`,
                    actor: `sim-${prefix.toLowerCase()}-${suffix}`,
                    connection: `dist-sim-${prefix.toLowerCase()}-${suffix}`,
                    group,
                }));
            }
            await configureAgentsForDistributedGroup(request, runId, handles, 'simulated', group, suffix);
            await waitForAgentsInGroup(request, runId, handles.map(handle => handle.agentId), group);

            const recipe = compositeEvidenceRecipe(`composite-ack-all-${suffix}`);
            const manifest = distributedManifest({
                distributedRunId: `dist-ack-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: recipe.recipeId,
                    recipe,
                    required: true,
                    profile: 'full-stack',
                }],
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 3,
                },
                displayName: 'All-agent ACK smoke',
            });

            const passed = await runToPassed(request, manifest);
            expect(passed.targetAgentIds.sort()).toEqual(handles.map(handle => handle.agentId).sort());
            expect(passed.rollup.summary.passedParticipants).toBe(3);
            expect(passed.commandLinks.filter(link => link.phase === 'stage')).toHaveLength(3);
            expect(passed.commandLinks.filter(link => link.phase === 'start')).toHaveLength(3);

            const artifact = await fetchDistributedArtifact(request, manifest.distributedRunId);
            expect(artifact.files?.['distributed-run.json']).toContain(manifest.distributedRunId);
            expect(artifact.files?.['manifest.json']).toContain(recipe.recipeId);
            expect(artifact.files?.['control-run.json']).toContain(runId);

            const panel = handles[0].page.locator('#panel-distributed-recipes');
            await handles[0].page.getByRole('button', {
                name: 'Distributed Recipes',
                exact: true,
            }).click();
            await panel.getByRole('button', { name: 'Refresh' }).click();
            await expect(panel).toContainText(manifest.distributedRunId, { timeout: 15_000 });
            await expect(panel).toContainText('passed');
        } finally {
            await attachDistributedRunSummary(request, testInfo, runId).catch(() => undefined);
            await Promise.all(handles.map(handle =>
                handle.context.close().catch(() => undefined)
            ));
        }
    });

    test('covers missing target, schema failure, ACK timeout, disconnect, and failure rollup', async ({
                                                                                                          browser,
                                                                                                          request,
                                                                                                      }) => {
        test.setTimeout(180_000);
        const suffix = uniqueSuffix();
        const runId = `dist-sim-negative-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `dist-sim-negative-${suffix}`,
        };
        const handles: AgentHandle[] = [];
        let ackTimeoutSocket: WebSocket | undefined;
        let failureSocket: WebSocket | undefined;

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                handles.push(await openControlAgent(browser, {
                    provider: 'simulated',
                    prefix,
                    runId,
                    agentId: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                    actor: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                    connection: `dist-neg-${prefix.toLowerCase()}-${suffix}`,
                    group,
                }));
            }
            await configureAgentsForDistributedGroup(request, runId, handles, 'simulated', group, suffix);
            await waitForAgentsInGroup(request, runId, handles.map(handle => handle.agentId), group);

            const schemaFailureResponse = await request.post(`${FULL_STACK_CONTROL_BASE_URL}/distributed-runs`, {
                data: {
                    manifest: {
                        distributedRunId: `dist-invalid-${suffix}`,
                        recipes: [],
                    },
                },
            });
            expect(schemaFailureResponse.status()).toBe(400);
            expect(await schemaFailureResponse.text()).toMatch(/group|recipes|required/i);

            const missingManifest = distributedManifest({
                distributedRunId: `dist-missing-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `missing-health-${suffix}`,
                    recipe: healthRecipe(`missing-health-${suffix}`),
                    required: true,
                }],
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 4,
                },
            });
            await createDistributedRun(request, missingManifest);
            const missing = await mutateDistributedRun(request, missingManifest.distributedRunId, 'stage');
            expect(missing.state).toBe('failed');
            expect(missing.error?.code).toBe('RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');

            const ackTimeoutAgentId = `silent-no-ack-${suffix}`;
            ackTimeoutSocket = await openScriptedControlAgent({
                runId,
                agentId: ackTimeoutAgentId,
                group,
                providerMode: 'silent-control',
            });
            await waitForAgentsInGroup(request, runId, [ackTimeoutAgentId], group);

            const ackTimeoutManifest = distributedManifest({
                distributedRunId: `dist-ack-timeout-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `timeout-health-${suffix}`,
                    recipe: healthRecipe(`timeout-health-${suffix}`),
                    required: true,
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [ackTimeoutAgentId],
                    expectedParticipantCount: 1,
                },
                ackTimeoutMs: 100,
            });
            await createDistributedRun(request, ackTimeoutManifest);
            await mutateDistributedRun(request, ackTimeoutManifest.distributedRunId, 'stage');
            const timedOut = await waitForDistributedState(
                request,
                ackTimeoutManifest.distributedRunId,
                'timed-out',
                15_000,
            );
            expect(JSON.stringify(timedOut.rollup.failures)).toContain('RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT');
            ackTimeoutSocket.close();
            ackTimeoutSocket = undefined;

            const failureAgentId = `scripted-failure-${suffix}`;
            failureSocket = await openScriptedControlAgent({
                runId,
                agentId: failureAgentId,
                group,
                providerMode: 'scripted-failure',
                onCommand: command => scriptedControlResult({
                    runId,
                    agentId: failureAgentId,
                    command,
                    ok: command.command.kind === 'recipe.load',
                    errorCode: 'RALLAR_BLACK_BOX_RECIPE_FAILED',
                    errorMessage: 'Scripted distributed recipe failure.',
                }),
            });
            await waitForAgentsInGroup(request, runId, [failureAgentId], group);

            const failureManifest = distributedManifest({
                distributedRunId: `dist-one-agent-fails-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [
                    {
                        recipeId: `role-pass-${suffix}`,
                        role: 'passer',
                        recipe: healthRecipe(`role-pass-${suffix}`),
                        required: true,
                    },
                    {
                        recipeId: `role-fail-${suffix}`,
                        role: 'breaker',
                        recipe: {
                            recipeId: `role-fail-${suffix}`,
                            commands: [{
                                kind: 'ws.send',
                                commandId: `role-fail-ws-${suffix}`,
                                connection: `missing-ws-${suffix}`,
                                data: {
                                    scenario: 'expected recipe failure',
                                },
                            }],
                        },
                        required: true,
                    },
                ],
                targetPolicy: {
                    mode: 'role-map',
                    roles: {
                        passer: [handles[0].agentId],
                        breaker: [failureAgentId],
                    },
                    expectedParticipantCount: 2,
                },
            });
            await createDistributedRun(request, failureManifest);
            await mutateDistributedRun(request, failureManifest.distributedRunId, 'stage');
            await waitForDistributedState(request, failureManifest.distributedRunId, 'ready');
            await mutateDistributedRun(request, failureManifest.distributedRunId, 'start');
            const failed = await waitForDistributedState(request, failureManifest.distributedRunId, 'failed');
            expect(failed.rollup.summary.failedRecipes).toBeGreaterThanOrEqual(1);
            expect(JSON.stringify(failed.rollup.failures)).toContain('RALLAR_BLACK_BOX_RECIPE_FAILED');

            const disconnectManifest = distributedManifest({
                distributedRunId: `dist-disconnect-after-stage-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: `disconnect-health-${suffix}`,
                    recipe: healthRecipe(`disconnect-health-${suffix}`),
                    required: true,
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [handles[0].agentId, handles[1].agentId],
                    expectedParticipantCount: 2,
                },
            });
            await createDistributedRun(request, disconnectManifest);
            await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'stage');
            await waitForDistributedState(request, disconnectManifest.distributedRunId, 'ready');
            await handles[1].context.close();
            await expect.poll(async () => {
                const run = await fetchControlRun(request, runId);
                return run.agents?.find(agent => agent.agentId === handles[1].agentId)?.connected;
            }, { timeout: 10_000 }).toBe(false);
            await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'start');
            const running = await waitForDistributedState(request, disconnectManifest.distributedRunId, 'running', 15_000);
            const disconnectedStart = running.commandLinks.find(link =>
                link.phase === 'start' && link.agentId === handles[1].agentId
            );
            expect(disconnectedStart).toBeTruthy();
            const runAfterDisconnect = await fetchControlRun(request, runId);
            expect(runAfterDisconnect.commands?.find(command =>
                command.envelope?.commandId === disconnectedStart?.commandId
            )?.completedAtEpochMs).toBeUndefined();
            const cancelled = await mutateDistributedRun(request, disconnectManifest.distributedRunId, 'cancel');
            expect(cancelled.state).toBe('cancelled');
        } finally {
            ackTimeoutSocket?.close();
            failureSocket?.close();
            await Promise.all(handles.map(handle => handle.context.close().catch(() => undefined)));
        }
    });
});

test.describe('full-stack distributed recipes with live Rallar data', () => {
    test.skip(
        !hasLiveDistributedConfig,
        [
            'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1,',
            'VITE_RALLAR_API_BASE_URL, and three live users/restored sessions.',
            'Use VITE_RALLAR_AGENT_A/B/C_USERNAME and VITE_RALLAR_AGENT_A/B/C_PASSWORD,',
            'or matching TOKEN/CLIENT_ID/SESSION_ID variables.',
        ].join(' '),
    );

    test('runs distributed ACK, WS, and RTC recipes against real browser agents', async ({
                                                                                             browser,
                                                                                             request,
                                                                                         }, testInfo) => {
        test.setTimeout(420_000);
        const suffix = `dist-live-${uniqueSuffix()}`;
        const runId = `distributed-live-${suffix}`;
        const group: RallarBlackBoxDistributedGroupRef = {
            applicationId: config.applicationId,
            workspaceId: config.workspaceId,
            groupId: `${config.roomId}-${suffix}`,
        };
        const handles: AgentHandle[] = [];
        const consoleArtifacts = createConsoleArtifactRecorder();

        try {
            for (const prefix of ['A', 'B', 'C'] as const) {
                const handle = await openControlAgent(browser, {
                    provider: 'browser-rallar',
                    prefix,
                    runId,
                    agentId: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    actor: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    connection: `dist-live-${prefix.toLowerCase()}-${suffix}`,
                    group,
                    auth: agentAuth(prefix),
                });
                consoleArtifacts.watch(handle.page, handle.agentId);
                handles.push(handle);
            }
            const agents = handles as [AgentHandle, AgentHandle, AgentHandle];
            await configureAgentsForDistributedGroup(request, runId, agents, 'browser-rallar', group, suffix);
            await waitForAgentsInGroup(request, runId, agents.map(agent => agent.agentId), group);
            await setupGroupMembership(request, runId, {
                owner: agents[0],
                members: agents,
                group,
                suffix,
            });

            const ackRecipe = healthRecipe(`live-ack-${suffix}`);
            const ack = await runToPassed(request, distributedManifest({
                distributedRunId: `dist-live-ack-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: ackRecipe.recipeId,
                    recipe: ackRecipe,
                    required: true,
                    profile: 'live',
                }],
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 3,
                },
            }));
            expect(ack.targetAgentIds).toHaveLength(3);

            const wsTypeId = `room.rallar-black-box.distributed.ws.${suffix}`;
            const wsTopicId = wsTypeId;
            const wsPrimerId = `ws-primer-${suffix}`;
            const wsPrimerRecipe = wsSendRecipe(`live-ws-primer-${suffix}`, group, {
                typeId: wsTypeId,
                topicId: wsTopicId,
                messageId: wsPrimerId,
                role: 'primer',
            });
            await runToPassed(request, distributedManifest({
                distributedRunId: `dist-live-ws-primer-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: wsPrimerRecipe.recipeId,
                    recipe: wsPrimerRecipe,
                    required: true,
                    profile: 'live-ws',
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: agents.map(agent => agent.agentId),
                    expectedParticipantCount: 3,
                },
            }));

            const wsMessageId = `ws-sender-receiver-${suffix}`;
            const wsDistributedRunId = `dist-live-ws-send-${suffix}`;
            const wsSenderRecipe = wsSendRecipe(`live-ws-sender-${suffix}`, group, {
                typeId: wsTypeId,
                topicId: wsTopicId,
                messageId: wsMessageId,
                role: 'sender',
                distributedRunId: wsDistributedRunId,
            });
            const wsPassed = await runToPassed(request, distributedManifest({
                distributedRunId: wsDistributedRunId,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: wsSenderRecipe.recipeId,
                    role: 'sender',
                    recipe: wsSenderRecipe,
                    required: true,
                    profile: 'live-ws',
                }],
                targetPolicy: {
                    mode: 'role-map',
                    roles: {
                        sender: [agents[0].agentId],
                    },
                    expectedParticipantCount: 1,
                },
            }));
            await Promise.all([
                waitForBrowserMessage(request, runId, {
                    agentId: agents[1].agentId,
                    transport: 'ws',
                    messageId: wsMessageId,
                }),
                waitForBrowserMessage(request, runId, {
                    agentId: agents[2].agentId,
                    transport: 'ws',
                    messageId: wsMessageId,
                }),
            ]);
            const wsArtifact = await fetchDistributedArtifact(request, wsDistributedRunId);
            const wsWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: wsPassed as AppControlDistributedRunSnapshot,
                controlRun: await fetchControlRun(request, runId) as AppControlRunSnapshot,
                artifactBundle: wsArtifact as AppControlDistributedRunArtifactBundle,
                expectation: {
                    messageEvidence: [wsMessageId],
                    failOnDiagnosticSeverities: ['error'],
                },
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-ws-warning-regression',
                wsWarningReport,
            );
            expect(wsWarningReport.ok, wsWarningReport.failures.join('\n')).toBe(true);

            const rtcConnect = rtcConnectRecipe(`live-rtc-connect-${suffix}`, group);
            await runToPassed(request, distributedManifest({
                distributedRunId: `dist-live-rtc-connect-${suffix}`,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: rtcConnect.recipeId,
                    recipe: rtcConnect,
                    required: true,
                    profile: 'live-rtc',
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: agents.map(agent => agent.agentId),
                    expectedParticipantCount: 3,
                },
            }));

            const rtcMessageId = `rtc-broadcast-${suffix}`;
            const rtcDistributedRunId = `dist-live-rtc-send-${suffix}`;
            const rtcSender = rtcSendRecipe(`live-rtc-send-${suffix}`, group, rtcMessageId, rtcDistributedRunId);
            const rtcPassed = await runToPassed(request, distributedManifest({
                distributedRunId: rtcDistributedRunId,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: rtcSender.recipeId,
                    role: 'sender',
                    recipe: rtcSender,
                    required: true,
                    profile: 'live-rtc',
                }],
                targetPolicy: {
                    mode: 'role-map',
                    roles: {
                        sender: [agents[0].agentId],
                    },
                    expectedParticipantCount: 1,
                },
            }));
            await Promise.all([
                waitForBrowserMessage(request, runId, {
                    agentId: agents[1].agentId,
                    transport: 'realtime',
                    messageId: rtcMessageId,
                }),
                waitForBrowserMessage(request, runId, {
                    agentId: agents[2].agentId,
                    transport: 'realtime',
                    messageId: rtcMessageId,
                }),
            ]);

            const rtcArtifact = await fetchDistributedArtifact(request, rtcDistributedRunId);
            expect(rtcArtifact.files?.['distributed-run.json']).toContain(rtcMessageId);
            const rtcWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: rtcPassed as AppControlDistributedRunSnapshot,
                controlRun: await fetchControlRun(request, runId) as AppControlRunSnapshot,
                artifactBundle: rtcArtifact as AppControlDistributedRunArtifactBundle,
                expectation: {
                    messageEvidence: [rtcMessageId],
                    failOnDiagnosticSeverities: ['error'],
                },
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-rtc-warning-regression',
                rtcWarningReport,
            );
            expect(rtcWarningReport.ok, rtcWarningReport.failures.join('\n')).toBe(true);

            const realtimeDistributedRunId = `dist-live-rtc-realtime-${suffix}`;
            const realtimeRecipe = rtcRealtimeDistributedRecipe(
                `live-rtc-realtime-${suffix}`,
                group,
                realtimeDistributedRunId,
            );
            const realtimePassed = await runToPassed(request, distributedManifest({
                distributedRunId: realtimeDistributedRunId,
                controlRunId: runId,
                group,
                recipes: [{
                    recipeId: realtimeRecipe.recipeId,
                    recipe: realtimeRecipe,
                    required: true,
                    profile: 'live-rtc-realtime',
                }],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: agents.map(agent => agent.agentId),
                    expectedParticipantCount: 3,
                },
            }));
            await waitForRealtimePositionPayload(request, runId, realtimeDistributedRunId);
            await emitKnownLiveWarningDiagnostics(agents, {
                distributedRunId: realtimeDistributedRunId,
                group,
            });
            await Promise.all([
                waitForRuntimeDiagnostic(request, runId, {
                    distributedRunId: realtimeDistributedRunId,
                    diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                }),
                waitForRuntimeDiagnostic(request, runId, {
                    distributedRunId: realtimeDistributedRunId,
                    diagnosticTypeId: 'rallar.browser.rtc.data_channel_warning',
                }),
            ]);

            const realtimeControlRun = await fetchControlRun(request, runId);
            const realtimeArtifact = await fetchDistributedArtifact(request, realtimeDistributedRunId);
            const realtimeMonitor = deriveDistributedRunMonitor({
                distributedRun: realtimePassed as AppControlDistributedRunSnapshot,
                controlRun: realtimeControlRun as AppControlRunSnapshot,
                artifactBundle: realtimeArtifact as AppControlDistributedRunArtifactBundle,
            });
            const retainedRealtimeEvidence = retainedRealtimeRecipeEvidence(
                realtimeControlRun,
                realtimePassed,
            );
            await testInfo.attach('distributed-live-realtime-retained-evidence.json', {
                body: JSON.stringify(retainedRealtimeEvidence, null, 2),
                contentType: 'application/json',
            });
            expect(retainedRealtimeEvidence.compactedStartResults).toHaveLength(3);
            for (const result of retainedRealtimeEvidence.compactedStartResults) {
                expect(result).toEqual({
                    agentId: expect.any(String),
                    ok: true,
                    resultCount: realtimeRecipe.commands.length,
                    failureCount: 0,
                    resultsOmitted: true,
                });
            }
            expect(retainedRealtimeEvidence.loopStats).toHaveLength(3);
            for (const stats of retainedRealtimeEvidence.loopStats) {
                expect(stats).toEqual({
                    agentId: expect.any(String),
                    latestLoopCommandId: 'rtc-realtime-position-loop',
                    plannedIterations: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    completedIterations: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    sendCount: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    succeeded: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
                    failed: 0,
                });
            }
            expect(realtimeMonitor.compositeDrilldowns).toEqual([]);

            const realtimeWarningReport = deriveDistributedRunWarningRegressionReport({
                distributedRun: realtimePassed as AppControlDistributedRunSnapshot,
                controlRun: realtimeControlRun as AppControlRunSnapshot,
                artifactBundle: realtimeArtifact as AppControlDistributedRunArtifactBundle,
                expectation: {
                    messageEvidence: [
                        realtimeDistributedRunId,
                        'room.black-box.rtc-realtime.position',
                    ],
                    diagnosticTypeIds: [
                        'rallar.browser.ws.unhandled_message',
                        'rallar.browser.rtc.data_channel_warning',
                    ],
                    compositeRecipeIds: [],
                    failOnDiagnosticSeverities: ['error'],
                },
            });
            await attachDistributedWarningRegressionReport(
                testInfo,
                'distributed-live-realtime-warning-regression',
                realtimeWarningReport,
            );
            expect(realtimeWarningReport.ok, realtimeWarningReport.failures.join('\n')).toBe(true);

            const panel = agents[0].page.locator('#panel-distributed-recipes');
            await agents[0].page.getByRole('button', {
                name: 'Distributed Recipes',
                exact: true,
            }).click();
            await panel.getByRole('button', { name: 'Refresh' }).click();
            await panel.locator('.distributed-run-list .distributed-run-row')
                .filter({ hasText: realtimeDistributedRunId })
                .first()
                .click();
            await expect(panel).toContainText('room.black-box.rtc-realtime.position', { timeout: 15_000 });
            await expect(panel).toContainText(realtimeDistributedRunId);
            const diagnostics = panel.getByLabel('Distributed runtime diagnostics');
            await expect(diagnostics).toContainText('Unhandled WS message');
            await expect(diagnostics).toContainText('Received data channel for different data channel name.');
            const composite = panel.getByLabel('Distributed composite drilldowns');
            await expect(composite).toContainText('No composite result drilldowns');

            expect(consoleArtifacts.highSeverityEntries()).toEqual([]);
        } finally {
            if (handles.length > 0) {
                await attachDistributedRunSummary(request, testInfo, runId).catch(() => undefined);
                await attachConsoleArtifacts(testInfo, consoleArtifacts.entries).catch(() => undefined);
            }
            await Promise.all(handles.map(async handle => {
                await executeOk(
                    request,
                    runId,
                    handle.agentId,
                    `best-effort-close-${handle.prefix.toLowerCase()}-${suffix}`,
                    { kind: 'close' },
                    15_000,
                ).catch(() => undefined);
                await handle.context.close().catch(() => undefined);
            }));
        }
    });
});
