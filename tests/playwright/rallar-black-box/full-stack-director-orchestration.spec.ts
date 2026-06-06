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
  cleanupRallarPage,
  enqueueControlCommand,
  exportControlRunArtifacts,
  fetchControlRun,
  openBrowserControlAgent,
  readFullStackConfig,
  uniqueAgentId,
  uniqueGroupId,
  uniqueRunId,
} from './full-stack-helpers.ts';

type AgentPrefix = 'A' | 'B' | 'C';

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
  commandId?: string;
  payload?: unknown;
}>;

const config = readFullStackConfig();
const directorEnabled = booleanEnv('RALLAR_BLACK_BOX_DIRECTOR');
const hasDirectorConfig = config.enabled && directorEnabled;

function booleanEnv(key: string): boolean {
  const normalized = process.env[key]?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on';
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

function resultValue(result: ControlResult): Record<string, unknown> {
  return asRecord(result.result?.value);
}

function directorStatusValue(result: ControlResult): Record<string, unknown> {
  return asRecord(resultValue(result).directorStatus);
}

function eventPayload(event: ControlEvent): Record<string, unknown> {
  return asRecord(event.payload);
}

function runtimeEventPayload(event: ControlEvent): Record<string, unknown> {
  const payload = eventPayload(event);
  return typeof payload.kind === 'string'
    ? payload
    : asRecord(payload.payload ?? payload);
}

function runtimeEventText(event: ControlEvent): string {
  return JSON.stringify(runtimeEventPayload(event));
}

async function waitForCommandResult(
  request: APIRequestContext,
  runId: string,
  commandId: string,
  timeout = 45_000,
): Promise<ControlResult> {
  let latest: ControlResult | undefined;
  await expect.poll(async () => {
    const run = await fetchControlRun(request, runId) as {
      results?: readonly ControlResult[];
    };
    latest = run.results?.find((result) => result.commandId === commandId);
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
  await enqueueControlCommand(request, runId, agentId, commandId, command);
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
  expect(result.ok, JSON.stringify(result.error ?? result)).toBe(true);
  return result;
}

async function waitForDirectorEvent(
  request: APIRequestContext,
  runId: string,
  input: Readonly<{
    agentId: string;
    topic: string;
    contains: readonly string[];
  }>,
): Promise<void> {
  await expect.poll(async () => {
    const run = await fetchControlRun(request, runId) as {
      events?: readonly ControlEvent[];
    };
    return run.events?.some((event) => {
      const payload = runtimeEventPayload(event);
      const text = runtimeEventText(event);
      return event.agentId === input.agentId &&
        payload.topic === input.topic &&
        input.contains.every(fragment => text.includes(fragment));
    }) ?? false;
  }, {
    timeout: 60_000,
  }).toBe(true);
}

async function openAgents(
  browser: Browser,
  runId: string,
  groupId: string,
  testInfo: TestInfo,
): Promise<readonly [AgentHandle, AgentHandle, AgentHandle]> {
  const users = {
    A: config.userA,
    B: config.userB,
    C: config.userC,
  } as const;
  const handles: AgentHandle[] = [];
  for (const prefix of ['A', 'B', 'C'] as const) {
    const agentId = uniqueAgentId(testInfo, `director-${prefix.toLowerCase()}`);
    const opened = await openBrowserControlAgent(browser, config, users[prefix], {
      runId,
      agentId,
      groupId,
      connection: `${agentId}-rtc`,
    });
    handles.push({
      context: opened.context,
      page: opened.page,
      prefix,
      agentId,
      actor: users[prefix].actor,
      connection: `${agentId}-director`,
    });
  }
  return handles as [AgentHandle, AgentHandle, AgentHandle];
}

async function closeAgents(agents: readonly AgentHandle[]): Promise<void> {
  await Promise.all(agents.map(async (agent) => {
    await cleanupRallarPage(agent.page).catch(() => undefined);
    await agent.context.close().catch(() => undefined);
  }));
}

async function setupGroupMembership(
  request: APIRequestContext,
  runId: string,
  input: Readonly<{
    owner: AgentHandle;
    members: readonly AgentHandle[];
    groupId: string;
  }>,
): Promise<void> {
  const groupSegment = pathSegment(input.groupId);
  await executeOk(request, runId, input.owner.agentId, 'director-group-create', {
    kind: 'http.request',
    request: {
      path: `/api/state/apps/${pathSegment(config.applicationId)}/workspaces/${
        pathSegment(config.workspaceId)
      }/groups`,
      method: 'POST',
      body: {
        groupId: input.groupId,
        displayName: input.groupId,
        description: 'Created by rallar-black-box director orchestration',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: '{auth.clientId}',
        metadata: {
          source: 'rallar-black-box',
          scenario: 'director-orchestration',
        },
      },
    },
    response: {
      body: 'json',
    },
    timeoutMs: 10_000,
  });

  for (const member of input.members) {
    await executeOk(request, runId, member.agentId, `director-group-join-${member.prefix.toLowerCase()}`, {
      kind: 'http.request',
      request: {
        path: `/api/state/apps/${pathSegment(config.applicationId)}/workspaces/${
          pathSegment(config.workspaceId)
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
}

async function connectAgent(
  request: APIRequestContext,
  runId: string,
  agent: AgentHandle,
  groupId: string,
): Promise<Readonly<{ commandId: string; sessionId: string }>> {
  const commandId = `director-connect-${agent.prefix.toLowerCase()}`;
  const result = await executeOk(request, runId, agent.agentId, commandId, {
    kind: 'rtc.connect',
    connection: agent.connection,
    actor: agent.actor,
    roomId: groupId,
    applicationId: config.applicationId,
    workspaceId: config.workspaceId,
    roomRef: {
      applicationId: config.applicationId,
      workspaceId: config.workspaceId,
      groupId,
    },
    transport: 'realtime',
    rallar: {
      apiBaseUrl: config.apiBaseUrl,
      restoreSession: true,
      logoutOnClose: false,
      leaveRoomOnClose: false,
      applicationId: config.applicationId,
      workspaceId: config.workspaceId,
      transport: 'realtime',
    },
    timeoutMs: 45_000,
  }, 60_000);
  const sessionId = stringValue(resultValue(result).sessionId);
  if (!sessionId) {
    throw new Error(`Connect result ${commandId} did not include a sessionId.`);
  }
  return { commandId, sessionId };
}

async function waitForPeerReadiness(
  request: APIRequestContext,
  runId: string,
  agent: AgentHandle,
  expectedPeerIds: readonly string[],
): Promise<void> {
  let attempt = 0;
  await expect.poll(async () => {
    const result = await executeResult(
      request,
      runId,
      agent.agentId,
      `director-health-${agent.prefix.toLowerCase()}-${attempt++}`,
      { kind: 'health' },
      15_000,
    ).catch(() => undefined);
    if (!result?.ok) {
      return [];
    }
    return stringArrayValue(
      asRecord(asRecord(resultValue(result).rallar).rtcStatus).readyPeerIds,
    );
  }, {
    timeout: 60_000,
  }).toEqual(expect.arrayContaining(expectedPeerIds));
}

function directorRoomFields(groupId: string): Record<string, unknown> {
  return {
    roomId: groupId,
    applicationId: config.applicationId,
    workspaceId: config.workspaceId,
    roomRef: {
      applicationId: config.applicationId,
      workspaceId: config.workspaceId,
      groupId,
    },
  };
}

test.describe('full-stack SPA-appointed director orchestration', () => {
  test.skip(
    !hasDirectorConfig,
    'Set RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_DIRECTOR=1 to run the full-stack director orchestration scenario.',
  );

  test('appoints A as director, relays B/C intents, snapshots, and marks stale without auto-election', async ({
    browser,
    request,
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
    const agents = await openAgents(browser, runId, groupId, testInfo);
    const [agentA, agentB, agentC] = agents;

    try {
      await setupGroupMembership(request, runId, {
        owner: agentA,
        members: agents,
        groupId,
      });

      const connectResults = await Promise.all(
        agents.map(agent => connectAgent(request, runId, agent, groupId)),
      );
      const sessions = {
        A: connectResults[0].sessionId,
        B: connectResults[1].sessionId,
        C: connectResults[2].sessionId,
      };

      await Promise.all([
        waitForPeerReadiness(request, runId, agentA, [sessions.B, sessions.C]),
        waitForPeerReadiness(request, runId, agentB, [sessions.A, sessions.C]),
        waitForPeerReadiness(request, runId, agentC, [sessions.A, sessions.B]),
      ]);

      const appoint = await executeOk(request, runId, agentA.agentId, 'director-appoint-a', {
        kind: 'director.appoint',
        ...directorRoomFields(groupId),
        heartbeatTtlMs: 1_200,
        timeoutMs: 20_000,
      }, 30_000);
      expect(directorStatusValue(appoint)).toMatchObject({
        role: 'director',
        state: 'fresh',
        isDirector: true,
      });

      const statusA = await executeOk(request, runId, agentA.agentId, 'director-status-a', {
        kind: 'director.status',
        ...directorRoomFields(groupId),
        refresh: true,
      });
      const statusB = await executeOk(request, runId, agentB.agentId, 'director-status-b', {
        kind: 'director.status',
        ...directorRoomFields(groupId),
        refresh: true,
      });
      const statusC = await executeOk(request, runId, agentC.agentId, 'director-status-c', {
        kind: 'director.status',
        ...directorRoomFields(groupId),
        refresh: true,
      });
      const epoch = asRecord(directorStatusValue(statusA).appointment).epoch;
      expect(directorStatusValue(statusA)).toMatchObject({ role: 'director', isDirector: true });
      expect(directorStatusValue(statusB)).toMatchObject({ role: 'client', isDirector: false });
      expect(directorStatusValue(statusC)).toMatchObject({ role: 'client', isDirector: false });
      expect(asRecord(directorStatusValue(statusB).appointment)).toMatchObject({
        sessionId: sessions.A,
        epoch,
      });
      expect(asRecord(directorStatusValue(statusC).appointment)).toMatchObject({
        sessionId: sessions.A,
        epoch,
      });

      for (const agent of agents) {
        await executeOk(request, runId, agent.agentId, `director-relay-start-${agent.prefix.toLowerCase()}`, {
          kind: 'director.relay.start',
          handle: relayHandle,
          ...directorRoomFields(groupId),
          laneId: 'director',
          topicId,
          intentTypeId,
          outputTypeId,
          heartbeatIntervalMs: 300,
          snapshotIntervalMs: 500,
          timeoutMs: 20_000,
        });
      }

      await executeOk(request, runId, agentB.agentId, 'director-intent-b', {
        kind: 'director.intent',
        handle: relayHandle,
        intent: {
          intentId: intentB,
          actor: agentB.actor,
          action: 'pose',
        },
      }, 30_000);
      await executeOk(request, runId, agentC.agentId, 'director-intent-c', {
        kind: 'director.intent',
        handle: relayHandle,
        intent: {
          intentId: intentC,
          actor: agentC.actor,
          action: 'shot',
        },
      }, 30_000);

      await Promise.all([
        waitForDirectorEvent(request, runId, {
          agentId: agentA.agentId,
          topic: 'rallar.browser.director.intent_received',
          contains: [intentB],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentA.agentId,
          topic: 'rallar.browser.director.intent_received',
          contains: [intentC],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentB.agentId,
          topic: 'rallar.browser.director.output_received',
          contains: [intentB],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentB.agentId,
          topic: 'rallar.browser.director.output_received',
          contains: [intentC],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentC.agentId,
          topic: 'rallar.browser.director.output_received',
          contains: [intentB],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentC.agentId,
          topic: 'rallar.browser.director.output_received',
          contains: [intentC],
        }),
      ]);

      await executeOk(request, runId, agentB.agentId, 'director-sync-b', {
        kind: 'director.sync.request',
        handle: relayHandle,
        payload: {
          reason: 'black-box-b',
        },
      });
      await executeOk(request, runId, agentC.agentId, 'director-sync-c', {
        kind: 'director.sync.request',
        handle: relayHandle,
        payload: {
          reason: 'black-box-c',
        },
      });
      await Promise.all([
        waitForDirectorEvent(request, runId, {
          agentId: agentB.agentId,
          topic: 'rallar.browser.director.snapshot_received',
          contains: [intentB, intentC],
        }),
        waitForDirectorEvent(request, runId, {
          agentId: agentC.agentId,
          topic: 'rallar.browser.director.snapshot_received',
          contains: [intentB, intentC],
        }),
      ]);

      await executeOk(request, runId, agentA.agentId, 'director-relay-stop-a', {
        kind: 'director.relay.stop',
        handle: relayHandle,
      });
      await agentA.page.waitForTimeout(1_900);

      const staleB = await executeOk(request, runId, agentB.agentId, 'director-status-b-stale', {
        kind: 'director.status',
        ...directorRoomFields(groupId),
        refresh: true,
      });
      const staleC = await executeOk(request, runId, agentC.agentId, 'director-status-c-stale', {
        kind: 'director.status',
        ...directorRoomFields(groupId),
        refresh: true,
      });
      expect(directorStatusValue(staleB)).toMatchObject({
        role: 'client',
        state: 'stale',
        isDirector: false,
      });
      expect(directorStatusValue(staleC)).toMatchObject({
        role: 'client',
        state: 'stale',
        isDirector: false,
      });
      expect(asRecord(directorStatusValue(staleB).appointment)).toMatchObject({
        sessionId: sessions.A,
        epoch,
      });
      expect(asRecord(directorStatusValue(staleC).appointment)).toMatchObject({
        sessionId: sessions.A,
        epoch,
      });

      await executeOk(request, runId, agentB.agentId, 'director-relay-stop-b', {
        kind: 'director.relay.stop',
        handle: relayHandle,
      });
      await executeOk(request, runId, agentC.agentId, 'director-relay-stop-c', {
        kind: 'director.relay.stop',
        handle: relayHandle,
      });

      const run = await fetchControlRun(request, runId) as {
        events?: readonly ControlEvent[];
      };
      const appointEvents = (run.events ?? []).filter((event) =>
        runtimeEventPayload(event).topic === 'rallar.browser.director.appointed'
      );
      expect(appointEvents.map(event => event.agentId)).toEqual([agentA.agentId]);

      const artifacts = await exportControlRunArtifacts(request, runId);
      expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.intent_received');
      expect(JSON.stringify(artifacts)).toContain('rallar.browser.director.snapshot_received');
    } finally {
      await closeAgents(agents);
    }
  });
});
