export interface ALReceiptRecordRef {
    readonly originPeerId: string;
    readonly msgId: string;
}

export function toALReceiptRecordNamespace(storeNamespace: string): string {
    return `${storeNamespace}:receipt:record`;
}

/** The JSON pair is injective where a separator-joined pair is not: 'o' + 'm:x' and 'o:m' + 'x' stay apart. */
export function toALReceiptRecordRefToken(ref: ALReceiptRecordRef): string {
    return JSON.stringify([ref.originPeerId, ref.msgId]);
}

export function toALReceiptRecordHeadKey(namespace: string, ref: ALReceiptRecordRef): string {
    return `${namespace}:receipt:${toALReceiptRecordRefToken(ref)}`;
}

export function toALReceiptRecordConfirmationPrefix(namespace: string, ref: ALReceiptRecordRef): string {
    return `${namespace}:receipt-ack:${toALReceiptRecordRefToken(ref)}:`;
}

export function toALReceiptRecordConfirmationKey(
    namespace: string,
    ref: ALReceiptRecordRef,
    recipientPeerId: string
): string {
    return `${toALReceiptRecordConfirmationPrefix(namespace, ref)}${recipientPeerId}`;
}
