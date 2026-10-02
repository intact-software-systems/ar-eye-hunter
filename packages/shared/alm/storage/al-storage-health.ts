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
 * failure, and the first recovery point after it. Every durable commit is a recovery point.
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
            lastRecoveryPointAtMs: undefined
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
            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs
        });
    }

    recordRecoveryPoint(atMs: number): void {
        this.lastRecoveryPointAtMs = atMs;
        const state = this.state.peek();
        if (state?.status === 'failing') {
            this.state.accept({
                status: 'healthy',
                lastFailure: state.lastFailure,
                lastRecoveryPointAtMs: atMs
            });
        }
    }

    /** A store two lanes share reports per lane, as `<store id>/<lane>`. */
    recordRecovery(outcome: ALStorageRecoveryOutcome, lane: string | undefined): void {
        const storeId = lane === undefined ? this.input.storeId : `${this.input.storeId}/${lane}`;
        this.input.storage({ kind: 'recovery', storeId, outcome });
    }
}
