import type {
    JSHandle,
    Page,
    TestInfo
} from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface CopyRepeatPayload {
    readonly topic: string;
    readonly marker: string;
    readonly value: number;
    readonly roomRef: GroupRef;
}

export interface NativeReceiveRecord {
    readonly peerId: string;
    readonly laneId: string;
    readonly data: CopyRepeatPayload;
    readonly nativeMessageEvent: boolean;
    readonly nativeTarget: boolean;
    readonly targetIndex: number;
    readonly readyStateAtCallback: string;
}

export interface NativeReceiveObserver {
    readonly records: NativeReceiveRecord[];
    readonly targets: RTCDataChannel[];
    unsubscribe(): void;
}

export interface CopyRepeatFinalStateInput {
    readonly sender: Page;
    readonly observer: JSHandle<NativeReceiveObserver> | undefined;
    readonly groupId: string;
    readonly expectedPayload: CopyRepeatPayload;
    readonly testInfo: Pick<TestInfo, 'outputPath' | 'attach'>;
}

interface CopyRepeatSenderState {
    readonly loadedRecipe: RallarBlackBoxTestState['loadedRecipe'];
    readonly commandHistory: RallarBlackBoxTestState['commandHistory'];
    readonly events: RallarBlackBoxTestState['events'];
}

interface CopyRepeatReceivedState {
    readonly records: readonly NativeReceiveRecord[];
    readonly targetStates: readonly RTCDataChannelState[];
}

type CopyRepeatUnavailableState =
    | { readonly status: 'not-reached'; readonly reason: 'observer-not-registered'; }
    | { readonly status: 'not-reached'; readonly reason: 'sender-not-initialized'; readonly url: string; }
    | { readonly status: 'unavailable'; readonly reason: 'sender-page-closed'; readonly url: string; };

interface CopyRepeatCaptureFailure {
    readonly status: 'unavailable';
    readonly reason: 'capture-failed';
    readonly error: string;
}

interface CopyRepeatFinalState {
    readonly groupId: string;
    readonly expectedPayload: CopyRepeatPayload;
    readonly senderState: CopyRepeatSenderState | CopyRepeatUnavailableState | CopyRepeatCaptureFailure;
    readonly received: CopyRepeatReceivedState | CopyRepeatUnavailableState | CopyRepeatCaptureFailure;
}

export async function writeCopyRepeatFinalState(input: CopyRepeatFinalStateInput): Promise<void> {
    const [senderState, received] = await Promise.allSettled([
        readCopyRepeatSenderState(input.sender),
        readCopyRepeatReceivedState(input.observer)
    ]);
    const finalState: CopyRepeatFinalState = {
        groupId: input.groupId,
        expectedPayload: input.expectedPayload,
        senderState: senderState.status === 'fulfilled'
            ? senderState.value
            : toCopyRepeatCaptureFailure(toError(senderState.reason)),
        received: received.status === 'fulfilled'
            ? received.value
            : toCopyRepeatCaptureFailure(toError(received.reason))
    };
    const [artifact] = await Promise.allSettled([writeCopyRepeatFinalStateArtifact(input.testInfo, finalState)]);
    const failures = [senderState, received, artifact].filter((result) => result.status === 'rejected');
    if (failures.length === 1) {
        throw failures[0].reason;
    }
    if (failures.length > 1) {
        throw new AggregateError(failures.map((failure) => failure.reason), 'Copy state capture failed.', {
            cause: failures[0].reason
        });
    }
}

async function writeCopyRepeatFinalStateArtifact(
    testInfo: CopyRepeatFinalStateInput['testInfo'],
    finalState: CopyRepeatFinalState
): Promise<void> {
    const evidencePath = testInfo.outputPath('actual-copy-repeat-final-state.json');
    await writeFile(evidencePath, JSON.stringify(finalState, null, 2));
    await testInfo.attach('actual-copy-repeat-final-state', { path: evidencePath, contentType: 'application/json' });
}

async function readCopyRepeatSenderState(sender: Page): Promise<CopyRepeatSenderState | CopyRepeatUnavailableState> {
    if (sender.isClosed()) {
        return { status: 'unavailable', reason: 'sender-page-closed', url: sender.url() };
    }
    if (new URL(sender.url()).origin === 'null') {
        return { status: 'not-reached', reason: 'sender-not-initialized', url: sender.url() };
    }
    // Keep the module import in the browser; SSR transforms otherwise rewrite a serialized callback.
    return await sender.evaluate<CopyRepeatSenderState>(`(async () => {
        const { rallarBlackBoxRuntimeStore } = await import('/src/runtime-store.ts');
        const state = rallarBlackBoxRuntimeStore.getSnapshot().state;
        return { loadedRecipe: state.loadedRecipe, commandHistory: state.commandHistory, events: state.events };
    })()`);
}

async function readCopyRepeatReceivedState(
    observer: JSHandle<NativeReceiveObserver> | undefined
): Promise<CopyRepeatReceivedState | CopyRepeatUnavailableState> {
    if (observer === undefined) {
        return { status: 'not-reached', reason: 'observer-not-registered' };
    }
    return await observer.evaluate(({ records, targets }) => ({
        records,
        targetStates: targets.map((target) => target.readyState)
    }));
}

function toCopyRepeatCaptureFailure(error: Error): CopyRepeatCaptureFailure {
    return { status: 'unavailable', reason: 'capture-failed', error: error.message };
}
