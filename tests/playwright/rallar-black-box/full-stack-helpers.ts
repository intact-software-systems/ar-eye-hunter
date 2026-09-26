import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
    type TestInfo
} from '@playwright/test';

import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { bindAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlCommandEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';

import {
    readFullStackControlBaseUrl,
    toFullStackControlWebSocketUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { startPageDiagnosticsCapture, type PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';

export const FULL_STACK_CONTROL_BASE_URL = readFullStackControlBaseUrl();
export const FULL_STACK_CONTROL_WS_URL = toFullStackControlWebSocketUrl(
    FULL_STACK_CONTROL_BASE_URL
);
export const FULL_STACK_SPA_ORIGIN = normalizeBaseUrl(
    envValue('VITE_RALLAR_SPA_BASE_URL') ?? 'http://localhost:5176'
);

export interface FullStackUser {
    readonly username: string;
    readonly password: string;
    readonly clientId: string;
    readonly actor: string;
}

export interface BrowserAuthSession {
    readonly clientId: string;
    readonly username: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly expiresAtEpochMs: number;
}

export interface FullStackConfig {
    readonly enabled: boolean;
    readonly skipReason: string;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly roomId: string;
    readonly userA: FullStackUser;
    readonly userB: FullStackUser;
    readonly userC: FullStackUser;
}

export type ExhaustivePostgresConfig =
    & FullStackConfig
    & Readonly<{
        exhaustive: true;
        controlBaseUrl: string;
        controlWsUrl: string;
    }>;

export type ExhaustiveTabId =
    | 'quick-test'
    | 'auth'
    | 'manual-rallar'
    | 'rooms-clients'
    | 'websocket'
    | 'rtc-realtime'
    | 'topology'
    | 'rtc-diagnostics'
    | 'rallar-data'
    | 'crdt-health'
    | 'media'
    | 'local-workbench'
    | 'run-manager'
    | 'distributed-recipes'
    | 'rallar-trace'
    | 'event-stream'
    | 'rallar-server'
    | 'flow-builder'
    | 'shared-test'
    | 'recipes'
    | 'runs'
    | 'builder'
    | 'advanced';

export type ExhaustiveWorkspace = 'rallar' | 'black-box-runner';

export interface DisposableBrowserContext {
    readonly context: BrowserContext;
    readonly page: Page;
    readonly groupId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly session: BrowserAuthSession;
}

export interface ControlRunEvent {
    readonly kind?: string;
    readonly agentId?: string;
    readonly commandId?: string;
    readonly payload?: Readonly<{
        topic?: string;
        payload?: Readonly<{ ok?: boolean; }>;
    }>;
}

export interface ControlRunSnapshot {
    readonly results?: readonly ControlResult[];
    readonly events?: readonly ControlRunEvent[];
    readonly stats?: readonly unknown[];
    readonly reports?: readonly unknown[];
}

export interface TwoAgentRunParticipant {
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
    readonly context: BrowserContext;
    readonly page: Page;
    /** Absent only for a synthetic participant that never opened a real page (e.g. a unit-test double). */
    readonly diagnostics?: PageDiagnosticsCapture;
}

export interface TwoAgentRun {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly sender: TwoAgentRunParticipant;
    readonly receiver: TwoAgentRunParticipant;
    readSnapshot(): Promise<ControlRunSnapshot>;
    close(): Promise<void>;
}

export interface RecipeRunOutcome {
    readonly commandId: string;
    readonly ok: boolean;
    readonly summary: string;
}

export interface RecipePairOutcome {
    readonly sender: RecipeRunOutcome;
    readonly receiver: RecipeRunOutcome;
}

export interface RecipePair {
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
}

/** A recipient recipe whose connect barrier has released; its outcome settles when the recipe does. */
export interface StartedRecipientRun {
    readonly outcome: Promise<RecipeRunOutcome>;
}

interface ControlResult {
    readonly commandId?: string;
    readonly ok?: boolean;
    readonly result?: unknown;
    readonly error?: ControlResultError;
}

interface ControlResultError {
    readonly code?: string;
    readonly message?: string;
    /** The failing child command's own error when a recipe fails. */
    readonly details?: ControlResultError;
}

const TAB_LABELS: Readonly<Record<ExhaustiveTabId, string>> = {
    'quick-test': 'Quick Test',
    auth: 'Auth',
    'manual-rallar': 'Manual Rallar',
    'rooms-clients': 'Groups/Clients',
    websocket: 'WebSocket',
    'rtc-realtime': 'RTC/Realtimes',
    topology: 'Topology',
    'rtc-diagnostics': 'RTC Diagnostics',
    'rallar-data': 'Rallar Data',
    'crdt-health': 'CRDT',
    media: 'Media',
    'local-workbench': 'Local Workbench',
    'run-manager': 'Run Manager',
    'distributed-recipes': 'Distributed Recipes',
    'rallar-trace': 'Rallar Trace',
    'event-stream': 'Event Stream',
    'rallar-server': 'Rallar Server',
    'flow-builder': 'Flow Builder',
    'shared-test': 'Shared Test',
    recipes: 'Recipes',
    runs: 'Runs',
    builder: 'Builder',
    advanced: 'Advanced'
};

const RUNNER_PANEL_TARGETS: Partial<
    Readonly<Record<ExhaustiveTabId, Readonly<{ tab: ExhaustiveTabId; surfaceLabel?: string; }>>>
> = {
    'manual-rallar': { tab: 'advanced', surfaceLabel: 'Manual Rallar' },
    'local-workbench': { tab: 'advanced', surfaceLabel: 'Local Workbench' },
    'run-manager': { tab: 'advanced', surfaceLabel: 'Run Manager' },
    'distributed-recipes': { tab: 'advanced', surfaceLabel: 'Distributed Recipes' },
    'shared-test': { tab: 'advanced', surfaceLabel: 'Shared Test' },
    'flow-builder': { tab: 'builder' }
};

const COMMAND_RESULT_TOPIC = 'rallar.bb.command.result';
const RTC_READINESS_WAIT_TOPIC = 'rallar.bb.rtc.readiness_wait_started';
const RECIPE_RUN_TIMEOUT_MS = 180_000;
const RECEIVER_CONNECT_TIMEOUT_MS = 60_000;
const CONTROL_POLL_INTERVAL_MS = 250;

export function readFullStackConfig(): FullStackConfig {
    const enabled = process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' ||
        process.env.RALLAR_BLACK_BOX_FULL_STACK === 'true';
    const configuredRoomId = envValue('VITE_RALLAR_ROOM_ID');

    return {
        enabled,
        skipReason:
            'Set RALLAR_BLACK_BOX_FULL_STACK=1 and provide either Postgres env files or RALLAR_BLACK_BOX_API_MODE=memory for apps/api-v1 full-stack Rallar Black Box tests.',
        apiBaseUrl: normalizeBaseUrl(envValue('VITE_RALLAR_API_BASE_URL') ?? 'http://localhost:8080'),
        applicationId: envValue('VITE_RALLAR_APPLICATION_ID') ?? 'rallar-server',
        workspaceId: envValue('VITE_RALLAR_WORKSPACE_ID') ?? 'default',
        roomId: configuredRoomId && configuredRoomId !== 'your-room-id'
            ? configuredRoomId
            : `rallar-bb-full-stack-${Date.now()}`,
        userA: {
            username: envValue('VITE_RALLAR_USERNAME') ?? 'alice',
            password: envValue('VITE_RALLAR_PASSWORD') ?? 'secret',
            clientId: envValue('VITE_RALLAR_CLIENT_ID') ??
                envValue('VITE_RALLAR_USERNAME') ??
                'alice',
            actor: envValue('VITE_RALLAR_ACTOR') ?? 'alice'
        },
        userB: {
            username: envValue('VITE_RALLAR_B_USERNAME') ?? 'bob',
            password: envValue('VITE_RALLAR_B_PASSWORD') ?? 'secret',
            clientId: envValue('VITE_RALLAR_B_CLIENT_ID') ??
                envValue('VITE_RALLAR_B_USERNAME') ??
                'bob',
            actor: envValue('VITE_RALLAR_B_ACTOR') ?? 'bob'
        },
        userC: {
            username: envValue('VITE_RALLAR_C_USERNAME') ?? 'charlie',
            password: envValue('VITE_RALLAR_C_PASSWORD') ?? 'secret',
            clientId: envValue('VITE_RALLAR_C_CLIENT_ID') ??
                envValue('VITE_RALLAR_C_USERNAME') ??
                'charlie',
            actor: envValue('VITE_RALLAR_C_ACTOR') ?? 'charlie'
        }
    };
}

export function readExhaustivePostgresConfig(): ExhaustivePostgresConfig {
    const config = readFullStackConfig();
    const apiMode = envValue('RALLAR_BLACK_BOX_API_MODE') ?? 'postgres';
    const enabled = config.enabled && apiMode !== 'memory';
    return {
        ...config,
        enabled,
        exhaustive: true,
        controlBaseUrl: FULL_STACK_CONTROL_BASE_URL,
        controlWsUrl: FULL_STACK_CONTROL_WS_URL,
        skipReason: enabled
            ? config.skipReason
            : 'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.'
    };
}

export async function expectFullStackApiReady(
    request: APIRequestContext,
    config: FullStackConfig
): Promise<void> {
    const configResponse = await request.get(`${config.apiBaseUrl}/api/config`, {
        headers: {
            origin: FULL_STACK_SPA_ORIGIN
        }
    });
    expect(configResponse.ok()).toBe(true);
    expect(configResponse.headers()['access-control-allow-origin']).toBe(FULL_STACK_SPA_ORIGIN);
}

export async function loginThroughUi(
    page: Page,
    config: FullStackConfig,
    user: FullStackUser,
    input: Readonly<{
        suffix: string;
        tab?:
            | 'quick-test'
            | 'manual-rallar'
            | 'rallar-server'
            | 'event-stream'
            | 'local-workbench'
            | 'rallar-data'
            | 'recipes';
        registerBeforeLogin?: boolean;
    }>
): Promise<void> {
    const sessionId = `${user.actor}-session-${input.suffix}`;
    await installExhaustiveRequestClientKey(page, config, sessionId);
    const query = new URLSearchParams({
        provider: 'browser-rallar',
        apiBaseUrl: config.apiBaseUrl,
        roomId: config.roomId,
        actor: user.actor,
        sessionId,
        tab: input.tab ?? 'rallar-server'
    });

    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await page.getByLabel('API Base URL').fill(config.apiBaseUrl);
    await page.getByLabel('Username').fill(user.username);
    await page.getByLabel('Password').fill(user.password);
    if (input.registerBeforeLogin) {
        await page.getByLabel('Register before login').check();
    }
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('tab', { name: 'Rallar Server' })).toBeVisible();
    await expect(page.locator('.run-header')).toContainText(user.username);
}

export async function loginUser(
    page: Page,
    config: FullStackConfig,
    user: FullStackUser,
    input: Readonly<{
        groupId: string;
        sessionId: string;
        tab?: ExhaustiveTabId;
        workspace?: ExhaustiveWorkspace;
        registerBeforeLogin?: boolean;
    }>
): Promise<BrowserAuthSession> {
    await installExhaustiveRequestClientKey(page, config, input.sessionId);
    const query = new URLSearchParams({
        provider: 'browser-rallar',
        apiBaseUrl: config.apiBaseUrl,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        roomId: input.groupId,
        actor: user.actor,
        sessionId: input.sessionId,
        tab: input.tab ?? 'rallar-server',
        ...(input.workspace ? { workspace: input.workspace } : {})
    });

    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await page.getByLabel('API Base URL').fill(config.apiBaseUrl);
    await page.getByLabel('Username').fill(user.username);
    await page.getByLabel('Password').fill(user.password);
    if (input.registerBeforeLogin) {
        await page.getByLabel('Register before login').check();
    }
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.run-header')).toContainText(user.username, { timeout: 30_000 });
    await openTab(page, input.tab ?? 'rallar-server', input.workspace);
    return await readBrowserAuthSession(page);
}

export async function installExhaustiveRequestClientKey(
    page: Page,
    config: Pick<FullStackConfig, 'apiBaseUrl'>,
    seed: string
): Promise<void> {
    const clientKey = `rallar-exhaustive-${sanitizeId(seed)}-${
        hashString(
            `${config.apiBaseUrl}:${seed}`
        )
    }`;
    await page.route('**/api/**', async (route) => {
        await route.continue({
            headers: {
                ...route.request().headers(),
                'cf-connecting-ip': clientKey
            }
        });
    });
}

export async function newDisposableContext(
    browser: Browser,
    config: FullStackConfig,
    user: FullStackUser,
    testInfo: TestInfo,
    input: Readonly<{
        tab?: ExhaustiveTabId;
        workspace?: ExhaustiveWorkspace;
        groupId?: string;
        runId?: string;
        agentId?: string;
    }> = {}
): Promise<DisposableBrowserContext> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const groupId = input.groupId ?? uniqueGroupId(testInfo);
    const runId = input.runId ?? uniqueRunId(testInfo);
    const agentId = input.agentId ?? uniqueAgentId(testInfo, user.actor);
    const session = await loginUser(page, config, user, {
        groupId,
        sessionId: `${agentId}-session`,
        tab: input.tab,
        workspace: input.workspace
    });
    return { context, page, groupId, runId, agentId, session };
}

export async function sendWsTicketFromRestWorkbench(
    page: Page,
    config: FullStackConfig
): Promise<Readonly<Record<string, string>>> {
    const requestPromise = page.waitForRequest((request) =>
        request.url().startsWith(`${config.apiBaseUrl}/api/auth/ws-ticket/requests/`) &&
        request.method() === 'POST'
    );
    const panel = page.locator('#panel-rallar-server');

    await page.getByRole('tab', { name: 'Rallar Server' }).click();
    await panel.getByLabel('Endpoint').selectOption('auth-ws-ticket');
    await panel.getByRole('button', { name: 'Send' }).click();

    const outgoingRequest = await requestPromise;
    await expect(panel).toContainText('200 OK');
    await expect(panel).toContainText('"ticket"');

    return outgoingRequest.headers();
}

export async function readBrowserAuthSession(page: Page): Promise<BrowserAuthSession> {
    const session = await page.evaluate(() => {
        const raw = window.localStorage.getItem('auth.session');
        return raw ? JSON.parse(raw) as unknown : undefined;
    }) as Partial<BrowserAuthSession> | undefined;

    expect(session?.clientId).toBeTruthy();
    expect(session?.username).toBeTruthy();
    expect(session?.sessionId).toBeTruthy();
    expect(session?.accessToken).toBeTruthy();

    return session as BrowserAuthSession;
}

export async function openTab(
    page: Page,
    tab: ExhaustiveTabId,
    workspace?: ExhaustiveWorkspace
): Promise<void> {
    if (workspace) {
        const modeSwitch = page.getByLabel('Rallar workspace mode');
        const modeName = workspace === 'black-box-runner'
            ? /Rallar black-box-runner/
            : /Rallar Direct live/;
        await modeSwitch.getByRole('button', { name: modeName }).click();
    }

    const panelTarget = RUNNER_PANEL_TARGETS[tab];
    const visibleTab = panelTarget?.tab ?? tab;
    const label = TAB_LABELS[visibleTab];
    await page.getByRole('tab', { name: label, exact: true }).click();
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
    );
    if (panelTarget?.surfaceLabel) {
        await page.locator('#panel-advanced')
            .getByRole('button', { name: panelTarget.surfaceLabel, exact: true })
            .click();
    }
    await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

export async function enqueueControlCommand(
    request: APIRequestContext,
    runId: string,
    agentId: string,
    commandId: string,
    command: unknown
): Promise<void> {
    const response = await request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
            encodeURIComponent(agentId)
        }/commands`,
        {
            data: {
                commandId,
                command
            }
        }
    );
    expect(response.status()).toBe(202);
}

export async function fetchControlRun(
    request: APIRequestContext,
    runId: string
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`
    );
    expect(response.ok()).toBe(true);
    return await response.json() as ControlRunSnapshot;
}

export async function waitForControlCommandOk(
    request: APIRequestContext,
    runId: string,
    commandId: string
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId);
        return run.results?.some((result) => result.commandId === commandId && result.ok === true) ??
            false;
    }, {
        timeout: 30_000
    }).toBe(true);
}

export async function waitForControlRunAgent(
    request: APIRequestContext,
    runId: string,
    agentId: string
): Promise<void> {
    await expect.poll(async () => {
        const run = await fetchControlRun(request, runId) as {
            agents?: readonly { agentId?: string; connected?: boolean; }[];
        };
        return run.agents?.some((agent) => agent.agentId === agentId && agent.connected) ?? false;
    }, {
        timeout: 30_000
    }).toBe(true);
}

export async function exportControlRunArtifacts(
    request: APIRequestContext,
    runId: string
): Promise<Readonly<Record<string, unknown>>> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/artifacts`
    );
    expect(response.ok()).toBe(true);
    return await response.json() as Readonly<Record<string, unknown>>;
}

export async function openBrowserControlAgent(
    browser: Browser,
    config: FullStackConfig,
    user: FullStackUser,
    input: Readonly<{
        runId: string;
        agentId: string;
        groupId: string;
        connection?: string;
        /** Requests page-diagnostics capture from page creation; omitted for callers that don't read it. */
        diagnosticsRole?: AlmConformanceRole;
    }>
): Promise<
    Readonly<{
        context: BrowserContext;
        page: Page;
        session: BrowserAuthSession;
        diagnostics?: PageDiagnosticsCapture;
    }>
> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const diagnostics = toPageDiagnosticsCapture(page, input);
    const query = new URLSearchParams({
        mode: 'control',
        workspace: 'black-box-runner',
        tab: 'local-workbench',
        provider: 'browser-rallar',
        autoConnect: '1',
        controlUrl: FULL_STACK_CONTROL_WS_URL,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: config.apiBaseUrl,
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        roomId: input.groupId,
        actor: user.actor,
        sessionId: `${input.agentId}-session`,
        heartbeatIntervalMs: '250',
        statsIntervalMs: '1000',
        rallarLeaveRoomOnClose: '0',
        rallarUsername: user.username,
        rallarPassword: user.password
    });

    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 30_000 }
    );
    await expect(page.locator('#panel-local-workbench .control-panel'))
        .toContainText('registered', { timeout: 30_000 });

    return {
        context,
        page,
        session: await readBrowserAuthSession(page),
        diagnostics
    };
}

function toPageDiagnosticsCapture(
    page: Page,
    input: Readonly<{ agentId: string; diagnosticsRole?: AlmConformanceRole; }>
): PageDiagnosticsCapture | undefined {
    return input.diagnosticsRole === undefined
        ? undefined
        : startPageDiagnosticsCapture(page, { agentId: input.agentId, role: input.diagnosticsRole });
}

export async function createTwoAgentRun(
    input: Readonly<{
        browser: Browser;
        request: APIRequestContext;
        testInfo: TestInfo;
        runId: string;
    }>
): Promise<TwoAgentRun> {
    const config = readFullStackConfig();
    const group: RallarBlackBoxDistributedGroupRef = {
        applicationId: config.applicationId,
        workspaceId: config.workspaceId,
        groupId: `${config.roomId}-${uniqueSuffix()}`
    };
    const { sender, receiver } = await openTwoAgentParticipants(input, config, group.groupId);

    return {
        request: input.request,
        runId: input.runId,
        group,
        sender,
        receiver,
        readSnapshot: async () => await fetchControlRun(input.request, input.runId),
        close: async () => await closeTwoAgentParticipants([sender, receiver])
    };
}

/** Closes whatever participant already opened when a later step in the pair fails, then rethrows. */
async function openTwoAgentParticipants(
    input: Readonly<{ browser: Browser; request: APIRequestContext; testInfo: TestInfo; runId: string; }>,
    config: FullStackConfig,
    groupId: string
): Promise<Readonly<{ sender: TwoAgentRunParticipant; receiver: TwoAgentRunParticipant; }>> {
    const base = { browser: input.browser, testInfo: input.testInfo, runId: input.runId, config, groupId };
    const opened: TwoAgentRunParticipant[] = [];
    try {
        const sender = await openTwoAgentParticipant(toParticipantInput(base, 'sender'));
        opened.push(sender);
        const receiver = await openTwoAgentParticipant(toParticipantInput(base, 'receiver'));
        opened.push(receiver);
        await waitForControlRunAgent(input.request, input.runId, sender.agentId);
        await waitForControlRunAgent(input.request, input.runId, receiver.agentId);
        return { sender, receiver };
    }
    catch (error) {
        await closeTwoAgentParticipants(opened);
        throw error;
    }
}

function toParticipantInput(
    base: Readonly<{
        browser: Browser;
        testInfo: TestInfo;
        runId: string;
        config: FullStackConfig;
        groupId: string;
    }>,
    role: 'sender' | 'receiver'
): Parameters<typeof openTwoAgentParticipant>[0] {
    return {
        browser: base.browser,
        testInfo: base.testInfo,
        runId: base.runId,
        config: base.config,
        user: role === 'sender' ? base.config.userA : base.config.userB,
        role,
        groupId: base.groupId
    };
}

export async function runRecipeOnAgent(
    run: TwoAgentRun,
    agent: TwoAgentRunParticipant,
    recipe: RallarBlackBoxTestRecipe
): Promise<RecipeRunOutcome> {
    const commandId = toRecipeRunCommandId(recipe);
    await enqueueControlCommand(run.request, run.runId, agent.agentId, commandId, {
        kind: 'recipe.run',
        recipe
    });
    return await readRecipeRunOutcome(run, commandId);
}

/**
 * Authored paired reload roots are bound and enqueued together; control owns their causal checkpoints.
 * For ordinary recipes, the receiver subscribes at connect, so its recipe starts first and the sender waits until the
 * receiver's connect command reports an ok result. A connect that must see a ready peer cannot
 * report one before the sender exists, so entering the readiness wait — which the runtime records
 * only after the connection is established and subscribed — releases the barrier too, as does a
 * receiver recipe that has already settled.
 */
export async function runRecipePairOnTwoAgents(
    run: TwoAgentRun,
    recipes: RecipePair
): Promise<RecipePairOutcome> {
    if (
        Object.hasOwn(recipes.sender.metadata ?? {}, 'almReloadCheckpoints') ||
        Object.hasOwn(recipes.receiver.metadata ?? {}, 'almReloadCheckpoints')
    ) {
        const bound = bindAlmReloadPair({
            sender: toReloadRecipeRoot(run, run.sender, recipes.sender),
            receiver: toReloadRecipeRoot(run, run.receiver, recipes.receiver)
        });
        if (bound.left) {
            throw new Error(`Cannot enqueue paired reload: ${bound.left.join(' ')}`);
        }
        const pair = bound.right!;
        await enqueueControlCommand(
            run.request,
            run.runId,
            run.sender.agentId,
            pair.sender.commandId,
            pair.sender.command
        );
        await enqueueControlCommand(
            run.request,
            run.runId,
            run.receiver.agentId,
            pair.receiver.commandId,
            pair.receiver.command
        );
        const [sender, receiver] = await Promise.all([
            readRecipeRunOutcome(run, pair.sender.commandId),
            readRecipeRunOutcome(run, pair.receiver.commandId)
        ]);
        return { sender, receiver };
    }
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const [sender, receiver] = await Promise.all([
        runRecipeOnAgent(run, run.sender, recipes.sender),
        receiverRun.outcome
    ]);
    return { sender, receiver };
}

/** Starts a recipient recipe and returns once its connect barrier releases, so a sender can start after it. */
export async function startRecipientRecipeRun(
    run: TwoAgentRun,
    agent: TwoAgentRunParticipant,
    recipe: RallarBlackBoxTestRecipe
): Promise<StartedRecipientRun> {
    const connectCommandId = requireConnectCommandId(recipe);
    const outcome = runRecipeOnAgent(run, agent, recipe);
    await waitForReceiverConnectBarrier(run, {
        connectCommandId,
        runCommandId: toRecipeRunCommandId(recipe)
    });
    return { outcome };
}

export async function selectControlRunInManager(
    page: Page,
    runId: string
): Promise<Locator> {
    await openTab(page, 'run-manager', 'black-box-runner');
    const panel = page.locator('#panel-run-manager');
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel).toContainText(runId, { timeout: 30_000 });
    const runSelect = panel.locator('.run-manager-toolbar select').first();
    await runSelect.selectOption(runId);
    await expect(panel.locator('.run-manager-agent-list')).toBeVisible();
    return panel;
}

export async function resolveDistributedTargets(
    page: Page,
    runId: string
): Promise<Locator> {
    await openTab(page, 'distributed-recipes', 'black-box-runner');
    const panel = page.locator('#panel-distributed-recipes');
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel).toContainText(runId, { timeout: 30_000 });
    const runSelect = panel.locator('.distributed-toolbar select').first();
    if (await runSelect.count()) {
        await runSelect.selectOption(runId);
    }
    await panel.getByRole('button', { name: 'Resolve targets' }).click();
    await expect(panel.locator('.distributed-target-list')).toBeVisible();
    return panel;
}

export async function expectNoSecrets(
    locator: Locator,
    extraSecrets: readonly string[] = []
): Promise<void> {
    const text = await locator.textContent() ?? '';
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]{8,}/);
    expect(text).not.toMatch(/"ticket"\s*:\s*"(?!<redacted>|\{auth\.wsTicket\})[A-Za-z0-9._~-]{16,}"/);
    for (const secret of extraSecrets) {
        if (secret.length > 8) {
            expect(text).not.toContain(secret);
        }
    }
}

export async function cleanupRallarPage(page: Page): Promise<void> {
    for (
        const label of [
            'Close connections',
            'Close',
            'Cleanup',
            'Unsubscribe WS',
            'Clear subscriptions',
            'Stop all',
            'Logout'
        ]
    ) {
        await clickVisibleButton(page, label);
    }

    await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
    }).catch(() => undefined);
}

export function uniqueGroupId(testInfo: TestInfo): string {
    return uniqueScopedId('rallar-bb-group', testInfo);
}

export function uniqueRunId(testInfo: TestInfo): string {
    return uniqueScopedId('rallar-bb-run', testInfo);
}

export function uniqueAgentId(testInfo: TestInfo, prefix = 'agent'): string {
    return uniqueScopedId(prefix, testInfo);
}

export function uniqueSuffix(): string {
    return `${Date.now()}-${crypto.randomUUID()}`;
}

async function openTwoAgentParticipant(
    input: Readonly<{
        browser: Browser;
        config: FullStackConfig;
        user: FullStackUser;
        testInfo: TestInfo;
        runId: string;
        groupId: string;
        role: 'sender' | 'receiver';
    }>
): Promise<TwoAgentRunParticipant> {
    const agentId = uniqueAgentId(input.testInfo, `alm-${input.role}`);
    const connection = `alm-${input.role}-connection`;
    const opened = await openBrowserControlAgent(input.browser, input.config, input.user, {
        runId: input.runId,
        agentId,
        groupId: input.groupId,
        connection,
        diagnosticsRole: input.role
    });
    return {
        agentId,
        actor: input.user.actor,
        connection,
        context: opened.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

async function closeTwoAgentParticipants(
    participants: readonly TwoAgentRunParticipant[]
): Promise<void> {
    await Promise.all(participants.map(async (participant) => {
        await cleanupRallarPage(participant.page).catch(() => undefined);
        await participant.context.close().catch(() => undefined);
    }));
}

async function readRecipeRunOutcome(
    run: TwoAgentRun,
    commandId: string
): Promise<RecipeRunOutcome> {
    const deadlineEpochMs = Date.now() + RECIPE_RUN_TIMEOUT_MS;
    while (Date.now() < deadlineEpochMs) {
        const result = await readControlResult(run, commandId);
        if (result) {
            return {
                commandId,
                ok: result.ok === true,
                summary: toControlResultSummary(result)
            };
        }
        await waitMs(CONTROL_POLL_INTERVAL_MS);
    }
    return {
        commandId,
        ok: false,
        summary: `no control result within ${RECIPE_RUN_TIMEOUT_MS} ms`
    };
}

async function waitForReceiverConnectBarrier(
    run: TwoAgentRun,
    input: Readonly<{ connectCommandId: string; runCommandId: string; }>
): Promise<void> {
    const deadlineEpochMs = Date.now() + RECEIVER_CONNECT_TIMEOUT_MS;
    while (Date.now() < deadlineEpochMs) {
        const snapshot = await run.readSnapshot();
        if (
            hasConnectedEvent(snapshot, input.connectCommandId) ||
            findControlResult(snapshot, input.runCommandId) !== undefined
        ) {
            return;
        }
        await waitMs(CONTROL_POLL_INTERVAL_MS);
    }
    console.warn('Receiver connect barrier timed out; releasing the sender anyway', {
        runId: run.runId,
        connectCommandId: input.connectCommandId,
        runCommandId: input.runCommandId,
        timeoutMs: RECEIVER_CONNECT_TIMEOUT_MS
    });
}

async function readControlResult(
    run: TwoAgentRun,
    commandId: string
): Promise<ControlResult | undefined> {
    return findControlResult(await run.readSnapshot(), commandId);
}

function findControlResult(
    snapshot: ControlRunSnapshot,
    commandId: string
): ControlResult | undefined {
    return snapshot.results?.find((result) => result.commandId === commandId);
}

function hasConnectedEvent(
    snapshot: ControlRunSnapshot,
    commandId: string
): boolean {
    return snapshot.events?.some((event) => event.commandId === commandId && isConnectedEventPayload(event.payload)) ??
        false;
}

function isConnectedEventPayload(payload: ControlRunEvent['payload']): boolean {
    return payload?.topic === RTC_READINESS_WAIT_TOPIC ||
        (payload?.topic === COMMAND_RESULT_TOPIC && payload.payload?.ok === true);
}

function toControlResultSummary(result: ControlResult): string {
    return result.ok === true ? 'ok' : toControlErrorSummary(result.error);
}

function toControlErrorSummary(error: ControlResultError | undefined): string {
    const summary = `${error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED'}: ${error?.message ?? 'no message'}`;
    const cause = error?.details;
    return cause?.code === undefined && cause?.message === undefined
        ? summary
        : `${summary} Cause: ${toControlErrorSummary(cause)}`;
}

function toReloadRecipeRoot(
    run: TwoAgentRun,
    agent: TwoAgentRunParticipant,
    recipe: RallarBlackBoxTestRecipe
): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: run.runId,
        agentId: agent.agentId,
        commandId: toRecipeRunCommandId(recipe),
        command: { kind: 'recipe.run', recipe, timeoutMs: RECIPE_RUN_TIMEOUT_MS }
    };
}

function toRecipeRunCommandId(recipe: RallarBlackBoxTestRecipe): string {
    return `${recipe.recipeId}-run`;
}

function requireConnectCommandId(recipe: RallarBlackBoxTestRecipe): string {
    const commandId = recipe.commands
        .find((command) => command.kind === 'rtc.connect')
        ?.commandId;
    if (!commandId) {
        throw new Error(`Recipe ${recipe.recipeId} has no identified rtc.connect command.`);
    }
    return commandId;
}

async function waitMs(durationMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function clickVisibleButton(page: Page, name: string): Promise<void> {
    const button = page.getByRole('button', { name }).first();
    try {
        if ((await button.count()) > 0 && await button.isVisible() && await button.isEnabled()) {
            await button.click({ timeout: 2_000 });
        }
    }
    catch {
        // Best-effort cleanup intentionally ignores hidden, detached, or disabled buttons.
    }
}

function uniqueScopedId(prefix: string, testInfo: TestInfo): string {
    const project = sanitizeId(testInfo.project.name);
    const title = sanitizeId(testInfo.titlePath.slice(-2).join('-'));
    return `${prefix}-${project}-w${testInfo.workerIndex}-${title}-${uniqueSuffix()}`;
}

function sanitizeId(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'test';
}

function hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function envValue(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}
