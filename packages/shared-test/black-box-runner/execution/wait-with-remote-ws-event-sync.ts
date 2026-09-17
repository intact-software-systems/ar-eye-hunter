import type { WaitObservationSource } from '../expectations/wait-observation-source.ts';
import {
    runWithRemoteBrowserEventSync,
    type RemoteBrowserObservationSync
} from '../remote-browser/remote-browser-observation-sync.ts';
import type { WsInteractionConfig } from '../ws/ws-interaction-statuses.ts';
import {
    toWsExpectedConnectionName,
    toWsFailureStatus
} from '../ws/ws-interaction-statuses.ts';
import {
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount,
    waitForWsMessages,
    type WsInteraction,
    type WsInteractionResult,
    type WsWaitInput
} from '../ws/ws-wait-expectations.ts';
import type { RemoteWsContext } from './remote-ws-connection.ts';

export interface RemoteWsWaitInput extends RemoteBrowserObservationSync.Connection {
    readonly context: RemoteWsContext;
    readonly interaction: WsInteraction;
    readonly config: WsInteractionConfig;
    readonly details: NonNullable<WsWaitInput['details']>;
}

/** Waits on the polled event stream; a polling failure discards the observations of every connection. */
export async function waitWithRemoteWsEventSync(input: RemoteWsWaitInput): Promise<WsInteractionResult> {
    const { context, interaction, config, details } = input;
    const observed = await runWithRemoteBrowserEventSync(
        input,
        (observations) => waitForRemoteWsExpectation(input, observations)
    );
    return observed.fold(
        (error) => {
            const connections = new Set([
                ...Object.keys(context.wsConnections),
                toWsExpectedConnectionName(interaction)
            ]);
            const losses = context.wsObservationLoss ??= {};
            for (const connection of connections) {
                losses[connection] = (losses[connection] ?? 0) + 1;
            }
            return toWsFailureStatus({
                config,
                interaction,
                result: 'WebSocket observations were discarded because remote polling failed',
                details: { ...details, exception: error.message }
            });
        },
        (status) => status
    );
}

function waitForRemoteWsExpectation(
    input: RemoteWsWaitInput,
    observations: WaitObservationSource
): Promise<WsInteractionResult> {
    const { interaction, config, context, details } = input;
    const response = interaction.response;
    if (response?.absent !== undefined) {
        return waitForWsMessageAbsence({
            interaction,
            config,
            context,
            details,
            observations,
            observeCloseEvents: true
        });
    }
    if (response?.count !== undefined) {
        return waitForWsMessageCount({ interaction, config, context, details, observations, observeCloseEvents: true });
    }
    if (response?.close !== undefined) {
        return waitForWsClose({ interaction, config, context, details });
    }
    if (response?.messages) {
        return waitForWsMessages({ interaction, config, context, details });
    }
    if (response?.message) {
        return waitForWsMessage({ interaction, config, context, details });
    }
    return Promise.resolve(
        toWsFailureStatus({
            config,
            interaction,
            result:
                'WebSocket wait expects expect.message, expect.messages, expect.count, expect.absent, or expect.close'
        })
    );
}
