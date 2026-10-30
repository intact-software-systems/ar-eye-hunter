import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALWorldBroadcast } from '../../../al-contracts/is-al-world-broadcast.ts';
import type { ALOutboundCapturedPolicy } from '../../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type { Key } from '../../../queuebox/ResourceEntry.ts';
import type { WsServerLiveSendInputDto } from '../ws-queue-box-server-contracts.ts';
import { isWsQueueBoxServerDirectScopedBroadcastRow } from './requires-ws-queue-box-server-recipient-scope.ts';
import { resolveWsQueueBoxServerRecipientScope } from './resolve-ws-queue-box-server-recipient-scope.ts';

export interface ToWsQueueBoxServerCapturedSendInput {
    readonly message: ALMessage;
    readonly key: Key;
    readonly policy: ALOutboundCapturedPolicy | undefined;
    /** The captured sessions a caller already found eligible here; undefined resolves them from the targets. */
    readonly eligibleSessionIds: readonly string[] | undefined;
}

/** The live send a dequeued row makes to this instance's sockets, bounded by the audience its producer captured. */
export function toWsQueueBoxServerCapturedSendInput(
    input: ToWsQueueBoxServerCapturedSendInput
): WsServerLiveSendInputDto {
    const { message, key, policy } = input;
    if (policy?.sessionInvalidation !== undefined) {
        return { message, sessionInvalidation: policy.sessionInvalidation };
    }
    const recipientScope = resolveWsQueueBoxServerRecipientScope(message, policy?.recipientScope);
    const directBroadcast = isWsQueueBoxServerDirectScopedBroadcastRow(message, key);
    return {
        message,
        recipientSessionIds: input.eligibleSessionIds,
        admittedPeerIds: policy?.admittedAudience,
        inboundScope: message.targets?.mode === 'unicast' ? recipientScope : undefined,
        recipientPrincipalId: policy?.principalTargetId,
        recipientScope: directBroadcast || isALWorldBroadcast(message) || policy?.principalTargetId !== undefined
            ? recipientScope
            : undefined
    };
}

/** Whether a row's captured sessions are filtered for durable eligibility before its live send. */
export function isWsQueueBoxServerCapturedSessionRow(message: ALMessage, key: Key): boolean {
    return message.targets?.mode === 'unicast' || isWsQueueBoxServerDirectScopedBroadcastRow(message, key);
}

/** A held row's policy for the one session it waits for: that session's audience and generation alone. */
export function toWsQueueBoxServerHeldSessionPolicy(
    policy: ALOutboundCapturedPolicy,
    sessionId: string
): ALOutboundCapturedPolicy {
    const generations = policy.admittedConnectionGenerationIds;
    return {
        ...policy,
        admittedAudience: [sessionId],
        ...(generations === undefined ? {} : {
            admittedConnectionGenerationIds: Object.hasOwn(generations, sessionId)
                ? { [sessionId]: generations[sessionId] }
                : {}
        })
    };
}
