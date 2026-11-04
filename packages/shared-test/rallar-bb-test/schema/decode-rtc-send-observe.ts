import { Either } from '@shared/resilience/Either.ts';

import { RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES } from './rallar-black-box-command-fields.ts';

/**
 * The end of a typed send an `rtc.send` reads as its value. `rejected`, its `observe` option: a rejected handle is the
 * value and any other end fails the command. `not-failed`, an absent `observe`: a rejected, failed, expired, cancelled
 * or superseded handle fails it.
 */
export type RtcSendExpectation = 'not-failed' | 'rejected';

const OBSERVE_MESSAGE = `rtc.send.observe must be ${
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcSendObserve.map((value) => `"${value}"`).join(' or ')
}.`;

/** The end of a send an `rtc.send` command reads as its success; the control validator and the page decode it alike. */
export function decodeRtcSendObserve(observe: unknown): Either<string, RtcSendExpectation> {
    if (observe === undefined) {
        return Either.ofRight('not-failed');
    }
    const expectation = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcSendObserve.find((value) => value === observe);
    return expectation === undefined ? Either.ofLeft(OBSERVE_MESSAGE) : Either.ofRight(expectation);
}
