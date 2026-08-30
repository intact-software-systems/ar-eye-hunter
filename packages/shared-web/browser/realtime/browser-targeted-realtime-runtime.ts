import type {
    RallarRealtimeHandler,
    RallarRealtimeJsonSendInput,
    RallarRealtimeSendResult,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetedChannelSendOptions,
    RallarTargetedSendStatus,
    RallarTargetSelector
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export namespace BrowserTargetedRealtimeRuntime {
    export interface Input {
        readSession(): AuthSession | undefined;
        readDefaultRoom(): string | GroupRef | undefined;
        readCurrentRoomRef(): GroupRef | undefined;
        resolveRoomTransportTarget(room: string | GroupRef): BrowserRoomTransportTarget;
        resolveLaneId(laneId?: string): string;
        sendJson<T>(input: RallarRealtimeJsonSendInput<T>): Promise<readonly RallarRealtimeSendResult[]>;
        onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    }
}

/** Owns fixed/live targeted peer selection and targeted realtime channels. */
export class BrowserTargetedRealtimeRuntime {
    private readonly input: BrowserTargetedRealtimeRuntime.Input;

    constructor(input: BrowserTargetedRealtimeRuntime.Input) {
        this.input = input;
    }

    resolvePeerIds(input: RallarTargetSelector = {}): readonly string[] {
        const sessionId = this.input.readSession()?.sessionId;
        const explicitPeerIds = input.peerIds ?? (input.peerId ? [input.peerId] : undefined);
        if (explicitPeerIds) {
            return [...new Set(explicitPeerIds)].filter((peerId) => peerId !== sessionId);
        }
        const room = input.roomRef ?? input.roomId ?? this.input.readDefaultRoom() ??
            this.input.readCurrentRoomRef();
        if (!room) {
            return [];
        }
        const target = this.input.resolveRoomTransportTarget(room);
        return target.transportState === 'halted' ? [] : target.peerIds;
    }

    create<T>(definition: RallarTargetedChannelDefinition): RallarTargetedChannel<T> {
        const fixedPeerIds = definition.membership === 'live'
            ? undefined
            : this.resolvePeerIds(definition);
        const defaultLaneId = this.input.resolveLaneId(definition.laneId);
        const resolvePeerIds = (options: RallarTargetSelector = {}): readonly string[] => {
            if (fixedPeerIds && !hasTargetSelectorOverride(options)) {
                return fixedPeerIds;
            }
            return this.resolvePeerIds({ ...definition, ...options });
        };
        return {
            send: async (data, options: RallarTargetedChannelSendOptions<T> = {}) => {
                const laneId = this.input.resolveLaneId(options.laneId ?? definition.laneId);
                const peerIds = resolvePeerIds(options);
                if (peerIds.length === 0) {
                    return {
                        transport: 'rtc',
                        status: 'no-targets',
                        laneId,
                        peerIds,
                        results: [],
                        reason: 'No target RTC peers resolved.'
                    };
                }
                const results = await this.input.sendJson<T>({
                    ...definition,
                    ...options,
                    laneId,
                    peerIds,
                    data
                });
                return {
                    transport: 'rtc',
                    status: toTargetedSendStatus(peerIds, results),
                    laneId,
                    peerIds,
                    results
                };
            },
            on: (handler) => this.input.onJson<T>(defaultLaneId, handler),
            peerIds: resolvePeerIds
        };
    }
}

function hasTargetSelectorOverride(input: RallarTargetSelector): boolean {
    return input.peerId !== undefined || input.peerIds !== undefined ||
        input.roomId !== undefined || input.roomRef !== undefined ||
        input.membership !== undefined;
}

function toTargetedSendStatus(
    peerIds: readonly string[],
    results: readonly RallarRealtimeSendResult[]
): RallarTargetedSendStatus {
    if (peerIds.length === 0) {
        return 'no-targets';
    }
    const sentCount = results.filter((result) =>
        result.result.status === 'sent' || result.result.status === 'queued' ||
        result.result.status === 'replaced'
    ).length;
    if (sentCount === peerIds.length) {
        return 'sent';
    }
    return sentCount > 0 ? 'partial' : 'failed';
}
