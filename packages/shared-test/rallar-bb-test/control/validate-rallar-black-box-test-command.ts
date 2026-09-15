import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { validateAlmControlCommand } from '../alm/validate-alm-control-command.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommandKind,
    type RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import {
    RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_FIELDS,
    RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS,
    type RallarBlackBoxCommandFieldSet
} from '../schema/rallar-black-box-command-fields.ts';
import {
    toControlCommandIssue,
    toPrefixedControlCommandIssues,
    type ControlCommandIssue
} from './control-command-issue.ts';
import { validateAssertControlCommand } from './validate-assert-control-command.ts';
import {
    validateAllowedFields,
    validateBooleanField,
    validateIntegerField,
    validateNumberField,
    validateObjectField,
    validateRequiredField,
    validateStringField
} from './validate-control-command-fields.ts';
import { validateDirectorControlCommand } from './validate-director-control-command.ts';
import { validateFormationControlCommand } from './validate-formation-control-command.ts';
import { validateHttpControlCommand } from './validate-http-control-command.ts';
import { validateLoopControlCommand } from './validate-loop-control-command.ts';
import { validateRtcControlCommand } from './validate-rtc-control-command.ts';
import { validateWaitControlCommand } from './validate-wait-control-command.ts';
import { validateWsControlCommand } from './validate-ws-control-command.ts';

export type ControlCommandValidationResult =
    | Readonly<{ ok: true; }>
    | Readonly<{ ok: false; error: string; issues?: readonly RallarValidationIssue[]; }>;

const UNSUPPORTED_COMMAND_ISSUE = toControlCommandIssue('Command must be an object with a supported kind.');

export function validateRallarBlackBoxTestCommand(value: unknown): ControlCommandValidationResult {
    const issues = isJsonRecordValue(value) ? validateCommandRecord(value, 0) : [UNSUPPORTED_COMMAND_ISSUE];
    if (issues.length === 0) {
        return { ok: true };
    }
    const error = issues.map((issue) => issue.message).join('\n');
    const validationIssues = issues.flatMap((issue) => issue.validationIssues);
    return validationIssues.length === 0 ? { ok: false, error } : { ok: false, error, issues: validationIssues };
}

function validateCommandRecord(command: RallarBlackBoxTestRecord, depth: number): readonly ControlCommandIssue[] {
    const kind = command.kind;
    if (!isCommandKind(kind)) {
        return [UNSUPPORTED_COMMAND_ISSUE];
    }
    const maxDepth = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth;
    if (depth > maxDepth) {
        return [toControlCommandIssue(`Command exceeds max composite depth ${maxDepth}.`)];
    }
    return [
        ...validateBaseFields(command),
        ...validateAllowedFields(command, toCommandFieldSet(kind), kind),
        ...validateCommandKindFields(command, kind, depth)
    ];
}

function isCommandKind(value: unknown): value is RallarBlackBoxTestCommandKind {
    return typeof value === 'string' && RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.some((kind) => kind === value);
}

function toCommandFieldSet(kind: RallarBlackBoxTestCommandKind): RallarBlackBoxCommandFieldSet {
    const fields = RALLAR_BLACK_BOX_COMMAND_FIELDS[kind];
    return {
        required: ['kind', ...fields.required],
        optional: [...RALLAR_BLACK_BOX_COMMAND_BASE_FIELDS, ...fields.optional]
    };
}

function validateBaseFields(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateStringField(command, 'commandId', 'command'),
        ...validateStringField(command, 'label', 'command'),
        ...validateNumberField(command, 'deadlineEpochMs', 'command'),
        ...validateNumberField(command, 'timeoutMs', 'command'),
        ...validateObjectField(command, 'metadata', 'command')
    ];
}

function validateCommandKindFields(
    command: RallarBlackBoxTestRecord,
    kind: RallarBlackBoxTestCommandKind,
    depth: number
): readonly ControlCommandIssue[] {
    switch (kind) {
        case 'configure':
            return [...validateRequiredField(command, 'config', kind), ...validateObjectField(command, 'config', kind)];
        case 'recipe.load':
            return validateInlineRecipe(command, `${kind}.recipe`, depth);
        case 'recipe.run':
            return command.recipe === undefined ? [] : validateInlineRecipe(command, `${kind}.recipe`, depth);
        case 'recipe.cancel':
            return validateStringField(command, 'reason', kind);
        case 'loop':
            return [
                ...validateCompositeCommandList(command, 'loop.commands', depth),
                ...validateLoopControlCommand(command)
            ];
        case 'parallel':
            return validateParallelCommand(command, depth);
        case 'wait':
            return validateWaitControlCommand(command);
        case 'assert':
            return validateAssertControlCommand(command);
        case 'health':
            return validateBooleanField(command, 'includeRtcDiagnostics', kind);
        case 'stats':
        case 'close':
        case 'reset':
            return [];
        default:
            return validateServiceCommandFields(command, kind);
    }
}

/** CRDT commands are browser-local documents; the control path does not dispatch them. */
function validateServiceCommandFields(
    command: RallarBlackBoxTestRecord,
    kind: RallarBlackBoxTestCommandKind
): readonly ControlCommandIssue[] {
    switch (kind) {
        case 'rtc.connect':
        case 'rtc.send':
        case 'rtc.stream':
            return validateRtcControlCommand(command, kind);
        case 'messages.send':
        case 'messages.observe':
        case 'messages.cancel':
        case 'messages.received':
        case 'messages.receipts':
        case 'fault.inject':
        case 'storage.counters':
        case 'agent.reload':
            return validateAlmControlCommand(command, kind);
        case 'ws.open':
        case 'ws.send':
        case 'ws.close':
            return validateWsControlCommand(command, kind);
        case 'http.request':
            return validateHttpControlCommand(command);
        case 'formation.command':
        case 'formation.readiness':
            return validateFormationControlCommand(command, kind);
        case 'director.appoint':
        case 'director.resign':
        case 'director.status':
        case 'director.relay.start':
        case 'director.intent':
        case 'director.sync.request':
        case 'director.relay.stop':
            return validateDirectorControlCommand(command, kind);
        default:
            return [toControlCommandIssue('Command kind is not supported.')];
    }
}

function validateInlineRecipe(
    command: RallarBlackBoxTestRecord,
    path: string,
    depth: number
): readonly ControlCommandIssue[] {
    const recipe = command.recipe;
    if (!isJsonRecordValue(recipe)) {
        return [toControlCommandIssue(`${path} must be an object.`)];
    }
    return [
        ...validateAllowedFields(recipe, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.recipe, path),
        ...(recipe.schemaVersion === 1 ? [] : [toControlCommandIssue(`${path}.schemaVersion must be 1.`)]),
        ...validateRequiredField(recipe, 'recipeId', path),
        ...validateStringField(recipe, 'recipeId', path),
        ...validateCommandList(recipe, `${path}.commands`, depth)
    ];
}

function validateParallelCommand(command: RallarBlackBoxTestRecord, depth: number): readonly ControlCommandIssue[] {
    const groups = command.groups;
    if (!Array.isArray(groups)) {
        return [toControlCommandIssue('parallel.groups must be an array.')];
    }
    return [
        ...(groups.length === 0 ? [toControlCommandIssue('parallel.groups requires at least one group.')] : []),
        ...validateIntegerField({
            record: command,
            key: 'maxConcurrency',
            path: 'parallel',
            minimum: 1,
            maximum: RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxParallelConcurrency
        }),
        ...validateBooleanField(command, 'failFast', 'parallel'),
        ...validateBooleanField(command, 'continueOnFailure', 'parallel'),
        ...groups.flatMap((group, index) =>
            isJsonRecordValue(group)
                ? validateParallelGroup(group, `parallel.groups[${index}]`, depth)
                : [toControlCommandIssue(`parallel.groups[${index}] must be an object.`)]
        )
    ];
}

function validateParallelGroup(
    group: RallarBlackBoxTestRecord,
    path: string,
    depth: number
): readonly ControlCommandIssue[] {
    return [
        ...validateAllowedFields(group, RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.parallelGroup, path),
        ...validateStringField(group, 'groupId', path),
        ...validateStringField(group, 'label', path),
        ...validateObjectField(group, 'metadata', path),
        ...validateCompositeCommandList(group, `${path}.commands`, depth)
    ];
}

function validateCompositeCommandList(
    parent: RallarBlackBoxTestRecord,
    path: string,
    depth: number
): readonly ControlCommandIssue[] {
    const maxDepth = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxDepth;
    if (depth > maxDepth) {
        return [toControlCommandIssue(`${path} exceeds max composite depth ${maxDepth}.`)];
    }
    const commands = parent.commands;
    return Array.isArray(commands) && commands.length === 0
        ? [toControlCommandIssue(`${path} requires at least one command.`)]
        : validateCommandList(parent, path, depth + 1);
}

function validateCommandList(
    parent: RallarBlackBoxTestRecord,
    path: string,
    depth: number
): readonly ControlCommandIssue[] {
    const commands = parent.commands;
    if (!Array.isArray(commands)) {
        return [toControlCommandIssue(`${path} must be an array.`)];
    }
    return commands.flatMap((child, index) =>
        toPrefixedControlCommandIssues(
            `${path}[${index}]`,
            isJsonRecordValue(child) ? validateCommandRecord(child, depth) : [UNSUPPORTED_COMMAND_ISSUE]
        )
    );
}
