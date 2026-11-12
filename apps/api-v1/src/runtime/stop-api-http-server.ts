import type { Timers } from '@shared/resilience/timers.ts';

/** The slice of `Bun.Server` the drain needs: `stop(true)` closes every active connection at once. */
export interface ApiHttpServerStop {
    stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface StopApiHttpServerInput {
    readonly graceMs: number;
    readonly timers: Timers;
    readonly closeWebSockets: () => void;
    readonly log: Pick<Console, 'warn'>;
}

export type ApiHttpServerStopOutcome = 'drained' | 'forced';

/**
 * A graceful `stop()` refuses new connections and lets in-flight requests finish, but an open WebSocket or a
 * request that never answers would hold it forever. WebSockets are closed first, and whatever is still open when
 * the grace runs out is closed by force.
 */
export async function stopApiHttpServer(
    server: ApiHttpServerStop,
    input: StopApiHttpServerInput
): Promise<ApiHttpServerStopOutcome> {
    const drained = server.stop().then((): ApiHttpServerStopOutcome => 'drained');
    input.closeWebSockets();
    let cancelGrace = (): void => undefined;
    const graceElapsed = new Promise<'grace-elapsed'>((resolve) => {
        cancelGrace = input.timers.schedule(() => resolve('grace-elapsed'), input.graceMs);
    });
    const first = await Promise.race([drained, graceElapsed]);
    cancelGrace();
    if (first !== 'grace-elapsed') {
        return first;
    }
    input.log.warn(`HTTP drain still open after ${input.graceMs} ms; closing the remaining connections.`);
    await server.stop(true);
    return 'forced';
}
