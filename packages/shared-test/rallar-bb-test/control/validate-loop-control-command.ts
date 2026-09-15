import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS
} from '../schema/rallar-black-box-command-fields.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateEnumField,
    validateIntegerField,
    validateNonNegativeNumberFields,
    validateNumberField,
    validateRatioField
} from './validate-control-command-fields.ts';

const LOOP_THRESHOLD_NON_NEGATIVE_FIELDS = [
    'minAchievedRateHz',
    'maxAverageStartDriftMs',
    'maxStartDriftMs',
    'maxJitterMs'
];

/** Validates the loop's own fields; its child commands are validated by the command entry. */
export function validateLoopControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateLoopBounds(command),
        ...validateBooleanField(command, 'continueOnFailure', 'loop'),
        ...validateEnumField({
            record: command,
            key: 'until',
            path: 'loop',
            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.loopUntil
        }),
        ...validateLoopUntilPolicy(command),
        ...validateLoopThresholds(command)
    ];
}

function validateLoopBounds(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const limits = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS;
    return [
        ...validateIntegerField({
            record: command,
            key: 'count',
            path: 'loop',
            minimum: 1,
            maximum: limits.maxLoopCount
        }),
        ...validateIntegerField({
            record: command,
            key: 'durationMs',
            path: 'loop',
            minimum: 1,
            maximum: limits.maxLoopDurationMs
        }),
        ...validateIntegerField({ record: command, key: 'intervalMs', path: 'loop', minimum: 0 }),
        ...validateIntegerField({ record: command, key: 'delayMs', path: 'loop', minimum: 0 }),
        ...validateIntegerField({
            record: command,
            key: 'maxCommands',
            path: 'loop',
            minimum: 1,
            maximum: limits.maxExpandedCommands
        })
    ];
}

function validateLoopUntilPolicy(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateBackoffMultiplier(command),
        ...(command.backoffMultiplier !== undefined && command.until === undefined
            ? [toControlCommandIssue('loop.backoffMultiplier requires until mode.')]
            : []),
        ...(command.until !== undefined && command.continueOnFailure === true
            ? [toControlCommandIssue('loop.continueOnFailure contradicts until mode.')]
            : [])
    ];
}

function validateBackoffMultiplier(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const backoffMultiplier = command.backoffMultiplier;
    const numberIssues = validateNumberField(command, 'backoffMultiplier', 'loop');
    if (numberIssues.length > 0 || typeof backoffMultiplier !== 'number') {
        return numberIssues;
    }
    if (backoffMultiplier <= 0) {
        return [toControlCommandIssue('loop.backoffMultiplier must be > 0.')];
    }
    return backoffMultiplier < 1 ? [toControlCommandIssue('loop.backoffMultiplier must be >= 1.')] : [];
}

function validateLoopThresholds(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const thresholds = command.thresholds;
    if (thresholds === undefined) {
        return [];
    }
    if (!isJsonRecordValue(thresholds)) {
        return [toControlCommandIssue('loop.thresholds must be an object.')];
    }
    return [
        ...validateAllowedFields(thresholds, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.loopThresholds, 'loop.thresholds'),
        ...validateNonNegativeNumberFields(thresholds, LOOP_THRESHOLD_NON_NEGATIVE_FIELDS, 'loop.thresholds'),
        ...validateRatioField(thresholds, 'minSendSuccessRatio', 'loop.thresholds'),
        ...validateBooleanField(thresholds, 'failOnBackpressure', 'loop.thresholds')
    ];
}
