import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type { ApiV1StateWriteEvidenceSpec } from './api-v1-state-write-evidence-contracts.ts';

export function toApiV1StateWriteEvidenceSpec(
    input: unknown
): ApiV1StateWriteEvidenceSpec {
    const issues = validateStateWriteEvidenceSpecShape(input);
    if (issues.length > 0) {
        const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        if (issues.some((issue) => issue.path === 'stateWriteEvidence.match')) {
            throw new Error(
                `stateWriteEvidence.match must be a non-empty string.${issues.length > 1 ? ` ${details}` : ''}`
            );
        }
        throw new TypeError(`stateWriteEvidence has invalid option shapes: ${details}`);
    }
    const {
        match,
        minimumMatchedRows,
        evidenceSampleLimit,
        commandTypes,
        commandIdPrefixes,
        expectedEffectsByCommandType,
        overdueRecoveryFixture
    } = input as ApiV1StateWriteEvidenceSpec;
    return {
        match,
        ...(minimumMatchedRows === undefined ? {} : { minimumMatchedRows }),
        ...(evidenceSampleLimit === undefined ? {} : { evidenceSampleLimit }),
        ...(commandTypes === undefined ? {} : { commandTypes: [...commandTypes] }),
        ...(commandIdPrefixes === undefined
            ? {}
            : { commandIdPrefixes: [...commandIdPrefixes] }),
        ...(expectedEffectsByCommandType === undefined ? {} : {
            expectedEffectsByCommandType: Object.fromEntries(
                Object.entries(expectedEffectsByCommandType).map((
                    [commandType, effects]
                ) => [commandType, [...effects]])
            )
        }),
        ...(overdueRecoveryFixture === undefined ? {} : {
            overdueRecoveryFixture: {
                ...(overdueRecoveryFixture.commandType === undefined
                    ? {}
                    : { commandType: overdueRecoveryFixture.commandType }),
                ...(overdueRecoveryFixture.commandIdPrefix === undefined
                    ? {}
                    : { commandIdPrefix: overdueRecoveryFixture.commandIdPrefix }),
                ...(overdueRecoveryFixture.overdueByMs === undefined
                    ? {}
                    : { overdueByMs: overdueRecoveryFixture.overdueByMs }),
                ...(overdueRecoveryFixture.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: overdueRecoveryFixture.timeoutMs })
            }
        })
    };
}

function validateStateWriteEvidenceSpecShape(input: unknown): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    const options = isRecord(input) ? input : {};
    if (typeof options.match !== 'string' || options.match.length === 0) {
        issues.push({
            path: 'stateWriteEvidence.match',
            code: 'invalid-match',
            message: 'Expected a non-empty string.'
        });
    }
    for (const field of ['minimumMatchedRows', 'evidenceSampleLimit']) {
        if (options[field] !== undefined && !isFiniteNumber(options[field])) {
            issues.push({
                path: `stateWriteEvidence.${field}`,
                code: 'invalid-number',
                message: 'Expected a finite number.'
            });
        }
    }
    for (const field of ['commandTypes', 'commandIdPrefixes']) {
        if (options[field] !== undefined && !isStringArray(options[field])) {
            issues.push({
                path: `stateWriteEvidence.${field}`,
                code: 'invalid-array',
                message: 'Expected an array of strings.'
            });
        }
    }
    const effects = options.expectedEffectsByCommandType;
    if (effects !== undefined) {
        if (!isRecord(effects)) {
            issues.push({
                path: 'stateWriteEvidence.expectedEffectsByCommandType',
                code: 'invalid-object',
                message: 'Expected an effect map.'
            });
        }
        else {
            for (const [commandType, value] of Object.entries(effects)) {
                if (!isStringArray(value)) {
                    issues.push({
                        path: `stateWriteEvidence.expectedEffectsByCommandType.${commandType}`,
                        code: 'invalid-array',
                        message: 'Expected an array of strings.'
                    });
                }
            }
        }
    }
    if (options.overdueRecoveryFixture !== undefined) {
        issues.push(...validateOverdueRecoveryFixtureShape(options.overdueRecoveryFixture));
    }
    return issues;
}

function validateOverdueRecoveryFixtureShape(value: unknown): readonly RallarValidationIssue[] {
    const path = 'stateWriteEvidence.overdueRecoveryFixture';
    if (!isRecord(value)) {
        return [{ path, code: 'invalid-object', message: 'Expected fixture options.' }];
    }
    const issues: RallarValidationIssue[] = [];
    for (const field of ['overdueByMs', 'timeoutMs']) {
        if (value[field] !== undefined && !isFiniteNumber(value[field])) {
            issues.push({ path: `${path}.${field}`, code: 'invalid-number', message: 'Expected a finite number.' });
        }
    }
    for (const field of ['commandType', 'commandIdPrefix']) {
        if (value[field] !== undefined && typeof value[field] !== 'string') {
            issues.push({ path: `${path}.${field}`, code: 'invalid-string', message: 'Expected a string.' });
        }
    }
    return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) &&
        value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
