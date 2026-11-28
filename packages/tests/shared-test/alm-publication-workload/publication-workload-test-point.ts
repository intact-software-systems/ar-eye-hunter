import {
    createPublicationWorkloadRecipes,
    type PublicationWorkloadRoleRecipe,
    type PublicationWorkloadRoomRecipes
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/create-publication-workload-recipes.ts';
import type { PublicationWorkloadParameters } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/mod.ts';

export const GROUP = { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' };

/**
 * One room of three agents, one of them sending every 500 ms for 30 seconds on rtc: 30,000 / 500 = 60 frames, and 95 %
 * of 60 is 57 for both ratios.
 */
export const POINT: PublicationWorkloadParameters = {
    groups: [GROUP],
    participantCount: 3,
    publisherCount: 1,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 30_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.95,
    readyTimeoutMs: 45_000,
    loss: { kind: 'none' }
};

/** `{"seq":60,"sentAtEpochMs":9999999999999,"pad":""}` is 49 bytes, so 256 bytes take 207 of filler. */
export const FILLER = 'x'.repeat(207);

export const FRAME_TYPE_ID = 'room.publication-workload.frame.v1';

/** The conformance lane's seeded loss: a quarter of the frames, from seed 7. */
export const QUARTER_LOSS = { kind: 'seeded', ratio: 0.25, seed: 7 } as const;

/** The point on ws under that loss: seed 7 drops 18 of the 60 frames, so a subscriber expects 42 and counts 40. */
export const WS_LOSS_POINT: PublicationWorkloadParameters = { ...POINT, carrier: 'ws', loss: QUARTER_LOSS };

export function createRooms(parameters: PublicationWorkloadParameters): readonly PublicationWorkloadRoomRecipes[] {
    const created = createPublicationWorkloadRecipes(parameters);
    if (created.right === undefined) {
        throw new Error(`The point is not valid: ${JSON.stringify(created.left)}`);
    }
    return created.right.rooms;
}

/** The roles of the point's first room, in the order the family gives them. */
export function createRoles(parameters: PublicationWorkloadParameters): readonly PublicationWorkloadRoleRecipe[] {
    return createRooms(parameters)[0].roles;
}

/** The first room's publisher that writes the group, and its subscriber. */
export function createRecipes(
    parameters: PublicationWorkloadParameters
): Readonly<Record<'publisher' | 'subscriber', PublicationWorkloadRoleRecipe>> {
    const roles = createRoles(parameters);
    const publisher = roles.find((role) => role.kind === 'publisher');
    const subscriber = roles.find((role) => role.kind === 'subscriber');
    if (publisher === undefined || subscriber === undefined) {
        throw new Error(`The room holds no publisher or no subscriber: ${roles.map((role) => role.kind).join(', ')}`);
    }
    return { publisher, subscriber };
}

/** The commands a role runs after the barrier `afterBarrierId`, to the end of its recipe. */
export function toCommandsAfterBarrier(
    recipe: RallarBlackBoxTestRecipe,
    afterBarrierId: string
): readonly RallarBlackBoxTestCommand[] {
    const start = recipe.commands.findIndex((command) => command.kind === 'barrier' && command.barrierId === afterBarrierId);
    if (start < 0) {
        throw new Error(`The recipe ${recipe.recipeId} holds no barrier ${afterBarrierId}.`);
    }
    return recipe.commands.slice(start + 1);
}
