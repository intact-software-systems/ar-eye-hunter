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
import { isAcceptedRealtimeSendResult } from '@shared-web/browser/realtime/browser-realtime-send-runtime.ts';
import type { BrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export namespace BrowserTargetedRealtimeRuntime {
    export interface Input {
        readSession(): AuthSession | undefined;
        readDefaultRoom(): string | GroupRef | undefined;
        readCurrentRoomRef(): GroupRef | undefined;
        resolveRoomRef(room: string | GroupRef): GroupRef | undefined;
        resolveRoomTransportTarget(room: string | GroupRef): BrowserRoomTransportTarget;
        resolveLaneId(laneId?: string): string;
        sendJson<T>(input: RallarRealtimeJsonSendInput<T>): Promise<readonly RallarRealtimeSendResult[]>;
        onJson<T>(laneId: string, handler: RallarRealtimeHandler<T>): RallarUnsubscribe;
    }

    export interface Target {
        readonly roomRef: GroupRef | undefined;
        readonly peerIds: readonly string[];
    }
}

/** Owns fixed/live targeted peer selection and targeted realtime channels. */
export class BrowserTargetedRealtimeRuntime {
    private readonly input: BrowserTargetedRealtimeRuntime.Input;

    constructor(input: BrowserTargetedRealtimeRuntime.Input) {
        this.input = input;
    }

    resolvePeerIds(input: RallarTargetSelector = {}): readonly string[] {
        return this.resolveTarget(input, false).peerIds;
    }

    private resolveTarget(
        selector: RallarTargetSelector,
        roomScoped: boolean
    ): BrowserTargetedRealtimeRuntime.Target {
        const sessionId = this.input.readSession()?.sessionId;
        const explicitPeerIds = selector.peerIds ?? (selector.peerId ? [selector.peerId] : undefined);
        const room = selector.roomRef ?? selector.roomId ?? (roomScoped || explicitPeerIds === undefined
            ? this.input.readDefaultRoom() ?? this.input.readCurrentRoomRef()
            : undefined);
        const selectedPeerIds = [...new Set(explicitPeerIds)].filter((peerId) => peerId !== sessionId);
        if (!room) {
            return { roomRef: undefined, peerIds: selectedPeerIds };
        }
        const roomRef = typeof room === 'string' ? this.input.resolveRoomRef(room) : room;
        if (!roomRef) {
            return { roomRef: undefined, peerIds: [] };
        }
        const authority = this.input.resolveRoomTransportTarget(roomRef);
        return {
            roomRef,
            peerIds: authority.transportState === 'halted'
                ? []
                : (explicitPeerIds === undefined ? authority.peerIds : selectedPeerIds)
                    .filter((peerId) => authority.peerIds.includes(peerId))
        };
    }

    create<T>(
        definition: RallarTargetedChannelDefinition,
        roomScoped = false
    ): RallarTargetedChannel<T> {
        const resolveTarget = this.createTargetResolver(definition, roomScoped);
        const defaultLaneId = this.input.resolveLaneId(definition.laneId);
        return {
            send: async (data, options: RallarTargetedChannelSendOptions<T> = {}) => {
                const laneId = this.input.resolveLaneId(options.laneId ?? definition.laneId);
                const target = resolveTarget(options);
                const peerIds = target.peerIds;
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
                    roomId: undefined,
                    roomRef: target.roomRef,
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
            peerIds: (options) => resolveTarget(options).peerIds
        };
    }

    private createTargetResolver(
        definition: RallarTargetedChannelDefinition,
        roomScoped: boolean
    ): (options?: RallarTargetSelector) => BrowserTargetedRealtimeRuntime.Target {
        const fixedMembership = definition.membership
            ? definition.membership === 'fixed'
            : !roomScoped;
        const fixedTarget = fixedMembership ? this.resolveTarget(definition, roomScoped) : undefined;
        return (options: RallarTargetSelector = {}) => {
            const selector = toTargetSelector(definition, options);
            if (fixedTarget && !hasTargetSelectorOverride(options)) {
                return this.resolveTarget(
                    { ...selector, roomRef: fixedTarget.roomRef, peerIds: fixedTarget.peerIds },
                    roomScoped
                );
            }
            return this.resolveTarget(selector, roomScoped);
        };
    }
}

function toTargetSelector(
    definition: RallarTargetedChannelDefinition,
    options: RallarTargetSelector
): RallarTargetSelector {
    return {
        ...definition,
        ...options,
        peerIds: options.peerId !== undefined && options.peerIds === undefined
            ? undefined
            : options.peerIds ?? definition.peerIds,
        roomRef: options.roomId !== undefined && options.roomRef === undefined
            ? undefined
            : options.roomRef ?? definition.roomRef
    };
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
    const sentCount = results.filter(isAcceptedRealtimeSendResult).length;
    if (sentCount === peerIds.length) {
        return 'sent';
    }
    return sentCount > 0 ? 'partial' : 'failed';
}
