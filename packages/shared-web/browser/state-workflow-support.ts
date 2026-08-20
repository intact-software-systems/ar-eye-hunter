import type { OrchestratorResults } from '@shared/cache/CommandsOrchestrator.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';

export function requireStateWorkflowResult<K, V>(
  results: OrchestratorResults<K, V>,
  key: K,
): NonNullable<V> {
  const value = results.get(key);
  if (value === undefined || value === null) {
    throw new Error(`Workflow step ${String(key)} did not produce a value.`);
  }

  return value;
}

export function tolerateStateWorkflowNotFound<T>(error: unknown, value: T): T {
  if (isStateWorkflowNotFoundError(error)) {
    return value;
  }

  throw error;
}

export function isStateWorkflowNotFoundError(error: unknown): boolean {
  return error instanceof ApiHttpError && error.status === 404;
}

export function toApiMutationWorkflowRequestId(): string {
  return crypto.randomUUID();
}
