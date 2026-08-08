/// <reference lib="deno.ns" />
import { verifyApiV1FairnessProof } from './state-write-evidence/api-v1-fairness-proof.ts';
import {
  startManagedApiServer,
  stopManagedApiServer,
  type ManagedApiServer,
  type ManagedPGliteRunStorage,
  withManagedPGliteRunStorage,
} from './managed-api/api-v1-managed-process-lifecycle.mts';
import {
  managedApiDiagnosticSecrets,
  waitForManagedApiReady,
} from './managed-api/api-v1-managed-api-readiness.mts';
import {
  requiresManagedPostgresRunDatabase,
  withManagedPostgresRunDatabase,
} from './managed-api/api-v1-managed-postgres-run-database.mts';
import {
  type ApiV1BlackBoxOptions,
  parseApiV1BlackBoxArgs,
} from './parse-api-v1-black-box-options.mts';

export {
  managedApiDiagnosticSecrets,
  readBoundedLogTail,
  waitForManagedApiReady,
  type BoundedLogTailFile,
  type ReadBoundedLogTailOptions,
  type WaitForManagedApiReadyInput,
} from './managed-api/api-v1-managed-api-readiness.mts';
export {
  type ApiV1BlackBoxBackend,
  type ApiV1BlackBoxOptions,
  parseApiV1BlackBoxArgs,
} from './parse-api-v1-black-box-options.mts';

export type ManagedApiServerPlan = Readonly<{
  port: number;
  baseUrl: string;
  logPath: string;
  env: Record<string, string>;
}>;

const SCRIPT_DIR = new URL('.', import.meta.url);
const REPO_ROOT = new URL('../../../', SCRIPT_DIR);
const API_CONFIG_PATH = 'apps/api-v1/deno.json';
const API_ENTRYPOINT = 'apps/api-v1/src/main.ts';
export const API_V1_STATE_WRITE_EVIDENCE_OUTPUT = 'stateWriteEvidence';
const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';

export function toApiV1BlackBoxEnvironment(
  options: ApiV1BlackBoxOptions,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(baseEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  env.PORT = String(options.port);
  const defaultApiBaseUrl = `http://127.0.0.1:${options.port}`;
  const defaultWsBaseUrl = `ws://127.0.0.1:${options.port}`;
  env.RALLAR_API_BASE_URL = options.recipesOnly
    ? (env.RALLAR_API_BASE_URL ?? defaultApiBaseUrl)
    : defaultApiBaseUrl;
  env.RALLAR_WS_BASE_URL = options.recipesOnly
    ? (env.RALLAR_WS_BASE_URL ?? defaultWsBaseUrl)
    : defaultWsBaseUrl;
  if (options.secondaryPort !== undefined) {
    env.RALLAR_API_BASE_URL_SECONDARY = `http://127.0.0.1:${options.secondaryPort}`;
    env.RALLAR_WS_BASE_URL_SECONDARY = `ws://127.0.0.1:${options.secondaryPort}`;
  }
  if (options.tertiaryPort !== undefined) {
    env.RALLAR_API_BASE_URL_TERTIARY = `http://127.0.0.1:${options.tertiaryPort}`;
    env.RALLAR_WS_BASE_URL_TERTIARY = `ws://127.0.0.1:${options.tertiaryPort}`;
  }
  env.RALLAR_BB_RUN_ID = options.runId;
  env.RALLAR_STATE_WRITE_EVIDENCE_OUTPUT = API_V1_STATE_WRITE_EVIDENCE_OUTPUT;
  env.RALLAR_ICE_MODE = env.RALLAR_ICE_MODE ?? 'local';
  env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET =
    env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET ?? 'local-api-v1-black-box-operator-secret';
  env.RALLAR_AUTH_CREDENTIAL_SECRET =
    env.RALLAR_AUTH_CREDENTIAL_SECRET ?? 'local-api-v1-black-box-auth-credential-secret-v1';
  env.RALLAR_LOGIN_IP_RATE_LIMIT = env.RALLAR_LOGIN_IP_RATE_LIMIT ?? '100';
  env.RALLAR_LOGIN_USER_RATE_LIMIT = env.RALLAR_LOGIN_USER_RATE_LIMIT ?? '100';
  env.RALLAR_STATE_STRICT_READ_AUTH = env.RALLAR_STATE_STRICT_READ_AUTH ?? '1';
  env.AUTH_STATIC_CLIENTS_MODE = env.AUTH_STATIC_CLIENTS_MODE ?? 'demo';
  env.AUTH_REGISTRATION_MODE = env.AUTH_REGISTRATION_MODE ?? 'public';
  env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON =
    env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON ??
    '[{"documentType":"black-box-map","rollout":"production"}]';

  if (options.backend === 'postgres') {
    env.RALLAR_SQL_BACKEND = 'postgres';
    env.DATABASE_URL = env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  } else {
    env.RALLAR_SQL_BACKEND = 'pglite-memory';
    env.TZ = 'UTC';
    env.RALLAR_PGLITE_DATA_DIR = 'memory://';
    env.RALLAR_PGLITE_SCHEMA_INIT = 'auto';
    env.RALLAR_DB_PUBSUB = 'local';
    delete env.DATABASE_URL;
  }

  return env;
}

export function toManagedApiServerPlans(
  options: ApiV1BlackBoxOptions,
  env: Record<string, string>,
  artifactDir: string,
): readonly ManagedApiServerPlan[] {
  const root = artifactDir.replace(/\/+$/, '');
  return [
    {
      port: options.port,
      baseUrl: `http://127.0.0.1:${options.port}`,
      logPath: `${root}/api-v1-server.log`,
      env: toManagedApiServerEnvironment(env, options.port),
    },
    ...(options.secondaryPort === undefined
      ? []
      : [
          {
            port: options.secondaryPort,
            baseUrl: `http://127.0.0.1:${options.secondaryPort}`,
            logPath: `${root}/api-v1-server-secondary.log`,
            env: toManagedApiServerEnvironment(env, options.secondaryPort),
          },
        ]),
    ...(options.tertiaryPort === undefined
      ? []
      : [
          {
            port: options.tertiaryPort,
            baseUrl: `http://127.0.0.1:${options.tertiaryPort}`,
            logPath: `${root}/api-v1-server-tertiary.log`,
            env: toManagedApiServerEnvironment(env, options.tertiaryPort),
          },
        ]),
  ];
}

function toManagedApiServerEnvironment(
  env: Record<string, string>,
  port: number,
): Record<string, string> {
  return {
    ...env,
    PORT: String(port),
    RALLAR_API_BASE_URL: `http://127.0.0.1:${port}`,
    RALLAR_WS_BASE_URL: `ws://127.0.0.1:${port}`,
  };
}

export function toApiV1ServerCommand(options: ApiV1BlackBoxOptions): readonly string[] {
  return [
    'deno',
    'run',
    '--config',
    API_CONFIG_PATH,
    '--allow-net',
    '--allow-env',
    '--allow-read',
    ...(options.backend === 'pglite-memory' ? ['--allow-write'] : []),
    API_ENTRYPOINT,
  ];
}

function toRecipeMatrixCommand(
  options: ApiV1BlackBoxOptions,
  artifactDir: string,
): readonly string[] {
  return [
    'deno',
    'run',
    '-A',
    'packages/shared-test/black-box-runner/recipe-matrix.mts',
    `--profile=${options.profile}`,
    ...(options.requireGates ? ['--require-gates'] : []),
    `--artifact-dir=${artifactDir}`,
  ];
}

export function toClusterRecipeMatrixCommand(
  options: ApiV1BlackBoxOptions,
  artifactDir: string,
): readonly string[] {
  return [
    'deno',
    'run',
    '-A',
    'packages/shared-test/black-box-runner/recipe-matrix.mts',
    `--profile=${options.clusterProfile}`,
    ...(options.requireGates ? ['--require-gates'] : []),
    `--artifact-dir=${artifactDir.replace(/\/+$/, '')}/cluster`,
  ];
}

export function toRecipeMatrixCommands(
  options: ApiV1BlackBoxOptions,
  artifactDir: string,
): readonly (readonly string[])[] {
  return [
    ...(options.clusterOnly ? [] : [toRecipeMatrixCommand(options, artifactDir)]),
    ...(options.tertiaryPort === undefined
      ? []
      : [toClusterRecipeMatrixCommand(options, artifactDir)]),
  ];
}

function repoRootPath(): string {
  return decodeURIComponent(REPO_ROOT.pathname);
}

function resolveArtifactDir(path: string): string {
  if (path.startsWith('/')) {
    return path;
  }

  return new URL(path.replaceAll('\\', '/') + '/', `file://${Deno.cwd().replace(/\/$/, '')}/`)
    .pathname;
}

async function runCommand(command: readonly string[], env: Record<string, string>): Promise<void> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: repoRootPath(),
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).output();

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (stdout.trim()) {
    console.log(stdout);
  }
  if (stderr.trim()) {
    console.error(stderr);
  }

  if (!output.success) {
    throw new Error(`${command.join(' ')} failed with exit code ${output.code}`);
  }
}

async function runRecipeMatrix(
  options: ApiV1BlackBoxOptions,
  env: Record<string, string>,
  artifactDir: string,
): Promise<void> {
  for (const command of toRecipeMatrixCommands(options, artifactDir)) {
    await runCommand(command, env);
  }
}

async function main(): Promise<void> {
  const options = parseApiV1BlackBoxArgs(Deno.args);
  const env = toApiV1BlackBoxEnvironment(options, Deno.env.toObject());
  const artifactDir = resolveArtifactDir(options.artifactDir);
  const servers: Array<
    Readonly<{
      plan: ManagedApiServerPlan;
      server: ManagedApiServer;
    }>
  > = [];
  await Deno.mkdir(artifactDir, { recursive: true });
  const runWithStorage = async (
    pgliteStorage: ManagedPGliteRunStorage | undefined,
  ): Promise<void> => {
    if (pgliteStorage) {
      env.RALLAR_PGLITE_DATA_DIR = pgliteStorage.dataDir;
      env.RALLAR_BLACK_BOX_PGLITE_SNAPSHOT_DIR = pgliteStorage.snapshotDir;
    }
    const serverPlans = toManagedApiServerPlans(options, env, artifactDir);
    if (options.runMigrations) {
      await runCommand(['npm', 'run', 'db:migrate'], env);
    }
    try {
      if (!options.recipesOnly) {
        for (const plan of serverPlans) {
          await Deno.writeTextFile(plan.logPath, '');
          servers.push({
            plan,
            server: startManagedApiServer(toApiV1ServerCommand(options), plan, repoRootPath()),
          });
        }
        await Promise.all(
          servers.map(({ plan, server }) =>
            waitForManagedApiReady({
              baseUrl: plan.baseUrl,
              logPath: plan.logPath,
              childStatus: server.child.status,
              startup: server.startup,
              streamsDrained: server.streamsDrained,
              diagnosticSecrets: managedApiDiagnosticSecrets(plan.env),
            }),
          ),
        );
      }

      await runRecipeMatrix(options, env, artifactDir);
      await verifyApiV1FairnessProof(
        artifactDir,
        servers.map(({ plan }) => plan.logPath),
      );
    } finally {
      await Promise.allSettled(
        [...servers].reverse().map(({ server }) => stopManagedApiServer(server.child)),
      );
    }
  };
  await runManagedBlackBoxBackend(options, env, runWithStorage);
}

async function runManagedBlackBoxBackend(
  options: ApiV1BlackBoxOptions,
  env: Record<string, string>,
  runWithStorage: (storage: ManagedPGliteRunStorage | undefined) => Promise<void>,
): Promise<void> {
  if (options.backend === 'pglite-memory' && !options.recipesOnly) {
    await withManagedPGliteRunStorage(runWithStorage);
  } else if (requiresManagedPostgresRunDatabase(options)) {
    if (!env.DATABASE_URL) {
      throw new Error('Managed PostgreSQL isolation requires DATABASE_URL.');
    }
    await withManagedPostgresRunDatabase(env.DATABASE_URL, options.runId, async (databaseUrl) => {
      env.DATABASE_URL = databaseUrl;
      await runWithStorage(undefined);
    });
  } else {
    await runWithStorage(undefined);
  }
}

const importMeta = import.meta as ImportMeta & { main?: boolean };

if (importMeta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
