import { createViewPushRecipe } from '@shared-test/rallar-bb-test/fixtures/create-view-push-recipe.ts';
import {
    createManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    type HetznerDistributedManifestEntry
} from './hetzner-manifest-entry.ts';

export function createViewPushManifestEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: 'apps/rallar-black-box/manifests/hetzner/24-view-push-2-agent.json',
        title: 'Private view push and reconnect, two agents',
        description:
            'Two fresh accounts observe their own committed view invalidations, then recover offline changes through canonical reads after reconnect.',
        distributedRunId: 'hetzner-view-push-2-agent',
        recipes: [createViewPushRecipe(HETZNER_DISTRIBUTED_MANIFEST_GROUP)],
        agentCount: 2,
        profiles: ['ws', 'view-push', 'recovery', 'extended'],
        live: true,
        targetAgentIds: [],
        targetPolicyMode: 'all-online-group-members',
        rolePattern: 'all-agents',
        mainline: false,
        diagnostic: false,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: [],
        metadata: { freshAgentsRequired: true }
    });
}
