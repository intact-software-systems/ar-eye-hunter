import { RELIC_PROTOCOL_VERSION, type RelicCommand } from '@relic-hunters/mod.ts';
import type { RelicHuntersRuntime } from '../relic-hunters-runtime.ts';
import type { RelicCommandOutcome } from '../to-relic-command-phase.ts';
import type { RelicCommandDraft } from './relic-command-draft.ts';
import type { RelicExpeditionParticipation } from './relic-expedition-participation.ts';

interface RelicCommandDelivery {
    readonly dependencies: Pick<RelicHuntersRuntime.Dependencies, 'sendWsCommand' | 'sendRestCommand'>;
    readonly participation: RelicExpeditionParticipation;
    readonly draft: RelicCommandDraft;
    readonly attempt: RelicHuntersRuntime.Attempt & { readonly roomId: string; };
    isCurrent(): boolean;
}

/** Owns command transport selection; a known WS outcome never starts a second REST write. */
export async function deliverRelicCommand(input: RelicCommandDelivery): Promise<RelicCommandOutcome | undefined> {
    const { attempt, draft, dependencies } = input;
    const command: RelicCommand = {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: attempt.roomId,
        username: attempt.session.username,
        ...draft
    };
    const delivery = draft.kind === 'join-expedition'
        ? undefined
        : await dependencies.sendWsCommand(attempt.roomId, command);
    if (!input.isCurrent()) {
        return undefined;
    }
    // Admission requires its durable result. Other commands use REST only when no WS server is known.
    if (delivery !== undefined) {
        return { transport: 'ws', delivery };
    }
    const snapshot = draft.kind === 'join-expedition'
        ? await input.participation.join(attempt.roomId, attempt.session.sessionId, command)
        : await dependencies.sendRestCommand({
            gameId: attempt.roomId,
            command,
            requestId: crypto.randomUUID(),
            sessionId: attempt.session.sessionId
        });
    return { transport: 'rest', snapshot };
}
