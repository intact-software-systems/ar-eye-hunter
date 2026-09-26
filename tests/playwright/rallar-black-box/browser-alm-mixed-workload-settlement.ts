import { toError } from '../../../packages/shared/resilience/to-error.ts';

export interface MixedWorkloadSettlement<TDurable, TLive, TReconnect> {
    readonly durable: PromiseSettledResult<TDurable>;
    readonly live: PromiseSettledResult<TLive>;
    readonly reconnect: PromiseSettledResult<TReconnect>;
    readonly firstRejection: {
        readonly stage: 'send-durable-burst' | 'send-live-sequence' | 'reconnect-and-send';
        readonly reason: Error;
    } | null;
}

export async function settleMixedWorkload<TDurable, TLive, TReconnect>(
    durablePromise: Promise<TDurable>,
    livePromise: Promise<TLive>,
    reconnectPromise: Promise<TReconnect>
): Promise<MixedWorkloadSettlement<TDurable, TLive, TReconnect>> {
    let firstRejection: MixedWorkloadSettlement<TDurable, TLive, TReconnect>['firstRejection'] = null;
    const observedDurable = durablePromise.catch((reason: unknown) => {
        const error = toError(reason);
        firstRejection ??= { stage: 'send-durable-burst', reason: error };
        throw error;
    });
    const observedLive = livePromise.catch((reason: unknown) => {
        const error = toError(reason);
        firstRejection ??= { stage: 'send-live-sequence', reason: error };
        throw error;
    });
    const observedReconnect = reconnectPromise.catch((reason: unknown) => {
        const error = toError(reason);
        firstRejection ??= { stage: 'reconnect-and-send', reason: error };
        throw error;
    });
    const [durable, live, reconnect] = await Promise.allSettled(
        [
            observedDurable,
            observedLive,
            observedReconnect
        ] as const
    );
    return { durable, live, reconnect, firstRejection };
}
