import {
  GROUP_POLICY_REASON_CODES,
  type GroupPolicyDenied,
} from '@shared/api/group-policy-types.ts';
import type { ApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';
import {
  GroupPolicyDeniedError,
  isGroupPolicyDeniedError,
} from '@shared-server/rallar-system/group-policy.ts';

import { isGroupAdmissionRateLimitedError } from '../services/group-admission-rate-limit.ts';
import {
  createApiMutationFailure,
  toApiMutationFailureJsonObject,
  toApiMutationFailureResponse,
  toApiMutationRateLimitResponse,
} from '../routes/api-mutation-route-failure.ts';

interface GroupAppInboxRouteFailure {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

const GROUP_POLICY_REASON_CODE_SET = new Set<string>(GROUP_POLICY_REASON_CODES);

export function toGroupAppInboxError(failure: string): Error {
  const denial = readAppInboxPolicyDenial(failure);
  if (denial) {
    return new GroupPolicyDeniedError(denial);
  }

  const routeFailure = readGroupAppInboxRouteFailure(failure);
  return routeFailure
    ? Object.assign(new Error(routeFailure.message), {
      code: routeFailure.code,
      status: routeFailure.status,
    })
    : new Error(failure);
}

export function toGroupStateErrorResponse(
  context: {
    json(
      value: unknown,
      status?: number,
      headers?: Record<string, string>,
    ): Response;
  },
  error: unknown,
): Response {
  if (isGroupAdmissionRateLimitedError(error)) {
    return context.json(
      { error: error.message, code: error.code },
      error.status,
      { 'Retry-After': String(error.retryAfterSeconds) },
    );
  }

  if (isGroupPolicyDeniedError(error)) {
    return context.json(
      {
        error: error.message,
        code: error.denial.code,
        message: error.denial.message,
        details: error.denial.details,
      },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = readErrorStatus(error) ?? toFallbackStatus(message);
  const code = readErrorCode(error);

  return context.json({
    error: message,
    ...(code ? { code } : {}),
  }, status);
}

interface GroupMutationFailureResponseWriter {
  json(value: ApiMutationFailure, status?: number): Response;
}

export function toGroupMutationErrorResponse<Failure>(
  context: GroupMutationFailureResponseWriter,
  error: Failure,
): Response {
  if (isGroupAdmissionRateLimitedError(error)) {
    return toApiMutationRateLimitResponse(
      context,
      error.message,
      error.retryAfterSeconds * 1_000,
    );
  }
  if (isGroupPolicyDeniedError(error)) {
    const failure = createApiMutationFailure({
      code: error.denial.code,
      status: error.status,
      message: error.denial.message,
      denial: {
        code: error.denial.code,
        message: error.denial.message,
        details: toApiMutationFailureJsonObject(error.denial.details),
      },
    });
    return context.json(failure, failure.status);
  }
  return toApiMutationFailureResponse(
    context,
    error instanceof Error ? error : new Error(String(error)),
  );
}

function readGroupAppInboxRouteFailure(value: string): GroupAppInboxRouteFailure | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const { code, message, status } = parsed;
    return typeof code === 'string' && code.length > 0 &&
        typeof message === 'string' && message.length > 0 &&
        Number.isSafeInteger(status) && Number(status) >= 400 && Number(status) <= 599
      ? { code, message, status: Number(status) }
      : undefined;
  } catch {
    return undefined;
  }
}

function readAppInboxPolicyDenial(value: string): GroupPolicyDenied | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const { code, message } = parsed;
    if (
      typeof code !== 'string' ||
      !GROUP_POLICY_REASON_CODE_SET.has(code) ||
      typeof message !== 'string'
    ) {
      return undefined;
    }

    return {
      allowed: false,
      code: code as GroupPolicyDenied['code'],
      message,
      details: isRecord(parsed.details) ? parsed.details : undefined,
    };
  } catch {
    return undefined;
  }
}

function readErrorStatus(error: unknown): number | undefined {
  if (
    !isRecord(error) || !Number.isSafeInteger(error.status) ||
    Number(error.status) < 400 || Number(error.status) > 599
  ) {
    return undefined;
  }
  return Number(error.status);
}

function readErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : undefined;
}

function toFallbackStatus(message: string): number {
  return message.includes('not found')
    ? 404
    : message.startsWith('Unauthorized:')
    ? 401
    : message.startsWith('Forbidden:')
    ? 403
    : message.includes('already exists')
    ? 409
    : 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
