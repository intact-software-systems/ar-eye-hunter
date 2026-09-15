import {
    isBlackBoxCommandRecord,
    isRallarMessagePayload
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RallarBlackBoxTestError } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId } from './browser-command-contracts.ts';

/** An rtc.send or rtc.stream that names no send carries an empty envelope; a value no transport can carry fails. */
export function decodeRtcSendPayload(value: unknown): Either<RallarBlackBoxTestError, RallarMessagePayload> {
    if (value === undefined) {
        return Either.ofRight({});
    }
    return isRallarMessagePayload(value)
        ? Either.ofRight(value)
        : Either.ofLeft({
            code: 'RALLAR_BB_RTC_INVALID_SEND_PAYLOAD',
            message: 'RTC send must be a JSON value the page runtime can carry.'
        });
}

export function toScopedRtcSend(
    command: Extract<CommandWithId, { kind: 'rtc.send' | 'rtc.stream'; }>,
    send: RallarMessagePayload
): RallarMessagePayload {
    const scopedSendFields = Object.fromEntries(
        Object.entries({
            roomId: 'roomId' in command ? command.roomId : undefined,
            applicationId: command.applicationId,
            workspaceId: command.workspaceId,
            scope: command.scope,
            roomRef: command.roomRef,
            minSnapshotVersion: command.minSnapshotVersion
        }).filter(([_key, value]) => value !== undefined)
    );
    if (Object.keys(scopedSendFields).length === 0) {
        return send;
    }
    if (!isBlackBoxCommandRecord(send)) {
        return { data: send, ...scopedSendFields };
    }
    return {
        ...send,
        ...Object.fromEntries(Object.entries(scopedSendFields).filter(([key]) => !Object.hasOwn(send, key)))
    };
}
