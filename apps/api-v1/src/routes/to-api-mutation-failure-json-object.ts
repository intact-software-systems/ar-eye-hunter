import type {
  ApiMutationFailureJsonObject,
  ApiMutationFailureJsonValue,
} from '@shared/api/mutation/api-mutation-failure.ts';

const API_MUTATION_FAILURE_CYCLE_MARKER = '[Circular]';
const API_MUTATION_FAILURE_UNINSPECTABLE_MARKER = '[Uninspectable]';
const API_MUTATION_FAILURE_ACCESSOR_MARKER = '[Accessor]';

export function toApiMutationFailureJsonObject<Value>(
  value: Value | null | undefined,
): ApiMutationFailureJsonObject | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = toApiMutationFailureJsonValue(value, new Set<object>());
  return isApiMutationFailureJsonObject(normalized) ? normalized : null;
}

function toApiMutationFailureJsonValue<Value>(
  value: Value,
  ancestors: Set<object>,
): ApiMutationFailureJsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value === true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value) : String(value);
  }
  if (typeof value !== 'object') {
    return toRepresentableString(value);
  }
  if (ancestors.has(value)) {
    return API_MUTATION_FAILURE_CYCLE_MARKER;
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? toApiMutationFailureJsonArray(value, ancestors)
      : toApiMutationFailureJsonRecord(value, ancestors);
  } catch {
    return API_MUTATION_FAILURE_UNINSPECTABLE_MARKER;
  } finally {
    ancestors.delete(value);
  }
}

function toApiMutationFailureJsonArray<Value>(
  value: readonly Value[],
  ancestors: Set<object>,
): readonly ApiMutationFailureJsonValue[] {
  const normalized: ApiMutationFailureJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    normalized.push(
      descriptor && 'value' in descriptor
        ? toApiMutationFailureJsonValue(descriptor.value, ancestors)
        : descriptor
        ? API_MUTATION_FAILURE_ACCESSOR_MARKER
        : 'undefined',
    );
  }
  return normalized;
}

function toApiMutationFailureJsonRecord<Value extends object>(
  value: Value,
  ancestors: Set<object>,
): ApiMutationFailureJsonObject {
  const normalized: Record<string, ApiMutationFailureJsonValue> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    normalized[key] = descriptor && 'value' in descriptor
      ? toApiMutationFailureJsonValue(descriptor.value, ancestors)
      : API_MUTATION_FAILURE_ACCESSOR_MARKER;
  }
  return normalized;
}

function toRepresentableString<Value>(value: Value): string {
  try {
    return String(value);
  } catch {
    return API_MUTATION_FAILURE_UNINSPECTABLE_MARKER;
  }
}

function isApiMutationFailureJsonObject(
  value: ApiMutationFailureJsonValue,
): value is ApiMutationFailureJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
