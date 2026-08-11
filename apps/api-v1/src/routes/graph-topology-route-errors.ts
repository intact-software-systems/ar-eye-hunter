import { isGroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/services/AppInboxService.ts';

export class TopologyAppInboxFailureError extends Error {
  readonly status: number;

  readonly failure: AppInboxFailure;

  constructor(failure: AppInboxFailure) {
    super(failure.message);
    this.failure = failure;
    this.name = 'TopologyAppInboxFailureError';
    this.status = failure.status;
  }
}

export function toGraphTopologyErrorResponse(
  c: { json(value: unknown, status?: number): Response },
  error: unknown,
): Response {
  if (error instanceof TopologyAppInboxFailureError) {
    return c.json({
      error: error.failure.message,
      code: error.failure.code,
      message: error.failure.message,
      issues: error.failure.issues,
      denial: error.failure.denial,
      retry: error.failure.retry,
    }, error.failure.status);
  }
  if (isGroupPolicyDeniedError(error)) {
    return c.json(
      {
        error: error.message,
        code: error.denial.code,
        message: error.denial.message,
        issues: null,
        denial: error.denial,
        retry: null,
        details: error.denial.details,
      },
      error.status,
    );
  }
  if (isStatusError(error)) {
    return c.json(
      {
        error: error.message,
        code: error.code ?? 'topology-mutation-failed',
        message: error.message,
        issues: error.issues ?? null,
        denial: null,
        retry: null,
      },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('stale') || message.includes('conflict')
    ? 409
    : 400;
  return c.json({ error: message }, status);
}

function isStatusError(
  error: unknown,
): error is Error & { status: number; code?: string; issues?: unknown } {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number';
}
