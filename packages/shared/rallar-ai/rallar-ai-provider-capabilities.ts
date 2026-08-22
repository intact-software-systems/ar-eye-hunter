import type {
    RallarAiProviderCapabilities,
    RallarAiProviderTarget,
    RallarAiValidationIssue
} from './rallar-ai-types.ts';
import { failRallarAiValidation, okRallarAiValidation } from './rallar-ai-validation.ts';

export function defineRallarAiProviderCapabilities(
    input: RallarAiProviderCapabilities
): RallarAiProviderCapabilities {
    return { ...input };
}

export function validateRallarAiProviderCapabilities(
    value: unknown
) {
    if (!isRecord(value)) {
        return failRallarAiValidation([
            {
                path: '$',
                code: 'invalid-provider-capabilities',
                message: 'Provider capabilities must be an object.'
            }
        ]);
    }

    const issues: RallarAiValidationIssue[] = [];
    requireBoolean(value.supportsJsonSchema, '$.supportsJsonSchema', issues);
    requireBoolean(value.supportsStreaming, '$.supportsStreaming', issues);
    requireBoolean(value.supportsCancellation, '$.supportsCancellation', issues);
    if (!isProviderTarget(value.target)) {
        issues.push({
            path: '$.target',
            code: 'invalid-provider-target',
            message: 'Provider target must be browser, server, or shared.'
        });
    }

    return issues.length === 0 ? okRallarAiValidation() : failRallarAiValidation(issues);
}

export function providerCanRunOnTarget(
    capabilities: RallarAiProviderCapabilities,
    target: Exclude<RallarAiProviderTarget, 'shared'>
): boolean {
    return capabilities.target === target || capabilities.target === 'shared';
}

function requireBoolean(
    value: unknown,
    path: string,
    issues: RallarAiValidationIssue[]
): void {
    if (typeof value !== 'boolean') {
        issues.push({
            path,
            code: 'invalid-boolean',
            message: 'Expected boolean.'
        });
    }
}

function isProviderTarget(value: unknown): value is RallarAiProviderTarget {
    return value === 'browser' || value === 'server' || value === 'shared';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
