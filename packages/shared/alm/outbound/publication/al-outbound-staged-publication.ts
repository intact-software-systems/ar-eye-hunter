import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../delivery/al-delivery-lifecycle.ts';

/** A live value held by its lane until an opportunity selects it; its identity and deadline are the built message's. */
export interface ALOutboundStagedPublication<TContext> {
    readonly msg: ALMessage;
    readonly msgId: string;
    readonly traceId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly laneKey: string;
    readonly streamKey: string;
    readonly bytes: number;
    readonly expiresAtMs: number;
    readonly stagedAtMs: number;
    /** What the caller needs back at `submit` to admit the value; the stage never reads it. */
    readonly context: TContext;
}
