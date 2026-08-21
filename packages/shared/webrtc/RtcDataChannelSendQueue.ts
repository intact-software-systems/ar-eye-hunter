import type { RtcDataChannelOverflowMode } from './QRtcDataChannel.ts';

export type RtcDataChannelQueuedSend<TPayload> = {
    payload: TPayload;
    key?: string;
    maxAgeMs?: number;
    createdAtEpochMs: number;
};

export type RtcDataChannelSendQueuePolicy = Readonly<{
    overflow: RtcDataChannelOverflowMode;
    maxQueueItems: number;
}>;

export type RtcDataChannelSendQueueOfferResult = Readonly<{
    status: 'queued' | 'dropped' | 'replaced';
    reason: string;
    key?: string;
    droppedOldest: boolean;
}>;

export class RtcDataChannelSendQueue<TPayload> {
    private readonly items: RtcDataChannelQueuedSend<TPayload>[] = [];
    private readonly indexByKey = new Map<string, number>();

    get size(): number {
        return this.items.length;
    }

    clear(): void {
        this.items.length = 0;
        this.indexByKey.clear();
    }

    offer(
        queued: RtcDataChannelQueuedSend<TPayload>,
        policy: RtcDataChannelSendQueuePolicy
    ): RtcDataChannelSendQueueOfferResult {
        switch (policy.overflow) {
            case 'drop-new':
                return this.toOfferResult(
                    'dropped',
                    'Back pressure',
                    queued.key,
                    false
                );
            case 'replace-by-key':
                if (queued.key && this.replaceByKey(queued.key, queued)) {
                    return this.toOfferResult(
                        'replaced',
                        'Replaced queued payload',
                        queued.key,
                        false
                    );
                }

                return this.enqueue(queued, policy.maxQueueItems, 'Queued payload', false);
            case 'drop-old': {
                const droppedOldest = this.items.length >= policy.maxQueueItems;
                if (droppedOldest) {
                    this.dropOldest();
                }

                return this.enqueue(
                    queued,
                    policy.maxQueueItems,
                    'Queued payload after dropping oldest',
                    droppedOldest
                );
            }
            case 'queue':
                return this.enqueue(queued, policy.maxQueueItems, 'Queued payload', false);
        }
    }

    shift(): RtcDataChannelQueuedSend<TPayload> | undefined {
        const shifted = this.items.shift();
        if (shifted) {
            this.rebuildIndexByKey();
        }

        return shifted;
    }

    private enqueue(
        queued: RtcDataChannelQueuedSend<TPayload>,
        maxQueueItems: number,
        reason: string,
        droppedOldest: boolean
    ): RtcDataChannelSendQueueOfferResult {
        if (this.items.length >= maxQueueItems) {
            return this.toOfferResult(
                'dropped',
                'Queue full',
                queued.key,
                droppedOldest
            );
        }

        this.items.push(queued);
        this.indexQueuedSend(queued, this.items.length - 1);
        return this.toOfferResult('queued', reason, queued.key, droppedOldest);
    }

    private replaceByKey(
        key: string,
        queued: RtcDataChannelQueuedSend<TPayload>
    ): boolean {
        const index = this.findIndexByKey(key);
        if (index === undefined) {
            return false;
        }

        this.replaceAt(index, queued);
        return true;
    }

    private findIndexByKey(key: string): number | undefined {
        const index = this.indexByKey.get(key);
        if (index === undefined) {
            return undefined;
        }

        if (this.items[index]?.key === key) {
            return index;
        }

        this.rebuildIndexByKey();
        return this.indexByKey.get(key);
    }

    private replaceAt(
        index: number,
        queued: RtcDataChannelQueuedSend<TPayload>
    ): void {
        const previous = this.items[index];
        this.items[index] = queued;

        if (previous?.key !== queued.key) {
            this.rebuildIndexByKey();
            return;
        }

        if (queued.key) {
            this.indexByKey.set(queued.key, index);
        }
    }

    private dropOldest(): void {
        if (this.items.length === 0) {
            return;
        }

        this.items.splice(0, 1);
        this.rebuildIndexByKey();
    }

    private indexQueuedSend(
        queued: RtcDataChannelQueuedSend<TPayload>,
        index: number
    ): void {
        if (!queued.key || this.indexByKey.has(queued.key)) {
            return;
        }

        this.indexByKey.set(queued.key, index);
    }

    private rebuildIndexByKey(): void {
        this.indexByKey.clear();
        for (let index = 0; index < this.items.length; index++) {
            this.indexQueuedSend(this.items[index], index);
        }
    }

    private toOfferResult(
        status: RtcDataChannelSendQueueOfferResult['status'],
        reason: string,
        key: string | undefined,
        droppedOldest: boolean
    ): RtcDataChannelSendQueueOfferResult {
        return {
            status,
            reason,
            key,
            droppedOldest
        };
    }
}
