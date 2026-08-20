import type { ApiMutationFailureJsonValue } from './api-mutation-failure.ts';

const API_MUTATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
