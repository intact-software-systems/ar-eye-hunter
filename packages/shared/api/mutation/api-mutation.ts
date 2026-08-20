export type ApiMutationFailureJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ApiMutationFailureJsonValue[]
  | ApiMutationFailureJsonObject;

export interface ApiMutationFailureJsonObject {
  readonly [key: string]: ApiMutationFailureJsonValue;
}

export interface ApiMutationFailureIssue {
  readonly code: string;
  readonly path: readonly (string | number)[] | null;
  readonly message: string;
  readonly details: ApiMutationFailureJsonObject | null;
}

export interface ApiMutationFailureDenial {
  readonly code: string;
  readonly message: string;
  readonly details: ApiMutationFailureJsonObject | null;
}

export interface ApiMutationFailureRetry {
  readonly kind: 'rate-limited' | 'unavailable' | 'exhausted';
  readonly retryAfterMs: number | null;
  readonly attempts: number | null;
  readonly lane: string | null;
  readonly queueAgeMs: number | null;
  readonly dueAgeMs: number | null;
}

export interface ApiMutationFailure {
  readonly type: 'api-mutation-failure';
  readonly version: 'canonical.v1';
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly issues: readonly ApiMutationFailureIssue[] | null;
  readonly denial: ApiMutationFailureDenial | null;
  readonly retry: ApiMutationFailureRetry | null;
}

const API_MUTATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const API_MUTATION_FAILURE_KEYS = [
  'type',
  'version',
  'code',
  'status',
  'message',
  'issues',
  'denial',
  'retry',
] as const;

export function isApiMutationRequestId(
  value: ApiMutationFailureJsonValue | undefined,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 128 &&
    API_MUTATION_REQUEST_ID_PATTERN.test(value)
  );
}

export function assertApiMutationRequestId(requestId: string): string {
  if (!isApiMutationRequestId(requestId)) {
    throw new TypeError(
      'API mutation requestId must contain 20 to 128 letters, digits, underscores, or hyphens',
    );
  }
  return requestId;
}

export function toApiMutationRequestPath(mutationPath: string, requestId: string): string {
  if (!mutationPath.startsWith('/')) {
    throw new TypeError('API mutation path must start with a slash');
  }
  const mutationRequestId = assertApiMutationRequestId(requestId);
  const canonicalMutationPath = mutationPath.endsWith('/')
    ? mutationPath.slice(0, -1)
    : mutationPath;
  return `${canonicalMutationPath}/requests/${mutationRequestId}`;
}

export function decodeApiMutationFailure(
  value: ApiMutationFailureJsonValue,
): ApiMutationFailure | undefined {
  if (!hasExactKeys(value, API_MUTATION_FAILURE_KEYS)) {
    return undefined;
  }
  if (
    value.type !== 'api-mutation-failure' ||
    value.version !== 'canonical.v1' ||
    !isNonEmptyString(value.code) ||
    !isHttpFailureStatus(value.status) ||
    !isNonEmptyString(value.message)
  ) {
    return undefined;
  }

  const issues = decodeApiMutationFailureIssues(value.issues);
  const denial = decodeApiMutationFailureDenial(value.denial);
  const retry = decodeApiMutationFailureRetry(value.retry, value.status);
  if (issues === undefined || denial === undefined || retry === undefined) {
    return undefined;
  }
  return {
    type: value.type,
    version: value.version,
    code: value.code,
    status: value.status,
    message: value.message,
    issues,
    denial,
    retry,
  };
}

function decodeApiMutationFailureIssues(
  value: ApiMutationFailureJsonValue,
): readonly ApiMutationFailureIssue[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues: ApiMutationFailureIssue[] = [];
  for (const issue of value) {
    if (!hasExactKeys(issue, ['code', 'path', 'message', 'details'])) {
      return undefined;
    }
    if (
      !isNonEmptyString(issue.code) ||
      !isApiMutationFailurePath(issue.path) ||
      !isNonEmptyString(issue.message) ||
      !isNullableRecord(issue.details)
    ) {
      return undefined;
    }
    issues.push({
      code: issue.code,
      path: issue.path,
      message: issue.message,
      details: issue.details,
    });
  }
  return issues;
}

function decodeApiMutationFailureDenial(
  value: ApiMutationFailureJsonValue,
): ApiMutationFailureDenial | null | undefined {
  if (value === null) {
    return null;
  }
  if (!hasExactKeys(value, ['code', 'message', 'details'])) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.code) ||
    !isNonEmptyString(value.message) ||
    !isNullableRecord(value.details)
  ) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    details: value.details,
  };
}

function decodeApiMutationFailureRetry(
  value: ApiMutationFailureJsonValue,
  status: number,
): ApiMutationFailureRetry | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    !hasExactKeys(value, ['kind', 'retryAfterMs', 'attempts', 'lane', 'queueAgeMs', 'dueAgeMs'])
  ) {
    return undefined;
  }
  if (
    (value.kind !== 'rate-limited' && value.kind !== 'unavailable' && value.kind !== 'exhausted') ||
    !isNullableNonNegativeNumber(value.retryAfterMs) ||
    !isNullableNonNegativeInteger(value.attempts) ||
    !isNullableNonEmptyString(value.lane) ||
    !isNullableNonNegativeNumber(value.queueAgeMs) ||
    !isNullableNonNegativeNumber(value.dueAgeMs)
  ) {
    return undefined;
  }
  if (
    (value.kind === 'rate-limited' && (status !== 429 || value.retryAfterMs === null)) ||
    ((value.kind === 'unavailable' || value.kind === 'exhausted') && status !== 503)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    retryAfterMs: value.retryAfterMs,
    attempts: value.attempts,
    lane: value.lane,
    queueAgeMs: value.queueAgeMs,
    dueAgeMs: value.dueAgeMs,
  };
}

function hasExactKeys(
  value: ApiMutationFailureJsonValue,
  expectedKeys: readonly string[],
): value is ApiMutationFailureJsonObject {
  if (!isRecord(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).toSorted();
  const sortedExpectedKeys = [...expectedKeys].toSorted();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isApiMutationFailurePath(
  value: ApiMutationFailureJsonValue,
): value is readonly (string | number)[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every(
        (part) => typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part)),
      ))
  );
}

function isHttpFailureStatus(value: ApiMutationFailureJsonValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 400 && value <= 599;
}

function isNonEmptyString(value: ApiMutationFailureJsonValue): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableNonEmptyString(value: ApiMutationFailureJsonValue): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNullableNonNegativeInteger(value: ApiMutationFailureJsonValue): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function isNullableNonNegativeNumber(value: ApiMutationFailureJsonValue): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isNullableRecord(
  value: ApiMutationFailureJsonValue,
): value is ApiMutationFailureJsonObject | null {
  return value === null || isRecord(value);
}

function isRecord(value: ApiMutationFailureJsonValue): value is ApiMutationFailureJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
