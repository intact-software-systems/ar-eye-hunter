import type { RtcDataChannelOverflowMode } from './qrtc-data-channel.ts';

export namespace RtcDataChannelSendQueue {
    export interface QueuedSend<TPayload> {
        readonly payload: TPayload;
        readonly key?: string;
        readonly maxAgeMs?: number;
        readonly createdAtEpochMs: number;
    }

    export interface Policy {
        readonly overflow: RtcDataChannelOverflowMode;
        readonly maxQueueItems: number;
    }

    export interface OfferResult {
        readonly status: 'queued' | 'dropped' | 'replaced';
        readonly reason: string;
        readonly key?: string;
        readonly droppedOldest: boolean;
    }
}

export class RtcDataChannelSendQueue<TPayload> {
    private readonly items: RtcDataChannelSendQueue.QueuedSend<TPayload>[] = [];
    private readonly indexByKey = new Map<string, number>();

    get size(): number {
        return this.items.length;
    }

    clear(): void {
        this.items.length = 0;
        this.indexByKey.clear();
    }

    offer(
        queued: RtcDataChannelSendQueue.QueuedSend<TPayload>,
        policy: RtcDataChannelSendQueue.Policy
    ): RtcDataChannelSendQueue.OfferResult {
        if (policy.overflow === 'drop-new') {
            return { status: 'dropped', reason: 'Back pressure', key: queued.key, droppedOldest: false };
        }
        if (policy.overflow === 'replace-by-key' && queued.key) {
            const index = this.indexByKey.get(queued.key);
            if (index !== undefined) {
                this.items[index] = queued;
                return { status: 'replaced', reason: 'Replaced queued payload', key: queued.key, droppedOldest: false };
            }
        }
        const droppedOldest = policy.overflow === 'drop-old' && this.items.length >= policy.maxQueueItems;
        if (droppedOldest) {
            this.shift();
        }
        return this.enqueue(queued, policy, droppedOldest);
    }

    shift(): RtcDataChannelSendQueue.QueuedSend<TPayload> | undefined {
        const shifted = this.items.shift();
        if (shifted) {
            this.rebuildIndexByKey();
        }
        return shifted;
    }

    private enqueue(
        queued: RtcDataChannelSendQueue.QueuedSend<TPayload>,
        policy: RtcDataChannelSendQueue.Policy,
        droppedOldest: boolean
    ): RtcDataChannelSendQueue.OfferResult {
        if (this.items.length >= policy.maxQueueItems) {
            return { status: 'dropped', reason: 'Queue full', key: queued.key, droppedOldest };
        }
        this.items.push(queued);
        this.indexQueuedSend(queued, this.items.length - 1);
        return {
            status: 'queued',
            reason: policy.overflow === 'drop-old' ? 'Queued payload after dropping oldest' : 'Queued payload',
            key: queued.key,
            droppedOldest
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
