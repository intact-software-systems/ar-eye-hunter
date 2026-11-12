import { toError } from '@shared/resilience/to-error.ts';

export type ServerProcessSignal = 'SIGTERM' | 'SIGINT';

/** Ctrl+C under npm or concurrently reaches the server twice within milliseconds: once from the tty, once forwarded. */
const REPEATED_SIGNAL_WINDOW_MS = 1_000;

/** The slice of `process` a server's signal shutdown needs. */
export interface ServerProcessSignals {
    on(signal: ServerProcessSignal, listener: () => void): void;
    exit(code: number): void;
}

export interface ServerProcessShutdownInput {
    readonly process: ServerProcessSignals;
    readonly signals: readonly ServerProcessSignal[];
    /** The server's ordered graceful stop; it rejects when any step failed. */
    readonly stop: () => Promise<void>;
    readonly log: Pick<Console, 'error' | 'log'>;
    readonly nowMs: () => number;
}

/**
 * A signal listener replaces the runtime's default terminate action, so the listener owns the exit: the first
 * signal runs the graceful stop and exits 0 (1 when a step failed). A signal repeated within a second is the same
 * request; a later one exits 1 at once.
 */
export function initServerProcessShutdown(input: ServerProcessShutdownInput): void {
    let stoppingSinceMs: number | undefined;
    const stopOnSignal = (signal: ServerProcessSignal): void => {
        if (stoppingSinceMs !== undefined) {
            if (input.nowMs() - stoppingSinceMs < REPEATED_SIGNAL_WINDOW_MS) {
                return;
            }
            input.log.error(`Received ${signal} while stopping; exiting without waiting for the stop.`);
            input.process.exit(1);
            return;
        }
        stoppingSinceMs = input.nowMs();
        input.log.log(`Received ${signal}; stopping the server.`);
        // Starting the stop inside a promise turns a step that throws before returning into a failed stop.
        Promise.resolve().then(input.stop).then(
            () => input.process.exit(0),
            (error) => {
                input.log.error('Server stop failed:', toError(error));
                input.process.exit(1);
            }
        );
    };
    for (const signal of input.signals) {
        input.process.on(signal, () => stopOnSignal(signal));
    }
}
