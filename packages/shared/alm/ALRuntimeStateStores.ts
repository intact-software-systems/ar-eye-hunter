import type { ALReadyable } from '../al-contracts/al-runtime.ts';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import type { Key } from '../queuebox/ResourceEntry.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from './ALMessageExpiry.ts';
import type { ALRuntimeStoreRetentionConfig, NormalizedALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import { normalizeALRuntimeStoreRetention, resolveExpireAtTimestampWithFallback, } from './ALStoreRetention.ts';

export type ALBufferedOrderedMessageSnapshot = Readonly<{
    trackKey: string;
    seq: number;
    msg: ALMessage;
    plan: ALMessageHandlingPlan;
}>;

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
            snapshot,
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
        retention?: ALRuntimeStoreRetentionConfig,
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
                    this.retention.bufferedMessageTtlMs,
                ),
            },
        );
    }

    async removeBufferedMessage(trackKey: string, seq: number): Promise<void> {
        await this.bufferedMessageProvider.removeItem(
            toBufferedMessagePersistenceKey(trackKey, seq),
        );
    }
}

export type ALOutboundSentMessageSnapshot = Readonly<{
    msgId: string;
    msg: ALMessage;
    outboxKey?: Key;
    supersedenceKey?: string;
}>;

export type ALOutboundPendingAckSnapshot = Readonly<{
    msgId: string;
    expectedPeerIds: readonly string[];
    ackedPeerIds: readonly string[];
    timeoutMs: number;
    maxAttempts: number;
    attempts: number;
    deadlineAtMs: number;
}>;

export type ALOutboundRepairAttemptSnapshot = Readonly<{
    msgId: string;
    attempts: number;
}>;

export interface ALOutboundRuntimeStateStore extends ALReadyable {
    getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]>;

    setSentMessage(snapshot: ALOutboundSentMessageSnapshot): Promise<void>;

    removeSentMessage(msgId: string): Promise<void>;

    getAllPendingAcks(): Promise<readonly ALOutboundPendingAckSnapshot[]>;

    setPendingAck(snapshot: ALOutboundPendingAckSnapshot): Promise<void>;

    removePendingAck(msgId: string): Promise<void>;

    getAllRepairAttempts(): Promise<readonly ALOutboundRepairAttemptSnapshot[]>;

    setRepairAttempt(snapshot: ALOutboundRepairAttemptSnapshot): Promise<void>;

    removeRepairAttempt(msgId: string): Promise<void>;
}

export class InMemoryALOutboundRuntimeStateStore implements ALOutboundRuntimeStateStore {
    private readonly sentMessageByMsgId = new Map<string, ALOutboundSentMessageSnapshot>();
    private readonly pendingAckByMsgId = new Map<string, ALOutboundPendingAckSnapshot>();
    private readonly repairAttemptByMsgId = new Map<string, ALOutboundRepairAttemptSnapshot>();

    async ready(): Promise<void> {
    }

    async getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]> {
        return [...this.sentMessageByMsgId.values()];
    }

    async setSentMessage(snapshot: ALOutboundSentMessageSnapshot): Promise<void> {
        this.sentMessageByMsgId.set(snapshot.msgId, snapshot);
    }

    async removeSentMessage(msgId: string): Promise<void> {
        this.sentMessageByMsgId.delete(msgId);
    }

    async getAllPendingAcks(): Promise<readonly ALOutboundPendingAckSnapshot[]> {
        return [...this.pendingAckByMsgId.values()];
    }

    async setPendingAck(snapshot: ALOutboundPendingAckSnapshot): Promise<void> {
        this.pendingAckByMsgId.set(snapshot.msgId, snapshot);
    }

    async removePendingAck(msgId: string): Promise<void> {
        this.pendingAckByMsgId.delete(msgId);
    }

    async getAllRepairAttempts(): Promise<readonly ALOutboundRepairAttemptSnapshot[]> {
        return [...this.repairAttemptByMsgId.values()];
    }

    async setRepairAttempt(snapshot: ALOutboundRepairAttemptSnapshot): Promise<void> {
        this.repairAttemptByMsgId.set(snapshot.msgId, snapshot);
    }

    async removeRepairAttempt(msgId: string): Promise<void> {
        this.repairAttemptByMsgId.delete(msgId);
    }
}

export class PersistentALOutboundRuntimeStateStore implements ALOutboundRuntimeStateStore {
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    private readonly sentMessageProvider: PersistenceProvider<string, ALOutboundSentMessageSnapshot>;
    private readonly pendingAckProvider: PersistenceProvider<string, ALOutboundPendingAckSnapshot>;
    private readonly repairAttemptProvider: PersistenceProvider<string, ALOutboundRepairAttemptSnapshot>;

    constructor(
        sentMessageProvider: PersistenceProvider<string, ALOutboundSentMessageSnapshot>,
        pendingAckProvider: PersistenceProvider<string, ALOutboundPendingAckSnapshot>,
        repairAttemptProvider: PersistenceProvider<string, ALOutboundRepairAttemptSnapshot>,
        retention?: ALRuntimeStoreRetentionConfig,
    ) {
        this.sentMessageProvider = sentMessageProvider;
        this.pendingAckProvider = pendingAckProvider;
        this.repairAttemptProvider = repairAttemptProvider;
        this.retention = normalizeALRuntimeStoreRetention(retention);
    }

    async ready(): Promise<void> {
    }

    async getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]> {
        return await readAllValues(this.sentMessageProvider);
    }

    async setSentMessage(snapshot: ALOutboundSentMessageSnapshot): Promise<void> {
        await this.sentMessageProvider.setItem(
            snapshot.msgId,
            snapshot,
            {
                expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                    resolveExplicitOutboundMessageExpireAtMs(snapshot.msg),
                    this.retention.sentMessageTtlMs,
                ),
            },
        );
    }

    async removeSentMessage(msgId: string): Promise<void> {
        await this.sentMessageProvider.removeItem(msgId);
    }

    async getAllPendingAcks(): Promise<readonly ALOutboundPendingAckSnapshot[]> {
        return await readAllValues(this.pendingAckProvider);
    }

    async setPendingAck(snapshot: ALOutboundPendingAckSnapshot): Promise<void> {
        await this.pendingAckProvider.setItem(
            snapshot.msgId,
            snapshot,
            {
                expireAtTimestamp: toPendingAckExpireAtTimestamp(snapshot),
            },
        );
    }

    async removePendingAck(msgId: string): Promise<void> {
        await this.pendingAckProvider.removeItem(msgId);
    }

    async getAllRepairAttempts(): Promise<readonly ALOutboundRepairAttemptSnapshot[]> {
        return await readAllValues(this.repairAttemptProvider);
    }

    async setRepairAttempt(snapshot: ALOutboundRepairAttemptSnapshot): Promise<void> {
        await this.repairAttemptProvider.setItem(
            snapshot.msgId,
            snapshot,
            {
                expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                    undefined,
                    this.retention.repairAttemptTtlMs,
                ),
            },
        );
    }

    async removeRepairAttempt(msgId: string): Promise<void> {
        await this.repairAttemptProvider.removeItem(msgId);
    }
}

async function readAllValues<V>(
    provider: PersistenceProvider<string, V>,
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

function toPendingAckExpireAtTimestamp(snapshot: ALOutboundPendingAckSnapshot): number {
    const remainingTimeoutWindows = Math.max(1, snapshot.maxAttempts - snapshot.attempts + 1);
    return snapshot.deadlineAtMs + snapshot.timeoutMs * remainingTimeoutWindows;
}
