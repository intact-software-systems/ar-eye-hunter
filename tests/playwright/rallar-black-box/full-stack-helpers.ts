import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

export const FULL_STACK_CONTROL_BASE_URL = 'http://127.0.0.1:5180';
export const FULL_STACK_CONTROL_WS_URL = 'ws://127.0.0.1:5180/control';
export const FULL_STACK_SPA_ORIGIN = 'http://localhost:5176';

export type FullStackUser = Readonly<{
  username: string;
  password: string;
  clientId: string;
  actor: string;
}>;

export type BrowserAuthSession = Readonly<{
  clientId: string;
  username: string;
  sessionId: string;
  accessToken: string;
  expiresAtEpochMs: number;
}>;

export type FullStackConfig = Readonly<{
  enabled: boolean;
  skipReason: string;
  apiBaseUrl: string;
  applicationId: string;
  workspaceId: string;
  roomId: string;
  userA: FullStackUser;
  userB: FullStackUser;
  userC: FullStackUser;
}>;

export type ExhaustivePostgresConfig = FullStackConfig & Readonly<{
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

export type DisposableBrowserContext = Readonly<{
  context: BrowserContext;
  page: Page;
  groupId: string;
  runId: string;
  agentId: string;
  session: BrowserAuthSession;
}>;

type ControlResult = Readonly<{
  commandId?: string;
  ok?: boolean;
  result?: unknown;
}>;

type ControlRunSnapshot = Readonly<{
  results?: readonly ControlResult[];
  events?: readonly unknown[];
  stats?: readonly unknown[];
  reports?: readonly unknown[];
}>;

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
      actor: envValue('VITE_RALLAR_ACTOR') ?? 'alice',
    },
    userB: {
      username: envValue('VITE_RALLAR_B_USERNAME') ?? 'bob',
      password: envValue('VITE_RALLAR_B_PASSWORD') ?? 'secret',
      clientId: envValue('VITE_RALLAR_B_CLIENT_ID') ??
        envValue('VITE_RALLAR_B_USERNAME') ??
        'bob',
      actor: envValue('VITE_RALLAR_B_ACTOR') ?? 'bob',
    },
    userC: {
      username: envValue('VITE_RALLAR_C_USERNAME') ?? 'charlie',
      password: envValue('VITE_RALLAR_C_PASSWORD') ?? 'secret',
      clientId: envValue('VITE_RALLAR_C_CLIENT_ID') ??
        envValue('VITE_RALLAR_C_USERNAME') ??
        'charlie',
      actor: envValue('VITE_RALLAR_C_ACTOR') ?? 'charlie',
    },
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
      : 'Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.',
  };
}

export async function expectFullStackApiReady(
  request: APIRequestContext,
  config: FullStackConfig,
): Promise<void> {
  const configResponse = await request.get(`${config.apiBaseUrl}/api/config`, {
    headers: {
      origin: FULL_STACK_SPA_ORIGIN,
    },
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
  }>,
): Promise<void> {
  const sessionId = `${user.actor}-session-${input.suffix}`;
  await installExhaustiveRequestClientKey(page, config, sessionId);
  const query = new URLSearchParams({
    provider: 'browser-rallar',
    apiBaseUrl: config.apiBaseUrl,
    roomId: config.roomId,
    actor: user.actor,
    sessionId,
    tab: input.tab ?? 'rallar-server',
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
  }>,
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
    ...(input.workspace ? { workspace: input.workspace } : {}),
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
  seed: string,
): Promise<void> {
  const clientKey = `rallar-exhaustive-${sanitizeId(seed)}-${hashString(
    `${config.apiBaseUrl}:${seed}`,
  )}`;
  await page.route('**/api/**', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        'cf-connecting-ip': clientKey,
      },
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
  }> = {},
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
    workspace: input.workspace,
  });
  return { context, page, groupId, runId, agentId, session };
}

export async function sendWsTicketFromRestWorkbench(
  page: Page,
  config: FullStackConfig,
): Promise<Readonly<Record<string, string>>> {
  const requestPromise = page.waitForRequest((request) =>
    request.url() === `${config.apiBaseUrl}/api/auth/ws-ticket` &&
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
  workspace?: ExhaustiveWorkspace,
): Promise<void> {
  if (workspace) {
    const modeSwitch = page.getByLabel('Rallar workspace mode');
    const modeName = workspace === 'black-box-runner'
      ? /Rallar black-box-runner/
      : /Rallar Direct live/;
    await modeSwitch.getByRole('button', { name: modeName }).click();
  }

  const label = TAB_LABELS[tab];
  await page.getByRole('tab', { name: label, exact: true }).click();
  await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator(`#panel-${tab}`)).toBeVisible();
}

export async function enqueueControlCommand(
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

export async function fetchControlRun(
  request: APIRequestContext,
  runId: string,
): Promise<ControlRunSnapshot> {
  const response = await request.get(
    `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`,
  );
  expect(response.ok()).toBe(true);
  return await response.json() as ControlRunSnapshot;
}

export async function waitForControlCommandOk(
  request: APIRequestContext,
  runId: string,
  commandId: string,
): Promise<void> {
  await expect.poll(async () => {
    const run = await fetchControlRun(request, runId);
    return run.results?.some((result) => result.commandId === commandId && result.ok === true) ??
      false;
  }, {
    timeout: 30_000,
  }).toBe(true);
}

export async function waitForControlRunAgent(
  request: APIRequestContext,
  runId: string,
  agentId: string,
): Promise<void> {
  await expect.poll(async () => {
    const run = await fetchControlRun(request, runId) as {
      agents?: readonly { agentId?: string; connected?: boolean }[];
    };
    return run.agents?.some(agent => agent.agentId === agentId && agent.connected) ?? false;
  }, {
    timeout: 30_000,
  }).toBe(true);
}

export async function exportControlRunArtifacts(
  request: APIRequestContext,
  runId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await request.get(
    `${FULL_STACK_CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/artifacts`,
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
  }>,
): Promise<Readonly<{
  context: BrowserContext;
  page: Page;
  session: BrowserAuthSession;
}>> {
  const context = await browser.newContext();
  const page = await context.newPage();
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
    rallarPassword: user.password,
  });

  await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
  await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Local Workbench' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Local Workbench' }).click();
  await expect(page.locator('#panel-local-workbench .control-panel'))
    .toContainText('registered', { timeout: 30_000 });

  return {
    context,
    page,
    session: await readBrowserAuthSession(page),
  };
}

export async function selectControlRunInManager(
  page: Page,
  runId: string,
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
  runId: string,
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
  extraSecrets: readonly string[] = [],
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
  for (const label of [
    'Close connections',
    'Close',
    'Cleanup',
    'Unsubscribe WS',
    'Clear subscriptions',
    'Stop all',
    'Logout',
  ]) {
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
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  advanced: 'Advanced',
};

async function clickVisibleButton(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name }).first();
  try {
    if ((await button.count()) > 0 && await button.isVisible() && await button.isEnabled()) {
      await button.click({ timeout: 2_000 });
    }
  } catch {
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
