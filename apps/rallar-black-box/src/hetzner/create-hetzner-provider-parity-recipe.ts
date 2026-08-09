import type {
    RallarBlackBoxDistributedGroupRef,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import {
    createRallarBlackBoxProviderParityLiveRecipe,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';

const OMITTED_DEMO_CREDENTIAL_KEYS = new Set([
    'username',
    'password',
    'token',
    'restoreSession',
]);

export function createHetznerProviderParityRecipe(
    group: RallarBlackBoxDistributedGroupRef,
): RallarBlackBoxTestRecipe {
    const recipe = withoutDemoCredentials(createRallarBlackBoxProviderParityLiveRecipe({
        group,
        readyPeerCount: 1,
        readyTimeoutMs: 10_000,
    }));
    const closeIndex = recipe.commands.findIndex(command => command.kind === 'close');
    if (closeIndex < 0) {
        throw new Error('Provider parity recipe must close its browser runtime.');
    }

    return {
        ...recipe,
        commands: [
            ...recipe.commands.slice(0, closeIndex),
            {
                kind: 'loop',
                commandId: 'parity-peer-overlap-hold',
                durationMs: 12_000,
                intervalMs: 1_000,
                maxCommands: 12,
                metadata: {
                    purpose: 'keep-all-parity-peers-online-through-connect-readiness',
                },
                commands: [
                    {
                        kind: 'health',
                        commandId: 'parity-peer-overlap-health',
                    },
                ],
            },
            ...recipe.commands.slice(closeIndex),
        ],
    };
}

function withoutDemoCredentials(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestRecipe {
    return {
        ...recipe,
        commands: recipe.commands.map(command => {
            if (command.kind !== 'configure' || command.config.rallar === undefined) {
                return command;
            }
            return {
                ...command,
                config: {
                    ...command.config,
                    rallar: Object.fromEntries(
                        Object.entries(command.config.rallar).filter(
                            ([key]) => !OMITTED_DEMO_CREDENTIAL_KEYS.has(key),
                        ),
                    ),
                },
            };
        }),
    };
}
