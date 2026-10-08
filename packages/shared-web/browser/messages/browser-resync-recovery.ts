import type { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import type { RallarChannelRecovery } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { AL_INBOUND_MAX_ORDERING_TRACKS } from '@shared/alm/inbound/admission/al-inbound-ordering-track-cap.ts';
import type {
    ALInboundResyncCursor,
    ALInboundResyncRequired
} from '@shared/alm/inbound/al-inbound-resync-required.ts';
import type { ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { AL_VOLATILE_SESSION_MAX_AGE_MS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
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
 * Invokes a channel's recovery owner once per ordering track while the track goes on resynchronizing:
 * the runtime resets no track after a resynchronization, and the sender's new epoch is a new track. A
 * track is remembered for the session's age budget after its last resynchronization (D181), so one that
 * fell silent is forgotten and a later resynchronization of it invokes the owner again. It remembers at most as
 * many tracks as the receiver keeps ordering snapshots for, the first remembered leaving first (D191). A message
 * whose route declared no owner is dropped as before, and nothing is stated for it.
 */
export class BrowserResyncRecovery {
    private readonly input: BrowserResyncRecovery.Input;
    private readonly invokedTrackKeys = new LatestRepository<string, true>({
        ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS,
        maxEntries: AL_INBOUND_MAX_ORDERING_TRACKS
    });

    constructor(input: BrowserResyncRecovery.Input) {
        this.input = input;
    }

    onResyncRequired(resync: ALInboundResyncRequired): void {
        const owner = this.input.owners.getOwner(resync.msg);
        if (owner === undefined) {
            return;
        }
        // A resynchronization's message is ordered, so its track is always named; the undefined branch is the type's.
        const trackKey = toALOrderingTrackKey(resync.msg);
        if (trackKey === undefined) {
            return;
        }
        const nowMs = this.input.nowMs();
        const invoked = this.invokedTrackKeys.readAt(trackKey, nowMs) !== undefined;
        this.invokedTrackKeys.acceptAt({ key: trackKey, value: true, nowEpochMs: nowMs });
        if (invoked) {
            return;
        }
        invokeRecoveryOwner(owner, resync.cursor);
        this.input.storage({ kind: 'recovery-owner-invoked', ...resync.cursor });
    }
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
