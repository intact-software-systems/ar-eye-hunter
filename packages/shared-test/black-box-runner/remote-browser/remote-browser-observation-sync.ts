// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';

import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import type { WaitObservationSource } from '../expectations/wait-observation-source.ts';
import { syncRallarRemoteBrowserEvents } from './rallar-remote-browser-control-client.ts';
import { recordRemoteRtcHealth } from './record-remote-rtc-health.ts';
import type { RallarRemoteBrowserConfig } from './resolve-rallar-remote-browser-config.ts';

export namespace RemoteBrowserObservationSync {
    export interface Connection {
        readonly remote: RallarRemoteBrowserConfig;
        readonly fetch: BlackBoxFetch;
        readonly context: any;
    }
    export interface Events extends Connection {
        readonly kind: 'events';
    }
    export interface Health extends Connection {
        readonly kind: 'health';
        readonly interaction: any;
        readonly commandIdPrefix: string;
        readonly command: RallarBlackBoxTestCommand;
    }
    export type Input = Events | Health;
}

/** Polls the control server on an interval until stopped; an events poll that fails ends polling and is kept. */
export class RemoteBrowserObservationSync implements WaitObservationSource {
    private readonly input: RemoteBrowserObservationSync.Input;
    private interval: ReturnType<typeof setInterval> | undefined;
    private pending: Promise<void> = Promise.resolve();
    private syncing = false;
    private sequence = 0;
    private failure: Error | undefined;

    constructor(input: RemoteBrowserObservationSync.Input) {
        this.input = input;
    }

    start(): void {
        if (this.interval === undefined) {
            this.interval = setInterval(() => this.startPoll(), this.input.remote.pollIntervalMs);
        }
    }

    /** Stops polling once the poll in flight has settled, so its observations are stored before a verdict. */
    async stop(): Promise<void> {
        clearInterval(this.interval);
        this.interval = undefined;
        await this.pending;
    }

    /** The failure that ended events polling, absent while every poll has succeeded. */
    getFailure(): Error | undefined {
        return this.failure;
    }

    private startPoll(): void {
        if (this.interval === undefined || this.syncing || this.failure !== undefined) {
            return;
        }
        this.syncing = true;
        this.pending = this.readObservation().finally(() => {
            this.syncing = false;
        });
    }

    private async readObservation(): Promise<void> {
        const input = this.input;
        if (input.kind === 'health') {
            this.sequence++;
            // A failed health probe may recover on the next tick; the health waiter owns the deadline.
            await recordRemoteRtcHealth({ ...input, commandId: `${input.commandIdPrefix}-health-${this.sequence}` });
            return;
        }
        const synced = await syncRallarRemoteBrowserEvents(input.remote, input.fetch, input.context);
        if (synced.left !== undefined) {
            this.failure = synced.left;
        }
    }
}

/** Runs the wait while events are polled; a polling failure replaces whatever verdict the wait reached. */
export async function runWithRemoteBrowserEventSync<Verdict>(
    connection: RemoteBrowserObservationSync.Connection,
    wait: (observations: WaitObservationSource) => Promise<Verdict>
): Promise<Either<Error, Verdict>> {
    const initial = await syncRallarRemoteBrowserEvents(connection.remote, connection.fetch, connection.context);
    if (initial.left !== undefined) {
        return Either.ofLeft(initial.left);
    }
    const synchronization = new RemoteBrowserObservationSync({ ...connection, kind: 'events' });
    synchronization.start();
    const verdict = await wait(synchronization).finally(() => synchronization.stop());
    const failure = synchronization.getFailure();
    return failure === undefined ? Either.ofRight(verdict) : Either.ofLeft(failure);
}
