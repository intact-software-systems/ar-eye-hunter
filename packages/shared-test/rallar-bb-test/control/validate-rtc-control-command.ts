import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_NON_NEGATIVE_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateIntegerField,
    validateNonNegativeNumberFields,
    validateNumberField,
    validateObjectField,
    validateRatioField,
    validateStringField
} from './validate-control-command-fields.ts';
import { validateControlCommandRoomFields } from './validate-control-command-room-fields.ts';
import { validateCompositeCountAndDuration } from './validate-loop-control-command.ts';

export type RtcControlCommandKind = 'rtc.connect' | 'rtc.send' | 'rtc.stream';

export function validateRtcControlCommand(
    command: RallarBlackBoxTestRecord,
    kind: RtcControlCommandKind
): readonly ControlCommandIssue[] {
    const rtcIssues = [
        ...validateStringField(command, 'connection', 'rtc'),
        ...validateStringField(command, 'actor', 'rtc'),
        ...validateControlCommandRoomFields(command, 'rtc'),
        ...validateNumberField(command, 'minSnapshotVersion', 'rtc'),
        ...validateRtcTransport(command, kind),
        ...(kind === 'rtc.connect' ? validateRtcConnectReadiness(command) : []),
        ...validateObjectField(command, 'rallar', 'rtc')
    ];
    return kind === 'rtc.stream' ? [...rtcIssues, ...validateRtcStreamFields(command)] : rtcIssues;
}

function validateRtcTransport(
    command: RallarBlackBoxTestRecord,
    kind: RtcControlCommandKind
): readonly ControlCommandIssue[] {
    const transports: readonly string[] = kind === 'rtc.connect'
        ? RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcConnectTransport
        : RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.rtcSendTransport;
    return command.transport === undefined || transports.includes(String(command.transport))
        ? []
        : [toControlCommandIssue(`rtc.transport must be ${transports.join(' or ')}.`)];
}

function validateRtcConnectReadiness(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const readiness = command.readiness;
    if (readiness === undefined) {
        return [];
    }
    if (!isJsonRecordValue(readiness)) {
        return [toControlCommandIssue('rtc.readiness must be an object.')];
    }
    return [
        ...validateAllowedFields(
            readiness,
            RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.rtcConnectReadiness,
            'rtc.readiness'
        ),
        ...['minReadyPeers', 'timeoutMs', 'intervalMs'].flatMap((key) =>
            validateIntegerField({ record: readiness, key, path: 'rtc.readiness', minimum: 1 })
        )
    ];
}

function validateRtcStreamFields(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...(command.count === undefined && command.durationMs === undefined
            ? [toControlCommandIssue('rtc.stream requires count or durationMs.')]
            : []),
        ...(command.intervalMs === undefined && command.rateHz === undefined
            ? [toControlCommandIssue('rtc.stream requires intervalMs or rateHz.')]
            : []),
        ...validateRtcStreamPacing(command),
        ...validateBooleanField(command, 'continueOnSendFailure', 'rtc.stream'),
        ...validateRtcStreamThresholds(command)
    ];
}

function validateRtcStreamPacing(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const path = 'rtc.stream';
    return [
        ...validateCompositeCountAndDuration(command, path),
        ...validateIntegerField({ record: command, key: 'intervalMs', path, minimum: 1 }),
        ...validateRtcStreamRate(command),
        ...validateIntegerField({ record: command, key: 'maxInFlight', path, minimum: 1 }),
        ...validateIntegerField({ record: command, key: 'drainTimeoutMs', path, minimum: 0 }),
        ...validateIntegerField({ record: command, key: 'progressEveryMs', path, minimum: 1 }),
        ...validateIntegerField({ record: command, key: 'sampleEvery', path, minimum: 1 })
    ];
}

function validateRtcStreamRate(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const numberIssues = validateNumberField(command, 'rateHz', 'rtc.stream');
    return numberIssues.length === 0 && typeof command.rateHz === 'number' && command.rateHz <= 0
        ? [toControlCommandIssue('rtc.stream.rateHz must be > 0.')]
        : numberIssues;
}

function validateRtcStreamThresholds(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const thresholds = command.thresholds;
    if (thresholds === undefined) {
        return [];
    }
    if (!isJsonRecordValue(thresholds)) {
        return [toControlCommandIssue('rtc.stream.thresholds must be an object.')];
    }
    const path = 'rtc.stream.thresholds';
    return [
        ...validateAllowedFields(thresholds, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.rtcStreamThresholds, path),
        ...validateRatioField(thresholds, 'minSendSuccessRatio', path),
        ...validateNonNegativeNumberFields(
            thresholds,
            RALLAR_BLACK_BOX_COMMAND_NON_NEGATIVE_FIELDS.rtcStreamThresholds,
            path
        )
    ];
}
