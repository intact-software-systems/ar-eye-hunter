import { NonRetryableException } from '../../queuebox/DequeueResourceEntryController.ts';
import type { ResourceInboxWorkPage } from '../../queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALPersistedInboundEffect } from './al-inbound-admission-store.ts';
import type { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { toALInboundWorkType } from './al-inbound-work-entry.ts';
import { readALInboundWorkSelection } from './read-al-inbound-work-selection.ts';

const SCAN_STATUSES = [EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED] as const;

export namespace ALInboundWorkHandler {
    export interface Dependencies
        extends
            Pick<
                ALInboundMessageRuntime.Resources,
                'admissionStore' | 'effectWorkerId' | 'clock' | 'queueEngine' | 'ownsQueueEngine'
            > {
        readonly delivery: ALInboundAdmittedDelivery;
    }

    export interface Selection {
        readonly entries: readonly ResourceEntry[];
        readonly rejectedReservations: readonly ResourceEntry[];
        readonly continueScan: boolean;
    }

    export interface Scan {
        readonly cursor: ResourceInboxWorkPage.Cursor | null;
        readonly statusIndex: number;
        readonly nextReadyAt: number | undefined;
    }
}

/** Holds one bounded observation page; QueueBox owns claims and the shared engine owns scheduling. */
export class ALInboundWorkHandler {
    private static readonly PAGE_SIZE = 16;
    private readonly dependencies: ALInboundWorkHandler.Dependencies;
    private scan: ALInboundWorkHandler.Scan = { cursor: null, statusIndex: 0, nextReadyAt: undefined };
    private selection: Promise<ALInboundWorkHandler.Selection> | undefined;
    private processing: Promise<void> | undefined;
    private bootstrapped = false;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALInboundWorkHandler.Dependencies) {
        this.dependencies = dependencies;
        dependencies.queueEngine.includeTask(dependencies.effectWorkerId, {
            name: dependencies.effectWorkerId,
            maxConcurrency: () => 1,
            isWork: () => this.hasReadyWork(),
            runnable: () => this.start(),
            ongoingTasks: []
        });
    }

    async startOnce(): Promise<void> {
        if (this.shutdown.signal.aborted || this.bootstrapped) {
            return;
        }
        await this.start();
        this.bootstrapped = true;
        if (!this.shutdown.signal.aborted && this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.start();
        }
    }

    hasActiveDrain(): boolean {
        return this.processing !== undefined;
    }

    dispose(): void {
        this.shutdown.abort();
        this.selection = undefined;
        this.dependencies.queueEngine.excludeTask(this.dependencies.effectWorkerId);
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    async committed(): Promise<void> {
        this.scan = { cursor: null, statusIndex: 0, nextReadyAt: undefined };
        this.dependencies.queueEngine.wake();
        if (this.processing === undefined) {
            await this.start();
        }
    }

    start(): Promise<void> {
        if (this.shutdown.signal.aborted) {
            return Promise.resolve();
        }
        if (this.processing !== undefined) {
            return this.processing;
        }
        this.processing = this.processPage().catch((error) => {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            console.error('Inbound QueueBox execution failed', error);
        }).finally(() => {
            this.processing = undefined;
        });
        return this.processing;
    }

    private async hasReadyWork(): Promise<boolean> {
        if (this.shutdown.signal.aborted || this.processing !== undefined) {
            return false;
        }
        const pending = this.selection ?? this.readSelection();
        this.selection = pending;
        try {
            const selection = await pending;
            if (this.selection !== pending || this.shutdown.signal.aborted || this.processing !== undefined) {
                return false;
            }
            if (
                selection.entries.length === 0 && selection.rejectedReservations.length === 0 && !selection.continueScan
            ) {
                this.selection = undefined;
                return false;
            }
            return true;
        }
        catch (error) {
            if (this.selection === pending) {
                this.selection = undefined;
            }
            throw error;
        }
    }

    private async readSelection(): Promise<ALInboundWorkHandler.Selection> {
        const { admissionStore, clock } = this.dependencies;
        const scan = this.scan;
        const page = await admissionStore.workQueue.readWorkPage({
            typeId: toALInboundWorkType(admissionStore.namespace),
            status: SCAN_STATUSES[scan.statusIndex],
            maxToRead: ALInboundWorkHandler.PAGE_SIZE,
            cursor: scan.cursor
        });
        const statusIndex = page.nextCursor === null ? (scan.statusIndex + 1) % SCAN_STATUSES.length : scan.statusIndex;
        const claimable = await readALInboundWorkSelection({
            entries: page.entries,
            namespace: admissionStore.namespace,
            nowMs: clock.nowMs()
        }, this.dependencies.delivery);
        const nextReadyAt = claimable.nextReadyAt === undefined
            ? scan.nextReadyAt
            : Math.min(scan.nextReadyAt ?? claimable.nextReadyAt, claimable.nextReadyAt);
        const continueScan = page.nextCursor !== null || statusIndex !== 0;
        if (this.scan === scan && !this.shutdown.signal.aborted) {
            this.scan = { cursor: page.nextCursor, statusIndex, nextReadyAt: continueScan ? nextReadyAt : undefined };
            if (!continueScan) {
                this.dependencies.queueEngine.wakeAt(this.dependencies.effectWorkerId, nextReadyAt);
            }
        }
        return { entries: claimable.entries, rejectedReservations: claimable.rejectedReservations, continueScan };
    }

    private async processPage(): Promise<void> {
        const pending = this.selection ?? this.readSelection();
        this.selection = undefined;
        const selection = await pending;
        if (this.shutdown.signal.aborted) {
            return;
        }
        for (const reservation of selection.rejectedReservations) {
            if (this.shutdown.signal.aborted) {
                return;
            }
            await this.dependencies.admissionStore.rejectEffect(reservation);
        }
        await this.dependencies.admissionStore.finalizeExhaustedEffects({
            maxCount: ALInboundWorkHandler.PAGE_SIZE,
            signal: this.shutdown.signal
        });
        if (this.shutdown.signal.aborted) {
            return;
        }
        const claimed = await this.dependencies.admissionStore.claimReadyEffects({
            maxCount: ALInboundWorkHandler.PAGE_SIZE,
            entries: selection.entries
        });
        for (const effect of claimed) {
            if (this.shutdown.signal.aborted) {
                return;
            }
            await this.deliverClaimed(effect);
        }
    }

    private async deliverClaimed(effect: ALPersistedInboundEffect): Promise<void> {
        let outcome: 'completed' | 'retry' | 'non-retryable';
        try {
            outcome = await this.dependencies.delivery.deliver(effect);
        }
        catch (error) {
            outcome = error instanceof ALAdmissionCorruptionError || error instanceof NonRetryableException
                ? 'non-retryable'
                : 'retry';
        }
        if (this.shutdown.signal.aborted) {
            return;
        }
        switch (outcome) {
            case 'completed':
                await this.dependencies.admissionStore.completeEffect(effect.entry);
                break;
            case 'non-retryable':
                await this.dependencies.admissionStore.rejectEffect(effect.entry);
                break;
            case 'retry':
                await this.retry(effect);
                break;
        }
    }

    private async retry(effect: ALPersistedInboundEffect): Promise<void> {
        const decision = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, effect.attempts, Math.random());
        await this.dependencies.admissionStore.rescheduleEffect({
            reservation: effect.entry,
            retryAtMs: this.dependencies.clock.nowMs() + (decision.delayMs ?? 0)
        });
    }
}
