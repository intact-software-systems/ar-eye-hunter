export type ProofPrincipal = 'alice' | 'bob' | 'admin';

export type ProofSession = Readonly<{
  label: string;
  principal: ProofPrincipal;
  clientId: string;
  sessionId: string;
  accessToken: string;
  apiBaseUrl: string;
  wsBaseUrl: string;
}>;

export type ProofCausalRevision = Readonly<{
  groupRevision: number;
  presenceRevision: number;
}>;

export type ProofTopologyCheckpoint = Readonly<{
  causalRevision: ProofCausalRevision;
  version: number;
}>;

export type ProofJsonPrimitive = string | number | boolean | null;
export type ProofJsonValue = ProofJsonPrimitive | ProofJsonObject | readonly ProofJsonValue[];
export interface ProofJsonObject {
  readonly [key: string]: ProofJsonValue | undefined;
}

type LoginCredentials = Readonly<{
  username: string;
  password: string;
}>;

export class ApiV1RtcTopologyProofApi {
  readonly #credentials: Readonly<Record<ProofPrincipal, LoginCredentials>>;

  constructor(credentials: Readonly<Record<ProofPrincipal, LoginCredentials>>) {
    this.#credentials = credentials;
  }

  async login(
    input: Readonly<{
      label: string;
      principal: ProofPrincipal;
      apiBaseUrl: string;
      wsBaseUrl: string;
    }>,
  ): Promise<ProofSession> {
    const body = await requestJson(input.apiBaseUrl, '/api/auth/login', {
      method: 'POST',
      body: this.#credentials[input.principal],
    });
    return {
      ...input,
      clientId: requireString(body.clientId, 'login client ID'),
      sessionId: requireString(body.sessionId, 'login session ID'),
      accessToken: requireString(body.accessToken, 'login access token'),
    };
  }

  async createGroup(input: ProofGroupInput & Readonly<{ owner: ProofSession }>): Promise<void> {
    await requestJson(input.owner.apiBaseUrl, groupCollectionPath(input), {
      method: 'POST',
      session: input.owner,
      body: {
        requestId: `${input.proofId}-create-group`,
        groupId: input.groupId,
        displayName: 'RTC topology durable replay proof',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: input.owner.clientId,
      },
      expectedStatus: 201,
    });
  }

  async activateMember(
    input: ProofGroupInput & Readonly<{ actor: ProofSession; memberClientId: string }>,
  ): Promise<void> {
    await requestJson(
      input.actor.apiBaseUrl,
      `${groupPath(input)}/members/${encodeURIComponent(input.memberClientId)}`,
      {
        method: 'PUT',
        session: input.actor,
        body: {
          requestId: `${input.proofId}-activate-${input.memberClientId}`,
          status: 'active',
        },
      },
    );
  }

  async connectPresence(
    input: ProofGroupInput & Readonly<{ actor: ProofSession }>,
  ): Promise<ProofCausalRevision> {
    const body = await requestJson(
      input.actor.apiBaseUrl,
      `${groupPath(input)}/sessions/${encodeURIComponent(input.actor.sessionId)}`,
      {
        method: 'PUT',
        session: input.actor,
        body: {
          requestId: `${input.proofId}-presence-${input.actor.label}`,
          generationId: `${input.proofId}-generation-${input.actor.label}`,
          principalId: input.actor.clientId,
        },
      },
    );
    return readCausalRevision(body);
  }

  async establishBaseline(
    input: ProofGroupInput & Readonly<{ actor: ProofSession }>,
  ): Promise<void> {
    await requestJson(input.actor.apiBaseUrl, `${groupPath(input)}/topology/reconfigure`, {
      method: 'POST',
      session: input.actor,
      headers: { 'Idempotency-Key': `${input.proofId}-baseline` },
      body: {
        requestId: `${input.proofId}-baseline`,
        publish: false,
      },
    });
  }

  async readCurrentTopology(
    input: ProofGroupInput & Readonly<{ actor: ProofSession }>,
  ): Promise<ProofTopologyCheckpoint> {
    const body = await requestJson(input.actor.apiBaseUrl, `${groupPath(input)}/topology`, {
      method: 'GET',
      session: input.actor,
    });
    const snapshot = requireRecord(body.snapshot, 'current topology snapshot');
    const causal = requireRecord(
      snapshot.sourceGroupStateCausalRevision,
      'current topology causal revision',
    );
    return {
      causalRevision: {
        groupRevision: requireSafeInteger(causal.groupRevision, 'topology group revision'),
        presenceRevision: requireSafeInteger(causal.presenceRevision, 'topology presence revision'),
      },
      version: requireSafeInteger(snapshot.version, 'topology version'),
    };
  }

  async updateMemberRole(
    input: ProofGroupInput &
      Readonly<{
        actor: ProofSession;
        memberClientId: string;
        role: 'admin' | 'member';
        phase: string;
      }>,
  ): Promise<ProofCausalRevision> {
    const body = await requestJson(
      input.actor.apiBaseUrl,
      `${groupPath(input)}/members/${encodeURIComponent(input.memberClientId)}/role`,
      {
        method: 'PUT',
        session: input.actor,
        body: {
          requestId: `${input.proofId}-${input.phase}-role`,
          role: input.role,
        },
      },
    );
    return readCausalRevision(body);
  }

  async updateDescription(
    input: ProofGroupInput & Readonly<{ actor: ProofSession; phase: string }>,
  ): Promise<ProofCausalRevision> {
    const body = await requestJson(input.actor.apiBaseUrl, groupPath(input), {
      method: 'PUT',
      session: input.actor,
      body: {
        requestId: `${input.proofId}-${input.phase}-description`,
        description: `RTC topology replay ${input.phase}`,
      },
    });
    return readCausalRevision(body);
  }

  async issueWebSocketTicket(
    session: ProofSession,
    apiBaseUrl = session.apiBaseUrl,
  ): Promise<string> {
    const body = await requestJson(apiBaseUrl, '/api/auth/ws-ticket', {
      method: 'POST',
      session,
    });
    if (requireString(body.sessionId, 'ticket session ID') !== session.sessionId) {
      throw new Error(`WebSocket ticket changed session identity for ${session.label}.`);
    }
    return requireString(body.ticket, 'WebSocket ticket');
  }

  async readReplayMetrics(apiBaseUrl: string): Promise<ProofJsonObject> {
    const admin = await this.login({
      label: 'admin-C',
      principal: 'admin',
      apiBaseUrl,
      wsBaseUrl: apiBaseUrl.replace(/^http/, 'ws'),
    });
    const body = await requestJson(apiBaseUrl, '/api/admin/operations/realtime', {
      method: 'GET',
      session: admin,
    });
    return requireRecord(
      requireRecord(requireRecord(body.rtcTopology, 'RTC topology metrics').metrics, 'metrics')
        .replay,
      'RTC topology replay metrics',
    );
  }
}

export type ProofGroupInput = Readonly<{
  proofId: string;
  applicationId: string;
  workspaceId: string;
  groupId: string;
}>;

type RequestOptions = Readonly<{
  method: string;
  session?: ProofSession;
  body?: object;
  headers?: Readonly<Record<string, string>>;
  expectedStatus?: number;
}>;

async function requestJson(
  baseUrl: string,
  path: string,
  options: RequestOptions,
): Promise<ProofJsonObject> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.session
        ? {
            Authorization: `Bearer ${options.session.accessToken}`,
            'x-client-id': options.session.clientId,
          }
        : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const expectedStatus = options.expectedStatus ?? 200;
  if (response.status !== expectedStatus) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `${options.method} ${path} returned ${response.status}; expected ${expectedStatus}.`,
    );
  }
  return requireRecord(await response.json(), `${options.method} ${path} response`);
}

function groupCollectionPath(input: ProofGroupInput): string {
  return (
    `/api/state/apps/${encodeURIComponent(input.applicationId)}` +
    `/workspaces/${encodeURIComponent(input.workspaceId)}/groups`
  );
}

function groupPath(input: ProofGroupInput): string {
  return `${groupCollectionPath(input)}/${encodeURIComponent(input.groupId)}`;
}

function readCausalRevision(body: ProofJsonObject): ProofCausalRevision {
  const causal = requireRecord(body.causalRevision, 'causal revision');
  return {
    groupRevision: requireSafeInteger(causal.groupRevision, 'group revision'),
    presenceRevision: requireSafeInteger(causal.presenceRevision, 'presence revision'),
  };
}

export function requireRecord(value: ProofJsonValue | undefined, label: string): ProofJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as ProofJsonObject;
}

export function requireString(value: ProofJsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function requireSafeInteger(value: ProofJsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}
