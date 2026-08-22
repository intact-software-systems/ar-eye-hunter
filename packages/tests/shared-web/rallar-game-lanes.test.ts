import { createRallarGameLanePresets, DEFAULT_RALLAR_GAME_LANE_IDS, resolveRallarGameLaneIds } from '@shared-web/game/mod.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar Game lane presets', () => {
    it('uses stable default lane IDs', () => {
        expect(DEFAULT_RALLAR_GAME_LANE_IDS).toEqual({
            input: 'game-input',
            intent: 'game-intent',
            snapshot: 'game-snapshot',
            metrics: 'game-metrics',
            replication: 'game-replication'
        });
    });

    it('produces exact V1 lane reliability and flow-control presets', () => {
        expect(createRallarGameLanePresets()).toEqual([
            {
                id: 'game-input',
                label: 'rtc-game-input',
                init: { ordered: false, maxRetransmits: 0 },
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 32 * 1024,
                    lowWatermarkBytes: 8 * 1024,
                    overflow: 'replace-by-key',
                    maxQueueItems: 16
                }
            },
            {
                id: 'game-intent',
                label: 'rtc-game-intent',
                init: { ordered: true },
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 128 * 1024,
                    lowWatermarkBytes: 32 * 1024,
                    overflow: 'queue',
                    maxQueueItems: 128
                }
            },
            {
                id: 'game-snapshot',
                label: 'rtc-game-snapshot',
                init: { ordered: false, maxRetransmits: 0 },
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 64 * 1024,
                    lowWatermarkBytes: 16 * 1024,
                    overflow: 'replace-by-key',
                    maxQueueItems: 8
                }
            },
            {
                id: 'game-metrics',
                label: 'rtc-game-metrics',
                init: { ordered: false, maxRetransmits: 0 },
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 16 * 1024,
                    lowWatermarkBytes: 4 * 1024,
                    overflow: 'drop-old',
                    maxQueueItems: 16
                }
            },
            {
                id: 'game-replication',
                label: 'rtc-game-replication',
                init: { ordered: true },
                binaryType: 'arraybuffer',
                flowControl: {
                    highWatermarkBytes: 256 * 1024,
                    lowWatermarkBytes: 64 * 1024,
                    overflow: 'queue',
                    maxQueueItems: 256
                }
            }
        ]);
    });

    it('allows lane IDs and queue budgets to be overridden without changing roles', () => {
        expect(
            createRallarGameLanePresets({
                laneIds: {
                    input: 'cash-input',
                    snapshot: 'cash-snapshot'
                },
                inputMaxQueueItems: 4
            })[0]
        ).toMatchObject({
            id: 'cash-input',
            label: 'rtc-game-input',
            flowControl: {
                overflow: 'replace-by-key',
                maxQueueItems: 4
            }
        });

        expect(resolveRallarGameLaneIds({ metrics: 'cash-metrics' })).toEqual({
            input: 'game-input',
            intent: 'game-intent',
            snapshot: 'game-snapshot',
            metrics: 'cash-metrics',
            replication: 'game-replication'
        });
    });
});
