import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';

export const RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES = [
    'targeting',
    'readiness',
    'barrier',
    'command',
    'group-assertion',
    'rtc-stream-performance',
    'diagnostic',
    'runtime',
    'unknown'
] as const;

export type RallarBlackBoxDistributedFailureCategory = typeof RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES[number];

export type DistributedFailureExplanation = Readonly<{
    category: RallarBlackBoxDistributedFailureCategory;
    title: string;
    likelyCause: string;
    nextAction: string;
    evidence: readonly string[];
}>;

export type FirstDistributedRunPhaseForCommand = (
    commandId: string | undefined
) => ControlDistributedRunCommandLink['phase'] | undefined;
