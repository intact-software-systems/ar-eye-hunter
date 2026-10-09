import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import type { RallarBlackBoxDistributedGroupAssertion } from '../../../distributed/group-assertions.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRecord } from '../../../rallar-black-box-test-contracts.ts';

import {
    createAlmScaleAcceptanceMetadata,
    createAlmScaleFinalCommands,
    createAlmScaleGroupAssertions,
    createAlmScaleSampler
} from './create-alm-scale-acceptance.ts';
import { createAlmScaleSetupCommands } from './create-alm-scale-setup-commands.ts';
import { createAlmScaleWorkloadCommands } from './create-alm-scale-workload-commands.ts';

export interface AlmScaleRecipeInput {
    readonly participantCount: 15 | 30 | 50;
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly readyTimeoutMs: number;
}

export interface AlmScaleRecipes {
    readonly recipes: readonly RallarBlackBoxTestRecipe[];
    readonly groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[];
    readonly metadata: RallarBlackBoxTestRecord;
}

export function createAlmScaleRecipes(input: AlmScaleRecipeInput): AlmScaleRecipes {
    const groupAssertions = createAlmScaleGroupAssertions(input.participantCount - 1);
    const metadata = {
        ...createAlmScaleAcceptanceMetadata(),
        participantCount: input.participantCount,
        senderCount: 1,
        receiverCount: input.participantCount - 1,
        shotsPerPlayer: 6,
        lifecycleEvents: 2,
        sampleCount: 7,
        intervalMs: 5_000,
        samplingWindowMs: 30_000,
        payloadScope:
            'AR Eye wire fixtures; representative baseline/results identities are fixture facts, not live game authority.',
        acceptanceSources: groupAssertions.map((assertion) => ({
            ...assertion.source,
            role: assertion.scope?.role ?? ''
        }))
    };
    return {
        recipes: (['director', 'player'] as const).map((role) => createRecipe(input, role, metadata)),
        groupAssertions,
        metadata
    };
}

function createRecipe(
    input: AlmScaleRecipeInput,
    role: 'director' | 'player',
    metadata: RallarBlackBoxTestRecord
): RallarBlackBoxTestRecipe {
    const prefix = `alm-scale-${role}`;
    return {
        schemaVersion: 1,
        recipeId: prefix,
        name: `ALM scale ${role}`,
        continueOnFailure: false,
        metadata,
        commands: [
            ...createAlmScaleSetupCommands(input, role),
            {
                kind: 'parallel',
                commandId: `${prefix}-traffic`,
                maxConcurrency: 2,
                failFast: false,
                groups: [
                    { groupId: 'workload', commands: createAlmScaleWorkloadCommands(input, role) },
                    { groupId: 'sampling', commands: [createAlmScaleSampler(prefix)] }
                ]
            },
            ...createAlmScaleFinalCommands(prefix)
        ]
    };
}
