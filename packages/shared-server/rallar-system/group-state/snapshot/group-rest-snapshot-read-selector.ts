import { compareGroupCausalRevision, readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type {
    GroupStateSnapshotReadOptions,
    StateSnapshotReadCleanupOutcome,
    StateSnapshotReadDiagnosticEvent,
    StateSnapshotReadDiagnosticsSink,
    StateSnapshotReadResult,
    StateSnapshotReadSource
} from '@shared/api/state-snapshot-read.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';

export interface GroupRestSnapshotReadRequest extends GroupStateSnapshotReadOptions {
    readonly strictMode?: boolean;
}

export interface GroupRestSnapshotReadSelector {
    read(
        ref: GroupRef,
        request?: GroupRestSnapshotReadRequest
    ): Promise<StateSnapshotReadResult<GroupSnapshot>>;
}

export type GroupRestSnapshotReadSelectorDependencies = Readonly<{
    durable: Readonly<{
        readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    }>;
    cache: Readonly<{
        peek(ref: GroupRef): GroupSnapshot | undefined;
        observe(snapshot: GroupSnapshot): StateSnapshotObservation;
        evictIfUnchanged(ref: GroupRef, expected: GroupSnapshot): boolean;
    }>;
    diagnostics?: StateSnapshotReadDiagnosticsSink;
    now?: () => number;
}>;

interface GroupRestSnapshotReadContext {
    readonly ref: GroupRef;
    readonly requestedFloor?: GroupStateCausalRevision;
    readonly strictMode: boolean;
    readonly startedAt: number;
    source: StateSnapshotReadSource;
}

class GroupRestSnapshotReadSelectorOwner implements GroupRestSnapshotReadSelector {
    private readonly dependencies: GroupRestSnapshotReadSelectorDependencies;

    public constructor(dependencies: GroupRestSnapshotReadSelectorDependencies) {
        this.dependencies = dependencies;
    }

    public async read(
        ref: GroupRef,
        request: GroupRestSnapshotReadRequest = {}
    ): Promise<StateSnapshotReadResult<GroupSnapshot>> {
        const context = this.toContext(ref, request);
        try {
            return await this.select(context);
        }
        catch (error) {
            this.emit(context, {
                source: context.source,
                result: 'error',
                floorOutcome: 'not-evaluated',
                cleanupOutcome: 'not-attempted',
                strictMode: context.strictMode
            });
            throw error;
        }
    }

    private toContext(
        ref: GroupRef,
        request: GroupRestSnapshotReadRequest
    ): GroupRestSnapshotReadContext {
        return {
            ref,
            requestedFloor: request.minCausalRevision,
            strictMode: request.strictMode ?? false,
            startedAt: this.dependencies.now?.() ?? Date.now(),
            source: 'cache'
        };
    }

    private async select(
        context: GroupRestSnapshotReadContext
    ): Promise<StateSnapshotReadResult<GroupSnapshot>> {
        const observed = this.dependencies.cache.peek(context.ref);
        const cached = this.selectCache(context, observed);
        if (cached) {
            return cached;
        }
        return await this.readDurable(context, observed);
    }

    private selectCache(
        context: GroupRestSnapshotReadContext,
        observed: GroupSnapshot | undefined
    ): StateSnapshotReadResult<GroupSnapshot> | undefined {
        if (
            context.requestedFloor === undefined ||
            context.strictMode ||
            observed === undefined ||
            !satisfiesGroupFloor(readGroupCausalRevision(observed), context.requestedFloor)
        ) {
            return undefined;
        }

        this.emitFound(context, 'cache', 'satisfied');
        return { status: 'found', source: 'cache', snapshot: observed };
    }

    private async readDurable(
        context: GroupRestSnapshotReadContext,
        observed: GroupSnapshot | undefined
    ): Promise<StateSnapshotReadResult<GroupSnapshot>> {
        context.source = 'durable';
        const snapshot = await this.dependencies.durable.readSnapshot(context.ref);
        if (!snapshot) {
            return this.toNotFound(context, observed);
        }

        this.dependencies.cache.observe(snapshot);
        if (
            context.requestedFloor !== undefined &&
            !satisfiesGroupFloor(readGroupCausalRevision(snapshot), context.requestedFloor)
        ) {
            this.emit(context, {
                source: 'durable',
                result: 'floor-not-satisfied',
                floorOutcome: 'not-satisfied',
                cleanupOutcome: 'not-attempted',
                strictMode: context.strictMode
            });
            return {
                status: 'floor-not-satisfied',
                source: 'durable',
                snapshot
            };
        }

        this.emitFound(
            context,
            'durable',
            context.requestedFloor === undefined ? 'not-requested' : 'satisfied'
        );
        return { status: 'found', source: 'durable', snapshot };
    }

    private toNotFound(
        context: GroupRestSnapshotReadContext,
        observed: GroupSnapshot | undefined
    ): StateSnapshotReadResult<GroupSnapshot> {
        const cleanupOutcome = this.cleanup(context.ref, observed);
        this.emit(context, {
            source: 'durable',
            result: 'not-found',
            floorOutcome: context.requestedFloor === undefined ? 'not-requested' : 'not-satisfied',
            cleanupOutcome,
            strictMode: context.strictMode
        });
        return { status: 'not-found', source: 'durable' };
    }

    private cleanup(
        ref: GroupRef,
        observed: GroupSnapshot | undefined
    ): StateSnapshotReadCleanupOutcome {
        if (!observed) {
            return 'not-attempted';
        }
        return this.dependencies.cache.evictIfUnchanged(ref, observed)
            ? 'evicted'
            : 'changed-or-absent';
    }

    private emitFound(
        context: GroupRestSnapshotReadContext,
        source: StateSnapshotReadSource,
        floorOutcome: 'not-requested' | 'satisfied'
    ): void {
        this.emit(context, {
            source,
            result: 'found',
            floorOutcome,
            cleanupOutcome: 'not-attempted',
            strictMode: context.strictMode
        });
    }

    private emit(
        context: GroupRestSnapshotReadContext,
        event: Omit<StateSnapshotReadDiagnosticEvent, 'name' | 'durationMs'>
    ): void {
        if (!this.dependencies.diagnostics) {
            return;
        }
        const finishedAt = this.dependencies.now?.() ?? Date.now();
        try {
            this.dependencies.diagnostics({
                name: 'rallar.rest.group-state-snapshot-read',
                ...event,
                durationMs: Math.max(0, finishedAt - context.startedAt)
            });
        }
        catch {
            // Diagnostics must not change read behavior.
        }
    }
}

export function createGroupRestSnapshotReadSelector(
    dependencies: GroupRestSnapshotReadSelectorDependencies
): GroupRestSnapshotReadSelector {
    return new GroupRestSnapshotReadSelectorOwner(dependencies);
}

function satisfiesGroupFloor(
    observed: GroupStateCausalRevision,
    requested: GroupStateCausalRevision
): boolean {
    const order = compareGroupCausalRevision(observed, requested);
    return order === 'equal' || order === 'dominates';
}
