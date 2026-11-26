import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/**
 * A formation cycle's owner commands in order, each by what bounds its result poll: the mesh configuration, the group
 * read, then the plan or reconfigure, the layout's connect and the activation, which name no budget.
 */
export const FORMATION_CYCLE_COMMAND_POLLS = [
    'mesh-configuration',
    'group-read',
    'unbudgeted',
    'unbudgeted',
    'unbudgeted'
] as const;

/**
 * The commands a formation run waits on outside its polls, one after another: its connects, then per cycle the owner's
 * commands and the last of the readiness reads, which run side by side and count once.
 */
export const FORMATION_RUN_COMMANDS = LIVE_RTC_TRIO_SIZE + 2 * (FORMATION_CYCLE_COMMAND_POLLS.length + 1);

/** A reconnect waits on its connect, then on the last of the readiness reads that run side by side. */
export const FORMATION_RECONNECT_COMMANDS = 2;
