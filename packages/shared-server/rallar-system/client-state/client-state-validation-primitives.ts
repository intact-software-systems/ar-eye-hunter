import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import { isClientJsonObject } from './client-state-semantic-equality.ts';

export class ClientMutationRejectedError extends Error {
  readonly code = 'client-mutation-rejected';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ClientMutationRejectedError';
  }
}

export function rejectClientMutation(message: string): never {
  throw new ClientMutationRejectedError(message);
}

export function requirePlainRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isClientJsonObject(value)) rejectClientMutation(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    rejectClientMutation(`${label} must be a plain object`);
  }
  return value;
}

export type ClientValidationRecord = ReturnType<typeof requirePlainRecord>;

interface RequireAllowedKeysInput {
  readonly value: ClientValidationRecord;
  readonly required: readonly string[];
  readonly allowed: readonly string[];
  readonly label: string;
}

export function requireExactKeys(
  value: ClientValidationRecord,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      rejectClientMutation(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) rejectClientMutation(`${label}.${key} is not allowed`);
  }
}

export function requireAllowedKeys({
  value,
  required,
  allowed,
  label,
}: RequireAllowedKeysInput): void {
  const expected = new Set(allowed);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      rejectClientMutation(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) rejectClientMutation(`${label}.${key} is not allowed`);
  }
}

export function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    rejectClientMutation(`${label} must be a non-empty string`);
  }
}

export function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') rejectClientMutation(`${label} must be a string`);
}

export function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') rejectClientMutation(`${label} must be a boolean`);
}

export function requireNullableString(value: unknown, label: string): void {
  if (value !== null) requireString(value, label);
}

export function requireNullableNonEmptyString(value: unknown, label: string): void {
  if (value !== null) requireNonEmptyString(value, label);
}

export function requireOptionalString(value: unknown, label: string): void {
  if (value !== undefined) requireString(value, label);
}

export function requireOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) requireNonEmptyString(value, label);
}

export function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    rejectClientMutation(`${label} must be a finite safe nonnegative integer`);
  }
}

export function requireNullableTimestamp(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) requireTimestamp(value, label);
}

export function requireOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) requireTimestamp(value, label);
}

export function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
  requireTimestamp(value, label);
  if ((value as number) < 1) rejectClientMutation(`${label} must be at least 1`);
}

export function requireEnum(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    rejectClientMutation(`${label} has an invalid value`);
  }
}

export function requireNullableEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (value !== null) requireEnum(value, allowed, label);
}

export function requireOptionalEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (value !== undefined) requireEnum(value, allowed, label);
}

export function requireStringArray(
  value: unknown,
  label: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value)) rejectClientMutation(`${label} must be an array`);
  value.forEach((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
}

export function requireNullableStringArray(value: unknown, label: string): void {
  if (value !== null) requireStringArray(value, label);
}

export function requireJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      rejectClientMutation(`${label} contains a non-JSON number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireJsonValue(item, `${label}[${index}]`));
    return;
  }
  const record = requirePlainRecord(value, label);
  for (const [key, item] of Object.entries(record)) requireJsonValue(item, `${label}.${key}`);
}

export function requireJsonRecord(value: unknown, label: string): void {
  requirePlainRecord(value, label);
  requireJsonValue(value, label);
}

export function requireNullableJsonRecord(value: unknown, label: string): void {
  if (value !== null) requireJsonRecord(value, label);
}

export function requireSha256(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    rejectClientMutation(`${label} must be a canonical SHA-256 digest`);
  }
}

export function validateClientPrincipalRef(
  value: unknown,
  label: string,
  exact = true,
): ClientPrincipalRef {
  const ref = requirePlainRecord(value, label);
  if (exact) requireExactKeys(ref, ['applicationId', 'workspaceId', 'principalId'], label);
  requireNonEmptyString(ref.applicationId, `${label}.applicationId`);
  requireNonEmptyString(ref.workspaceId, `${label}.workspaceId`);
  requireNonEmptyString(ref.principalId, `${label}.principalId`);
  return {
    applicationId: ref.applicationId,
    workspaceId: ref.workspaceId,
    principalId: ref.principalId,
  };
}
