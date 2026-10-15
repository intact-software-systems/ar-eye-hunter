import { createAlmScaleRecipes } from '@shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-recipes.ts';
import type { RallarBlackBoxTestRecord } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    createManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    toControllerAgentIds,
    type HetznerDistributedManifestEntry
} from './hetzner-manifest-entry.ts';

interface AlmScaleManifestInput {
    readonly participantCount: 6 | 11 | 15 | 30 | 50;
    readonly filePath: string;
    readonly diagnostic: boolean;
}

export function createAlmScaleManifestEntries(): readonly HetznerDistributedManifestEntry[] {
    return ([15, 30, 50] as const).map((participantCount, index) =>
        createAlmScaleManifestEntry({
            participantCount,
            filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[18 + index]!,
            diagnostic: false
        })
    );
}

export function createAlmScaleDiagnosticEntries(): readonly HetznerDistributedManifestEntry[] {
    return ([6, 11] as const).map((participantCount) =>
        createAlmScaleManifestEntry({
            participantCount,
            filePath:
                `apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-${participantCount}-agent-30s.json`,
            diagnostic: true
        })
    );
}

function createAlmScaleManifestEntry(input: AlmScaleManifestInput): HetznerDistributedManifestEntry {
    const scale = createAlmScaleRecipes({
        participantCount: input.participantCount,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        readyTimeoutMs: 45_000,
        almDiagnostics: input.diagnostic
    });
    return createManifestEntry({
        filePath: input.filePath,
        title: `ALM conformance ${input.participantCount}-agent 30s${input.diagnostic ? ' diagnostic' : ''}`,
        description:
            `${input.diagnostic ? 'Diagnostic: ' : ''}One director and ${
                input.participantCount - 1
            } players send reliable AR Eye match payloads ` +
            'within a 30-second workload deadline, with seven bounded ALM samples and native per-agent delivery evidence.',
        distributedRunId: `hetzner-alm-conformance-${input.participantCount}-agent-30s`,
        recipes: scale.recipes,
        agentCount: input.participantCount,
        profiles: [
            'alm',
            'messages.rtc',
            'match-payloads',
            'tree',
            `${input.participantCount}-agent`,
            input.diagnostic ? 'diagnostic' : 'extended'
        ],
        live: true,
        targetAgentIds: toControllerAgentIds(input.participantCount),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        mainline: false,
        diagnostic: input.diagnostic,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: scale.groupAssertions,
        metadata: toAlmScaleManifestMetadata(scale.metadata, input.participantCount)
    });
}

function toAlmScaleManifestMetadata(
    scaleMetadata: RallarBlackBoxTestRecord,
    participantCount: number
): RallarBlackBoxTestRecord {
    const { receiverCount, shotsPerPlayer, lifecycleEvents, workloadWindowMs } = scaleMetadata;
    if (
        typeof receiverCount !== 'number' || typeof shotsPerPlayer !== 'number' ||
        typeof lifecycleEvents !== 'number' || typeof workloadWindowMs !== 'number'
    ) {
        throw new Error('ALM scale fixture metadata must declare its workload counts.');
    }
    return {
        family: 'alm-scale',
        topologyProfile: 'tree',
        transport: 'messages.rtc',
        participantCount: scaleMetadata.participantCount,
        senderCount: scaleMetadata.senderCount,
        receiverCount,
        expectedDurationSeconds: workloadWindowMs / 1_000,
        recommendedTerminalTimeoutSeconds: 330,
        rtcTopologyEnv: { RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: String(participantCount + 1) },
        loadEstimate: { logicalFanoutMessages: receiverCount * (shotsPerPlayer + lifecycleEvents) },
        almMetrics: scaleMetadata
    };
}
