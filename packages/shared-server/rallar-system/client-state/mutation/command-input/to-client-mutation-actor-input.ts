import type { NullableActorInput } from '../client-mutation-contracts.ts';

export interface ToClientMutationActorInput {
    readonly actorPrincipalId?: string;
    readonly actorSessionId?: string;
    readonly reason?: string;
    readonly traceId?: string;
}

export function toClientMutationActorInput(
    actorInput: ToClientMutationActorInput
): NullableActorInput {
    return {
        actorPrincipalId: actorInput.actorPrincipalId ?? null,
        actorSessionId: actorInput.actorSessionId ?? null,
        reason: actorInput.reason ?? null,
        traceId: actorInput.traceId ?? null
    };
}
