export namespace ExpectedConnectionHolds {
    export interface Dependencies {
        readonly isOpen: (id: string) => boolean;
        readonly nowEpochMs: () => number;
    }

    /** A generation admitted before its socket exists: sends addressed to its id wait until it opens or settles. */
    export interface Expected {
        readonly id: string;
        readonly generationId: string;
    }

    export interface Expectation extends Expected {
        /** A backstop for an upgrade whose socket neither opens nor closes. */
        readonly expiresAtEpochMs: number;
    }

    export interface HeldSend {
        readonly expiresAtEpochMs: number;
        readonly send: () => void;
    }

    export type HoldOutcome = 'held' | 'held-evicting-oldest' | 'not-awaiting';

    export interface AudienceSend {
        readonly expiresAtEpochMs: number;
        /** Sends to the one awaited id, once its socket opens or its upgrade settles. */
        readonly send: (id: string) => void;
    }

    export interface AudienceHold {
        readonly heldCount: number;
        readonly evictedCount: number;
    }
}

interface ConnectionHold {
    readonly generations: Map<string, number>;
    readonly sends: ExpectedConnectionHolds.HeldSend[];
}

/**
 * Sends held for connections a route has admitted but whose sockets are not open yet (D269). A full hold
 * evicts its oldest send, so the newest rows, the admitting connect's own among them, are the ones kept.
 */
export class ExpectedConnectionHolds {
    public static readonly MAX_HELD_SENDS_PER_CONNECTION = 64;

    readonly #dependencies: ExpectedConnectionHolds.Dependencies;
    readonly #holds = new Map<string, ConnectionHold>();

    constructor(dependencies: ExpectedConnectionHolds.Dependencies) {
        this.#dependencies = dependencies;
    }

    expect(expectation: ExpectedConnectionHolds.Expectation): void {
        const hold = this.#holds.get(expectation.id) ?? { generations: new Map(), sends: [] };
        hold.generations.set(expectation.generationId, expectation.expiresAtEpochMs);
        this.#holds.set(expectation.id, hold);
    }

    /** The last expected generation of an id to settle runs its held sends, which then find whatever is open. */
    release(expected: ExpectedConnectionHolds.Expected): void {
        const hold = this.#holds.get(expected.id);
        if (hold?.generations.delete(expected.generationId) && hold.generations.size === 0) {
            this.#holds.delete(expected.id);
            this.runSends(hold.sends);
        }
    }

    open(expected: ExpectedConnectionHolds.Expected): void {
        const hold = this.#holds.get(expected.id);
        if (!hold?.generations.delete(expected.generationId)) {
            return;
        }
        if (hold.generations.size === 0) {
            this.#holds.delete(expected.id);
        }
        this.runSends(hold.sends.splice(0));
    }

    hasExpectations(): boolean {
        return this.#holds.size > 0;
    }

    isAwaiting(id: string): boolean {
        this.releaseExpiredGenerations(id);
        return this.#holds.has(id) && !this.#dependencies.isOpen(id);
    }

    hold(id: string, held: ExpectedConnectionHolds.HeldSend): ExpectedConnectionHolds.HoldOutcome {
        const hold = this.#holds.get(id);
        if (hold === undefined || !this.isAwaiting(id)) {
            return 'not-awaiting';
        }
        const nowEpochMs = this.#dependencies.nowEpochMs();
        const live = hold.sends.filter((candidate) => candidate.expiresAtEpochMs > nowEpochMs);
        const evicting = live.length >= ExpectedConnectionHolds.MAX_HELD_SENDS_PER_CONNECTION;
        hold.sends.splice(0, hold.sends.length, ...live.slice(evicting ? 1 : 0), held);
        return evicting ? 'held-evicting-oldest' : 'held';
    }

    /** Holds one send per awaited id of an audience; the caller holds only a row it will not retry. */
    holdForAudience(
        audience: readonly string[],
        audienceSend: ExpectedConnectionHolds.AudienceSend
    ): ExpectedConnectionHolds.AudienceHold {
        let heldCount = 0;
        let evictedCount = 0;
        if (this.#holds.size === 0) {
            return { heldCount, evictedCount };
        }
        for (const id of audience) {
            const outcome = this.hold(id, {
                expiresAtEpochMs: audienceSend.expiresAtEpochMs,
                send: () => audienceSend.send(id)
            });
            heldCount += outcome === 'not-awaiting' ? 0 : 1;
            evictedCount += outcome === 'held-evicting-oldest' ? 1 : 0;
        }
        return { heldCount, evictedCount };
    }

    private releaseExpiredGenerations(id: string): void {
        const hold = this.#holds.get(id);
        const nowEpochMs = this.#dependencies.nowEpochMs();
        for (const [generationId, expiresAtEpochMs] of hold?.generations ?? []) {
            if (expiresAtEpochMs <= nowEpochMs) {
                this.release({ id, generationId });
            }
        }
    }

    private runSends(sends: readonly ExpectedConnectionHolds.HeldSend[]): void {
        const nowEpochMs = this.#dependencies.nowEpochMs();
        for (const held of sends) {
            if (held.expiresAtEpochMs <= nowEpochMs) {
                continue;
            }
            try {
                held.send();
            }
            catch (error) {
                console.error('Held WebSocket send failed:', error);
            }
        }
    }
}
