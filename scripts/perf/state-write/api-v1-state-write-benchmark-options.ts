import { normalize } from 'node:path';

import {
    GROUP_FORMATION_DAMPING_REGRESSION_REASON_PROFILE,
    PLANNED_LAYOUT_PROMOTION_REGRESSION_REASON_PROFILE,
    RTC_TOPOLOGY_REGRESSION_REASON_PROFILE
} from './api-v1-state-write-regression-reasons.ts';

export const STATE_WRITE_REQUIRED_CONCURRENCY = 10;

const MAX_WARMUP_RUNS = 10;
const MAX_MEASURED_RUNS = 100;
const MAX_CONCURRENCY = 256;

interface ParseIntegerOptionInput {
    readonly name: string;
    readonly raw: string | undefined;
    readonly fallback: number;
    readonly minimum: number;
    readonly maximum: number;
}

export interface StateWriteBenchmarkOptions {
    readonly backend: string;
    readonly warmup: number;
    readonly runs: number;
    readonly concurrency: number;
    readonly out: string;
    readonly regressionReasonsFile?: string;
    readonly regressionReasonProfile?:
        | typeof RTC_TOPOLOGY_REGRESSION_REASON_PROFILE
        | typeof GROUP_FORMATION_DAMPING_REGRESSION_REASON_PROFILE
        | typeof PLANNED_LAYOUT_PROMOTION_REGRESSION_REASON_PROFILE;
}

export function parseBenchmarkOptions(args: readonly string[]): StateWriteBenchmarkOptions {
    const values = new Map(
        args.map((argument) => {
            const [key, ...rest] = argument.replace(/^--/, '').split('=');
            return [key, rest.join('=')];
        })
    );
    const regressionReasonsFile = values.get('regression-reasons-file');
    const regressionReasonProfile = values.get('regression-reason-profile');
    if (regressionReasonsFile !== undefined) {
        assertPerfInputPath(regressionReasonsFile);
    }
    if (
        regressionReasonProfile !== undefined &&
        regressionReasonProfile !== RTC_TOPOLOGY_REGRESSION_REASON_PROFILE &&
        regressionReasonProfile !== GROUP_FORMATION_DAMPING_REGRESSION_REASON_PROFILE &&
        regressionReasonProfile !== PLANNED_LAYOUT_PROMOTION_REGRESSION_REASON_PROFILE
    ) {
        throw new Error(
            `Unsupported state-write regression reason profile: ${regressionReasonProfile}`
        );
    }
    if (regressionReasonsFile !== undefined && regressionReasonProfile !== undefined) {
        throw new Error('--regression-reasons-file and --regression-reason-profile cannot be combined');
    }
    return {
        backend: values.get('backend') || 'postgres',
        warmup: parseIntegerOption({
            name: 'warmup',
            raw: values.get('warmup'),
            fallback: 1,
            minimum: 1,
            maximum: MAX_WARMUP_RUNS
        }),
        runs: parseIntegerOption({
            name: 'runs',
            raw: values.get('runs'),
            fallback: 3,
            minimum: 1,
            maximum: MAX_MEASURED_RUNS
        }),
        concurrency: parseIntegerOption({
            name: 'concurrency',
            raw: values.get('concurrency'),
            fallback: STATE_WRITE_REQUIRED_CONCURRENCY,
            minimum: 1,
            maximum: MAX_CONCURRENCY
        }),
        out: values.get('out') || 'tmp/perf/api-v1-state-write-results.json',
        ...(regressionReasonsFile === undefined ? {} : { regressionReasonsFile }),
        ...(regressionReasonProfile === undefined ? {} : { regressionReasonProfile })
    };
}

function parseIntegerOption(input: ParseIntegerOptionInput): number {
    const { fallback, maximum, minimum, name, raw } = input;
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `--${name} must be a safe integer between ${minimum} and ${maximum}; received ${raw}`
        );
    }
    return value;
}

function assertPerfInputPath(path: string): void {
    const normalized = normalize(path).replaceAll('\\', '/');
    if (normalized !== path || !normalized.startsWith('tmp/perf/') || normalized.includes('/../')) {
        throw new Error(`Regression-reason input must remain under tmp/perf/: ${path}`);
    }
}
