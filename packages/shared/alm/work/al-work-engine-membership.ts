import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import type { LoopsTaskDto } from '../../resilience/ComputeAsyncTask.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import type { ALDurableWorkLaneOwnership } from './al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from './al-work-readiness-memory.ts';

export namespace ALWorkEngineMembership {
    export interface Input {
        readonly queueEngine: InboxOutboxEngine;
        readonly workerId: string;
        readonly task: LoopsTaskDto;
        readonly onExternalWake: () => void;
        /** Absent on a lane no other runtime drains: the task joins the engine at construction. */
        readonly durableOwnership: ALDurableWorkLaneOwnership | undefined;
        /** Runs once, when ownership turns true after construction: the new owner's bootstrap. */
        readonly takeOver: () => void;
    }
}

/**
 * A work owner's task on the engine, which follows its session's ownership. An owner's task joins at
 * construction; a runtime that does not own the work keeps it out, announces each commit to the owner
 * instead, and joins when ownership turns true. A row the previous owner held under its lease is left
 * to the lease sweep of a later batch: a released ownership proves nothing about a batch still running.
 */
export class ALWorkEngineMembership {
    private readonly input: ALWorkEngineMembership.Input;
    private included = false;
    private disposed = false;
    private readonly ownershipListener: Unsubscribe | undefined;

    constructor(input: ALWorkEngineMembership.Input) {
        this.input = input;
        if (this.isOwned()) {
            this.include();
        }
        else {
            this.ownershipListener = input.durableOwnership?.ownership.owned.onChangeDo(() => this.takeOver());
        }
    }

    isOwned(): boolean {
        return this.input.durableOwnership?.ownership.isOwned() ?? true;
    }

    /** Whether the commit went to the owner; false when this runtime owns the work and runs it itself. */
    announceUnlessOwned(rows: ALWorkCommittedRows): boolean {
        const durable = this.input.durableOwnership;
        if (durable === undefined || durable.ownership.isOwned()) {
            return false;
        }
        durable.ownership.announceCommit({ workType: durable.workType, rows });
        return true;
    }

    dispose(): void {
        this.disposed = true;
        this.ownershipListener?.unsubscribe();
        this.input.queueEngine.excludeWakeListener(this.input.workerId);
        this.input.queueEngine.excludeTask(this.input.workerId);
    }

    private include(): void {
        const { queueEngine, workerId } = this.input;
        this.included = true;
        queueEngine.includeTask(workerId, this.input.task);
        queueEngine.includeWakeListener(workerId, this.input.onExternalWake);
    }

    private takeOver(): void {
        if (this.included || this.disposed || !this.isOwned()) {
            return;
        }
        this.include();
        this.input.takeOver();
    }
}
