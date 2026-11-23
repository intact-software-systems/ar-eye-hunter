/** The outbound admission state keys; the store, its reads and the control owner all address these. */

/** The namespace an outbound admission store keeps its state under, inside its runtime store namespace. */
export function toALOutboundAdmissionNamespace(storeNamespace: string): string {
    return `${storeNamespace}:outbound:admission`;
}

export function toALOutboundMessageOwnerKey(namespace: string, msgId: string): string {
    return `${namespace}:msg-owner:${msgId}`;
}

export function toALOutboundVersionKey(namespace: string, senderId: string): string {
    return `${namespace}:version:${senderId}`;
}

export function toALOutboundSentMessageKey(namespace: string, msgId: string): string {
    return `${namespace}:sent:${msgId}`;
}

/**
 * A message's identity where origins share a namespace: msgIds are origin-unique, so the origin and the id name it (D40).
 * Its pending-ACK row and its version row are keyed by it.
 */
export interface ALOutboundPendingAckRef {
    readonly originPeerId: string;
    readonly msgId: string;
}

export interface ToALOutboundPendingAckKeyInput extends ALOutboundPendingAckRef {
    readonly namespace: string;
}

export function toALOutboundPendingAckKey(input: ToALOutboundPendingAckKeyInput): string {
    return `${input.namespace}:pending-ack:${JSON.stringify([input.originPeerId, input.msgId])}`;
}

/** The version every commit that writes one of the message's rows moves: what a control of the message fences on. */
export function toALOutboundMessageVersionKey(input: ToALOutboundPendingAckKeyInput): string {
    return `${input.namespace}:msg-version:${JSON.stringify([input.originPeerId, input.msgId])}`;
}

export function toALOutboundRepairAttemptKey(namespace: string, msgId: string): string {
    return `${namespace}:repair-attempts:${msgId}`;
}

export function toALOutboundFirstHopWaitKey(namespace: string, msgId: string): string {
    return `${namespace}:first-hop-wait:${msgId}`;
}

export function toALOutboundNotYetInSyncRetryKey(namespace: string, msgId: string): string {
    return `${namespace}:not-yet-in-sync-retry:${msgId}`;
}

export function toALOutboundSupersedenceLatestKey(namespace: string, supersedenceKey: string): string {
    return `${namespace}:supersedence:latest:${supersedenceKey}`;
}

export function toALOutboundSupersedenceReplacementKey(namespace: string, msgId: string): string {
    return `${namespace}:supersedence:replacement:${msgId}`;
}

export function toALOutboundControlHistoryKey(namespace: string, kind: string, msgId: string): string {
    return `${namespace}:control:${kind}:${msgId}`;
}
