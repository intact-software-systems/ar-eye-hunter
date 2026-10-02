import type { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { toALDurableOwnerLockName, type ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { ALDurableWorkCommit, ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
import type { ObservableValue } from '@shared/cache/RepositoryInterfaces.ts';

export namespace BrowserALDurableWorkClaim {
    export interface Input {
        readonly scope: StateScope;
        readonly sessionId: string;
        /** `undefined` where the Locks API is missing: every connect owns its session's durable work. */
        readonly locks: ALBrowserLocks | undefined;
        /** The connect's channel to the session's other tabs, which carries the commits; closed on release. */
        readonly sessionChannel: BrowserALSessionChannel;
    }
}

interface ForeignCommitListener {
    readonly workType: string;
    readonly listener: (rows: ALWorkCommittedRows) => void;
}

/**
 * One connect's claim on its session's durable work in one scope. Every tab of the session requests the
 * owner lock once per connect; the connect it is granted to owns the work and holds the lock until
 * `release()`, and the request of the next tab is granted then. A connect whose request fails for any
 * reason but its own release owns the work, as every connect did before there was a claim. Ownership
 * turns true at most once and never back while the connect's runtimes live, so it cannot flap; a connect
 * that fails after its WS transport is built leaves those runtimes owning (a carried limit).
 */
export class BrowserALDurableWorkClaim implements ALDurableWorkOwnership {
    private readonly ownedValue = new ObservableLatestValue<boolean>();
    private readonly lifetime = new AbortController();
    private readonly foreignCommitListeners = new Set<ForeignCommitListener>();
    private readonly input: BrowserALDurableWorkClaim.Input;

    constructor(input: BrowserALDurableWorkClaim.Input) {
        this.input = input;
        this.ownedValue.accept(input.locks === undefined);
        input.sessionChannel.onCommitted((commit) => this.applyForeignCommit(commit));
    }

    get owned(): ObservableValue<boolean> {
        return this.ownedValue;
    }

    /** Requests the owner lock once; its callback is the takeover. */
    request(): void {
        const { locks, scope, sessionId } = this.input;
        const { signal } = this.lifetime;
        void locks?.request(
            toALDurableOwnerLockName(scope, sessionId),
            { mode: 'exclusive', signal },
            async () => await this.holdUntilReleased()
        )
            .catch(() => this.takeOverUnlessReleased());
    }

    /** Ends the connect's claim: a request still waiting is abandoned, a held lock is released. */
    release(): void {
        this.lifetime.abort();
        this.input.sessionChannel.close();
    }

    isOwned(): boolean {
        return this.ownedValue.peek() === true;
    }

    announceCommit(commit: ALDurableWorkCommit): void {
        this.input.sessionChannel.announceCommit(commit);
    }

    onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void {
        const entry: ForeignCommitListener = { workType, listener };
        this.foreignCommitListeners.add(entry);
        return () => this.foreignCommitListeners.delete(entry);
    }

    /**
     * Another connect's commit reaches its work type's lane only while this connect holds the work, so
     * a waiting connect neither runs a commit it hears nor announces it again.
     */
    applyForeignCommit(commit: ALDurableWorkCommit): void {
        if (!this.isOwned() || this.lifetime.signal.aborted) {
            return;
        }
        for (const entry of this.foreignCommitListeners) {
            if (entry.workType === commit.workType) {
                entry.listener(commit.rows);
            }
        }
    }

    private async holdUntilReleased(): Promise<void> {
        this.takeOverUnlessReleased();
        const { signal } = this.lifetime;
        await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            if (signal.aborted) {
                resolve();
            }
        });
    }

    private takeOverUnlessReleased(): void {
        if (!this.lifetime.signal.aborted) {
            this.ownedValue.accept(true);
        }
    }
}
