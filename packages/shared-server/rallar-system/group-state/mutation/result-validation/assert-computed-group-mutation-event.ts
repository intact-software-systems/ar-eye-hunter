import { validateAuthoritativeGroupEvent } from '@shared/api/authoritative-state-validation.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import type { AssertComputedGroupMutationWriteInput } from './assert-computed-group-mutation-write.ts';

export function assertComputedGroupMutationEvent({
    command,
    facts,
    computed
}: AssertComputedGroupMutationWriteInput): void {
    validateAuthoritativeGroupEvent(computed.event, command.aggregateRef);
    if (
        computed.event.eventId !== facts.eventId ||
        computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
        (computed.event.requestId ?? null) !== command.requestId ||
        actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
        actorSessionId(computed.event.actor) !== command.input.actorSessionId
    ) {
        throw new TypeError('Group mutation computed event identity differs from command and facts');
    }
}

function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}
