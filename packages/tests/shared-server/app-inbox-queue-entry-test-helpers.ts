import { Temporal } from '@js-temporal/polyfill';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { createResilience, readEntries, type TestResourceInbox } from './auth/auth-app-inbox-test-runtime.ts';

const DELAYED_UNTIL_EPOCH_MS = 1_800_001_000_000;

export function groupPresenceFacts(
    facts: Readonly<{ input: Readonly<{ connectedAtEpochMs: number; }>; }>,
    generationId: string,
    connectedAtOffsetMs: number
): Readonly<{
    generationId: string;
    connectedAtEpochMs: number;
    expiresAtEpochMs: number;
}> {
    const connectedAtEpochMs = facts.input.connectedAtEpochMs + connectedAtOffsetMs;
    return {
        generationId,
        connectedAtEpochMs,
        expiresAtEpochMs: connectedAtEpochMs + 60_000
    };
}

export async function processNext(reader: InboxQueueReader): Promise<void> {
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
}

export async function delayEntry(
    queue: TestResourceInbox,
    entry: ResourceEntry
): Promise<void> {
    await queue.enqueue({
        ...entry,
        status: EntityStatus.RETRY,
        dequeueAudit: {
            ...entry.dequeueAudit,
            nextTs: Temporal.Instant.fromEpochMilliseconds(DELAYED_UNTIL_EPOCH_MS)
        }
    });
}

export async function releaseEntry(
    queue: TestResourceInbox,
    entry: ResourceEntry
): Promise<void> {
    await queue.enqueue({
        ...entry,
        status: EntityStatus.NEW,
        dequeueAudit: { ...entry.dequeueAudit, nextTs: undefined }
    });
}

export async function requireQueuedType(
    queue: TestResourceInbox,
    type: AppInboxType
): Promise<ResourceEntry> {
    const entry = (await readEntries(queue)).find((candidate) => readType(candidate) === type);
    if (!entry) {
        throw new Error(`Expected queued AppInbox type ${type}`);
    }
    return entry;
}

export async function waitForQueuedType(
    queue: TestResourceInbox,
    type: AppInboxType
): Promise<ResourceEntry> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const entry = (await readEntries(queue)).find((candidate) => readType(candidate) === type && candidate.status === EntityStatus.NEW);
        if (entry) {
            return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Expected queued AppInbox type ${type}`);
}

export async function queuedTypes(
    queue: TestResourceInbox
): Promise<readonly AppInboxType[]> {
    return (await readEntries(queue)).map(readType);
}

function readType(entry: ResourceEntry): AppInboxType {
    const message = JSON.parse(entry.resource) as { payload: { resource: string; }; };
    return (JSON.parse(message.payload.resource) as { type: AppInboxType; }).type;
}
