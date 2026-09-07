// deno-lint-ignore-file no-explicit-any
import { isSafeOutputTransformOnlySpec } from '../scenario-transform/safe-output-transform.ts';
import { toPublicCorrelationConfig } from './black-box-run-correlation.ts';

export function toResolverRoot(context: any): any {
    return {
        ...context.variables,
        ...context.outputs,
        variables: context.variables,
        outputs: context.outputs,
        results: context.results,
        resultsList: context.resultsList,
        resultsByName: context.resultsByName,
        runnerRunId: context.correlation?.runnerRunId,
        correlation: toPublicCorrelationConfig(context.correlation)
    };
}

export function resolvePath(path: string, root: any): any {
    const resolved = path.split('.')
        .reduce((prev, curr) => prev === undefined || prev === null ? undefined : prev[curr], root);

    if (resolved === undefined) {
        throw new Error('Cannot resolve placeholder {' + path + '}');
    }

    return resolved;
}

function pathSegments(path: string): string[] {
    return path
        .replaceAll(/\[(\d+)]/g, '.$1')
        .split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}

export function tryResolvePath(path: string, root: any): { found: boolean; value?: any; } {
    const segments = pathSegments(path);
    let value = root;

    for (const segment of segments) {
        if (value === undefined || value === null) {
            return {
                found: false
            };
        }

        value = value[segment];
    }

    return value === undefined
        ? {
            found: false
        }
        : {
            found: true,
            value
        };
}

function stringifyResolvedValue(value: any): string {
    if (value === undefined || value === null) {
        return String(value);
    }

    return typeof value === 'string'
        ? value
        : JSON.stringify(value);
}

function resolveStringPlaceholders(value: string, context: any): any {
    const exactPlaceholderMatch = value.match(/^\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}$/u);

    if (exactPlaceholderMatch) {
        return resolvePath(exactPlaceholderMatch[1], toResolverRoot(context));
    }

    return value.replaceAll(/\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}/gu, (_match, path) => {
        return stringifyResolvedValue(resolvePath(path, toResolverRoot(context)));
    });
}

export function resolvePlaceholders(value: any, context: any): any {
    if (typeof value === 'string') {
        return resolveStringPlaceholders(value, context);
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolvePlaceholders(item, context));
    }

    if (value && typeof value === 'object') {
        if (isSafeOutputTransformOnlySpec(value as Record<string, any>)) {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolvePlaceholders(nested, context)])
        );
    }

    return value;
}

/**
 * A comparator entry is `{ path, <comparator> }` and never a transform, but
 * `path` plus `equals` is also a valid transform-only spec, so the generic
 * resolver skips the whole entry and the comparator ends up comparing against
 * the literal placeholder text. Comparator lists are resolved value by value
 * instead, without that exemption.
 */
export function resolveComparators(comparators: any, context: any): any {
    if (!Array.isArray(comparators)) {
        return comparators;
    }

    return comparators.map((entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.fromEntries(
                Object.entries(entry)
                    .map(([key, value]) => [key, resolvePlaceholders(value, context)])
            )
            : resolvePlaceholders(entry, context)
    );
}

export function resolveAssertActual(value: any, context: any, missingActualValue: any): any {
    if (typeof value === 'string') {
        try {
            return resolveStringPlaceholders(value, context);
        }
        catch (error) {
            if (missingActualValue !== undefined) {
                return missingActualValue;
            }
            throw error;
        }
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolveAssertActual(item, context, missingActualValue));
    }

    if (value && typeof value === 'object') {
        if (isSafeOutputTransformOnlySpec(value as Record<string, any>)) {
            return value;
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolveAssertActual(nested, context, missingActualValue)])
        );
    }

    return value;
}
