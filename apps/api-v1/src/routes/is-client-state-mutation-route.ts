const CLIENT_MUTATION_PREFIX = '^/api/state/apps/[^/]+/workspaces/[^/]+/clients/[^/]+';

const CLIENT_MUTATION_PATHS: Readonly<Record<'POST' | 'PUT', readonly RegExp[]>> = {
  PUT: [
    new RegExp(`${CLIENT_MUTATION_PREFIX}/principal/requests/[^/]+$`),
    new RegExp(`${CLIENT_MUTATION_PREFIX}/instances/[^/]+/requests/[^/]+$`),
    new RegExp(
      `${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+/requests/[^/]+$`,
    ),
  ],
  POST: [
    new RegExp(
      `${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+/heartbeat/requests/[^/]+$`,
    ),
    new RegExp(
      `${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+/disconnect/requests/[^/]+$`,
    ),
  ],
};

const REMOVED_CLIENT_MUTATION_PATHS: Readonly<Record<'POST' | 'PUT', readonly RegExp[]>> = {
  PUT: [
    new RegExp(`${CLIENT_MUTATION_PREFIX}/principal$`),
    new RegExp(`${CLIENT_MUTATION_PREFIX}/instances/[^/]+$`),
    new RegExp(`${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+$`),
  ],
  POST: [
    new RegExp(`${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+/heartbeat$`),
    new RegExp(`${CLIENT_MUTATION_PREFIX}/instances/[^/]+/sessions/[^/]+/disconnect$`),
  ],
};

export function isClientStateMutationRoute(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PUT') return false;
  return CLIENT_MUTATION_PATHS[method].some((pattern) => pattern.test(path));
}

export function isRemovedClientStateMutationRoute(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PUT') return false;
  return REMOVED_CLIENT_MUTATION_PATHS[method].some((pattern) => pattern.test(path));
}
