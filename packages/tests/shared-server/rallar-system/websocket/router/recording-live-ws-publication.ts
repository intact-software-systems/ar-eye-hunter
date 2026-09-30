import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { RallarServerWsRouterOptions } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';

export interface RecordingLiveWsPublication {
    readonly livePublication: NonNullable<RallarServerWsRouterOptions['livePublication']>;
    readonly notices: readonly LiveWsNotice[];
}

export function createRecordingLiveWsPublication(): RecordingLiveWsPublication {
    const notices: LiveWsNotice[] = [];
    return {
        notices,
        livePublication: {
            transport: {
                publish: async (notice) => {
                    notices.push(notice);
                },
                subscribe: async () => {}
            },
            channel: 'ws-channel',
            publisherId: 'server-a'
        }
    };
}
