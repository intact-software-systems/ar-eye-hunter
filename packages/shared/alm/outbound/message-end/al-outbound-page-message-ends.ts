import type { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
import type { ALOutboundSendControls } from '../lane/al-outbound-send-controls.ts';

export namespace ALOutboundPageMessageEnds {
    /** The lane that holds a message, which ends it in its own store. */
    export interface Lane {
        endMessage(msgId: string): Promise<void>;
    }

    /** A message an admission committed, in the lane that holds it. */
    export interface Admitted {
        readonly lane: Lane;
        readonly msgId: string;
    }

    export interface Input {
        readonly sendControls: Pick<ALOutboundSendControls, 'isEnded'>;
        /** Every lane's storage readiness: an end waits for the lane it ends the message in. */
        readonly ready: () => Promise<ALStorageReadiness.Outcome>;
        /** The lane holding the message in either form: its stored row, or an admission this page retained. */
        readonly readLaneForMessageEnd: (msgId: string) => Promise<Lane>;
    }
}

/**
 * The ends of the messages one page cancelled or handed over: each runs in the lane that holds its message, and the
 * page's disposal joins every end it started, so a cancel the page stated is stored before its lanes close.
 */
export class ALOutboundPageMessageEnds {
    private readonly input: ALOutboundPageMessageEnds.Input;
    /** A rejected end stays here for `join` to report. */
    private readonly started = new Set<Promise<void>>();
    private joined = false;

    constructor(input: ALOutboundPageMessageEnds.Input) {
        this.input = input;
    }

    /** Ends the message in the lane that holds it; nothing once the page is disposing. */
    start(msgId: string): Promise<void> {
        const ending = this.writeEnd(msgId);
        this.started.add(ending);
        ending.then(() => this.started.delete(ending), () => undefined);
        return ending;
    }

    /**
     * A cancel that landed while the message's admission was in flight found no row to end; the admission committed
     * one since, so it is ended before the admission returns. Undefined when no admitted message was ended: such an
     * admission returns without a read and without a turn of its own.
     */
    startAdmittedEnds(admitted: readonly ALOutboundPageMessageEnds.Admitted[]): Promise<void> | undefined {
        const ended = this.joined ? [] : admitted.filter(({ msgId }) => this.input.sendControls.isEnded(msgId));
        if (ended.length === 0) {
            return undefined;
        }
        return Promise.all(ended.map(({ lane, msgId }) => lane.endMessage(msgId))).then(() => undefined);
    }

    /** Starts no more ends and joins those started; undefined when none is pending, so disposal stays synchronous. */
    join(): Promise<readonly PromiseSettledResult<void>[]> | undefined {
        this.joined = true;
        return this.started.size === 0 ? undefined : Promise.allSettled(this.started);
    }

    /** An end started before `join` runs to its commit: the lanes are disposed only after it. */
    private async writeEnd(msgId: string): Promise<void> {
        if (this.joined) {
            return;
        }
        await this.input.ready();
        await (await this.input.readLaneForMessageEnd(msgId)).endMessage(msgId);
    }
}
