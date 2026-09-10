/** The outbound admission state keys; the store, its reads and the control owner all address these. */

export function toALOutboundMessageOwnerKey(namespace: string, msgId: string): string {
    return `${namespace}:msg-owner:${msgId}`;
}

export function toALOutboundVersionKey(namespace: string, senderId: string): string {
    return `${namespace}:version:${senderId}`;
}

export function toALOutboundSentMessageKey(namespace: string, msgId: string): string {
    return `${namespace}:sent:${msgId}`;
}

export function toALOutboundPendingAckKey(namespace: string, msgId: string): string {
    return `${namespace}:pending-ack:${msgId}`;
}

export function toALOutboundRepairAttemptKey(namespace: string, msgId: string): string {
    return `${namespace}:repair-attempt:${msgId}`;
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

export function toALOutboundOrderingMessageKey(namespace: string, trackKey: string, seq: number): string {
    return `${namespace}:ordering-message:${JSON.stringify([trackKey, seq])}`;
}
