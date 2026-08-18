import type { Key } from './ResourceEntry.ts';

const RESOURCE_INBOX_TOPIC_ID_MAX_LENGTH = 36;
const RESOURCE_INBOX_RESOURCE_ID_MAX_LENGTH = 36;
const RESOURCE_INBOX_CONTEXT_ID_MAX_LENGTH = 35;
const RESOURCE_INBOX_CREATED_BY_MAX_LENGTH = 16;

export function toAppQueueKey(key: Key): Key {
  return {
    topicId: toQueueKeyPart(key.topicId, RESOURCE_INBOX_TOPIC_ID_MAX_LENGTH),
    resourceId: toQueueKeyPart(key.resourceId, RESOURCE_INBOX_RESOURCE_ID_MAX_LENGTH),
    contextId: toQueueKeyPart(key.contextId, RESOURCE_INBOX_CONTEXT_ID_MAX_LENGTH),
  };
}

export function toAppQueueCreatedBy(value: string): string {
  return toQueueKeyPart(value, RESOURCE_INBOX_CREATED_BY_MAX_LENGTH);
}

function toQueueKeyPart(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const hash = fnv1a64(value);
  const separator = '-';
  const prefixLength = Math.max(0, maxLength - hash.length - separator.length);
  const prefix = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, prefixLength);

  return `${prefix}${separator}${hash}`.slice(0, maxLength);
}

export function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return hash.toString(36);
}
