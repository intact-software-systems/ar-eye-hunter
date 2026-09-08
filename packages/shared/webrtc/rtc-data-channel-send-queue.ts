import type { RtcDataChannelOverflowMode } from './qrtc-data-channel.ts';

export namespace RtcDataChannelSendQueue {
    export interface QueuedSend<TPayload> {
        readonly payload: TPayload;
        readonly key?: string;
        readonly maxAgeMs?: number;
        readonly expiresAtEpochMs?: number;
        readonly createdAtEpochMs: number;
    }

    export interface Policy {
        readonly overflow: RtcDataChannelOverflowMode;
        readonly maxQueueItems: number;
    }

    export interface OfferResult<TPayload> {
        readonly status: 'queued' | 'dropped' | 'replaced';
        readonly reason: string;
        readonly key?: string;
        readonly droppedOldest: boolean;
        readonly displaced: QueuedSend<TPayload> | undefined;
    }
}

export class RtcDataChannelSendQueue<TPayload> {
    private readonly items: RtcDataChannelSendQueue.QueuedSend<TPayload>[] = [];
    private readonly indexByKey = new Map<string, number>();

    get size(): number {
        return this.items.length;
    }

    clear(): readonly RtcDataChannelSendQueue.QueuedSend<TPayload>[] {
        const removed = this.items.splice(0);
        this.indexByKey.clear();
        return removed;
    }

    offer(
        queued: RtcDataChannelSendQueue.QueuedSend<TPayload>,
        policy: RtcDataChannelSendQueue.Policy
    ): RtcDataChannelSendQueue.OfferResult<TPayload> {
        if (policy.overflow === 'drop-new') {
            return {
                status: 'dropped',
                reason: 'Back pressure',
                key: queued.key,
                droppedOldest: false,
                displaced: undefined
            };
        }
        if (policy.overflow === 'replace-by-key' && queued.key) {
            const index = this.indexByKey.get(queued.key);
            if (index !== undefined) {
                const displaced = this.items[index];
                this.items[index] = queued;
                return {
                    status: 'replaced',
                    reason: 'Replaced queued payload',
                    key: queued.key,
                    droppedOldest: false,
                    displaced
                };
            }
        }
        const droppedOldest = policy.overflow === 'drop-old' && this.items.length >= policy.maxQueueItems;
        const displaced = droppedOldest ? this.shift() : undefined;
        return this.enqueue(queued, policy, displaced);
    }

    shift(): RtcDataChannelSendQueue.QueuedSend<TPayload> | undefined {
        const shifted = this.items.shift();
        if (shifted) {
            this.rebuildIndexByKey();
        }
        return shifted;
    }

    remove(queued: RtcDataChannelSendQueue.QueuedSend<TPayload>): boolean {
        const index = this.items.indexOf(queued);
        if (index < 0) {
            return false;
        }
        this.items.splice(index, 1);
        this.rebuildIndexByKey();
        return true;
    }

    removeExpired(nowMs: number): readonly RtcDataChannelSendQueue.QueuedSend<TPayload>[] {
        const removed: RtcDataChannelSendQueue.QueuedSend<TPayload>[] = [];
        const retained: RtcDataChannelSendQueue.QueuedSend<TPayload>[] = [];
        for (const item of this.items) {
            if (isRtcQueuedSendExpired(item, nowMs)) {
                removed.push(item);
            }
            else {
                retained.push(item);
            }
        }
        if (removed.length > 0) {
            this.items.splice(0, this.items.length, ...retained);
            this.rebuildIndexByKey();
        }
        return removed;
    }

    nextExpiryAtMs(): number | undefined {
        let earliest = Infinity;
        for (const item of this.items) {
            if (item.maxAgeMs !== undefined) {
                const dueAtMs = item.createdAtEpochMs + item.maxAgeMs + 1;
                if (Number.isFinite(dueAtMs)) {
                    earliest = Math.min(earliest, dueAtMs);
                }
            }
            if (item.expiresAtEpochMs !== undefined && Number.isFinite(item.expiresAtEpochMs)) {
                earliest = Math.min(earliest, item.expiresAtEpochMs);
            }
        }
        return Number.isFinite(earliest) ? earliest : undefined;
    }

    private enqueue(
        queued: RtcDataChannelSendQueue.QueuedSend<TPayload>,
        policy: RtcDataChannelSendQueue.Policy,
        displaced: RtcDataChannelSendQueue.QueuedSend<TPayload> | undefined
    ): RtcDataChannelSendQueue.OfferResult<TPayload> {
        const droppedOldest = displaced !== undefined;
        if (this.items.length >= policy.maxQueueItems) {
            return { status: 'dropped', reason: 'Queue full', key: queued.key, droppedOldest, displaced };
        }
        this.items.push(queued);
        this.indexQueuedSend(queued, this.items.length - 1);
        return {
            status: 'queued',
            reason: policy.overflow === 'drop-old' ? 'Queued payload after dropping oldest' : 'Queued payload',
            key: queued.key,
            droppedOldest,
            displaced
        };
    }

    private indexQueuedSend(queued: RtcDataChannelSendQueue.QueuedSend<TPayload>, index: number): void {
        if (queued.key && !this.indexByKey.has(queued.key)) {
            this.indexByKey.set(queued.key, index);
        }
    }

    private rebuildIndexByKey(): void {
        this.indexByKey.clear();
        for (let index = 0; index < this.items.length; index++) {
            this.indexQueuedSend(this.items[index], index);
        }
    }
}

export function isRtcQueuedSendExpired<TPayload>(
    queued: RtcDataChannelSendQueue.QueuedSend<TPayload>,
    nowMs: number
): boolean {
    return (queued.expiresAtEpochMs !== undefined && nowMs >= queued.expiresAtEpochMs) ||
        (queued.maxAgeMs !== undefined && nowMs - queued.createdAtEpochMs > queued.maxAgeMs);
}
