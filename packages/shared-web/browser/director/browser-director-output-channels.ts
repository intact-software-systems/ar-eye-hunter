import type {
    RallarDirectorRelayEnvelope,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import type {
    RallarMessageOrderGap,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { AsyncNotifications } from '@shared/cache/async-notifications.ts';

/**
 * A receipted output is retried after its 2 s ACK timeout, so 3 s covers the first retry and its delivery. A later
 * output is not held longer than that for a missing one.
 */
const DIRECTOR_OUTPUT_GAP_WAIT_MS = 3_000;

export namespace BrowserDirectorOutputChannels {
    export interface Input {
        readonly messages: Pick<RallarMessagesOperations, 'room'>;
    }

    export interface Route {
        readonly topicId: string;
        readonly typeId: string;
    }

    /** One relay's gap listener: its output route, who its director is now, and the application's callback. */
    export interface GapListener extends Route {
        /** The relay config's callback; undefined when the application takes no gap. */
        readonly onOutputGap: ((gap: RallarMessageOrderGap) => void | Promise<void>) | undefined;
        readStatus(): RallarDirectorStatus;
    }
}

/**
 * The page's director relays' edge-ordered output channels. A page keeps one gap handler per topic and type, and the
 * latest declaration replaces the one before it, so every channel publishes its gaps here and each live relay hears
 * them through its own fenced listener.
 */
export class BrowserDirectorOutputChannels {
    private readonly input: BrowserDirectorOutputChannels.Input;
    private readonly gaps = new AsyncNotifications<RallarMessageOrderGap>();

    public constructor(input: BrowserDirectorOutputChannels.Input) {
        this.input = input;
    }

    /** A relay's output channel. It names no room: every output send names its room. */
    public open<TOutput>(
        route: BrowserDirectorOutputChannels.Route
    ): RallarTypedMessageChannel<RallarDirectorRelayEnvelope<TOutput>> {
        return this.input.messages.room<RallarDirectorRelayEnvelope<TOutput>>({
            topicId: route.topicId,
            typeId: route.typeId,
            purpose: 'notification',
            access: 'members',
            order: 'edge',
            orderGapWaitMs: DIRECTOR_OUTPUT_GAP_WAIT_MS,
            onOrderGap: async (gap) =>
                await this.gaps.publishConcurrent(gap, (error) => {
                    console.error('Error notifying a director relay of an output gap', error);
                })
        });
    }

    /** A fan-out captures its audience first, so a relay another relay's callback stopped is checked here too. */
    public onGap(listener: BrowserDirectorOutputChannels.GapListener): RallarUnsubscribe {
        let subscribed = true;
        const subscription = this.gaps.subscribe(async (gap) => {
            if (subscribed && isRelayGap(listener, gap)) {
                await listener.onOutputGap?.(gap);
            }
        });
        return () => {
            subscribed = false;
            subscription.unsubscribe();
        };
    }
}

/**
 * Every relay on the page hears every gap, and the declaration stands for every room, so a relay checks its route,
 * its room and its director: one session can direct two rooms on one topic, and only a gap of this relay's room,
 * from its current director's stream, is its own.
 */
function isRelayGap(listener: BrowserDirectorOutputChannels.GapListener, gap: RallarMessageOrderGap): boolean {
    const status = listener.readStatus();
    return gap.topicId === listener.topicId && gap.typeId === listener.typeId &&
        status.roomRef !== undefined && isSameGroupRef(gap.roomRef, status.roomRef) &&
        gap.senderId === status.appointment?.sessionId;
}
