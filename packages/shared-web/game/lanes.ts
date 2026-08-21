import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import type { RallarGameLaneIds, RallarGameLanePresetOptions } from './types.ts';

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
    options: RallarGameLanePresetOptions = {}
): readonly RtcDataChannelLaneConfig[] {
    const laneIds = resolveRallarGameLaneIds(options.laneIds);

    return [
        {
            id: laneIds.input,
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
                maxQueueItems: options.inputMaxQueueItems ?? 16
            }
        },
        {
            id: laneIds.intent,
            label: 'rtc-game-intent',
            init: {
                ordered: true
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 128 * 1024,
                lowWatermarkBytes: 32 * 1024,
                overflow: 'queue',
                maxQueueItems: options.intentMaxQueueItems ?? 128
            }
        },
        {
            id: laneIds.snapshot,
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
                maxQueueItems: options.snapshotMaxQueueItems ?? 8
            }
        },
        {
            id: laneIds.metrics,
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
                maxQueueItems: options.metricsMaxQueueItems ?? 16
            }
        },
        {
            id: laneIds.replication,
            label: 'rtc-game-replication',
            init: {
                ordered: true
            },
            binaryType: 'arraybuffer',
            flowControl: {
                highWatermarkBytes: 256 * 1024,
                lowWatermarkBytes: 64 * 1024,
                overflow: 'queue',
                maxQueueItems: options.replicationMaxQueueItems ?? 256
            }
        }
    ];
}
