export const AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v2';
export const AL_CONTROL_NACK_TYPE_ID = 'al.control.nack.v2';
export const AL_CONTROL_REPAIR_TYPE_ID = 'al.control.repair.v2';
export const AL_CONTROL_RECEIPT_TYPE_ID = 'al.control.receipt.v1';

/**
 * Every other `al.control.*` id is refused `unsupported`: `al.control.ack.v1`, and `al.control.nack.v1` and
 * `al.control.repair.v1`, which carried missing sequences as lists where `v2` carries ranges.
 */
export function isALControlTypeId(typeId: string): boolean {
    return typeId === AL_CONTROL_ACK_TYPE_ID ||
        typeId === AL_CONTROL_NACK_TYPE_ID ||
        typeId === AL_CONTROL_REPAIR_TYPE_ID ||
        typeId === AL_CONTROL_RECEIPT_TYPE_ID;
}
