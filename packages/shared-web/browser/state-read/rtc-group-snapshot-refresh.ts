import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toScopedGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export namespace RtcGroupSnapshotRefresh {
    export interface Input {
        readonly refreshGroupSnapshot: (
            roomRef: GroupRef,
            minSnapshotVersion: number,
            signal: AbortSignal
        ) => Promise<void>;
    }
}

interface ActiveGroupSnapshotRefresh {
    readonly controller: AbortController;
    readonly task: Promise<void>;
}

export class RtcGroupSnapshotRefresh {
    readonly #activeByGroup = new Map<string, ActiveGroupSnapshotRefresh>();
    readonly #input: RtcGroupSnapshotRefresh.Input;
    #disposed = false;

    constructor(input: RtcGroupSnapshotRefresh.Input) {
        this.#input = input;
    }

    async afterInboundAdmission(
        message: ALMessage,
        acceptance: ALInboundMessageRuntime.Acceptance
    ): Promise<void> {
        if (
            this.#disposed || acceptance.kind !== 'not-admitted' ||
            acceptance.reason !== 'not-yet-in-sync'
        ) {
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
            await active.task;
            return;
        }

        const controller = new AbortController();
        const task = this.#input.refreshGroupSnapshot(
            roomRef,
            targets.minSnapshotVersion ?? 0,
            controller.signal
        ).catch(() => {
            // The point-read diagnostic and retained QueueBox retry own recovery evidence.
        }).finally(() => {
            if (this.#activeByGroup.get(groupKey)?.task === task) {
                this.#activeByGroup.delete(groupKey);
            }
        });
        this.#activeByGroup.set(groupKey, { controller, task });
        await task;
    }

    dispose(): void {
        this.#disposed = true;
        for (const active of this.#activeByGroup.values()) {
            active.controller.abort();
        }
        this.#activeByGroup.clear();
    }
}
