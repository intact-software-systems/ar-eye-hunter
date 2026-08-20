import type { ArenaActions, ArenaActionsInput } from '../actions/use-arena-actions.ts';
import { useArenaCombatActions } from './use-arena-combat-actions.ts';
import { useArenaPresenceActions } from '../state/use-arena-presence-actions.ts';
import { useArenaWorldActions } from './use-arena-world-actions.ts';

export function useArenaGameActions(input: ArenaActionsInput): Pick<
    ArenaActions,
    | 'sendPose'
    | 'sendShot'
    | 'sendPlayerHit'
    | 'sendPickupIntent'
    | 'startArenaMatch'
    | 'publishArenaSnapshot'
> {
    return {
        ...useArenaPresenceActions(input),
        ...useArenaCombatActions(input),
        ...useArenaWorldActions(input),
    };
}
