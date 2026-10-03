import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
import type { ALStorageEventSink, ALStorageHealthState, ALStorageRecoveryOutcome } from './al-storage-event.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

export namespace ALStorageHealth {
    export interface Input {
        readonly storeId: string;
        readonly storage: ALStorageEventSink;
    }
}

/**
 * One durable store's health. It starts `healthy` and states only a change of status: the first
 * failure, and the first recovery point after it. A recovery point is a committed send, an inbound
 * admission that wrote work, a flushed batch, or a completed checkpoint; a committed control or
 * receipt records none. Only a checkpoint store reads `delayed`.
 */
export class ALStorageHealth {
    private readonly state = new ObservableLatestValue<ALStorageHealthState>({
        equals: (left, right) => left.status === right.status
    });
    private readonly input: ALStorageHealth.Input;
    private lastRecoveryPointAtMs: number | undefined = undefined;

    constructor(input: ALStorageHealth.Input) {
        this.input = input;
        this.state.accept({
            status: 'healthy',
            lastFailure: undefined,
            lastRecoveryPointAtMs: undefined,
            oldestUnsavedAgeMs: undefined
        });
        this.state.onUpdatedDo(({ value }) => {
            if (value !== undefined) {
                input.storage({ kind: 'health', storeId: input.storeId, ...value });
            }
        });
    }

    recordFailure(failure: ALStorageUnavailable): void {
        this.state.accept({
            status: 'failing',
            lastFailure: failure,
            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
            oldestUnsavedAgeMs: undefined
        });
    }

    /** A checkpoint store's lag beyond its bound: the store fails until a checkpoint completes. */
    recordLagFailure(failure: ALStorageUnavailable, oldestUnsavedAgeMs: number): void {
        this.state.accept({
            status: 'failing',
            lastFailure: failure,
            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
            oldestUnsavedAgeMs
        });
    }

    /** Stated once, on leaving `healthy`; a failing store stays failing until its next recovery point. */
    recordDelayed(oldestUnsavedAgeMs: number, lastFailure: ALStorageUnavailable | undefined): void {
        const state = this.state.peek();
        if (state?.status !== 'healthy') {
            return;
        }
        this.state.accept({
            status: 'delayed',
            lastFailure: lastFailure ?? state.lastFailure,
            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
            oldestUnsavedAgeMs
        });
    }

    recordRecoveryPoint(atMs: number): void {
        this.lastRecoveryPointAtMs = atMs;
        const state = this.state.peek();
        if (state !== undefined && state.status !== 'healthy') {
            this.state.accept({
                status: 'healthy',
                lastFailure: state.lastFailure,
                lastRecoveryPointAtMs: atMs,
                oldestUnsavedAgeMs: undefined
            });
        }
    }

    /** A store two lanes share reports per lane, as `<store id>/<lane>`. */
    recordRecovery(outcome: ALStorageRecoveryOutcome, lane: string | undefined): void {
        const storeId = lane === undefined ? this.input.storeId : `${this.input.storeId}/${lane}`;
        this.input.storage({ kind: 'recovery', storeId, outcome });
    }
}
