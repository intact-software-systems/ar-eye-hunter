import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPlanningAiContext,
    type RelicPlanningAiSuggestion
} from '@relic-hunters/mod.ts';
import type { RallarMessageHandle, RallarMessagePayload } from '@shared-web/browser/rallar-messages.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import type { RallarAiJsonResult } from '@shared/rallar-ai/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import { decodeRelicPlanningAiReply } from './decode-relic-planning-ai-reply.ts';
import type { RelicPlanningAiRequest } from './relic-planning-ai.ts';

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
    readonly request: RelicPlanningAiRequest;
    readonly context: RelicPlanningAiContext;
    readonly currentBaseStateRevision: () => string | undefined;
    readonly signal: AbortSignal;
}

/**
 * A rejected send (the peer changed, the connect failed) reaches no server, so it falls back like an undelivered
 * one.
 */
async function sendRelicPlanningWs(
    facade: Pick<RallarFacade, 'messages'>,
    serverPeerId: string,
    input: RelicPlanningRequestInput
): Promise<Either<'undelivered', RallarMessageHandle>> {
    try {
        return Either.ofRight(
            await facade.messages
                .room<RelicPlanningRequestInput['request']>({
                    topicId: RELIC_TOPICS.aiPlanning,
                    typeId: RELIC_TYPES.aiPlanningRequest,
                    purpose: 'command',
                    access: 'members',
                    roomId: input.roomId
                })
                .sendWs(input.request, { peerId: serverPeerId })
        );
    }
    catch {
        return Either.ofLeft('undelivered');
    }
}

export async function sendRelicPlanningRequest(
    facade: Pick<RallarFacade, 'serverPeerId' | 'messages'>,
    input: RelicPlanningRequestInput
): Promise<Either<RelicPlanningRequestFallback, RallarAiJsonResult<RelicPlanningAiSuggestion>>> {
    const serverPeerId = facade.serverPeerId();
    if (serverPeerId === undefined) {
        return Either.ofLeft('no-server');
    }
    const sent = await sendRelicPlanningWs(facade, serverPeerId, input);
    const handle = sent.right;
    if (handle === undefined) {
        return Either.ofLeft('undelivered');
    }
    const outcome = await handle.awaitReply<RallarMessagePayload>({
        timeoutMs: RELIC_PLANNING_REPLY_TIMEOUT_MS,
        signal: input.signal
    });
    if (outcome.status !== 'replied') {
        return Either.ofLeft(outcome.status);
    }
    const currentBaseStateRevision = input.currentBaseStateRevision();
    if (currentBaseStateRevision === undefined) {
        return Either.ofLeft('invalid-reply');
    }
    const reply = decodeRelicPlanningAiReply(outcome.reply.payload, {
        requestId: input.request.requestId,
        baseStateRevision: currentBaseStateRevision,
        context: input.context
    });
    return reply.right === undefined ? Either.ofLeft('invalid-reply') : Either.ofRight(reply.right);
}
