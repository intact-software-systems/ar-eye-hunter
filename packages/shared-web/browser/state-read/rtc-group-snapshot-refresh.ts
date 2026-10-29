import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';

export namespace RtcGroupSnapshotRefresh {
    export interface Input {
        /** Resolves after a validated scoped read and authority adoption; rejects on failure or stale session. */
        readonly refreshGroupSnapshot: (
            roomRef: GroupRef,
            minSnapshotVersion: number,
            signal: AbortSignal
        ) => Promise<void>;
    }
}

export class RtcGroupSnapshotRefresh {
    readonly #refreshes = new SingleFlight<string, boolean>();
    readonly #controller = new AbortController();
    readonly #input: RtcGroupSnapshotRefresh.Input;

    constructor(input: RtcGroupSnapshotRefresh.Input) {
        this.#input = input;
    }

    async afterInboundAdmission(
        message: ALMessage,
        acceptance: ALInboundMessageRuntime.Acceptance
    ): Promise<boolean> {
        if (
            this.#controller.signal.aborted || acceptance.kind !== 'not-admitted' ||
            !isNotYetInSyncReason(acceptance.reason)
        ) {
            return false;
        }
        const targets = message.targets;
        const roomRef = readALTargetGroupRef(message);
        if (roomRef === undefined || (targets?.mode !== 'multicast' && targets?.mode !== 'broadcast')) {
            return false;
        }
        const refreshed = await this.#refreshes.run(
            toScopedGroupKey(roomRef),
            () => this.refreshGroupSnapshot(roomRef, targets.minSnapshotVersion ?? 0)
        );
        return refreshed && !this.#controller.signal.aborted;
    }

    dispose(): void {
        this.#controller.abort();
        this.#refreshes.clear();
    }

    private async refreshGroupSnapshot(roomRef: GroupRef, minSnapshotVersion: number): Promise<boolean> {
        try {
            await this.#input.refreshGroupSnapshot(roomRef, minSnapshotVersion, this.#controller.signal);
            return !this.#controller.signal.aborted;
        }
        catch {
            return false;
        }
    }
}

/**
 * The acceptance carries the plan's drop reason, not its code. A room-authority denial writes the
 * code at the head of that reason and the denial that fired after it
 * (`rtc-room-snapshot-admission.ts`); a server-side denial writes the bare code.
 */
function isNotYetInSyncReason(reason: string): boolean {
    return reason === 'not-yet-in-sync' || reason.startsWith('not-yet-in-sync: ');
}
