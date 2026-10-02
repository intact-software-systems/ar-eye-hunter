import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
import type { ALStorageEventSink, ALStorageHealthState } from './al-storage-event.ts';
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
    private lastRecoveryPointAtMs: number | undefined = undefined;

    constructor(input: ALStorageHealth.Input) {
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
}
