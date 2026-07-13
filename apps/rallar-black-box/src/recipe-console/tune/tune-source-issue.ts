import type { TuneSourceIssue } from './tune-source-model.ts';

export function tuneSourceIssueKey(issue: TuneSourceIssue): string {
    return `${issue.code}\u0000${issue.message}`;
}

export function tuneOmittedInventoryMessage(
    omittedKnobs: number,
    omittedLimitations: number,
): string {
    return [
        omittedKnobs > 0
            ? `${omittedKnobs} tuning ${plural(omittedKnobs, 'knob')}`
            : undefined,
        omittedLimitations > 0
            ? `${omittedLimitations} tuning ${plural(omittedLimitations, 'limitation')}`
            : undefined,
    ].filter((part): part is string => part !== undefined).join(' and ') +
        ' remain worker-windowed.';
}

function plural(count: number, noun: string): string {
    return count === 1 ? noun : `${noun}s`;
}
