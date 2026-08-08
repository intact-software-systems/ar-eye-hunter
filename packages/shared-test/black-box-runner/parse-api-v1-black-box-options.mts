import { readApiV1BlackBoxArgValues } from './read-api-v1-black-box-arg-values.mts';

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

export function parseApiV1BlackBoxArgs(args: readonly string[]): ApiV1BlackBoxOptions {
  const values = readApiV1BlackBoxArgValues(args);
  const backend = String(values.get('--backend') ?? 'postgres') as ApiV1BlackBoxBackend;
  if (backend !== 'postgres' && backend !== 'pglite-memory') {
    throw new Error('--backend must be postgres or pglite-memory.');
  }

  const port = toApiPort(values.get('--port') ?? '18080', '--port');
  const secondaryPort = toOptionalApiPort(values.get('--secondary-port'), '--secondary-port');
  const tertiaryPort = toOptionalApiPort(values.get('--tertiary-port'), '--tertiary-port');
  const hasIncompleteClusterPorts = (secondaryPort === undefined) !== (tertiaryPort === undefined);
  if (hasIncompleteClusterPorts) {
    throw new Error(
      '--secondary-port and --tertiary-port must be provided together for a managed cluster.',
    );
  }
  if (secondaryPort === port) {
    throw new Error('--secondary-port must differ from --port.');
  }
  if (
    tertiaryPort !== undefined &&
    (tertiaryPort === port || tertiaryPort === secondaryPort)
  ) {
    throw new Error('--tertiary-port must differ from --port and --secondary-port.');
  }

  const hasManagedClusterPorts = secondaryPort !== undefined && tertiaryPort !== undefined;
  if (hasManagedClusterPorts && backend !== 'postgres') {
    throw new Error('--secondary-port and --tertiary-port require --backend=postgres.');
  }

  const recipesOnly = values.get('--recipes-only') === true;
  if (recipesOnly && hasManagedClusterPorts) {
    throw new Error(
      '--secondary-port and --tertiary-port are not available with --recipes-only.',
    );
  }
  const clusterOnly = values.get('--cluster-only') === true;
  if ((clusterOnly || values.has('--cluster-profile')) && !hasManagedClusterPorts) {
    throw new Error(
      '--cluster-only and --cluster-profile require --secondary-port and --tertiary-port.',
    );
  }

  return {
    backend,
    port,
    ...(secondaryPort === undefined ? {} : { secondaryPort }),
    ...(tertiaryPort === undefined ? {} : { tertiaryPort }),
    profile: String(
      values.get('--profile') ?? (recipesOnly ? 'api-v1-black-box-recipes' : 'api-v1-black-box'),
    ),
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
