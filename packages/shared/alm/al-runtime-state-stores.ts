import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { ALReadyable } from '../al-contracts/al-runtime.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import type { Key } from '../queuebox/ResourceEntry.ts';
import type { ALRuntimeStoreRetentionConfig, NormalizedALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import { normalizeALRuntimeStoreRetention, resolveExpireAtTimestampWithFallback } from './ALStoreRetention.ts';

export interface ALBufferedOrderedMessageSnapshot {
    readonly trackKey: string;
    readonly seq: number;
    readonly msg: ALMessage;
    readonly plan: ALMessageHandlingPlan;
}

export interface ALInboundRuntimeStateStore extends ALReadyable {
    getAllBufferedMessages(): Promise<readonly ALBufferedOrderedMessageSnapshot[]>;

    setBufferedMessage(snapshot: ALBufferedOrderedMessageSnapshot): Promise<void>;

    removeBufferedMessage(trackKey: string, seq: number): Promise<void>;
}

export class InMemoryALInboundRuntimeStateStore implements ALInboundRuntimeStateStore {
    private readonly bufferedMessagesByKey = new Map<string, ALBufferedOrderedMessageSnapshot>();

    async ready(): Promise<void> {
    }

    async getAllBufferedMessages(): Promise<readonly ALBufferedOrderedMessageSnapshot[]> {
        return [...this.bufferedMessagesByKey.values()];
    }

    async setBufferedMessage(snapshot: ALBufferedOrderedMessageSnapshot): Promise<void> {
        this.bufferedMessagesByKey.set(
            toBufferedMessagePersistenceKey(snapshot.trackKey, snapshot.seq),
            snapshot
        );
    }

    async removeBufferedMessage(trackKey: string, seq: number): Promise<void> {
        this.bufferedMessagesByKey.delete(toBufferedMessagePersistenceKey(trackKey, seq));
    }
}

export class PersistentALInboundRuntimeStateStore implements ALInboundRuntimeStateStore {
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    private readonly bufferedMessageProvider: PersistenceProvider<string, ALBufferedOrderedMessageSnapshot>;

    constructor(
        bufferedMessageProvider: PersistenceProvider<string, ALBufferedOrderedMessageSnapshot>,
        retention?: ALRuntimeStoreRetentionConfig
    ) {
        this.bufferedMessageProvider = bufferedMessageProvider;
        this.retention = normalizeALRuntimeStoreRetention(retention);
    }

    async ready(): Promise<void> {
    }

    async getAllBufferedMessages(): Promise<readonly ALBufferedOrderedMessageSnapshot[]> {
        return await readAllValues(this.bufferedMessageProvider);
    }

    async setBufferedMessage(snapshot: ALBufferedOrderedMessageSnapshot): Promise<void> {
        await this.bufferedMessageProvider.setItem(
            toBufferedMessagePersistenceKey(snapshot.trackKey, snapshot.seq),
            snapshot,
            {
                expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                    snapshot.msg.constraints?.expiresAtMs,
                    this.retention.bufferedMessageTtlMs
                )
            }
        );
    }

    async removeBufferedMessage(trackKey: string, seq: number): Promise<void> {
        await this.bufferedMessageProvider.removeItem(
            toBufferedMessagePersistenceKey(trackKey, seq)
        );
    }
}

export interface ALOutboundSentMessageSnapshot {
    readonly msgId: string;
    readonly msg: ALMessage;
    readonly outboxKey?: Key;
    readonly supersedenceKey?: string;
}

export interface ALOutboundPendingAckSnapshot {
    readonly msgId: string;
    readonly expectedPeerIds: readonly string[];
    readonly ackedPeerIds: readonly string[];
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly attempts: number;
    readonly deadlineAtMs: number;
}

export interface ALOutboundRepairAttemptSnapshot {
    readonly msgId: string;
    readonly attempts: number;
}

async function readAllValues<V>(
    provider: PersistenceProvider<string, V>
): Promise<V[]> {
    const values: V[] = [];

    for (const key of await provider.getAllKeys()) {
        const value = await provider.getItem(key);
        if (value !== undefined) {
            values.push(value);
        }
    }

    return values;
}

function toBufferedMessagePersistenceKey(trackKey: string, seq: number): string {
    return JSON.stringify([trackKey, seq]);
}
