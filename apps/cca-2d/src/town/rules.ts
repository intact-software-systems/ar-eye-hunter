import { computeTownAuthorities } from './authorities.ts';
import { addPuke, advanceTownDebris, tipTownShops } from './mess.ts';
import { computeTownOwners, witnessTownPrank } from './owners.ts';
import { collectTownPickup, releaseTownPrank } from './pranks.ts';
import { computeTownProps } from './props.ts';
import type { TownComputed, TownTickInput } from './state.ts';

export function computeTownTick(input: TownTickInput): TownComputed {
    const { player, now, step } = input;
    let town = advanceTownDebris(input.town, now, step);
    if (input.dash) {
        town = releaseTownPrank(town, player, now);
    }
    town = tipTownShops(town, player, now);
    town = computeTownProps({ ...input, town });
    if (input.dash) {
        town = witnessTownPrank({ ...input, town });
    }
    const owners = computeTownOwners({ ...input, town });
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
        frozenUntil: authorities.frozenUntil,
        shieldUntil: authorities.shieldUntil,
        sickAt,
        dizzyUntil: exposed ? now + 3.2 : player.dizzyUntil,
        immuneUntil: exposed ? now + 9 : player.immuneUntil
    };
}
