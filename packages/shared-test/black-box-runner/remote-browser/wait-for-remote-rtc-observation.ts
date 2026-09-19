// deno-lint-ignore-file no-explicit-any
import { Either } from '../../../shared/resilience/Either.ts';

import type { WaitObservationSource } from '../expectations/wait-observation-source.ts';
import {
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    waitForRtcClose,
    waitForRtcDiagnostic,
    waitForRtcDiagnostics,
    waitForRtcHealth,
    waitForRtcMessage,
    waitForRtcMessageCount,
    waitForRtcMessages
} from '../rtc/rtc-wait-expectations.ts';
import { recordRemoteRtcHealth } from './record-remote-rtc-health.ts';
import {
    toRemoteBrowserCommand,
    type IdentifiedRemoteBrowserCommand
} from './remote-browser-commands.ts';
import {
    RemoteBrowserObservationSync,
    runWithRemoteBrowserEventSync
} from './remote-browser-observation-sync.ts';
import { toRemoteRtcFailure } from './remote-rtc-statuses.ts';

export type RemoteRtcExpectation =
    | 'count'
    | 'close'
    | 'diagnostics'
    | 'diagnostic'
    | 'health'
    | 'messages'
    | 'message'
    | 'none';

export interface RemoteRtcWaitInput extends RemoteBrowserObservationSync.Connection {
    readonly interaction: any;
    readonly config: any;
    readonly details: any;
}

interface RemoteRtcMatchInput extends RemoteRtcWaitInput {
    readonly observations: WaitObservationSource;
}

export function toRemoteRtcExpectation(response: any, phase: 'send' | 'wait'): RemoteRtcExpectation {
    if (phase === 'wait' && response?.close !== undefined) {
        return 'close';
    }
    if (response?.count !== undefined) {
        return 'count';
    }
    if (phase === 'send' && response?.messages) {
        return 'messages';
    }
    if (response?.diagnostics) {
        return 'diagnostics';
    }
    if (response?.diagnostic) {
        return 'diagnostic';
    }
    if (response?.health !== undefined) {
        return 'health';
    }
    if (response?.messages) {
        return 'messages';
    }
    return response?.message ? 'message' : 'none';
}

/** A health expectation probes the agent directly; every other expectation waits on the polled event stream. */
export async function waitForRemoteRtcObservation(
    input: RemoteRtcWaitInput,
    expectation: RemoteRtcExpectation
): Promise<Either<Error, any>> {
    if (expectation === 'health') {
        return Either.ofRight(await waitForRemoteRtcHealth(input));
    }
    return runWithRemoteBrowserEventSync(
        input,
        (observations) => waitForRemoteRtcMatch({ ...input, observations }, expectation)
    );
}

export function waitForRemoteRtcHealth(input: RemoteRtcWaitInput): Promise<any> {
    const { interaction, config } = input;
    return toRemoteBrowserCommand('health', interaction).fold(
        (error) =>
            Promise.resolve(toRemoteRtcFailure({ config, interaction, message: 'Remote RTC health failed', error })),
        (health) => waitForProbedRemoteRtcHealth(input, health)
    );
}

async function waitForProbedRemoteRtcHealth(
    input: RemoteRtcWaitInput,
    health: IdentifiedRemoteBrowserCommand
): Promise<any> {
    const { interaction, config, context, details } = input;
    // An unanswered first probe is not a failure: the probes keep polling and the health waiter owns the deadline.
    await recordRemoteRtcHealth({ ...input, commandId: `${health.commandId}-health-0`, command: health.command });
    const synchronization = new RemoteBrowserObservationSync({
        ...input,
        kind: 'health',
        commandIdPrefix: health.commandId,
        command: health.command
    });
    synchronization.start();
    return waitForRtcHealth({ interaction, config, context, details }).finally(() => synchronization.stop());
}

function waitForRemoteRtcMatch(input: RemoteRtcMatchInput, expectation: RemoteRtcExpectation): Promise<any> {
    switch (expectation) {
        case 'close':
            return waitForRtcClose(input);
        case 'diagnostics':
            return waitForRtcDiagnostics(input);
        case 'diagnostic':
            return waitForRtcDiagnostic(input);
        case 'count':
            return waitForRtcMessageCount(input);
        case 'messages':
            return waitForRtcMessages(input);
        case 'message':
            return waitForRtcMessage(input);
        default:
            return Promise.resolve(toRtcFailureStatus({
                config: input.config,
                interaction: input.interaction,
                result:
                    'RTC wait expects expect.message, expect.messages, expect.count, expect.diagnostic, expect.diagnostics, expect.health, or expect.close',
                details: { connection: toRtcExpectedConnectionName(input.interaction), remote: input.remote }
            }));
    }
}
