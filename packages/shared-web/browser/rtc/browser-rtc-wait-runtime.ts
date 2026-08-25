import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import type {
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcStatus,
    RallarRtcStatusOptions,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult,
    RallarWaitForOpenStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarNormalizedReadinessExpectation,
    type RallarReadinessEvaluation
} from '@shared-web/browser/readiness.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { WebRtcPeerLaneOpenResult } from '@shared/services/WebRtcConnectionService.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';

export namespace BrowserRtcWaitRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readStatus(options?: RallarRtcStatusOptions): RallarRtcStatus;
        resolveRoomPeerIds(room: string | GroupRef): readonly string[];
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

interface RallarRtcLaneTarget {
    readonly peerId: string;
    readonly laneId: string;
}

interface RallarRtcLaneRuntimeInput extends RallarRtcLaneTarget {
    readonly ctx: ApiMiddleware;
    readonly options: RallarRtcWaitForOpenOptions;
}

interface RallarRtcWaitForOpenResultInput {
    readonly status: RallarWaitForOpenStatus;
    readonly peerId: string;
    readonly laneId: string;
    readonly reason?: string;
}

interface RallarRtcExpectationWaitStatusInput {
    readonly evaluation: RallarReadinessEvaluation;
    readonly waitStatus: RallarRtcRoomLaneWaitStatus;
    readonly readyPeerIds: readonly string[];
    readonly notReady: readonly RallarRtcWaitForOpenResult[];
    readonly preferUnsatisfiedTerminalStatus: boolean;
}

/** Owns RTC lane waiting, readiness evaluation, and caller-visible wait results. */
export class BrowserRtcWaitRuntime {
    private readonly input: BrowserRtcWaitRuntime.Input;

    constructor(input: BrowserRtcWaitRuntime.Input) {
        this.input = input;
    }

    async waitForLane(
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions = {}
    ): Promise<RallarRtcWaitForOpenResult> {
        const ctx = this.input.readMiddleware();
        if (options.signal?.aborted) {
            return this.toWaitForOpenResult({ status: 'aborted', peerId, laneId });
        }
        if (!ctx) {
            return this.toWaitForOpenResult({ status: 'not-connected', peerId, laneId });
        }
        const waitInput = { ctx, peerId, laneId, options };
        return this.input.resolveConnectOnWait(options.connect)
            ? await this.waitWithConnect(waitInput)
            : await this.waitForExistingLane(waitInput);
    }

    async waitForRoomLane(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomLaneWaitOptions = {}
    ): Promise<RallarRtcRoomLaneWaitResult> {
        const roomId = typeof room === 'string' ? room : room.groupId;
        const peerIds = this.input.resolveRoomPeerIds(options.roomRef ?? room);
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
        return this.toRoomLaneResult({
            roomId,
            laneId,
            ready: results.filter((result) => result.status === 'open'),
            notReady: results.filter((result) => result.status !== 'open'),
            expectation,
            preferUnsatisfiedTerminalStatus: options.expect !== undefined
        });
    }

    private async waitForExistingLane(
        input: RallarRtcLaneRuntimeInput
    ): Promise<RallarRtcWaitForOpenResult> {
        const peer = input.ctx.middleware.webRtcConnectionService.readPeer(input.peerId);
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
            const result = await input.ctx.middleware.webRtcConnectionService.ensurePeerLaneOpen(
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
        catch (error) {
            return this.toWaitForOpenResult({
                status: 'failed',
                peerId: input.peerId,
                laneId: input.laneId,
                reason: toErrorMessage(error)
            });
        }
    }

    private toRoomLaneResult(
        input: BrowserRtcWaitRuntime.RoomLaneResultInput
    ): RallarRtcRoomLaneWaitResult {
        const readyPeerIds = uniquePeerIds(input.ready.map((result) => result.peerId));
        const notReadyPeerIds = uniquePeerIds(input.notReady.map((result) => result.peerId));
        const evaluation = evaluateRallarReadinessExpectation(readyPeerIds, input.expectation);
        const waitStatus = toRtcRoomLaneWaitStatus(input.ready, input.notReady);
        return {
            transport: 'rtc',
            roomId: input.roomId,
            laneId: input.laneId,
            status: toExpectationAwareRtcRoomLaneWaitStatus({
                evaluation,
                waitStatus,
                readyPeerIds,
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
        target: RallarRtcLaneTarget,
        reason?: string
    ): RallarRtcWaitForOpenResult {
        return this.toWaitForOpenResult({
            status,
            peerId: target.peerId,
            laneId: target.laneId,
            reason
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
                reject(error);
            });
    });
}

function toErrorMessage(error: Error['cause']): string {
    return error instanceof Error ? error.message : String(error);
}

function toRallarWaitForOpenStatus(
    status: WebRtcPeerLaneOpenResult['status']
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

function toRtcRoomLaneWaitStatus(
    ready: readonly RallarRtcWaitForOpenResult[],
    notReady: readonly RallarRtcWaitForOpenResult[]
): RallarRtcRoomLaneWaitStatus {
    if (ready.length === 0 && notReady.length === 0) {
        return 'empty';
    }
    if (notReady.length === 0) {
        return 'open';
    }
    if (ready.length > 0) {
        return 'partial';
    }
    if (notReady.every((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }
    if (notReady.every((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }
    if (notReady.every((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }
    if (notReady.every((peer) => peer.status === 'failed')) {
        return 'failed';
    }
    return 'not-ready';
}

function toExpectationAwareRtcRoomLaneWaitStatus(
    input: RallarRtcExpectationWaitStatusInput
): RallarRtcRoomLaneWaitStatus {
    if (input.evaluation.status === 'over-capacity') {
        return 'over-capacity';
    }
    if (input.evaluation.status === 'empty' && input.evaluation.expectedCount === 0) {
        return 'empty';
    }
    if (input.evaluation.status === 'ready') {
        return input.waitStatus === 'open'
            ? 'open'
            : input.readyPeerIds.length > 0
            ? 'partial'
            : 'empty';
    }
    if (!input.preferUnsatisfiedTerminalStatus) {
        return input.waitStatus;
    }
    if (input.notReady.some((peer) => peer.status === 'failed')) {
        return 'failed';
    }
    if (input.notReady.some((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }
    if (input.notReady.some((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }
    if (input.notReady.some((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }
    return input.waitStatus;
}

function toPeerLaneOpenReason(result: WebRtcPeerLaneOpenResult): string | undefined {
    if (result.status === 'open' || !result.error) {
        return undefined;
    }
    const cause = result.error.cause;
    return cause !== undefined ? toErrorMessage(cause) : result.error.message;
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}
