import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

/**
 * A role's body split where another role's first send may start. The arming run is what the role must have in place
 * before then: its leading fault injections and the cue subscription through which it hears another role's cue.
 */
export interface AlmCellArming {
    readonly arming: readonly RallarBlackBoxTestCommand[];
    readonly rest: readonly RallarBlackBoxTestCommand[];
}

/** Set on both commands of a cue subscription by its builder; absent, a command subscribes the role to nothing. */
export const ALM_CELL_CUE_SUBSCRIPTION_METADATA = { cellArming: 'cue-subscription' } as const;

/** The longest leading run of fault injections and cue subscriptions, and everything after it. */
export function toAlmCellArming(body: readonly RallarBlackBoxTestCommand[]): AlmCellArming {
    const restAt = body.findIndex((command) => command.kind !== 'fault.inject' && !isAlmCellCueSubscription(command));
    const armingEnd = restAt < 0 ? body.length : restAt;
    return { arming: body.slice(0, armingEnd), rest: body.slice(armingEnd) };
}

export function isAlmCellCueSubscription(command: RallarBlackBoxTestCommand): boolean {
    return command.metadata?.cellArming === ALM_CELL_CUE_SUBSCRIPTION_METADATA.cellArming;
}
