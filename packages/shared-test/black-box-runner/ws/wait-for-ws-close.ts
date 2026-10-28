import {
    toWsFailureStatus,
    toWsSuccessStatus
} from './ws-interaction-statuses.ts';
import {
    matchesWsValue,
    startWsWaitWindow,
    type WsInteractionResult,
    type WsWaitInput
} from './ws-wait-expectations.ts';

/** Resolves on the first close event of the connection that matches `expect.close`, or fails when the window ends. */
export function waitForWsClose(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config, context, details = {} } = input;
    const { connectionName, startedAt, timeoutMs } = startWsWaitWindow(input);
    const expectedClose = interaction.response?.close === true ? {} : interaction.response?.close;
    if (expectedClose === undefined) {
        return Promise.resolve(
            toWsFailureStatus({
                config,
                interaction,
                result: 'WebSocket close expectation is missing. Use expect.close.',
                details: {
                    ...details,
                    connection: connectionName
                }
            })
        );
    }
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const closeEvents = context.wsCloseEvents?.[connectionName] ?? [];
            const index = closeEvents.findIndex((event) => matchesWsValue(expectedClose, event, interaction));
            if (index >= 0) {
                clearInterval(interval);
                const matchedCloseEvent = closeEvents[index];
                if (interaction.response?.consume) {
                    closeEvents.splice(index, 1);
                    const loss = context.wsObservationLoss ??= {};
                    loss[connectionName] = (loss[connectionName] ?? 0) + 1;
                }
                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedCloseEvent,
                    consumed: interaction.response?.consume === true,
                    waitedMs: input.context.dependencies.now() - startedAt
                }));
            }
            else if (input.context.dependencies.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(
                    toWsFailureStatus({
                        config,
                        interaction,
                        result: 'Expected WebSocket close event was not received',
                        details: {
                            ...details,
                            connection: connectionName,
                            expectedClose,
                            closeEvents,
                            waitedMs: input.context.dependencies.now() - startedAt
                        }
                    })
                );
            }
        }, 25);
    });
}
