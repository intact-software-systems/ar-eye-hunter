import {
    createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe,
    createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes,
    type RallarBlackBoxRtcMessagesMulticastRecipeOptions
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { HetznerDistributedManifestEntry, ManifestCatalogInput } from './hetzner-manifest-entry.ts';
import {
    createManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    toControllerAgentIds,
    toMulticastManifestMetadata
} from './hetzner-manifest-entry.ts';

export function createDiagnosticRtcMessagesPrincipal50Agent60m20hzTreeEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath:
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json',
        title: 'RTC messages principal 50-agent 60m 20 Hz tree diagnostic',
        description: 'Long diagnostic principal RTC messages multicast run for 60-minute tree soak validation.',
        distributedRunId: 'hetzner-diagnostic-rtc-messages-principal-50-agent-60m-20hz-tree',
        recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 3_600,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                progressEveryMs: 30_000,
                sampleEvery: 100,
                drainTimeoutMs: 30_000,
                maxDroppedFrames: 3_600,
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: 50,
        profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'tree', 'long', 'diagnostic'],
        live: true,
        targetAgentIds: toControllerAgentIds(50),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        diagnostic: true,
        stress: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: 50,
            senderCount: 1,
            durationSeconds: 3_600,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: 72_000,
            recommendedTerminalTimeoutSeconds: 3_900
        })
    });
}

export function createDiagnosticRtcMessagesAllPeer50Agent30s20hzTreeEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath:
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-30s-20hz-tree.json',
        title: 'RTC messages all-peer 50-agent 30s 20 Hz tree diagnostic',
        description: 'Diagnostic 50-agent all-peer RTC messages multicast at 20 Hz through a forced tree topology.',
        distributedRunId: 'hetzner-diagnostic-rtc-messages-all-peer-50-agent-30s-20hz-tree',
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.8,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000
        }),
        agentCount: 50,
        profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'diagnostic'],
        live: true,
        diagnostic: true,
        stress: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: 50,
            senderCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.8,
            receiverExpectedFrames: 29_400,
            recommendedTerminalTimeoutSeconds: 330
        })
    });
}

export function createRtcMessagesAllPeer50Agent30s5hzTreeEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[8],
        title: 'RTC messages all-peer 50-agent 30s 5 Hz tree',
        description: 'All 50 headless peers multicast RTC messages at 5 Hz through a forced tree topology.',
        distributedRunId: 'hetzner-rtc-messages-all-peer-50-agent-30s-5hz-tree',
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: 50,
        profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'extended'],
        live: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: 50,
            senderCount: 50,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            receiverExpectedFrames: 7_350,
            recommendedTerminalTimeoutSeconds: 330
        })
    });
}

export function createRtcMessagesPrincipal50Agent30s20hzMeshEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[7],
        title: 'RTC messages principal 50-agent 30s 20 Hz mesh',
        description:
            'One principal headless sender multicasts RTC messages at 20 Hz to 49 receivers through the default mesh topology.',
        distributedRunId: 'hetzner-rtc-messages-principal-50-agent-30s-20hz-mesh',
        recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: 50,
        profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'mesh', 'extended'],
        live: true,
        targetAgentIds: toControllerAgentIds(50),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'mesh',
            participantCount: 50,
            senderCount: 1,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: 600,
            recommendedTerminalTimeoutSeconds: 330
        })
    });
}

export function createRtcMessagesPrincipal50Agent30s20hzTreeEntry(): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath: HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[6],
        title: 'RTC messages principal 50-agent 30s 20 Hz tree',
        description:
            'One principal headless sender multicasts RTC messages at 20 Hz to 49 receivers through a forced tree topology.',
        distributedRunId: 'hetzner-rtc-messages-principal-50-agent-30s-20hz-tree',
        recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount: 50,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: 50,
        profiles: [
            'rtc',
            'messages.rtc',
            'principal',
            'multicast',
            'tree',
            '50-agent',
            'github-free-smoke',
            'extended'
        ],
        live: true,
        targetAgentIds: toControllerAgentIds(50),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: 50,
            senderCount: 1,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: 600,
            recommendedTerminalTimeoutSeconds: 330,
            catalogProfiles: ['github-free-smoke', '50-agent', 'tree']
        })
    });
}

export function createLongAllPeerEntry(rateHz: number): HetznerDistributedManifestEntry {
    return createManifestEntry({
        filePath:
            `apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-all-peer-50-agent-60m-${rateHz}hz-tree.json`,
        title: `RTC messages all-peer 50-agent 60m ${rateHz} Hz tree diagnostic`,
        description:
            `Long diagnostic all-peer RTC messages multicast run at ${rateHz} Hz for 60-minute tree soak validation.`,
        distributedRunId: `hetzner-diagnostic-rtc-messages-all-peer-50-agent-60m-${rateHz}hz-tree`,
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount: 50,
            durationSeconds: 3_600,
            rateHz,
            minReceiveRatio: rateHz === 20 ? 0.8 : rateHz === 10 ? 0.85 : 0.9,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                progressEveryMs: 30_000,
                sampleEvery: 100,
                drainTimeoutMs: 30_000,
                maxDroppedFrames: Math.ceil(3_600 * rateHz * 0.05),
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: 50,
        profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'long', 'diagnostic'],
        live: true,
        diagnostic: true,
        stress: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: 50,
            senderCount: 50,
            durationSeconds: 3_600,
            rateHz,
            minReceiveRatio: rateHz === 20 ? 0.8 : rateHz === 10 ? 0.85 : 0.9,
            receiverExpectedFrames: 49 * 3_600 * rateHz,
            recommendedTerminalTimeoutSeconds: 4_200
        })
    });
}

function createPrincipalTreeAlternative(
    input: {
        readonly participantCount: number;
        readonly principalTreePath: string;
        readonly principalRecipes: readonly RallarBlackBoxTestRecipe[];
        readonly principalMetadata: Readonly<{
            participantCount: number;
            senderCount: 1;
            durationSeconds: 30;
            rateHz: 20;
            minReceiveRatio: 0.95;
            receiverExpectedFrames: 600;
            recommendedTerminalTimeoutSeconds: 330;
        }>;
    }
): HetznerDistributedManifestEntry {
    const { participantCount, principalTreePath, principalRecipes, principalMetadata } = input;
    return createManifestEntry({
        filePath: principalTreePath,
        title: `RTC messages principal ${participantCount}-agent 30s 20 Hz tree`,
        description: `One principal headless sender multicasts RTC messages at 20 Hz to ${
            participantCount - 1
        } receivers through a forced tree topology.`,
        distributedRunId: `hetzner-rtc-messages-principal-${participantCount}-agent-30s-20hz-tree`,
        recipes: principalRecipes,
        agentCount: participantCount,
        profiles: [
            'rtc',
            'messages.rtc',
            'principal',
            'multicast',
            'tree',
            `${participantCount}-agent`,
            'github-free-smoke',
            'extended'
        ],
        live: true,
        targetAgentIds: toControllerAgentIds(participantCount),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            treeMeshMinSize: participantCount + 1,
            ...principalMetadata,
            catalogProfiles: ['github-free-smoke', `${participantCount}-agent`, 'tree']
        })
    });
}

function createPrincipalMeshAlternative(
    input: {
        readonly participantCount: number;
        readonly principalMeshPath: string;
        readonly principalRecipes: readonly RallarBlackBoxTestRecipe[];
        readonly principalMetadata: Readonly<{
            participantCount: number;
            senderCount: 1;
            durationSeconds: 30;
            rateHz: 20;
            minReceiveRatio: 0.95;
            receiverExpectedFrames: 600;
            recommendedTerminalTimeoutSeconds: 330;
        }>;
    }
): HetznerDistributedManifestEntry {
    const { participantCount, principalMeshPath, principalRecipes, principalMetadata } = input;
    return createManifestEntry({
        filePath: principalMeshPath,
        title: `RTC messages principal ${participantCount}-agent 30s 20 Hz mesh`,
        description: `One principal headless sender multicasts RTC messages at 20 Hz to ${
            participantCount - 1
        } receivers through the default mesh topology.`,
        distributedRunId: `hetzner-rtc-messages-principal-${participantCount}-agent-30s-20hz-mesh`,
        recipes: principalRecipes,
        agentCount: participantCount,
        profiles: ['rtc', 'messages.rtc', 'principal', 'multicast', 'mesh', 'extended'],
        live: true,
        targetAgentIds: toControllerAgentIds(participantCount),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'mesh',
            ...principalMetadata
        })
    });
}

function createAllPeerTreeAlternative(
    input: { readonly participantCount: number; readonly allPeerTreePath: string; }
): HetznerDistributedManifestEntry {
    const { participantCount, allPeerTreePath } = input;
    return createManifestEntry({
        filePath: allPeerTreePath,
        title: `RTC messages all-peer ${participantCount}-agent 30s 5 Hz tree`,
        description:
            `All ${participantCount} headless peers multicast RTC messages at 5 Hz through a forced tree topology.`,
        distributedRunId: `hetzner-rtc-messages-all-peer-${participantCount}-agent-30s-5hz-tree`,
        recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe({
            participantCount,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        }),
        agentCount: participantCount,
        profiles: ['rtc', 'messages.rtc', 'all-peer', 'multicast', 'tree', 'extended'],
        live: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            treeMeshMinSize: participantCount + 1,
            participantCount,
            senderCount: participantCount,
            durationSeconds: 30,
            rateHz: 5,
            minReceiveRatio: 0.9,
            receiverExpectedFrames: (participantCount - 1) * 30 * 5,
            recommendedTerminalTimeoutSeconds: 330
        })
    });
}

const RTC_MESSAGES_MATRIX_AGENT_COUNTS = [10, 15, 20, 30] as const;

const RTC_MESSAGES_MATRIX_DURATION_SECONDS = [30, 300] as const;

const RTC_MESSAGES_MATRIX_RATE_HZ = [10, 20] as const;

const RTC_MESSAGES_MATRIX_PROFILES = ['principal', 'all-peer'] as const;

const RTC_MESSAGES_MAINLINE_ALTERNATIVE_AGENT_COUNTS = [15, 30] as const;

export function createRtcMessagesMainlineAlternativeEntries(): readonly HetznerDistributedManifestEntry[] {
    return RTC_MESSAGES_MAINLINE_ALTERNATIVE_AGENT_COUNTS.flatMap((participantCount) => {
        const pathOffset = participantCount === 15 ? 9 : 12;
        const [principalTreePath, principalMeshPath, allPeerTreePath] = [
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset]!,
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset + 1]!,
            HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[pathOffset + 2]!
        ];
        const principalRecipes = createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes({
            participantCount,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
            readyTimeoutMs: 45_000,
            stream: {
                maxP95SendDurationMs: 2_500,
                maxP99SendDurationMs: 4_000
            }
        });
        const principalMetadata = {
            participantCount,
            senderCount: 1,
            durationSeconds: 30,
            rateHz: 20,
            minReceiveRatio: 0.95,
            receiverExpectedFrames: 600,
            recommendedTerminalTimeoutSeconds: 330
        } as const;

        return [
            createPrincipalTreeAlternative({
                participantCount,
                principalTreePath,
                principalRecipes,
                principalMetadata
            }),
            createPrincipalMeshAlternative({
                participantCount,
                principalMeshPath,
                principalRecipes,
                principalMetadata
            }),
            createAllPeerTreeAlternative({ participantCount, allPeerTreePath })
        ];
    });
}

export function createRtcMessagesMediumScaleMatrixEntries(): readonly HetznerDistributedManifestEntry[] {
    return RTC_MESSAGES_MATRIX_AGENT_COUNTS.flatMap((participantCount) =>
        RTC_MESSAGES_MATRIX_DURATION_SECONDS.flatMap((durationSeconds) =>
            RTC_MESSAGES_MATRIX_RATE_HZ.flatMap((rateHz) =>
                RTC_MESSAGES_MATRIX_PROFILES.map((profile) =>
                    createRtcMessagesMatrixEntry({
                        profile,
                        participantCount,
                        durationSeconds,
                        rateHz
                    })
                )
            )
        )
    );
}

function createRtcMessagesMatrixEntry(
    input: RtcMessagesMatrixInput
): HetznerDistributedManifestEntry {
    const label = toDurationLabel(input.durationSeconds);
    const minReceiveRatio = input.profile === 'principal'
        ? 0.95
        : input.rateHz === 20
        ? 0.8
        : 0.85;
    const senderCount = input.profile === 'principal' ? 1 : input.participantCount;
    const receiverExpectedFrames = input.profile === 'principal'
        ? input.durationSeconds * input.rateHz
        : (input.participantCount - 1) * input.durationSeconds * input.rateHz;
    const stream = toStreamOptionsForRtcMessagesMatrix(input.durationSeconds, input.rateHz);
    const baseInput = {
        participantCount: input.participantCount,
        durationSeconds: input.durationSeconds,
        rateHz: input.rateHz,
        minReceiveRatio,
        group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
        readyTimeoutMs: 45_000,
        stream
    };
    const roleFields = toRtcMessagesMatrixRoles(input, baseInput);

    return createManifestEntry({
        filePath:
            `apps/rallar-black-box/manifests/hetzner/diagnostic/matrix/rtc-messages-${input.profile}-${input.participantCount}-agent-${label}-${input.rateHz}hz-tree.json`,
        title:
            `RTC messages ${input.profile} ${input.participantCount}-agent ${label} ${input.rateHz} Hz tree diagnostic`,
        description:
            `Diagnostic ${input.participantCount}-agent ${input.profile} RTC messages multicast run at ${input.rateHz} Hz for ${label} through a forced tree topology.`,
        distributedRunId:
            `hetzner-diagnostic-rtc-messages-${input.profile}-${input.participantCount}-agent-${label}-${input.rateHz}hz-tree`,
        ...roleFields,
        agentCount: input.participantCount,
        profiles: ['rtc', 'messages.rtc', input.profile, 'multicast', 'tree', 'matrix', 'diagnostic'],
        live: true,
        diagnostic: true,
        stress: true,
        barrier: true,
        metadata: toMulticastManifestMetadata({
            topologyProfile: 'tree',
            participantCount: input.participantCount,
            senderCount,
            durationSeconds: input.durationSeconds,
            rateHz: input.rateHz,
            minReceiveRatio,
            receiverExpectedFrames,
            recommendedTerminalTimeoutSeconds: input.durationSeconds + 300
        })
    });
}

function toStreamOptionsForRtcMessagesMatrix(
    durationSeconds: number,
    rateHz: number
): RallarBlackBoxRtcMessagesMulticastRecipeOptions['stream'] {
    return {
        ...(durationSeconds >= 300
            ? {
                progressEveryMs: 30_000,
                sampleEvery: 100,
                drainTimeoutMs: 30_000
            }
            : {}),
        maxDroppedFrames: Math.ceil(durationSeconds * rateHz * 0.05),
        maxP95SendDurationMs: 2_500,
        maxP99SendDurationMs: 4_000
    };
}

function toDurationLabel(seconds: number): string {
    return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

interface RtcMessagesMatrixInput {
readonly profile: typeof RTC_MESSAGES_MATRIX_PROFILES[number];
readonly participantCount: number;
readonly durationSeconds: number;
readonly rateHz: number;
}

function toRtcMessagesMatrixRoles(
    input: RtcMessagesMatrixInput,
    baseInput: RallarBlackBoxRtcMessagesMulticastRecipeOptions
): Pick<ManifestCatalogInput, 'recipe' | 'recipes' | 'targetAgentIds' | 'targetPolicyMode' | 'rolePattern'> {
    return input.profile === 'principal'
        ? {
            recipes: createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes(baseInput),
            targetAgentIds: toControllerAgentIds(input.participantCount),
            targetPolicyMode: 'role-map' as const,
            rolePattern: 'one-sender-many-receivers' as const
        }
        : {
            recipe: createRallarBlackBoxRtcMessagesAllPeerMulticastRecipe(baseInput)
        };
}
