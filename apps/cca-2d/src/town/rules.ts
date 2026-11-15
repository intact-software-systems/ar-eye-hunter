import { computeTownAuthorities } from './authorities.ts';
import { computeTownCreatures } from './creatures/rules.ts';
import {
    addPuke,
    advanceTownDebris,
    tipTownShops
} from './mess.ts';
import { computeTownObjects } from './objects.ts';
import { computeTownOwners, witnessTownPrank } from './owners.ts';
import { collectTownPickup, releaseTownPrank } from './pranks.ts';
import { computeTownProps } from './props.ts';
import { computeTownSoiling } from './soiling.ts';
import type { TownComputed, TownTickInput } from './state.ts';

export function computeTownTick(input: TownTickInput): TownComputed {
    const { now, step } = input;
    let player = input.player;
    let town = advanceTownDebris(input.town, now, step);
    if (input.dash) {
        town = releaseTownPrank(town, player, now);
    }
    town = tipTownShops(town, player, now);
    town = computeTownProps({ ...input, town });
    town = computeTownObjects({ ...input, town });
    const creatures = computeTownCreatures({ ...input, town });
    const soiling = computeTownSoiling({ ...input, ...creatures });
    town = soiling.town;
    player = soiling.player;
    if (input.dash || town.mischief > input.town.mischief) {
        town = witnessTownPrank({ ...input, town });
    }
    const owners = computeTownOwners({ ...input, town, player });
    town = owners.town;
    const exposed = player.immuneUntil <= now &&
        town.patches.some((patch) =>
            patch.kind === 'powder' && now - patch.born > 0.4 &&
            Math.hypot(player.x - patch.x, player.z - patch.z) < 1.8
        );
    const sickAt = exposed ? now + 2.2 : player.sickAt;
    if (sickAt >= 0 && sickAt > now - step && sickAt <= now) {
        town = addPuke(town, player, now);
    }
    const authorities = computeTownAuthorities({
        ...input,
        town,
        player: { ...player, shieldUntil: owners.shieldUntil }
    });
    const pickup = collectTownPickup(authorities.town, { ...player, power: input.dash ? 'fart' : player.power }, now);
    return {
        ...pickup,
        stain: player.stain,
        stainedUntil: player.stainedUntil,
        messImmuneUntil: player.messImmuneUntil,
        frozenUntil: authorities.frozenUntil,
        shieldUntil: authorities.shieldUntil,
        sickAt,
        dizzyUntil: exposed ? now + 3.2 : player.dizzyUntil,
        immuneUntil: exposed ? now + 9 : player.immuneUntil
    };
}
