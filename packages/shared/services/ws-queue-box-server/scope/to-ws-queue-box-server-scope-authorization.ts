import { readALTargetGroupRef, type ALMessage } from '../../../al-contracts/al-contract.ts';
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
        return toScopeRefusal(
            input,
            `AL message ${message.id.msgId} arrived without a current authenticated WS scope`
        );
    }
    const addressed = readAddressedScope(message);
    if (
        addressed !== undefined &&
        (addressed.applicationId !== proof.scope.applicationId ||
            addressed.workspaceId !== proof.scope.workspaceId)
    ) {
        return toScopeRefusal(
            input,
            `AL message ${message.id.msgId} addresses ${addressed.applicationId}/${addressed.workspaceId}, ` +
                `outside its connection's authenticated scope`
        );
    }
    return { authorized: true, proof };
}

function readAddressedScope(message: ALMessage): StateScope | undefined {
    const targets = message.targets;
    return readALTargetGroupRef(message) ??
        (targets?.mode === 'broadcast' && targets.scope === 'principal'
            ? targets.principalRef
            : undefined);
}

function toScopeRefusal(
    input: ToWsQueueBoxServerScopeAuthorizationInput,
    logMessage: string
): WsQueueBoxServerScopeRefusal {
    return {
        authorized: false,
        reason: 'unauthorized',
        rejectionCode: 'unauthorized',
        logMessage,
        sendNack: input.sendNack
    };
}
