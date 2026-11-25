import { LIVE_RTC_TRIO_SIZE } from './live-rtc-control-waits.ts';

/** A formation cycle's owner commands that name no budget: the plan or reconfigure, the connect, the activation. */
export const FORMATION_CYCLE_UNBUDGETED_COMMANDS = 3;

/** A formation cycle's owner commands: the mesh configuration, the group read, then its unbudgeted commands. */
const FORMATION_CYCLE_COMMANDS = 2 + FORMATION_CYCLE_UNBUDGETED_COMMANDS;

/**
 * The commands a formation run waits on outside its polls, one after another: its connects, then per cycle the owner's
 * commands and the last of the readiness reads, which run side by side and count once.
 */
export const FORMATION_RUN_COMMANDS = LIVE_RTC_TRIO_SIZE + 2 * (FORMATION_CYCLE_COMMANDS + 1);

/** A reconnect waits on its connect, then on the last of the readiness reads that run side by side. */
export const FORMATION_RECONNECT_COMMANDS = 2;
