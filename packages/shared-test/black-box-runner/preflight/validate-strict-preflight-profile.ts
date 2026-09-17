import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import { toRecipeStepAction } from '../recipes/to-recipe-step-action.ts';
import type { BlackBoxRunnerPreflightIssue } from './black-box-runner-preflight-issue.ts';
import {
    isPreflightJsonObject,
    toPreflightJsonArray,
    toPreflightJsonObject
} from './preflight-json-values.ts';
import type { BlackBoxRunnerPreflightOperation } from './preflight-operations.ts';

const KNOWN_STEP_TYPES = [
    'http',
    'http.request',
    'ws',
    'ws.open',
    'ws.send',
    'ws.wait',
    'ws.close',
    'rtc',
    'rtc.connect',
    'rtc.send',
    'rtc.wait',
    'rtc.close',
    'webrtc',
    'crdt',
    'crdt.open',
    'crdt.apply',
    'crdt.read',
    'crdt.sync',
    'crdt.health',
    'crdt.wait',
    'crdt.undo',
    'crdt.redo',
    'crdt.close',
    'crdt.destroy',
    'assert',
    'set',
    'derive',
    'parallel',
    'loop'
];

/**
 * Assertion keys a WebSocket send never reads. `sendWs` dispatches on
 * `expect.messages` and `expect.message` only, so these two describe a check
 * the runner will not perform. Wait plumbing (`connection`, `withinMs`,
 * `consume`) is deliberately absent from this list: those are honoured
 * elsewhere on the step and flagging them would be noise, not a finding.
 */
const WS_SEND_IGNORED_ASSERTION_KEYS = ['absent', 'close'];

/**
 * `anyOf` is an ASSERT-step key. An HTTP step takes its accepted statuses from
 * `status`/`statusCode`/`statusCodes`/`allowedStatusCodes` and its accepted
 * bodies from `bodyAnyOf`, so `expect.anyOf` is read by nothing — and it fails
 * silently, because a 2xx answer with no expected status passes anyway.
 */
const HTTP_IGNORED_ASSERTION_KEYS = ['anyOf'];

/**
 * `compatible` and `compatible-structure` match an empty expected array against
 * any actual array, so an empty one asserts nothing at all. The stricter modes
 * reject it, which is what makes the mode part of the check rather than the
 * array alone.
 */
const VACUOUS_ARRAY_COMPARISONS = ['', 'compatible', 'compatible-structure'];

export function validateStrictPreflightProfile(
    rawConfig: ApiJsonObject,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly BlackBoxRunnerPreflightIssue[] {
    const steps = toPreflightJsonArray(rawConfig.steps).map(toPreflightJsonObject);
    return [
        ...steps.flatMap((step, index) => validateStrictStep(step, `steps[${index}]`)),
        ...operations
            .filter((operation) => operation.transport === 'HTTP' && !operation.path)
            .map((operation): BlackBoxRunnerPreflightIssue => ({
                severity: 'error',
                code: 'STRICT_HTTP_TARGET',
                message:
                    `Strict HTTP operation ${operation.name} requires request.path, request.url, or connection.url.`,
                path: operation.name
            }))
    ];
}

function validateStrictStep(step: ApiJsonObject, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const type = String(step.type || '').toLowerCase();
    return [
        ...(type.length > 0 && !isKnownStepType(type)
            ? [{
                severity: 'error' as const,
                code: 'STRICT_UNKNOWN_STEP_TYPE',
                message: `Unknown strict step type ${type}.`,
                path: `${path}.type`
            }]
            : []),
        ...(type.startsWith('set') || type.startsWith('derive') ? validateStrictSet(step, path) : []),
        ...(type.startsWith('assert') ? validateStrictAssertExpected(step, path) : []),
        ...validateStrictExpectIsHonoured(step, type, path),
        ...validateStrictExpectIsNotVacuous(step, path)
    ];
}

function validateStrictAssertExpected(step: ApiJsonObject, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const expected = toPreflightJsonObject(step.expect || step.response);
    const hasExpected = expected.body !== undefined || expected.expect !== undefined ||
        expected.expected !== undefined || Array.isArray(expected.anyOf) || Array.isArray(expected.comparators);
    return hasExpected
        ? []
        : [{
            severity: 'error',
            code: 'STRICT_ASSERT_EXPECTED',
            message: 'Strict assert steps need an expected value or expect.comparators.',
            path
        }];
}

function validateStrictExpectIsHonoured(
    step: ApiJsonObject,
    type: string,
    path: string
): readonly BlackBoxRunnerPreflightIssue[] {
    const expectedKeys = Object.keys(toPreflightJsonObject(step.expect || step.response));
    if (expectedKeys.length <= 0) {
        return [];
    }
    if (type.length <= 0 || type.startsWith('http')) {
        return expectedKeys
            .filter((key) => HTTP_IGNORED_ASSERTION_KEYS.includes(key))
            .map((key) => ({
                severity: 'error',
                code: 'STRICT_EXPECT_IGNORED',
                message: `HTTP steps do not read expect.${key}; use expect.statusCodes for several accepted ` +
                    'statuses and expect.bodyAnyOf for several accepted bodies.',
                path: `${path}.expect.${key}`
            }));
    }
    const action = String(toRecipeStepAction(step) || '').toLowerCase();
    if (!type.startsWith('ws') || (action !== 'send' && action.length > 0)) {
        return [];
    }
    return expectedKeys
        .filter((key) => WS_SEND_IGNORED_ASSERTION_KEYS.includes(key))
        .map((key) => ({
            severity: 'error',
            code: 'STRICT_EXPECT_IGNORED',
            message:
                `WebSocket send steps read expect.message, expect.messages, and expect.count; expect.${key} is ignored. ` +
                'Use a ws.wait step for it.',
            path: `${path}.expect.${key}`
        }));
}

function validateStrictExpectIsNotVacuous(step: ApiJsonObject, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const expected = toPreflightJsonObject(step.expect || step.response);
    const comparison = String(expected.comparison || '').toLowerCase();
    if (!VACUOUS_ARRAY_COMPARISONS.includes(comparison)) {
        return [];
    }
    return toEmptyArrayPaths(expected.body, `${path}.expect.body`)
        .map((emptyPath) => ({
            severity: 'error',
            code: 'STRICT_EXPECT_VACUOUS',
            message: 'An empty expected array matches anything under compatible; ' +
                'use compatible-complete or a non-empty expectation.',
            path: emptyPath
        }));
}

function toEmptyArrayPaths(value: ApiJsonValue | undefined, path: string): readonly string[] {
    if (Array.isArray(value)) {
        return value.length <= 0
            ? [path]
            : value.flatMap((item, index) => toEmptyArrayPaths(item, `${path}[${index}]`));
    }
    return isPreflightJsonObject(value)
        ? Object.entries(value).flatMap(([key, item]) => toEmptyArrayPaths(item, `${path}.${key}`))
        : [];
}

/** A strict set step names its output, has a value source, and takes state-write evidence only from the collector. */
function validateStrictSet(step: ApiJsonObject, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const request = toPreflightJsonObject(step.request);
    const output = step.output ?? request.output;
    const stateWriteEvidence = step.stateWriteEvidence ?? request.stateWriteEvidence;
    const hasValueSource = step.value !== undefined || request.value !== undefined ||
        step.transform !== undefined || request.transform !== undefined ||
        step.derive !== undefined || request.derive !== undefined || stateWriteEvidence !== undefined;
    const issues: BlackBoxRunnerPreflightIssue[] = [];
    if (output === 'stateWriteEvidence' && !isPreflightJsonObject(stateWriteEvidence)) {
        issues.push({
            severity: 'error',
            code: 'STRICT_STATE_WRITE_EVIDENCE_SOURCE',
            message: 'Strict stateWriteEvidence must come from the persisted-state collector.',
            path
        });
    }
    if (typeof output !== 'string') {
        issues.push({
            severity: 'error',
            code: 'STRICT_SET_OUTPUT',
            message: 'Strict set steps require output.',
            path
        });
    }
    if (!hasValueSource) {
        issues.push({
            severity: 'error',
            code: 'STRICT_SET_VALUE',
            message: 'Strict set steps require value, request.value, transform, or request.transform.',
            path
        });
    }
    return issues;
}

function isKnownStepType(type: string): boolean {
    return KNOWN_STEP_TYPES.some((known) => type === known || type.startsWith(`${known}.`));
}
