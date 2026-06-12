export type HeadlessWorkerTransport = "realtime" | "messages.rtc";

export type HeadlessWorkerCredentials = Readonly<{
  username: string;
  password: string;
}>;

export type HeadlessWorkerAgentConfig = Readonly<{
  agentId: string;
  actor: string;
  sessionId: string;
  credentials: HeadlessWorkerCredentials;
  url: string;
}>;

export type HeadlessWorkerConfig = Readonly<{
  spaUrl: string;
  controlUrl: string;
  apiBaseUrl: string;
  runId: string;
  agentPrefix: string;
  agentCount: number;
  roomId: string;
  applicationId?: string;
  workspaceId?: string;
  transport: HeadlessWorkerTransport;
  statsIntervalMs?: number;
  heartbeatIntervalMs?: number;
  controlToken?: string;
  reportUploadUrl?: string;
  environment?: string;
  fleetRegion?: string;
  fleetProvider?: string;
  fleetDatacenter?: string;
  fleetHostId?: string;
  fleetAgentPoolId?: string;
  fleetDeploymentId?: string;
  fleetBrowserName?: string;
  fleetBrowserVersion?: string;
  fleetOs?: string;
  fleetTags?: readonly string[];
  register: boolean;
  restoreSession: boolean;
  logoutOnClose: boolean;
  leaveRoomOnClose: boolean;
  headless: boolean;
  launchTimeoutMs: number;
  readyTimeoutMs: number;
  agentCredentials: readonly HeadlessWorkerCredentials[];
  agents: readonly HeadlessWorkerAgentConfig[];
}>;

export type HeadlessWorkerConfigInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type HeadlessWorkerAgentUrlInput =
  & Omit<HeadlessWorkerConfig, "agents" | "agentCredentials">
  & Omit<HeadlessWorkerAgentConfig, "url">;

const DEFAULT_AGENT_COUNT = 1;
const DEFAULT_AGENT_PREFIX = "hetzner-agent";
const DEFAULT_TRANSPORT: HeadlessWorkerTransport = "realtime";
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 45_000;

const REQUIRED_ENV = [
  "RALLAR_BLACK_BOX_SPA_URL",
  "RALLAR_BLACK_BOX_CONTROL_URL",
  "RALLAR_API_BASE_URL",
  "RALLAR_BLACK_BOX_RUN_ID",
  "RALLAR_BLACK_BOX_ROOM_ID",
] as const;

export function readHeadlessWorkerConfig(
  input: HeadlessWorkerConfigInput = {},
): HeadlessWorkerConfig {
  const env = input.env ?? {};
  const missing = REQUIRED_ENV.filter((key) => !envValue(env, key));
  if (missing.length > 0) {
    throw new Error(
      `Missing required headless worker env: ${missing.join(", ")}`,
    );
  }

  const agentCount = positiveIntegerEnv(
    env,
    "RALLAR_BLACK_BOX_AGENT_COUNT",
    DEFAULT_AGENT_COUNT,
  );
  const agentCredentials = readAgentCredentials(env, agentCount);
  const baseConfig = {
    spaUrl: normalizeBaseUrl(requireEnv(env, "RALLAR_BLACK_BOX_SPA_URL")),
    controlUrl: requireEnv(env, "RALLAR_BLACK_BOX_CONTROL_URL"),
    apiBaseUrl: normalizeBaseUrl(requireEnv(env, "RALLAR_API_BASE_URL")),
    runId: requireEnv(env, "RALLAR_BLACK_BOX_RUN_ID"),
    agentPrefix: envValue(env, "RALLAR_BLACK_BOX_AGENT_PREFIX") ??
      DEFAULT_AGENT_PREFIX,
    agentCount,
    roomId: requireEnv(env, "RALLAR_BLACK_BOX_ROOM_ID"),
    applicationId: envValue(env, "RALLAR_APPLICATION_ID") ??
      envValue(env, "RALLAR_BLACK_BOX_APPLICATION_ID"),
    workspaceId: envValue(env, "RALLAR_WORKSPACE_ID") ??
      envValue(env, "RALLAR_BLACK_BOX_WORKSPACE_ID"),
    transport: transportEnv(
      env,
      "RALLAR_BLACK_BOX_TRANSPORT",
      DEFAULT_TRANSPORT,
    ),
    statsIntervalMs: optionalPositiveIntegerEnv(
      env,
      "RALLAR_BLACK_BOX_STATS_INTERVAL_MS",
    ),
    heartbeatIntervalMs: optionalPositiveIntegerEnv(
      env,
      "RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS",
    ),
    controlToken: envValue(env, "RALLAR_BLACK_BOX_CONTROL_TOKEN"),
    reportUploadUrl: envValue(env, "RALLAR_BLACK_BOX_REPORT_UPLOAD_URL"),
    environment: envValue(env, "RALLAR_BLACK_BOX_ENVIRONMENT"),
    fleetRegion: envValue(env, "RALLAR_AGENT_REGION") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_REGION"),
    fleetProvider: envValue(env, "RALLAR_AGENT_PROVIDER") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_PROVIDER"),
    fleetDatacenter: envValue(env, "RALLAR_AGENT_DATACENTER") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_DATACENTER"),
    fleetHostId: envValue(env, "RALLAR_AGENT_HOST_ID") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_HOST_ID"),
    fleetAgentPoolId: envValue(env, "RALLAR_AGENT_POOL_ID") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_POOL_ID"),
    fleetDeploymentId: envValue(env, "RALLAR_AGENT_DEPLOYMENT_ID") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_DEPLOYMENT_ID"),
    fleetBrowserName: envValue(env, "RALLAR_AGENT_BROWSER_NAME") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_BROWSER_NAME"),
    fleetBrowserVersion: envValue(env, "RALLAR_AGENT_BROWSER_VERSION") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_BROWSER_VERSION"),
    fleetOs: envValue(env, "RALLAR_AGENT_OS") ??
      envValue(env, "RALLAR_BLACK_BOX_AGENT_OS"),
    fleetTags: csvEnv(env, "RALLAR_AGENT_TAGS") ??
      csvEnv(env, "RALLAR_BLACK_BOX_AGENT_TAGS"),
    register: booleanEnv(env, "RALLAR_BLACK_BOX_REGISTER", false),
    restoreSession: booleanEnv(env, "RALLAR_BLACK_BOX_RESTORE_SESSION", false),
    logoutOnClose: booleanEnv(env, "RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE", false),
    leaveRoomOnClose: booleanEnv(
      env,
      "RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE",
      false,
    ),
    headless: booleanEnv(env, "RALLAR_BLACK_BOX_HEADLESS", true),
    launchTimeoutMs: positiveIntegerEnv(
      env,
      "RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS",
      DEFAULT_LAUNCH_TIMEOUT_MS,
    ),
    readyTimeoutMs: positiveIntegerEnv(
      env,
      "RALLAR_BLACK_BOX_READY_TIMEOUT_MS",
      DEFAULT_READY_TIMEOUT_MS,
    ),
    agentCredentials,
  };

  return {
    ...baseConfig,
    agents: createHeadlessWorkerAgents(baseConfig),
  };
}

export function createHeadlessWorkerAgents(
  config: Omit<HeadlessWorkerConfig, "agents">,
): readonly HeadlessWorkerAgentConfig[] {
  return Array.from({ length: config.agentCount }, (_, index) => {
    const ordinal = index + 1;
    const agentId = `${config.agentPrefix}-${String(ordinal).padStart(2, "0")}`;
    const actor = agentId;
    return {
      agentId,
      actor,
      sessionId: agentId,
      credentials: config.agentCredentials[index],
      url: createHeadlessWorkerAgentUrl({
        ...config,
        agentId,
        actor,
        sessionId: agentId,
        credentials: config.agentCredentials[index],
      }),
    };
  });
}

export function createHeadlessWorkerAgentUrl(
  input: HeadlessWorkerAgentUrlInput,
): string {
  const url = new URL(input.spaUrl);
  const params = url.searchParams;
  params.set("mode", "control");
  params.set("provider", "browser-rallar");
  params.set("autoConnect", "1");
  params.set("tab", "local-workbench");
  params.set("controlUrl", input.controlUrl);
  params.set("runId", input.runId);
  params.set("agentId", input.agentId);
  params.set("apiBaseUrl", input.apiBaseUrl);
  params.set("roomId", input.roomId);
  params.set("actor", input.actor);
  params.set("sessionId", input.sessionId);
  params.set("transport", input.transport);
  params.set("rallarUsername", input.credentials.username);
  params.set("rallarPassword", input.credentials.password);
  params.set("rallarLeaveRoomOnClose", input.leaveRoomOnClose ? "1" : "0");
  params.set("rallarLogoutOnClose", input.logoutOnClose ? "1" : "0");

  setOptionalParam(params, "applicationId", input.applicationId);
  setOptionalParam(params, "workspaceId", input.workspaceId);
  setOptionalParam(
    params,
    "statsIntervalMs",
    numberString(input.statsIntervalMs),
  );
  setOptionalParam(
    params,
    "heartbeatIntervalMs",
    numberString(input.heartbeatIntervalMs),
  );
  setOptionalParam(params, "controlToken", input.controlToken);
  setOptionalParam(params, "reportUploadUrl", input.reportUploadUrl);
  setOptionalParam(params, "environment", input.environment);
  setOptionalParam(params, "fleetRegion", input.fleetRegion);
  setOptionalParam(params, "fleetProvider", input.fleetProvider);
  setOptionalParam(params, "fleetDatacenter", input.fleetDatacenter);
  setOptionalParam(params, "fleetHostId", input.fleetHostId);
  setOptionalParam(params, "fleetAgentPoolId", input.fleetAgentPoolId);
  setOptionalParam(params, "fleetDeploymentId", input.fleetDeploymentId);
  setOptionalParam(params, "fleetBrowserName", input.fleetBrowserName);
  setOptionalParam(params, "fleetBrowserVersion", input.fleetBrowserVersion);
  setOptionalParam(params, "fleetOs", input.fleetOs);
  setOptionalParam(params, "fleetTags", input.fleetTags?.join(","));

  if (input.register) {
    params.set("rallarRegister", "1");
  }
  if (input.restoreSession) {
    params.set("rallarRestoreSession", "1");
  }

  return url.toString();
}

export function controlRunSnapshotUrlFromControlUrl(
  controlUrl: string,
  runId: string,
): string {
  const url = new URL(controlUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Control URL must use ws, wss, http, or https. Received: ${controlUrl}`,
    );
  }

  url.pathname = `/runs/${encodeURIComponent(runId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readAgentCredentials(
  env: Readonly<Record<string, string | undefined>>,
  agentCount: number,
): readonly HeadlessWorkerCredentials[] {
  const genericUsername = envValue(env, "RALLAR_BLACK_BOX_USERNAME");
  const genericPassword = envValue(env, "RALLAR_BLACK_BOX_PASSWORD");
  const credentials: HeadlessWorkerCredentials[] = [];
  for (let index = 0; index < agentCount; index += 1) {
    const ordinal = index + 1;
    const username =
      envValue(env, `RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME`) ??
        genericUsername;
    const password =
      envValue(env, `RALLAR_BLACK_BOX_AGENT_${ordinal}_PASSWORD`) ??
        genericPassword;
    if (!username || !password) {
      throw new Error(
        `Missing credentials for headless worker agent ${ordinal}. ` +
          `Set RALLAR_BLACK_BOX_USERNAME/PASSWORD or ` +
          `RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME/PASSWORD.`,
      );
    }
    credentials.push({ username, password });
  }
  return credentials;
}

function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
): void {
  if (value && value.length > 0) {
    params.set(key, value);
  }
}

function numberString(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = envValue(env, key);
  if (!value) {
    throw new Error(`Missing required headless worker env: ${key}`);
  }
  return value;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function csvEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): readonly string[] | undefined {
  const value = envValue(env, key);
  if (!value) {
    return undefined;
  }
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
): number {
  const value = optionalPositiveIntegerEnv(env, key);
  return value ?? fallback;
}

function optionalPositiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): number | undefined {
  const raw = envValue(env, key);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer. Received: ${raw}`);
  }
  return parsed;
}

function booleanEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = envValue(env, key);
  if (!raw) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on";
}

function transportEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: HeadlessWorkerTransport,
): HeadlessWorkerTransport {
  const raw = envValue(env, key);
  if (!raw) {
    return fallback;
  }
  if (raw === "realtime" || raw === "messages.rtc") {
    return raw;
  }
  throw new Error(`${key} must be realtime or messages.rtc. Received: ${raw}`);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
