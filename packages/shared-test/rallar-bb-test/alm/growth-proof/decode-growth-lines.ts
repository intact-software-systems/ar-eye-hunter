import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { GrowthSamplePoint } from './growth-series.ts';

export interface DecodedGrowthPoints {
    readonly points: readonly GrowthSamplePoint[];
    /** Lines that did not decode, such as a line torn by the sampler's stop, and readings dropped as unforced; each is skipped. */
    readonly skippedLines: number;
}

/** One sample file's lines, each turned into its points by `toPoints`; a line it returns undefined for is skipped. */
export function decodeGrowthLines(
    text: string,
    toPoints: (value: ApiJsonValue | undefined) => readonly GrowthSamplePoint[] | undefined
): DecodedGrowthPoints {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const decoded = lines.map((line) => toPoints(decodeJsonLine(line)));
    return {
        points: decoded.flatMap((points) => points ?? []),
        skippedLines: decoded.filter((points) => points === undefined).length
    };
}

/** `JSON.parse` yields JSON values only; undefined for a line that is not JSON. */
export function decodeJsonLine(text: string): ApiJsonValue | undefined {
    try {
        return JSON.parse(text) as ApiJsonValue;
    }
    catch {
        return undefined;
    }
}

export function isPositiveNumber(value: ApiJsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
