import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export namespace RtcGroupSnapshotRefresh {
    export interface Input {
        readonly refreshGroupSnapshot: (
            roomRef: GroupRef,
            minSnapshotVersion: number
        ) => Promise<void>;
    }
}

export class RtcGroupSnapshotRefresh {
    readonly #activeByGroup = new Map<string, Promise<void>>();
    readonly #input: RtcGroupSnapshotRefresh.Input;

    constructor(input: RtcGroupSnapshotRefresh.Input) {
        this.#input = input;
    }

    async afterInboundAdmission(
        message: ALMessage,
        acceptance: ALInboundMessageRuntime.Acceptance
    ): Promise<void> {
        if (acceptance.kind !== 'not-admitted' || acceptance.reason !== 'not-yet-in-sync') {
            return;
        }
        const targets = message.targets;
        const roomRef = readALTargetGroupRef(message);
        if (roomRef === undefined || (targets?.mode !== 'multicast' && targets?.mode !== 'broadcast')) {
            return;
        }
        const groupKey = toScopedGroupKey(roomRef);
        const active = this.#activeByGroup.get(groupKey);
        if (active !== undefined) {
            await active;
            return;
        }

        const task = this.#input.refreshGroupSnapshot(
            roomRef,
            targets.minSnapshotVersion ?? 0
        ).catch(() => {
            // The point-read diagnostic and retained QueueBox retry own recovery evidence.
        }).finally(() => {
            if (this.#activeByGroup.get(groupKey) === task) {
                this.#activeByGroup.delete(groupKey);
            }
        });
        this.#activeByGroup.set(groupKey, task);
        await task;
    }
}
