export type ServerProcessSignal = 'SIGTERM' | 'SIGINT';

/** The slice of `process` a server's signal shutdown needs. */
export interface ServerProcessSignals {
    on(signal: ServerProcessSignal, listener: () => void): unknown;
    exit(code: number): void;
}

export interface ServerProcessShutdownInput {
    readonly process: ServerProcessSignals;
    readonly signals: readonly ServerProcessSignal[];
    /** The server's ordered graceful stop; it rejects when any step failed. */
    readonly stop: () => Promise<void>;
    readonly log: Pick<Console, 'error' | 'log'>;
}

/**
 * A signal listener replaces the runtime's default terminate action, so the listener owns the exit: the first
 * signal runs the graceful stop and exits 0 (1 when a step failed); a second signal exits 1 at once.
 */
export function initServerProcessShutdown(input: ServerProcessShutdownInput): void {
    let stopping = false;
    const stopOnSignal = (signal: ServerProcessSignal): void => {
        if (stopping) {
            input.log.error(`Received ${signal} while stopping; exiting without waiting for the stop.`);
            input.process.exit(1);
            return;
        }
        stopping = true;
        input.log.log(`Received ${signal}; stopping the server.`);
        input.stop().then(
            () => input.process.exit(0),
            (error: Error) => {
                input.log.error('Server stop failed:', error);
                input.process.exit(1);
            }
        );
    };
    for (const signal of input.signals) {
        input.process.on(signal, () => stopOnSignal(signal));
    }
}
