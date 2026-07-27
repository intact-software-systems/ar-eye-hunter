import { describe, expect, it, vi } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  AppInboxService,
  SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  type AppInboxEnqueueInput,
  AppInboxType,
} from '@shared-server/rallar-system/services/app-inbox-contracts.ts';

interface DurableAppInbox {
  enqueue<V>(command: AppInboxEnqueueInput<V>): Promise<ResourceEntry>;
}

const COMMAND = {
  type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
  resourceId: 'durable-command-1',
  contextId: 'app:workspace:principal',
  senderId: 'principal',
  data: { requestId: 'durable-command-1', principalId: 'principal' },
} as const;

describe('AppInbox durable enqueue', () => {
  it('returns the exact persisted row without waiting for command completion', async () => {
    const queue = new InMemoryQueueBox(new Map());
    const service = createService(queue);

    const entry = await asDurable(service).enqueue(COMMAND);

    expect(entry).toBe(await queue.getItem(entry.key));
    expect(entry.key).toEqual({
      topicId: SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
      resourceId: COMMAND.resourceId,
      contextId: COMMAND.contextId,
    });
    expect(JSON.parse(entry.resource)).toMatchObject({
      payload: {
        typeId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
      },
    });
  });

  it('propagates durable storage failure to the transport owner', async () => {
    const failure = new Error('durable enqueue unavailable');
    const queue = new FailingQueueBox(failure);
    const service = createService(queue);

    await expect(asDurable(service).enqueue(COMMAND)).rejects.toBe(failure);
  });

  it('wakes the owning queue engine after durable enqueue, including idempotent reuse', async () => {
    const queue = new InMemoryQueueBox(new Map());
    const wakeQueue = vi.fn();
    const service = createService(queue, wakeQueue);

    const first = await asDurable(service).enqueue(COMMAND);
    const duplicate = await asDurable(service).enqueue(COMMAND);

    expect(duplicate).toBe(first);
    expect(wakeQueue).toHaveBeenCalledTimes(2);
  });
});

function createService(queue: InMemoryQueueBox, wakeQueue?: () => void): AppInboxService {
  return new AppInboxService(
    new InboxQueueReader(queue),
    queue as never,
    {} as never,
    {} as never,
    'server-12345678',
    SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
    undefined,
    undefined,
    wakeQueue,
  );
}

function asDurable(service: AppInboxService): DurableAppInbox {
  return service as unknown as DurableAppInbox;
}

class FailingQueueBox extends InMemoryQueueBox {
  constructor(private readonly failure: Error) {
    super(new Map());
  }

  override enqueueIfAbsent(): Promise<ResourceEntry> {
    return Promise.reject(this.failure);
  }
}
