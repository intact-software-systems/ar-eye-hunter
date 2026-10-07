import { readALTargetGroupRef, type ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALNackReason } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { StateScope } from '../../../api/state-types.ts';
import type {
    WsServerInboundAuthorization,
    WsServerInboundConnectionScopeProof
} from '../ws-queue-box-server-contracts.ts';

export interface ToWsQueueBoxServerScopeAuthorizationInput {
    readonly message: ALMessage;
    readonly proof: WsServerInboundConnectionScopeProof | undefined;
    readonly nowMs: number;
    /** The wrapped authorizer's own NACK policy (`WsServerInboundAuthorizer.sendNacks`), as the addressee refusal. */
    readonly sendNack: boolean;
}

export type WsQueueBoxServerScopeRefusal = Extract<WsServerInboundAuthorization, { authorized: false; }>;

export type WsQueueBoxServerScopeAuthorization =
    | Readonly<{ authorized: true; proof: WsServerInboundConnectionScopeProof; }>
    | WsQueueBoxServerScopeRefusal;

export function toWsQueueBoxServerScopeAuthorization(
    input: ToWsQueueBoxServerScopeAuthorizationInput
): WsQueueBoxServerScopeAuthorization {
    const { message, proof } = input;
    if (proof === undefined || proof.expiresAtEpochMs <= input.nowMs) {
        return toScopeRefusal(input, {
            reason: 'unauthorized',
            rejectionCode: 'unauthorized',
            logMessage: `AL message ${message.id.msgId} arrived without a current authenticated WS scope`
        });
    }
    const audienceRefusal = readClientAudienceRefusal(message);
    if (audienceRefusal !== undefined) {
        return toScopeRefusal(input, audienceRefusal);
    }
    const outside = readAddressedScopes(message).find((addressed) =>
        addressed.applicationId !== proof.scope.applicationId || addressed.workspaceId !== proof.scope.workspaceId
    );
    if (outside !== undefined) {
        return toScopeRefusal(input, {
            reason: 'unauthorized',
            rejectionCode: 'unauthorized',
            logMessage: `AL message ${message.id.msgId} addresses ${outside.applicationId}/${outside.workspaceId}, ` +
                `outside its connection's authenticated scope`
        });
    }
    return { authorized: true, proof };
}

interface ScopeRefusalCause {
    readonly reason: ALNackReason;
    readonly rejectionCode: ALMessageRejection['code'];
    readonly logMessage: string;
}

/**
 * A client addresses a principal only inside the room it names and the world only off a room topic, which is room-scoped
 * by its name; every connection the server holds is the server's audience alone.
 */
function readClientAudienceRefusal(message: ALMessage): ScopeRefusalCause | undefined {
    const targets = message.targets;
    if (targets?.mode !== 'broadcast') {
        return undefined;
    }
    if (targets.scope === 'all') {
        return {
            reason: 'unauthorized',
            rejectionCode: 'unauthorized',
            logMessage: `AL message ${message.id.msgId} addresses every scope, which only the server may address`
        };
    }
    if (targets.scope === 'world' && message.route.topicId.startsWith('room.')) {
        return {
            reason: 'no-route',
            rejectionCode: 'malformed',
            logMessage: `AL message ${message.id.msgId} addresses the world on room topic ${message.route.topicId}`
        };
    }
    return targets.scope === 'principal' && targets.groupRef === undefined
        ? {
            reason: 'no-route',
            rejectionCode: 'malformed',
            logMessage: `AL message ${message.id.msgId} addresses a principal without the room it is addressed in`
        }
        : undefined;
}

function readAddressedScopes(message: ALMessage): readonly StateScope[] {
    const targets = message.targets;
    const principalRef = targets?.mode === 'broadcast' && targets.scope === 'principal'
        ? targets.principalRef
        : undefined;
    return [readALTargetGroupRef(message), principalRef].filter((scope) => scope !== undefined);
}

function toScopeRefusal(
    input: ToWsQueueBoxServerScopeAuthorizationInput,
    cause: ScopeRefusalCause
): WsQueueBoxServerScopeRefusal {
    return { authorized: false, ...cause, sendNack: input.sendNack };
}
