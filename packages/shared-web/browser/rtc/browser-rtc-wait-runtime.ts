import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcStatus,
    RallarRtcStatusOptions,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult,
    RallarWaitForOpenStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarNormalizedReadinessExpectation
} from '@shared-web/browser/readiness.ts';
import type { BrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import {
    isRtcRoomPeerFailed,
    resolveRtcRoomLaneWaitStatus
} from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/qrtc-data-channel.ts';

interface RallarRtcLaneTarget {
    readonly peerId: string;
    readonly laneId: string;
}

interface RallarRtcLaneRuntimeInput extends RallarRtcLaneTarget {
    readonly context: ApiMiddleware;
    readonly options: RallarRtcWaitForOpenOptions;
}

interface RallarRtcWaitForOpenResultInput {
    readonly status: RallarWaitForOpenStatus;
    readonly peerId: string;
    readonly laneId: string;
    readonly reason?: string;
}

export namespace BrowserRtcWaitRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readStatus(options?: RallarRtcStatusOptions): RallarRtcStatus;
        resolveRoomTransportTarget(room: string | GroupRef): BrowserRoomTransportTarget;
        resolveRoomRef(room: string | GroupRef): GroupRef | undefined;
        resolveWaitTimeoutMs(timeoutMs?: number): number | undefined;
        resolveConnectOnWait(connect?: boolean): boolean;
    }

    export interface RoomLaneResultInput {
        readonly roomId: string;
        readonly laneId: string;
        readonly ready: readonly RallarRtcWaitForOpenResult[];
        readonly notReady: readonly RallarRtcWaitForOpenResult[];
        readonly expectation: RallarNormalizedReadinessExpectation;
        readonly preferUnsatisfiedTerminalStatus: boolean;
    }
}

/** Owns RTC lane waiting, readiness evaluation, and caller-visible wait results. */
export class BrowserRtcWaitRuntime {
    private readonly input: BrowserRtcWaitRuntime.Input;

    public constructor(input: BrowserRtcWaitRuntime.Input) {
        this.input = input;
    }

    public async waitForLane(
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions = {}
    ): Promise<RallarRtcWaitForOpenResult> {
        const context = this.input.readMiddleware();
        if (options.signal?.aborted) {
            return this.toWaitForOpenResult({ status: 'aborted', peerId, laneId });
        }
        if (!context) {
            return this.toWaitForOpenResult({ status: 'not-connected', peerId, laneId });
        }
        const waitInput = { context, peerId, laneId, options };
        return this.input.resolveConnectOnWait(options.connect)
            ? await this.waitWithConnect(waitInput)
            : await this.waitForExistingLane(waitInput);
    }

    public async waitForRoomLane(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomLaneWaitOptions = {}
    ): Promise<RallarRtcRoomLaneWaitResult> {
        const requestedRoom = options.roomRef ?? room;
        const pinnedRoom = this.input.resolveRoomRef(requestedRoom) ?? requestedRoom;
        const roomId = typeof pinnedRoom === 'string' ? pinnedRoom : pinnedRoom.groupId;
        const target = this.input.resolveRoomTransportTarget(pinnedRoom);
        const peerIds = target.transportState === 'halted' ? [] : target.peerIds;
        const expectation = normalizeRallarReadinessExpectation(
            options.expect ?? { exact: peerIds.length }
        );
        if (peerIds.length === 0) {
            return this.toRoomLaneResult({
                roomId,
                laneId,
                ready: [],
                notReady: [],
                expectation,
                preferUnsatisfiedTerminalStatus: options.expect !== undefined
            });
        }
        const results = await Promise.all(
            peerIds.map(async (peerId) => await this.waitForLane(peerId, laneId, options))
        );
        const currentTarget = this.input.resolveRoomTransportTarget(pinnedRoom);
        const currentPeerIds = new Set(currentTarget.transportState === 'halted' ? [] : currentTarget.peerIds);
        const currentStatus = this.input.readStatus({ laneId });
        const authorizedResults = results
            .filter((result) => currentPeerIds.has(result.peerId))
            .map((result) => this.recheckOpenLaneResult(result, currentStatus));
        return this.toRoomLaneResult({
            roomId,
            laneId,
            ready: authorizedResults.filter((result) => result.status === 'open'),
            notReady: authorizedResults.filter((result) => result.status !== 'open'),
            expectation,
            preferUnsatisfiedTerminalStatus: options.expect !== undefined
        });
    }

    private recheckOpenLaneResult(
        result: RallarRtcWaitForOpenResult,
        status: RallarRtcStatus
    ): RallarRtcWaitForOpenResult {
        if (result.status !== 'open') {
            return result;
        }
        const peer = status.peers.find((candidate) => candidate.peerId === result.peerId);
        const lane = peer?.lanes.find((candidate) => candidate.laneId === result.laneId);
        const current = { ...result, rtcStatus: status, peer, lane };
        if (!peer) {
            return { ...current, status: 'no-peer' };
        }
        if (!lane) {
            return { ...current, status: 'no-lane' };
        }
        if (lane.isOpen && peer.isActive && !isRtcRoomPeerFailed(peer, result.laneId)) {
            return current;
        }
        return {
            ...current,
            status: isClosedRtcLaneHealth(lane.channel) ? 'closed' : 'failed',
            reason: 'RTC lane is no longer ready for the room.'
        };
    }

    private async waitForExistingLane(
        input: RallarRtcLaneRuntimeInput
    ): Promise<RallarRtcWaitForOpenResult> {
        const peer = input.context.middleware.webRtcConnectionService.readPeer(input.peerId);
        if (!peer) {
            return this.toLaneWaitResult('no-peer', input);
        }
        const channel = peer.channels.get(input.laneId);
        if (!channel) {
            return this.toLaneWaitResult('no-lane', input);
        }
        const initialHealth = channel.readHealth();
        if (initialHealth.readyState === 'open') {
            return this.toLaneWaitResult('open', input);
        }
        if (isClosedRtcLaneHealth(initialHealth)) {
            return this.toLaneWaitResult('closed', input);
        }
        const timeoutMs = normalizeWaitTimeoutMs(
            this.input.resolveWaitTimeoutMs(input.options.timeoutMs)
        );
        if (timeoutMs <= 0) {
            return this.toLaneWaitResult('timeout', input);
        }
        const opened = await waitForRtcChannelOpenOrAbort(
            channel.waitUntilOpen(timeoutMs),
            input.options.signal
        );
        if (opened === 'aborted') {
            return this.toLaneWaitResult('aborted', input);
        }
        if (opened) {
            return this.toLaneWaitResult('open', input);
        }
        const status = isClosedRtcLaneHealth(channel.readHealth()) ? 'closed' : 'timeout';
        return this.toLaneWaitResult(status, input);
    }

    private async waitWithConnect(
        input: RallarRtcLaneRuntimeInput
    ): Promise<RallarRtcWaitForOpenResult> {
        try {
            const result = await input.context.middleware.webRtcConnectionService.ensurePeerLaneOpen(
                input.peerId,
                input.laneId,
                {
                    timeoutMs: normalizeWaitTimeoutMs(
                        this.input.resolveWaitTimeoutMs(input.options.timeoutMs)
                    ),
                    signal: input.options.signal
                }
            );
            return this.toWaitForOpenResult({
                status: toRallarWaitForOpenStatus(result.status),
                peerId: result.peerId,
                laneId: result.laneId,
                reason: toPeerLaneOpenReason(result)
            });
        }
        catch (caught) {
            return this.toWaitForOpenResult({
                status: 'failed',
                peerId: input.peerId,
                laneId: input.laneId,
                reason: toError(caught).message
            });
        }
    }

    private toRoomLaneResult(
        input: BrowserRtcWaitRuntime.RoomLaneResultInput
    ): RallarRtcRoomLaneWaitResult {
        const readyPeerIds = uniquePeerIds(input.ready.map((result) => result.peerId));
        const notReadyPeerIds = uniquePeerIds(input.notReady.map((result) => result.peerId));
        const evaluation = evaluateRallarReadinessExpectation(readyPeerIds, input.expectation);
        return {
            transport: 'rtc',
            roomId: input.roomId,
            laneId: input.laneId,
            status: resolveRtcRoomLaneWaitStatus({
                evaluation,
                ready: input.ready,
                notReady: input.notReady,
                preferUnsatisfiedTerminalStatus: input.preferUnsatisfiedTerminalStatus
            }),
            rtcStatus: this.input.readStatus({ laneId: input.laneId }),
            ready: input.ready,
            notReady: input.notReady,
            readyPeerIds,
            notReadyPeerIds,
            missingPeerIds: evaluation.missingSessionIds,
            extraPeerIds: evaluation.extraSessionIds,
            observedCount: evaluation.observedCount,
            expectedCount: evaluation.expectedCount
        };
    }

    private toWaitForOpenResult(
        input: RallarRtcWaitForOpenResultInput
    ): RallarRtcWaitForOpenResult {
        const rtcStatus = this.input.readStatus({ laneId: input.laneId });
        const peer = rtcStatus.peers.find((candidate) => candidate.peerId === input.peerId);
        const lane = peer?.lanes.find((candidate) => candidate.laneId === input.laneId);
        return {
            transport: 'rtc',
            status: input.status,
            peerId: input.peerId,
            laneId: input.laneId,
            rtcStatus,
            peer,
            lane,
            reason: input.reason
        };
    }

    private toLaneWaitResult(
        status: RallarWaitForOpenStatus,
        target: RallarRtcLaneTarget
    ): RallarRtcWaitForOpenResult {
        return this.toWaitForOpenResult({
            status,
            peerId: target.peerId,
            laneId: target.laneId
        });
    }
}

function isClosedRtcLaneHealth(channel: RtcDataChannelHealth | undefined): boolean {
    return channel?.readyState === 'closing' || channel?.readyState === 'closed' ||
        channel?.state === 'Closed' || channel?.state === 'Failed';
}

function waitForRtcChannelOpenOrAbort(
    waitUntilOpen: Promise<boolean>,
    signal?: AbortSignal
): Promise<boolean | 'aborted'> {
    if (!signal) {
        return waitUntilOpen;
    }
    if (signal.aborted) {
        return Promise.resolve('aborted');
    }
    return new Promise<boolean | 'aborted'>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve('aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((error) => {
                signal.removeEventListener('abort', onAbort);
                reject(toError(error));
            });
    });
}

function toRallarWaitForOpenStatus(
    status: WebRtcConnectionService.PeerLaneOpenResult['status']
): RallarWaitForOpenStatus {
    switch (status) {
        case 'open':
        case 'timeout':
        case 'aborted':
        case 'no-peer':
        case 'no-lane':
        case 'closed':
            return status;
        case 'exhausted':
        case 'self':
        case 'connect-failed':
        case 'failed':
            return 'failed';
    }
}

function toPeerLaneOpenReason(result: WebRtcConnectionService.PeerLaneOpenResult): string | undefined {
    if (result.status === 'open' || !result.error) {
        return undefined;
    }
    const cause = result.error.cause;
    return cause !== undefined ? toError(cause).message : result.error.message;
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}
