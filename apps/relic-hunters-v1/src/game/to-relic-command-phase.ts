import type {
    RelicCommandOutcome,
    RelicHuntersRuntimePhase,
    RelicRuntimeDiagnostics
} from './relic-hunters-runtime.ts';

export interface RelicCommandPhase {
    readonly phase: RelicHuntersRuntimePhase;
    readonly patch: Partial<RelicRuntimeDiagnostics>;
    /** The text the hunter sees; undefined when the command landed. */
    readonly error: string | undefined;
}

/**
 * What the UI shows after a command: a WS receipt says the server admitted it, and the applied snapshot arrives on the
 * snapshot channel (D57 as applied); a REST reply carries its snapshot. A rule error the server met is not shown
 * after a WS command until a reply channel exists — the stated regression (D72).
 */
export function toRelicCommandPhase(
    outcome: RelicCommandOutcome,
    snapshotReady: boolean
): RelicCommandPhase {
    if (outcome.transport === 'rest') {
        return {
            phase: snapshotReady ? 'ready' : 'degraded',
            patch: {
                snapshotReady,
                commandTransport: 'rest',
                lastCommandDelivery: undefined,
                lastError: outcome.snapshot ? undefined : 'No relic snapshot returned for command.'
            },
            error: undefined
        };
    }
    const { state, reason } = outcome.delivery;
    const unconfirmed = `The server did not confirm the command (${state})`;
    const error = state === 'acknowledged'
        ? undefined
        : reason === undefined
        ? `${unconfirmed}.`
        : `${unconfirmed}: ${reason}`;
    return {
        phase: error === undefined && snapshotReady ? 'ready' : 'degraded',
        patch: {
            snapshotReady,
            commandTransport: 'ws',
            lastCommandDelivery: state,
            lastError: error
        },
        error
    };
}
