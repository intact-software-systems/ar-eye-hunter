import type { OrchestratorResults } from '@shared/cache/CommandsOrchestrator.ts';

export function requireStateWorkflowResult<K, V>(
  results: OrchestratorResults<K, V>,
  key: K,
): NonNullable<V> {
  const value = results.get(key);
  if (value === undefined || value === null) {
    throw new Error(`Workflow step ${String(key)} did not produce a value.`);
  }

  return value as NonNullable<V>;
}

export function tolerateStateWorkflowNotFound<T>(error: unknown, value: T): T {
  if (isStateWorkflowNotFoundError(error)) {
    return value;
  }

  throw error;
}

export function isStateWorkflowNotFoundError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    Number.isFinite(error.status) &&
    error.status === 404
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes('404');
}

export function toStateWorkflowRequestId(operation: string, ...parts: readonly string[]): string {
  return [operation, ...parts, crypto.randomUUID()].join(':');
}
