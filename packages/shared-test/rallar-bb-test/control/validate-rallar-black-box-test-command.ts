import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import {
    validateAlmControlCommand,
    type RallarBlackBoxTestAlmCommandKind
} from '../alm/validate-alm-control-command.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_KINDS,
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommandKind,
    type RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { validateRecipeFields } from '../recipe/validate-recipe-fields.ts';
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
    validateRequiredFields,
    validateStringField
} from './validate-control-command-fields.ts';
import {
    validateDirectorControlCommand,
    type DirectorControlCommandKind
} from './validate-director-control-command.ts';
import {
    validateFormationControlCommand,
    type FormationControlCommandKind
} from './validate-formation-control-command.ts';
import { validateHttpControlCommand } from './validate-http-control-command.ts';
import { validateLoopControlCommand } from './validate-loop-control-command.ts';
import { validateRtcControlCommand, type RtcControlCommandKind } from './validate-rtc-control-command.ts';
import { validateWaitControlCommand } from './validate-wait-control-command.ts';
import { validateWsControlCommand, type WsControlCommandKind } from './validate-ws-control-command.ts';

export type ControlCommandValidationResult =
    | Readonly<{ ok: true; }>
    | Readonly<{
        ok: false;
        /** Every issue message, one per line. */
        error: string;
        messages: readonly string[];
        issues?: readonly RallarValidationIssue[];
    }>;

type CrdtCommandKind = Extract<RallarBlackBoxTestCommandKind, `crdt.${string}`>;
type ControlCommandKind = Exclude<RallarBlackBoxTestCommandKind, CrdtCommandKind>;
type ServiceCommandKind =
    | RtcControlCommandKind
    | RallarBlackBoxTestAlmCommandKind
    | WsControlCommandKind
    | 'http.request'
    | FormationControlCommandKind
    | DirectorControlCommandKind;

/** Required fields whose absence the kind's own validator reports in more specific words. */
const REQUIRED_FIELDS_WITH_OWN_MESSAGE: {
    readonly [Kind in ControlCommandKind]?:
        readonly (typeof RALLAR_BLACK_BOX_COMMAND_FIELDS)[Kind]['required'][number][];
} = {
    'recipe.load': ['recipe'],
    loop: ['commands'],
    parallel: ['groups'],
    wait: ['match'],
    'http.request': ['request'],
    'messages.send': ['carrier', 'typeId', 'payload'],
    'messages.observe': ['state'],
    'fault.inject': ['match'],
    'director.intent': ['intent']
};
const UNSUPPORTED_COMMAND_ISSUE = toControlCommandIssue('Command must be an object with a supported kind.');

export function validateRallarBlackBoxTestCommand(value: unknown): ControlCommandValidationResult {
    const issues = isJsonRecordValue(value) ? validateCommandRecord(value, 0) : [UNSUPPORTED_COMMAND_ISSUE];
    if (issues.length === 0) {
        return { ok: true };
    }
    const messages = issues.map((issue) => issue.message);
    const error = messages.join('\n');
    const validationIssues = issues.flatMap((issue) => issue.validationIssues);
    return validationIssues.length === 0
        ? { ok: false, error, messages }
        : { ok: false, error, messages, issues: validationIssues };
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
    const fields: RallarBlackBoxCommandFieldSet = RALLAR_BLACK_BOX_COMMAND_FIELDS[kind];
    const shapeIssues = [
        ...validateBaseFields(command),
        ...validateAllowedFields(command, toCommandFieldSet(fields), kind)
    ];
    if (isCrdtCommandKind(kind)) {
        return [...shapeIssues, toControlCommandIssue('Command kind is not supported.')];
    }
    const ownMessageFields: readonly string[] = REQUIRED_FIELDS_WITH_OWN_MESSAGE[kind] ?? [];
    return [
        ...shapeIssues,
        ...validateRequiredFields({ record: command, fields, path: kind, ownMessageFields }),
        ...validateCommandKindFields(command, kind, depth)
    ];
}

function isCommandKind(value: unknown): value is RallarBlackBoxTestCommandKind {
    return typeof value === 'string' && RALLAR_BLACK_BOX_TEST_COMMAND_KINDS.some((kind) => kind === value);
}

/** CRDT commands are browser-local documents; the control path does not dispatch them. */
function isCrdtCommandKind(kind: RallarBlackBoxTestCommandKind): kind is CrdtCommandKind {
    return kind.startsWith('crdt.');
}

function toCommandFieldSet(fields: RallarBlackBoxCommandFieldSet): RallarBlackBoxCommandFieldSet {
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
    kind: ControlCommandKind,
    depth: number
): readonly ControlCommandIssue[] {
    switch (kind) {
        case 'configure':
            return validateObjectField(command, 'config', kind);
        case 'recipe.load':
            return validateInlineRecipe(command, `${kind}.recipe`, depth);
        case 'recipe.run':
            return command.recipe === undefined ? [] : validateInlineRecipe(command, `${kind}.recipe`, depth);
        case 'recipe.cancel':
            return [
                ...validateStringField(command, 'reason', kind),
                ...validateStringField(command, 'targetCommandId', kind)
            ];
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
        case 'close':
            return validateStringField(command, 'targetCommandId', kind);
        case 'stats':
        case 'reset':
            return [];
        default:
            return validateServiceCommandFields(command, kind);
    }
}

function validateServiceCommandFields(
    command: RallarBlackBoxTestRecord,
    kind: ServiceCommandKind
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
        case 'messages.control':
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
        ...validateRecipeFields(recipe, path),
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
