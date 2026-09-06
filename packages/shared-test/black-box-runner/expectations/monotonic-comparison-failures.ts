// deno-lint-ignore-file no-explicit-any
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { resolvePath } from '../execution/black-box-value-resolution.ts';

/**
 * Each path must resolve to a non-empty array of finite numbers; the first
 * element smaller than its predecessor is reported with its index and both
 * values. Equal neighbours pass -- the property is non-decreasing, which is
 * what a revision, generation or epoch series actually guarantees.
 */
export function monotonicComparisonFailures(actual: any, paths: ApiJsonValue | undefined): any[] {
    if (!Array.isArray(paths)) {
        return [];
    }

    return paths.flatMap<any>((path) => {
        if (typeof path !== 'string' || path.length <= 0) {
            return [{ path, error: 'Monotonic assertion paths must be non-empty strings.' }];
        }

        let values: ApiJsonValue;
        try {
            values = resolvePath(path, actual);
        }
        catch (error) {
            return [{
                path,
                error: error instanceof Error ? error.message : String(error)
            }];
        }

        if (!Array.isArray(values) || values.length <= 0) {
            return [{ path, values, error: 'Monotonic assertion path must resolve to a non-empty array.' }];
        }

        const numericValues = values.map((value) => Number(value));
        if (numericValues.some((value) => !Number.isFinite(value))) {
            return [{ path, values, error: 'Monotonic assertion values must be finite numbers.' }];
        }

        const regressionIndex = numericValues.findIndex((value, index) =>
            index > 0 && value < numericValues[index - 1]
        );
        return regressionIndex < 0
            ? []
            : [{
                path,
                values,
                regressionIndex,
                previous: numericValues[regressionIndex - 1],
                current: numericValues[regressionIndex]
            }];
    });
}
