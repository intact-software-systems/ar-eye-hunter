export type ApiV1BlackBoxBackend = 'postgres' | 'pglite-memory';

export interface ApiV1BlackBoxOptions {
  readonly backend: ApiV1BlackBoxBackend;
  readonly port: number;
  readonly secondaryPort?: number;
  readonly tertiaryPort?: number;
  readonly profile: string;
  readonly clusterProfile: string;
  readonly clusterOnly: boolean;
  readonly artifactDir: string;
  readonly runId: string;
  readonly requireGates: boolean;
  readonly runMigrations: boolean;
  readonly recipesOnly: boolean;
}

const API_V1_CLUSTER_MATRIX_PROFILE = 'api-v1-black-box-cluster';
const MANAGED_API_V1_CLUSTER_PROFILES = new Set([
  API_V1_CLUSTER_MATRIX_PROFILE,
  'api-v1-black-box-crdt',
  'api-v1-black-box-medium-scale',
]);

interface ApiV1ClusterOptionValues {
  readonly backend: ApiV1BlackBoxBackend;
  readonly port: number;
  readonly secondaryPort: number | undefined;
  readonly tertiaryPort: number | undefined;
  readonly profile: string;
  readonly recipesOnly: boolean;
  readonly clusterOnly: boolean;
  readonly hasClusterProfile: boolean;
}

export function parseApiV1BlackBoxArgs(args: readonly string[]): ApiV1BlackBoxOptions {
  const values = readApiV1BlackBoxArgValues(args);
  const backend = String(values.get('--backend') ?? 'postgres') as ApiV1BlackBoxBackend;
  if (backend !== 'postgres' && backend !== 'pglite-memory') {
    throw new Error('--backend must be postgres or pglite-memory.');
  }

  const port = toApiPort(values.get('--port') ?? '18080', '--port');
  const secondaryPort = toOptionalApiPort(values.get('--secondary-port'), '--secondary-port');
  const tertiaryPort = toOptionalApiPort(values.get('--tertiary-port'), '--tertiary-port');
  const recipesOnly = values.get('--recipes-only') === true;
  const profile = String(
    values.get('--profile') ?? (recipesOnly ? 'api-v1-black-box-recipes' : 'api-v1-black-box'),
  );
  const clusterOnly = values.get('--cluster-only') === true;
  const clusterOptionIssues = validateApiV1ClusterOptionValues({
    backend,
    port,
    secondaryPort,
    tertiaryPort,
    profile,
    recipesOnly,
    clusterOnly,
    hasClusterProfile: values.has('--cluster-profile'),
  });
  if (clusterOptionIssues.length > 0) {
    throw new Error(clusterOptionIssues[0]);
  }

  return {
    backend,
    port,
    ...(secondaryPort === undefined ? {} : { secondaryPort }),
    ...(tertiaryPort === undefined ? {} : { tertiaryPort }),
    profile,
    clusterProfile: String(
      values.get('--cluster-profile') ?? API_V1_CLUSTER_MATRIX_PROFILE,
    ),
    clusterOnly,
    artifactDir: String(
      values.get('--artifact-dir') ?? `.artifacts/api-v1-black-box/${backend}`,
    ),
    runId: String(values.get('--run-id') ?? `local-${Date.now()}`),
    requireGates: values.get('--no-require-gates') !== true,
    runMigrations: backend === 'postgres' && !recipesOnly && values.get('--no-migrate') !== true,
    recipesOnly,
  };
}

function validateApiV1ClusterOptionValues(
  values: ApiV1ClusterOptionValues,
): readonly string[] {
  const issues: string[] = [];
  const hasIncompletePorts =
    (values.secondaryPort === undefined) !== (values.tertiaryPort === undefined);
  const hasManagedPorts = values.secondaryPort !== undefined && values.tertiaryPort !== undefined;
  const usesManagedProfile = !values.recipesOnly &&
    MANAGED_API_V1_CLUSTER_PROFILES.has(values.profile);
  if (hasIncompletePorts) {
    issues.push(
      '--secondary-port and --tertiary-port must be provided together for a managed cluster.',
    );
  }
  if (values.secondaryPort === values.port) {
    issues.push('--secondary-port must differ from --port.');
  }
  if (
    values.tertiaryPort !== undefined &&
    (values.tertiaryPort === values.port || values.tertiaryPort === values.secondaryPort)
  ) {
    issues.push('--tertiary-port must differ from --port and --secondary-port.');
  }
  if (hasManagedPorts && values.backend !== 'postgres') {
    issues.push('--secondary-port and --tertiary-port require --backend=postgres.');
  }
  if (values.recipesOnly && hasManagedPorts) {
    issues.push('--secondary-port and --tertiary-port are not available with --recipes-only.');
  }
  if (usesManagedProfile && values.backend !== 'postgres') {
    issues.push(`--profile=${values.profile} requires --backend=postgres.`);
  }
  if (usesManagedProfile && !hasManagedPorts) {
    issues.push(`--profile=${values.profile} requires --secondary-port and --tertiary-port.`);
  }
  if ((values.clusterOnly || values.hasClusterProfile) && !hasManagedPorts) {
    issues.push(
      '--cluster-only and --cluster-profile require --secondary-port and --tertiary-port.',
    );
  }
  return issues;
}

function toOptionalApiPort(
  value: string | boolean | undefined,
  argumentName: string,
): number | undefined {
  return value === undefined ? undefined : toApiPort(value, argumentName);
}

function toApiPort(value: string | boolean, argumentName: string): number {
  if (typeof value !== 'string') {
    throw new Error(`${argumentName} must have an integer value from 1 to 65535.`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${argumentName} must be an integer from 1 to 65535.`);
  }
  return port;
}

function readApiV1BlackBoxArgValues(
  args: readonly string[],
): ReadonlyMap<string, string | boolean> {
  const values = new Map<string, string | boolean>();
  for (const arg of args) {
    const [name, value] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, true];
    values.set(name, value);
  }
  return values;
}
