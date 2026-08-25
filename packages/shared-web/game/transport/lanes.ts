import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

export interface RallarGameLaneIds {
    readonly input: string;
    readonly intent: string;
    readonly snapshot: string;
    readonly metrics: string;
    readonly replication: string;
}

export interface RallarGameLanePresetConfig {
    readonly laneIds: RallarGameLaneIds;
    readonly inputMaxQueueItems: number;
    readonly snapshotMaxQueueItems: number;
    readonly metricsMaxQueueItems: number;
    readonly intentMaxQueueItems: number;
    readonly replicationMaxQueueItems: number;
}

export const DEFAULT_RALLAR_GAME_LANE_IDS: RallarGameLaneIds = {
    input: 'game-input',
    intent: 'game-intent',
    snapshot: 'game-snapshot',
    metrics: 'game-metrics',
    replication: 'game-replication'
};

export function resolveRallarGameLaneIds(
    laneIds: Partial<RallarGameLaneIds> = {}
): RallarGameLaneIds {
    return {
        ...DEFAULT_RALLAR_GAME_LANE_IDS,
        ...laneIds
    };
}

export function createRallarGameLanePresets(
    config: RallarGameLanePresetConfig
): readonly RtcDataChannelLaneConfig[] {
    return [
        {
            id: config.laneIds.input,
            label: 'rtc-game-input',
            init: {
                ordered: false,
                maxRetransmits: 0
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 32 * 1024,
                lowWatermarkBytes: 8 * 1024,
                overflow: 'replace-by-key',
                maxQueueItems: config.inputMaxQueueItems
            }
        },
        {
            id: config.laneIds.intent,
            label: 'rtc-game-intent',
            init: {
                ordered: true
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 128 * 1024,
                lowWatermarkBytes: 32 * 1024,
                overflow: 'queue',
                maxQueueItems: config.intentMaxQueueItems
            }
        },
        {
            id: config.laneIds.snapshot,
            label: 'rtc-game-snapshot',
            init: {
                ordered: false,
                maxRetransmits: 0
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 64 * 1024,
                lowWatermarkBytes: 16 * 1024,
                overflow: 'replace-by-key',
                maxQueueItems: config.snapshotMaxQueueItems
            }
        },
        {
            id: config.laneIds.metrics,
            label: 'rtc-game-metrics',
            init: {
                ordered: false,
                maxRetransmits: 0
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 16 * 1024,
                lowWatermarkBytes: 4 * 1024,
                overflow: 'drop-old',
                maxQueueItems: config.metricsMaxQueueItems
            }
        },
        {
            id: config.laneIds.replication,
            label: 'rtc-game-replication',
            init: {
                ordered: true
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 256 * 1024,
                lowWatermarkBytes: 64 * 1024,
                overflow: 'queue',
                maxQueueItems: config.replicationMaxQueueItems
            }
        }
    ];
}

export function createDefaultRallarGameLanePresets(): readonly RtcDataChannelLaneConfig[] {
    return createRallarGameLanePresets({
        laneIds: DEFAULT_RALLAR_GAME_LANE_IDS,
        inputMaxQueueItems: 16,
        intentMaxQueueItems: 128,
        snapshotMaxQueueItems: 8,
        metricsMaxQueueItems: 16,
        replicationMaxQueueItems: 256
    });
}
