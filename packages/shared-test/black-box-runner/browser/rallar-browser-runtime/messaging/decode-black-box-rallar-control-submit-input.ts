import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarControlSubmitInput } from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';

const CONTROL_CARRIERS: readonly ALDeliveryCarrier[] = ['ws', 'rtc'];
const CONTROL_TYPE_ID_PREFIX = 'al.control.';

export function decodeBlackBoxRallarControlSubmitInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarControlSubmitInput> {
    const record = isBlackBoxCommandRecord(value) ? value : {};
    const carrier = CONTROL_CARRIERS.find((candidate) => candidate === record.carrier);
    const typeId = decodeBlackBoxCommandString(record.typeId);
    const ackedMsgId = decodeBlackBoxCommandString(record.ackedMsgId);
    const toPeerId = decodeBlackBoxCommandString(record.toPeerId);
    if (
        carrier === undefined || typeId === undefined || !typeId.startsWith(CONTROL_TYPE_ID_PREFIX) ||
        ackedMsgId === undefined || toPeerId === undefined
    ) {
        return Either.ofLeft({
            message: 'messages.control must name a ws or rtc carrier, an al.control.* typeId, ackedMsgId and toPeerId.'
        });
    }
    return Either.ofRight({ carrier, typeId, ackedMsgId, toPeerId });
}
