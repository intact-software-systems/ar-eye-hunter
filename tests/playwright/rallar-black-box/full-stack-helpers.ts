import {
    expect,
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
    type TestInfo
} from '@playwright/test';

import { isRallarBlackBoxTestError } from '@shared-test/rallar-bb-test/composite-results.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { bindAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlCommandEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunArtifactBundle, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    isFiniteNumber,
    isNonEmptyText
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { decodeControlRunArtifactBundle } from '@shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import {
    readFullStackControlBaseUrl,
    toFullStackControlWebSocketUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestError,
    RallarBlackBoxTestRecipe
} from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { startPageDiagnosticsCapture, type PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';

export interface FullStackUser {
    readonly username: string;
    readonly password: string;
    readonly clientId: string;
    readonly actor: string;
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

export interface ExhaustivePostgresConfig extends FullStackConfig {
    readonly exhaustive: true;
    readonly controlBaseUrl: string;
    readonly controlWsUrl: string;
}

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
    | 'advanced'
    | 'fleet';

export type ExhaustiveWorkspace = 'rallar' | 'black-box-runner';

export interface TwoAgentRunParticipant extends RecipeRunAgent {
    readonly actor: string;
    readonly connection: string;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly diagnostics: PageDiagnosticsCapture;
}

export interface TwoAgentRun extends RecipePairRun {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly sender: TwoAgentRunParticipant;
    readonly receiver: TwoAgentRunParticipant;
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

/** An accepted recipe root; its caller owns when result observation starts and joins it. */
export interface StartedRecipeRun {
    readonly commandId: string;
    readOutcome(): Promise<RecipeRunOutcome>;
}

export interface BrowserControlAgentInput {
    readonly config: FullStackConfig;
    readonly user: FullStackUser;
    readonly runId: string;
    readonly agentId: string;
    readonly groupId: string;
    /** Requests page-diagnostics capture from page creation; omitted for callers that don't read it. */
    readonly diagnosticsRole?: AlmConformanceRole;
}

/** Owns a manually acquired receiver page through its native case and final evidence. */
export interface RallarReceiverPageRunInput {
    readonly browser: Browser;
    readonly sender: Page;
    run(receiver: Page): Promise<void>;
    captureEvidence(receiver: Page | undefined): Promise<void>;
}

export interface OpenedBrowserControlAgent {
    readonly context: BrowserContext;
    readonly page: Page;
    readonly session: AuthSession;
    readonly diagnostics?: PageDiagnosticsCapture;
}

export interface FullStackTestIdentity {
    readonly project: Pick<TestInfo['project'], 'name'>;
    readonly workerIndex: number;
    readonly titlePath: readonly string[];
}

export interface LoginThroughUiInput {
    readonly page: Page;
    readonly config: FullStackConfig;
    readonly user: FullStackUser;
    readonly suffix: string;
    readonly tab?:
        | 'quick-test'
        | 'manual-rallar'
        | 'rallar-server'
        | 'event-stream'
        | 'local-workbench'
        | 'rallar-data'
        | 'recipes';
    readonly registerBeforeLogin?: boolean;
}

export interface LoginUserInput {
    readonly page: Page;
    readonly config: FullStackConfig;
    readonly user: FullStackUser;
    readonly groupId: string;
    readonly sessionId: string;
    readonly tab?: ExhaustiveTabId;
    readonly workspace?: ExhaustiveWorkspace;
    readonly registerBeforeLogin?: boolean;
    readonly rallarLeaveRoomOnClose?: boolean;
}

export interface EnqueueControlCommandInput {
    readonly request: APIRequestContext;
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
}

export interface OpenBrowserControlAgentInput extends BrowserControlAgentInput {
    readonly browser: Browser;
}

export interface RecipeRunAgent {
    readonly agentId: string;
}

/** The actual HTTP and snapshot operations consumed by recipe execution. */
export interface RecipeRun {
    readonly request: APIRequestContext;
    readonly runId: string;
    readSnapshot(): Promise<ControlRunSnapshot>;
}

export interface RecipePairRun extends RecipeRun {
    readonly sender: RecipeRunAgent;
    readonly receiver: RecipeRunAgent;
}

export interface CreateTwoAgentRunInput {
    readonly browser: Browser;
    readonly request: APIRequestContext;
    readonly testInfo: FullStackTestIdentity;
    readonly runId: string;
}

interface RunnerPanelTarget {
    readonly tab: ExhaustiveTabId;
    readonly surfaceLabel?: string;
}

interface AgentDiagnosticsInput {
    readonly agentId: string;
    readonly diagnosticsRole?: AlmConformanceRole;
}

interface ParticipantBaseInput {
    readonly browser: Browser;
    readonly testInfo: FullStackTestIdentity;
    readonly runId: string;
    readonly config: FullStackConfig;
    readonly groupId: string;
}

interface OpenTwoAgentParticipantInput extends ParticipantBaseInput {
    readonly user: FullStackUser;
    readonly role: 'sender' | 'receiver';
}

interface TwoAgentParticipants {
    readonly sender: TwoAgentRunParticipant;
    readonly receiver: TwoAgentRunParticipant;
}

interface ReceiverConnectBarrierInput {
    readonly connectCommandId: string;
    readonly runCommandId: string;
}

interface FullStackSignInInput {
    readonly page: Page;
    readonly config: FullStackConfig;
    readonly user: FullStackUser;
    readonly registerBeforeLogin?: boolean;
    readonly query: URLSearchParams;
}

export const FULL_STACK_CONTROL_BASE_URL = readFullStackControlBaseUrl();
export const FULL_STACK_CONTROL_WS_URL = toFullStackControlWebSocketUrl(
    FULL_STACK_CONTROL_BASE_URL
);
export const FULL_STACK_SPA_ORIGIN = normalizeBaseUrl(
    envValue('VITE_RALLAR_SPA_BASE_URL') ?? 'http://localhost:5176'
);

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
    advanced: 'Advanced',
    fleet: 'Fleet'
};

const RUNNER_PANEL_TARGETS: Partial<Readonly<Record<ExhaustiveTabId, RunnerPanelTarget>>> = {
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

export async function loginThroughUi(input: LoginThroughUiInput): Promise<void> {
    const { page, config, user } = input;
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
    await signInFullStackUser({ ...input, query });
    await expect(page.getByRole('tab', { name: 'Rallar Server' })).toBeVisible();
    await expect(page.locator('.run-header')).toContainText(user.username);
}

export async function loginUser(input: LoginUserInput): Promise<AuthSession> {
    const { page, config, user } = input;
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
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.rallarLeaveRoomOnClose === undefined ? {} : {
            rallarLeaveRoomOnClose: input.rallarLeaveRoomOnClose ? '1' : '0'
        })
    });
    await signInFullStackUser({ ...input, query });
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

export async function readBrowserAuthSession(page: Page): Promise<AuthSession> {
    const session: unknown = await page.evaluate(() => {
        const raw = window.localStorage.getItem('auth.session');
        return raw ? JSON.parse(raw) : undefined;
    });
    return decodeFullStackAuthSession(session);
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

export async function enqueueControlCommand(input: EnqueueControlCommandInput): Promise<void> {
    const response = await input.request.post(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(input.runId)}/agents/${
            encodeURIComponent(input.agentId)
        }/commands`,
        { data: { commandId: input.commandId, command: input.command } }
    );
    expect(response.status()).toBe(202);
}

export async function readControlRun(
    request: APIRequestContext,
    runId: string
): Promise<ControlRunSnapshot> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`
    );
    expect(response.ok()).toBe(true);
    return decodeControlRunSnapshot(await response.json()).fold(
        (issue) => {
            throw new Error(`Invalid control run snapshot: ${issue}`);
        },
        (snapshot) => snapshot
    );
}

export async function waitForControlCommandOk(
    request: APIRequestContext,
    runId: string,
    commandId: string
): Promise<void> {
    await expect.poll(async () => {
        const run = await readControlRun(request, runId);
        return run.results.some((result) => result.commandId === commandId && result.ok === true);
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
        const run = await readControlRun(request, runId);
        return run.agents.some((agent) => agent.agentId === agentId && agent.connected);
    }, {
        timeout: 30_000
    }).toBe(true);
}

export async function exportControlRunArtifacts(
    request: APIRequestContext,
    runId: string
): Promise<ControlRunArtifactBundle> {
    const response = await request.get(
        `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/artifacts`
    );
    expect(response.ok()).toBe(true);
    return decodeControlRunArtifactBundle(await response.json()).fold(
        (issue) => {
            throw new Error(`Invalid control run artifact: ${issue}`);
        },
        (artifact) => artifact
    );
}

export async function openBrowserControlAgent(input: OpenBrowserControlAgentInput): Promise<OpenedBrowserControlAgent> {
    const context = await input.browser.newContext();
    try {
        return await openBrowserControlAgentInContext(context, input);
    }
    catch (error) {
        await closeAfterAcquisitionFailure(() => context.close(), error);
        throw error;
    }
}

/**
 * Opens a control agent page in a context that may already hold an auth session: a page of a context another agent
 * signed in skips the login screen, so it signs in only when the gate shows.
 */
export async function openBrowserControlAgentInContext(
    context: BrowserContext,
    agent: BrowserControlAgentInput
): Promise<OpenedBrowserControlAgent> {
    const page = await context.newPage();
    try {
        const diagnostics = startAgentDiagnosticsCapture(page, agent);
        await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${toBrowserControlAgentQuery(agent).toString()}`);
        await signInIfLoginGateIsVisible(page);
        await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true', {
            timeout: 30_000
        });
        await expect(page.locator('#panel-local-workbench .control-panel')).toContainText('registered', {
            timeout: 30_000
        });
        return { context, page, session: await readBrowserAuthSession(page), diagnostics };
    }
    catch (error) {
        await closeAfterAcquisitionFailure(() => closeBrowserControlAgentPage(page), error);
        throw error;
    }
}

export async function createTwoAgentRun(
    input: CreateTwoAgentRunInput
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
        readSnapshot: async () => await readControlRun(input.request, input.runId),
        close: async () => await closeTwoAgentParticipants([sender, receiver])
    };
}

export async function runRecipeOnAgent(
    run: RecipeRun,
    agent: RecipeRunAgent,
    recipe: RallarBlackBoxTestRecipe
): Promise<RecipeRunOutcome> {
    const started = await startRecipeRun(run, agent, recipe);
    return await started.readOutcome();
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
    run: RecipePairRun,
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
        const pair = bound.fold(
            (issues) => {
                throw new Error(`Cannot enqueue paired reload: ${issues.join(' ')}`);
            },
            (value) => value
        );
        await enqueueControlCommand({
            request: run.request,
            runId: run.runId,
            agentId: run.sender.agentId,
            commandId: pair.sender.commandId,
            command: pair.sender.command
        });
        await enqueueControlCommand({
            request: run.request,
            runId: run.runId,
            agentId: run.receiver.agentId,
            commandId: pair.receiver.commandId,
            command: pair.receiver.command
        });
        const [sender, receiver] = await Promise.allSettled([
            readRecipeRunOutcome(run, pair.sender.commandId),
            readRecipeRunOutcome(run, pair.receiver.commandId)
        ]);
        if (sender.status === 'rejected') {
            throw sender.reason;
        }
        if (receiver.status === 'rejected') {
            throw receiver.reason;
        }
        return { sender: sender.value, receiver: receiver.value };
    }
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const senderRun = await startRecipeRun(run, run.sender, recipes.sender);
    const [sender, receiver] = await Promise.allSettled([
        senderRun.readOutcome(),
        receiverRun.readOutcome()
    ]);
    if (sender.status === 'rejected') {
        throw sender.reason;
    }
    if (receiver.status === 'rejected') {
        throw receiver.reason;
    }
    return { sender: sender.value, receiver: receiver.value };
}

/** Accepts the root and captures its original result deadline without starting an unowned observer. */
export async function startRecipeRun(
    run: RecipeRun,
    agent: RecipeRunAgent,
    recipe: RallarBlackBoxTestRecipe
): Promise<StartedRecipeRun> {
    const commandId = await enqueueRecipeRun(run, agent, recipe);
    const deadlineEpochMs = Date.now() + RECIPE_RUN_TIMEOUT_MS;
    return { commandId, readOutcome: () => readRecipeRunOutcome(run, commandId, deadlineEpochMs) };
}

/** Starts a recipient recipe and returns once its connect barrier releases, so a sender can start after it. */
export async function startRecipientRecipeRun(
    run: RecipeRun,
    agent: RecipeRunAgent,
    recipe: RallarBlackBoxTestRecipe
): Promise<StartedRecipeRun> {
    const connectCommandId = requireConnectCommandId(recipe);
    const started = await startRecipeRun(run, agent, recipe);
    await waitForReceiverConnectBarrier(run, { connectCommandId, runCommandId: started.commandId });
    return started;
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

export async function refreshDistributedTargets(
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

    if (!page.isClosed()) {
        await page.evaluate(() => {
            window.localStorage.clear();
            window.sessionStorage.clear();
        });
    }
}

export async function runWithRallarReceiverPage(input: RallarReceiverPageRunInput): Promise<void> {
    const context = await input.browser.newContext();
    const failures: PromiseRejectedResult[] = [];
    let receiver: Page | undefined;
    const [acquisition] = await Promise.allSettled([Promise.resolve().then(() => context.newPage())]);
    if (acquisition.status === 'rejected') {
        failures.push(acquisition);
    }
    else {
        receiver = acquisition.value;
        const [body] = await Promise.allSettled([Promise.resolve().then(() => input.run(acquisition.value))]);
        if (body.status === 'rejected') {
            failures.push(body);
        }
    }
    const finalizationSteps = [
        () => input.captureEvidence(receiver),
        () => cleanupRallarPage(input.sender),
        () => receiver === undefined ? Promise.resolve() : cleanupRallarPage(receiver),
        () => context.close()
    ];
    for (const finalize of finalizationSteps) {
        const [result] = await Promise.allSettled([Promise.resolve().then(finalize)]);
        if (result.status === 'rejected') {
            failures.push(result);
        }
    }
    if (failures.length === 1) {
        throw failures[0].reason;
    }
    if (failures.length > 1) {
        throw new AggregateError(failures.map((failure) => failure.reason), 'Receiver run and finalization failed.', {
            cause: failures[0].reason
        });
    }
}

export function uniqueGroupId(testInfo: FullStackTestIdentity): string {
    return uniqueScopedId('rallar-bb-group', testInfo);
}

export function uniqueRunId(testInfo: FullStackTestIdentity): string {
    return uniqueScopedId('rallar-bb-run', testInfo);
}

export function uniqueAgentId(testInfo: FullStackTestIdentity, prefix = 'agent'): string {
    return uniqueScopedId(prefix, testInfo);
}

export function uniqueSuffix(): string {
    return `${Date.now()}-${crypto.randomUUID()}`;
}

/** Validates the browser/API authentication handoff without changing auth lifetime policy. */
export function decodeFullStackAuthSession(session: unknown): AuthSession {
    if (
        !isJsonRecordValue(session) || !isNonEmptyText(session.clientId) ||
        !isNonEmptyText(session.username) || !isNonEmptyText(session.sessionId) ||
        !isNonEmptyText(session.accessToken) || !isFiniteNumber(session.expiresAtEpochMs)
    ) {
        throw new Error('The browser authentication session is missing or invalid.');
    }
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessToken: session.accessToken,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}

/** Owns the newly acquired agent page and its capture listeners, never its borrowed context. */
export async function closeBrowserControlAgentPage(page: Page): Promise<void> {
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    await page.close();
}

function toBrowserControlAgentQuery(agent: BrowserControlAgentInput): URLSearchParams {
    return new URLSearchParams({
        mode: 'control',
        workspace: 'black-box-runner',
        tab: 'local-workbench',
        provider: 'browser-rallar',
        autoConnect: '1',
        controlUrl: FULL_STACK_CONTROL_WS_URL,
        runId: agent.runId,
        agentId: agent.agentId,
        apiBaseUrl: agent.config.apiBaseUrl,
        applicationId: agent.config.applicationId,
        workspaceId: agent.config.workspaceId,
        roomId: agent.groupId,
        actor: agent.user.actor,
        sessionId: `${agent.agentId}-session`,
        heartbeatIntervalMs: '250',
        statsIntervalMs: '1000',
        rallarLeaveRoomOnClose: '0',
        rallarUsername: agent.user.username,
        rallarPassword: agent.user.password
    });
}

function toParticipantInput(
    base: ParticipantBaseInput,
    role: 'sender' | 'receiver'
): OpenTwoAgentParticipantInput {
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

function findControlResult(
    snapshot: ControlRunSnapshot,
    commandId: string
): ControlResultEnvelope | undefined {
    return snapshot.results.find((result) => result.commandId === commandId);
}

function hasConnectedEvent(
    snapshot: ControlRunSnapshot,
    commandId: string
): boolean {
    return snapshot.events.some((event) => event.commandId === commandId && isConnectedEventPayload(event.payload));
}

function isConnectedEventPayload(payload: unknown): boolean {
    return isJsonRecordValue(payload) && (
        payload.topic === RTC_READINESS_WAIT_TOPIC ||
        (payload.topic === COMMAND_RESULT_TOPIC && isJsonRecordValue(payload.payload) && payload.payload.ok === true)
    );
}

function toReloadRecipeRoot(
    run: RecipeRun,
    agent: RecipeRunAgent,
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

function uniqueScopedId(prefix: string, testInfo: FullStackTestIdentity): string {
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

function normalizeBaseUrl(value: string): string {
    return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Either screen settles first; the workbench of a signed-in context never shows the gate. */
async function signInIfLoginGateIsVisible(page: Page): Promise<void> {
    const loginGate = page.getByRole('heading', { name: 'Rallar Server Login' });
    const workbench = page.getByRole('tab', { name: 'Advanced' });
    await expect(loginGate.or(workbench).first()).toBeVisible({ timeout: 30_000 });
    if (await loginGate.isVisible()) {
        await page.getByRole('button', { name: 'Sign in' }).click();
    }
}

function startAgentDiagnosticsCapture(
    page: Page,
    input: AgentDiagnosticsInput
): PageDiagnosticsCapture | undefined {
    return input.diagnosticsRole === undefined
        ? undefined
        : startPageDiagnosticsCapture(page, { agentId: input.agentId, role: input.diagnosticsRole });
}

/** Closes whatever participant already opened when a later step in the pair fails, then rethrows. */
async function openTwoAgentParticipants(
    input: CreateTwoAgentRunInput,
    config: FullStackConfig,
    groupId: string
): Promise<TwoAgentParticipants> {
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
        await closeAfterAcquisitionFailure(() => closeTwoAgentParticipants(opened), error);
        throw error;
    }
}

async function openTwoAgentParticipant(
    input: OpenTwoAgentParticipantInput
): Promise<TwoAgentRunParticipant> {
    const agentId = uniqueAgentId(input.testInfo, `alm-${input.role}`);
    const connection = `alm-${input.role}-connection`;
    const opened = await openBrowserControlAgent({
        browser: input.browser,
        config: input.config,
        user: input.user,
        runId: input.runId,
        agentId,
        groupId: input.groupId,
        diagnosticsRole: input.role
    });
    if (opened.diagnostics === undefined) {
        await opened.context.close();
        throw new Error('A completed pair participant must own diagnostics.');
    }
    return {
        agentId,
        actor: input.user.actor,
        connection,
        context: opened.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

async function closeTwoAgentParticipants(participants: readonly TwoAgentRunParticipant[]): Promise<void> {
    const results = await Promise.allSettled(participants.map(async (participant) => {
        try {
            await cleanupRallarPage(participant.page);
        }
        finally {
            await participant.context.close();
        }
    }));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to close full-stack participants.');
    }
}

async function readRecipeRunOutcome(
    run: RecipeRun,
    commandId: string,
    deadlineEpochMs = Date.now() + RECIPE_RUN_TIMEOUT_MS
): Promise<RecipeRunOutcome> {
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
    run: RecipeRun,
    input: ReceiverConnectBarrierInput
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
    run: RecipeRun,
    commandId: string
): Promise<ControlResultEnvelope | undefined> {
    return findControlResult(await run.readSnapshot(), commandId);
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

function envValue(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

async function signInFullStackUser(input: FullStackSignInInput): Promise<void> {
    await input.page.goto(`${FULL_STACK_SPA_ORIGIN}/?${input.query.toString()}`);
    await expect(input.page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
    await input.page.getByLabel('API Base URL').fill(input.config.apiBaseUrl);
    await input.page.getByLabel('Username').fill(input.user.username);
    await input.page.getByLabel('Password').fill(input.user.password);
    if (input.registerBeforeLogin) {
        await input.page.getByLabel('Register before login').check();
    }
    await input.page.getByRole('button', { name: 'Sign in' }).click();
}

async function enqueueRecipeRun(
    run: RecipeRun,
    agent: RecipeRunAgent,
    recipe: RallarBlackBoxTestRecipe
): Promise<string> {
    const commandId = toRecipeRunCommandId(recipe);
    await enqueueControlCommand({
        request: run.request,
        runId: run.runId,
        agentId: agent.agentId,
        commandId,
        command: { kind: 'recipe.run', recipe }
    });
    return commandId;
}

function toControlResultSummary(result: ControlResultEnvelope): string {
    return result.ok === true ? 'ok' : toControlErrorSummary(result.error);
}

function toControlErrorSummary(error: RallarBlackBoxTestError | undefined): string {
    const summary = `${error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED'}: ${error?.message ?? 'no message'}`;
    return isRallarBlackBoxTestError(error?.details)
        ? `${summary} Cause: ${toControlErrorSummary(error.details)}`
        : summary;
}

async function closeAfterAcquisitionFailure(close: () => Promise<void>, originalError: unknown): Promise<void> {
    try {
        await close();
    }
    catch (cleanupError) {
        throw new AggregateError([originalError, cleanupError], 'Acquisition failed and cleanup also failed.', {
            cause: originalError
        });
    }
}
