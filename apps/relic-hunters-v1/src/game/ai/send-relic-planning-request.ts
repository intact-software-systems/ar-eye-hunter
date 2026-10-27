import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPlanningAiContext,
    type RelicPlanningAiSuggestion
} from '@relic-hunters/mod.ts';
import type { RallarMessagePayload } from '@shared-web/browser/rallar-messages.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import type { RallarAiJsonRequest, RallarAiJsonResult } from '@shared/rallar-ai/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import { decodeRelicPlanningAiReply } from './decode-relic-planning-ai-reply.ts';

/** The browser policy's generation timeout: past it, the local companion answers instead. */
export const RELIC_PLANNING_REPLY_TIMEOUT_MS = 5_000;

export type RelicPlanningRequestFallback =
    | 'no-server'
    | 'timeout'
    | 'aborted'
    | 'undelivered'
    | 'invalid-reply';

export interface RelicPlanningRequestInput {
    readonly roomId: string;
    /** Without `signal`: the server refuses a request with fields it does not know. */
    readonly request: Omit<RallarAiJsonRequest<RelicPlanningAiContext>, 'signal'>;
    readonly context: RelicPlanningAiContext;
    readonly currentBaseStateRevision: () => string | undefined;
    readonly signal: AbortSignal;
}

/**
 * Asks the Relic server's planning companion on the `command` channel and awaits its one reply (D444). A left names
 * why the server did not answer usefully, so the caller runs its local companion instead.
 */
export async function sendRelicPlanningRequest(
    facade: Pick<RallarFacade, 'serverPeerId' | 'messages'>,
    input: RelicPlanningRequestInput
): Promise<Either<RelicPlanningRequestFallback, RallarAiJsonResult<RelicPlanningAiSuggestion>>> {
    const serverPeerId = facade.serverPeerId();
    if (serverPeerId === undefined) {
        return Either.ofLeft('no-server');
    }
    const handle = await facade.messages
        .room<RelicPlanningRequestInput['request']>({
            topicId: RELIC_TOPICS.aiPlanning,
            typeId: RELIC_TYPES.aiPlanningRequest,
            purpose: 'command',
            roomId: input.roomId
        })
        .sendWs(input.request, { peerId: serverPeerId });
    const outcome = await handle.awaitReply<RallarMessagePayload>({
        timeoutMs: RELIC_PLANNING_REPLY_TIMEOUT_MS,
        signal: input.signal
    });
    if (outcome.status !== 'replied') {
        return Either.ofLeft(outcome.status);
    }
    const reply = decodeRelicPlanningAiReply(outcome.reply.payload, {
        requestId: input.request.requestId ?? '',
        baseStateRevision: input.currentBaseStateRevision() ?? '',
        context: input.context
    });
    return reply.right === undefined ? Either.ofLeft('invalid-reply') : Either.ofRight(reply.right);
}
