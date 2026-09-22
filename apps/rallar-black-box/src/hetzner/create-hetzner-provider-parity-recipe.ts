import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { createRallarBlackBoxProviderParityLiveRecipe } from '@shared-test/rallar-bb-test/fixtures/rtc-live-recipes.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const OMITTED_DEMO_CREDENTIAL_KEYS = new Set([
    'username',
    'password',
    'token',
    'restoreSession'
]);

export function createHetznerProviderParityRecipe(
    group: RallarBlackBoxDistributedGroupRef
): RallarBlackBoxTestRecipe {
    const recipe = toRecipeWithoutDemoCredentials(createRallarBlackBoxProviderParityLiveRecipe({
        group,
        readyPeerCount: 1,
        readyTimeoutMs: 10_000
    }));
    const holdIndex = resolveOverlapHoldIndex(recipe);

    return {
        ...recipe,
        commands: [
            ...recipe.commands.slice(0, holdIndex),
            {
                kind: 'loop',
                commandId: 'parity-peer-overlap-hold',
                durationMs: 12_000,
                intervalMs: 1_000,
                maxCommands: 12,
                metadata: {
                    purpose: 'keep-all-parity-peers-online-through-connect-readiness'
                },
                commands: [
                    {
                        kind: 'health',
                        commandId: 'parity-peer-overlap-health'
                    }
                ]
            },
            ...recipe.commands.slice(holdIndex)
        ]
    };
}

/**
 * The peers must stay online until the runtime closes, so the hold goes immediately before the
 * close, or at the end of a recipe that does not close.
 */
function resolveOverlapHoldIndex(recipe: RallarBlackBoxTestRecipe): number {
    const closeIndex = recipe.commands.findIndex((command) => command.kind === 'close');
    return closeIndex < 0 ? recipe.commands.length : closeIndex;
}

function toRecipeWithoutDemoCredentials(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    return {
        ...recipe,
        commands: recipe.commands.map((command) => {
            if (command.kind !== 'configure' || command.config.rallar === undefined) {
                return command;
            }
            return {
                ...command,
                config: {
                    ...command.config,
                    rallar: Object.fromEntries(
                        Object.entries(command.config.rallar).filter(
                            ([key]) => !OMITTED_DEMO_CREDENTIAL_KEYS.has(key)
                        )
                    )
                }
            };
        })
    };
}
