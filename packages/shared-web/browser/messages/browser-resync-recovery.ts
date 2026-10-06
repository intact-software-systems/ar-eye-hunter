import type { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import type { RallarChannelRecovery } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    ALInboundResyncCursor,
    ALInboundResyncRequired
} from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { toError } from '@shared/resilience/to-error.ts';

export namespace BrowserResyncRecovery {
    export interface Input {
        readonly owners: BrowserChannelRecoveryOwners;
        /** The browser's ALM diagnostics port, where every invocation is stated. */
        readonly storage: ALStorageEventSink;
        readonly nowMs: () => number;
    }
}

/**
 * Invokes a channel's recovery owner once per ordering track for the life of this runtime: the
 * runtime resets no track after a resynchronization, and the sender's new epoch is a new track. A
 * message whose route declared no owner is dropped as before, and nothing is stated for it.
 */
export class BrowserResyncRecovery {
    private readonly input: BrowserResyncRecovery.Input;
    private readonly invokedTracks = new LatestRepository<string, ALInboundResyncCursor>();

    constructor(input: BrowserResyncRecovery.Input) {
        this.input = input;
    }

    onResyncRequired(resync: ALInboundResyncRequired): void {
        const owner = this.input.owners.getOwner(resync.msg);
        if (owner === undefined) {
            return;
        }
        const trackKey = toResyncTrackKey(resync.cursor);
        const nowMs = this.input.nowMs();
        if (this.invokedTracks.readAt(trackKey, nowMs) !== undefined) {
            return;
        }
        this.invokedTracks.acceptAt({ key: trackKey, value: resync.cursor, nowEpochMs: nowMs });
        invokeRecoveryOwner(owner, resync.cursor);
        this.input.storage({ kind: 'recovery-owner-invoked', ...resync.cursor });
    }
}

/** The track the inbound runtime observed, as `toALOrderingTrackKey` names it from the message. */
function toResyncTrackKey(cursor: ALInboundResyncCursor): string {
    return `${cursor.orderingKey}:${cursor.senderId}:${cursor.epoch}`;
}

/** An owner's failure is the application's; the runtime that invoked it keeps its own work. */
function invokeRecoveryOwner(owner: RallarChannelRecovery, cursor: ALInboundResyncCursor): void {
    try {
        owner.onResyncRequired(cursor);
    }
    catch (error) {
        console.error('A channel recovery owner failed', toError(error));
    }
}
