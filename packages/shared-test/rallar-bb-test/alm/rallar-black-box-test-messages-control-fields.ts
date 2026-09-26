import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

/**
 * A harness capability, not a product path: the raw ACK envelope of `ackedMsgId` to `toPeerId`, its sender, submitted
 * on one carrier under the authored `msgId`, which the admission outcome of its addressee names, and carrying `typeId`
 * in place of the supported ACK version. A type literal, as every command shape is, so a command stays assignable to a
 * command record.
 */
export type RallarBlackBoxTestMessagesControlFields = Readonly<{
    connection?: string;
    carrier: ALDeliveryCarrier;
    typeId: string;
    msgId: string;
    ackedMsgId: string;
    toPeerId: string;
}>;
