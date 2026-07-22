import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
  AppInboxType,
  type AppInboxEnqueueInput,
} from './app-inbox-contracts.ts';

interface ValidAppInboxCommandIdentity {
  readonly valid: true;
  readonly identity: Readonly<{
    operation: AppInboxType;
    operationSource: 'command';
  }>;
  readonly command: AppInboxEnqueueInput<unknown>;
}

interface InvalidAppInboxCommandIdentity {
  readonly valid: false;
  readonly identity: Readonly<{
    operation: AppInboxUnavailableOperation;
    operationSource: 'corrupt' | 'unavailable';
  }>;
}

export type AppInboxCommandIdentityValidation =
  ValidAppInboxCommandIdentity | InvalidAppInboxCommandIdentity;

type AppInboxUnavailableOperation =
  | 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE'
  | 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE'
  | 'APP_INBOX_OPERATION_UNAVAILABLE';

const APP_INBOX_CLIENT_TOPIC = 'app-inbox.client-state';
const APP_INBOX_GROUP_TOPIC = 'app-inbox.group-state';
const APP_INBOX_OPERATIONS = new Set<string>(Object.values(AppInboxType));
const APP_INBOX_OPERATION_SPECIFIC_TOPIC_BY_OPERATION: Readonly<
  Partial<Record<AppInboxType, string>>
> = {
  [AppInboxType.CLIENT_EXPIRED_SESSIONS]: AppInboxType.CLIENT_EXPIRED_SESSIONS,
};
const OPTIONAL_STRING_FIELDS = [
  'topicId',
  'resourceId',
  'contextId',
  'senderId',
] as const;

export class AppInboxCommandIdentityError extends Error {
  readonly code = 'app-inbox-malformed-command';
  readonly status = 400;

  constructor(readonly operationSource: 'corrupt' | 'unavailable') {
    super(
      operationSource === 'corrupt'
        ? 'App inbox command identity is corrupt'
        : 'App inbox command identity is unavailable',
    );
    this.name = 'AppInboxCommandIdentityError';
  }
}

export function validateAppInboxCommandIdentity(
  entry: ResourceEntry,
): AppInboxCommandIdentityValidation {
  let outer: unknown;
  try {
    outer = JSON.parse(entry.resource) as unknown;
  } catch {
    return toInvalidIdentity(entry.key.topicId, 'corrupt');
  }
  if (
    !isRecord(outer) ||
    !isRecord(outer.payload) ||
    typeof outer.payload.typeId !== 'string' ||
    typeof outer.payload.resource !== 'string'
  ) {
    return toInvalidIdentity(entry.key.topicId, 'corrupt');
  }
  const dispatchedOperation = outer.payload.typeId;

  let command: unknown;
  try {
    command = JSON.parse(outer.payload.resource) as unknown;
  } catch {
    return toInvalidIdentity(entry.key.topicId, 'corrupt');
  }
  if (!isAppInboxEnqueueShape(command)) {
    return toInvalidIdentity(entry.key.topicId, 'corrupt');
  }
  if (
    !APP_INBOX_OPERATIONS.has(dispatchedOperation) ||
    !APP_INBOX_OPERATIONS.has(command.type)
  ) {
    return toInvalidIdentity(entry.key.topicId, 'unavailable');
  }
  if (
    dispatchedOperation !== command.type ||
    !isOperationForTopic(dispatchedOperation as AppInboxType, entry.key.topicId)
  ) {
    return toInvalidIdentity(entry.key.topicId, 'corrupt');
  }
  return {
    valid: true,
    identity: {
      operation: dispatchedOperation as AppInboxType,
      operationSource: 'command',
    },
    command: command as AppInboxEnqueueInput<unknown>,
  };
}

function toInvalidIdentity(
  topicId: string,
  operationSource: 'corrupt' | 'unavailable',
): InvalidAppInboxCommandIdentity {
  const operation =
    topicId === APP_INBOX_GROUP_TOPIC
      ? 'APP_INBOX_GROUP_OPERATION_UNAVAILABLE'
      : topicId === APP_INBOX_CLIENT_TOPIC
        ? 'APP_INBOX_CLIENT_OPERATION_UNAVAILABLE'
        : 'APP_INBOX_OPERATION_UNAVAILABLE';
  return {
    valid: false,
    identity: { operation, operationSource },
  };
}

function isOperationForTopic(
  operation: AppInboxType,
  topicId: string,
): boolean {
  if (APP_INBOX_OPERATION_SPECIFIC_TOPIC_BY_OPERATION[operation] === topicId) {
    return true;
  }
  return topicId === APP_INBOX_GROUP_TOPIC
    ? operation.startsWith('GROUP_')
    : topicId === APP_INBOX_CLIENT_TOPIC && operation.startsWith('CLIENT_');
}

function isAppInboxEnqueueShape(value: unknown): value is Record<
  string,
  unknown
> & {
  type: string;
  data: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    Object.prototype.hasOwnProperty.call(value, 'data') &&
    OPTIONAL_STRING_FIELDS.every(
      (field) => value[field] === undefined || typeof value[field] === 'string',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
