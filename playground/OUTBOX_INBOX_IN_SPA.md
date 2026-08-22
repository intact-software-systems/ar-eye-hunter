# Outbox and inbox in SPA

Ensure all services are idempotent

- ALInboundMessageRuntime
- ALOutboundMessageRuntime

## Optimistic locking in RTC reception/sending

Introduce a storage table for peers with a version number. One row for each peer.

## Outbox API

```typescript
type Key = {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
};

enum EntityStatus {
    NEW,
    RETRY,
    RESERVED,
    COMPLETED,
    FAILED,
    ABORTED,
    NON_RETRYABLE,
    PARTITIONED,
    MERGED
}

type Audit = {
    readonly date: string;
    readonly createdBy: string;
    readonly createdTs: string;
    startTs: string;
    endTs: string;
    nextTs: string;
    attempts: bigint;
};

type ResourceEntry = {
    readonly key: Key;
    readonly resource: string;
    readonly typeId: string;
    status: EntityStatus;
    audit: Audit;
    db: Db;
};

interface OutboxQueue<K, V> {
    enqueue(key: K, value: V);
}

class OutboxQueueReader {
    public putIfAbsent(resourceEntry: ResourceEntry) {
    }

    private dequeue() {
        // dequeue from outbox queue
        //
    }
}
```
