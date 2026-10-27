import { Either } from '@shared/resilience/Either.ts';

import type {
    BlackBoxRallarReplyInput,
    BlackBoxRallarReplyWaitInput
} from '../black-box-rallar-operation-contracts.ts';
import {
    decodeBlackBoxCommandNumber,
    decodeBlackBoxCommandString,
    isBlackBoxCommandRecord,
    isRallarMessagePayload,
    type BlackBoxRallarInputIssue
} from '../decode-black-box-rallar-command-input.ts';
import { decodeBlackBoxRallarDeliveryHandleInput } from './decode-black-box-rallar-messaging-input.ts';

export function decodeBlackBoxRallarReplyWaitInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarReplyWaitInput> {
    const timeoutMs = isBlackBoxCommandRecord(value) ? decodeBlackBoxCommandNumber(value.timeoutMs) : undefined;
    return decodeBlackBoxRallarDeliveryHandleInput(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (handle) =>
            timeoutMs === undefined
                ? Either.ofLeft({ message: 'messages.awaitReply.timeoutMs is required.' })
                : Either.ofRight({ ...handle, timeoutMs })
    );
}

/** The payload is the recipe's JSON, carried as given; only the request's arrival and the reply's handle are decoded. */
export function decodeBlackBoxRallarReplyInput(
    value: unknown
): Either<BlackBoxRallarInputIssue, BlackBoxRallarReplyInput> {
    const record = isBlackBoxCommandRecord(value) ? value : {};
    const connection = decodeBlackBoxCommandString(record.connection);
    const typeId = decodeBlackBoxCommandString(record.typeId);
    const handleId = decodeBlackBoxCommandString(record.handleId);
    const index = record.index;
    const payload = record.payload;
    if (
        connection === undefined || typeId === undefined || handleId === undefined ||
        typeof index !== 'number' || !Number.isInteger(index) || index < 1 || !isRallarMessagePayload(payload)
    ) {
        return Either.ofLeft({
            message: 'messages.reply must name connection, typeId, an index of at least 1, payload and handleId.'
        });
    }
    return Either.ofRight({ connection, typeId, index, payload, handleId });
}
