export interface ALReceiptRecordRef {
    readonly originPeerId: string;
    readonly msgId: string;
}

export function toALReceiptRecordNamespace(storeNamespace: string): string {
    return `${storeNamespace}:receipt:record`;
}

export function toALReceiptRecordHeadKey(namespace: string, ref: ALReceiptRecordRef): string {
    return `${namespace}:receipt:${JSON.stringify([ref.originPeerId, ref.msgId])}`;
}

export function toALReceiptRecordConfirmationPrefix(namespace: string, ref: ALReceiptRecordRef): string {
    return `${namespace}:receipt-ack:${JSON.stringify([ref.originPeerId, ref.msgId])}:`;
}

export function toALReceiptRecordConfirmationKey(
    namespace: string,
    ref: ALReceiptRecordRef,
    recipientPeerId: string
): string {
    return `${toALReceiptRecordConfirmationPrefix(namespace, ref)}${recipientPeerId}`;
}
