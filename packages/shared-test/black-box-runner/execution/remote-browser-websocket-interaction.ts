// deno-lint-ignore-file no-explicit-any
import {
    executeRallarRemoteBrowserCommand,
    resolveRallarRemoteBrowserConfig,
    syncRallarRemoteBrowserEvents,
    toRallarRemoteBrowserCommandId,
    type RallarRemoteBrowserConfig,
    type RallarRemoteBrowserControlFetch
} from '../rallar-remote-browser-provider.ts';
import {
    toWsConnectionName,
    toWsExpectedConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus,
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount,
    waitForWsMessages
} from '../ws/ws-wait-expectations.ts';
import {
    isRallarRemoteBrowserRequest,
    remoteBrowserFetch,
    remoteBrowserOptions,
    remoteResultValue
} from './remote-browser-execution.ts';
import {
    toRemoteWsCloseCommand,
    toRemoteWsOpenCommand,
    toRemoteWsPayload,
    toRemoteWsSendCommand,
    toWsUrl
} from './remote-websocket-commands.ts';

function toRemoteWsConfig(interaction: any, config: any, context: any): RallarRemoteBrowserConfig {
    return resolveRallarRemoteBrowserConfig(
        interaction.request,
        config,
        context,
        remoteBrowserOptions(context)
    );
}

function isRemoteWsConnection(context: any, connectionName: string): boolean {
    return context.wsConnections?.[connectionName]?.remote === true;
}

export function shouldExecuteRemoteWsInteraction(interaction: any, context: any): boolean {
    const action = interaction.request.action || 'send';
    const connectionName = action === 'wait' || action === 'expect'
        ? toWsExpectedConnectionName(interaction)
        : toWsConnectionName(interaction.request);
    return isRallarRemoteBrowserRequest(interaction.request) ||
        isRemoteWsConnection(context, connectionName);
}

function startRemoteWsEventSync(
    remote: RallarRemoteBrowserConfig,
    fetchFn: RallarRemoteBrowserControlFetch,
    context: any
): number {
    let syncing = false;
    return setInterval(() => {
        if (syncing) {
            return;
        }
        syncing = true;
        void syncRallarRemoteBrowserEvents(remote, fetchFn, context)
            .catch(() => {
                // Wait helpers surface missing events through their normal timeout diagnostics.
            })
            .finally(() => {
                syncing = false;
            });
    }, remote.pollIntervalMs) as any as number;
}

interface WaitWithRemoteWsEventSyncInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetchFn: RallarRemoteBrowserControlFetch;
    readonly context: any;
    readonly wait: () => Promise<any>;
}

async function waitWithRemoteWsEventSync(input: WaitWithRemoteWsEventSyncInput): Promise<any> {
    const { remote, fetchFn, context, wait } = input;
    await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
    const interval = startRemoteWsEventSync(remote, fetchFn, context);
    try {
        return await wait();
    }
    finally {
        clearInterval(interval);
    }
}

interface ToRemoteWsFailureInput {
    readonly config: any;
    readonly interaction: any;
    readonly result: string;
    readonly details?: any;
}

function toRemoteWsFailure(input: ToRemoteWsFailureInput): any {
    const { config, interaction, result, details = {} } = input;
    return toWsFailureStatus(config, interaction, result, details);
}

async function openRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);
    const url = toWsUrl(interaction.request);

    if (!url) {
        return toRemoteWsFailure({ config, interaction, result: 'WebSocket URL is missing' });
    }

    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-open', interaction);

    try {
        const command = toRemoteWsOpenCommand(commandId, interaction, context);
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        if (!result.ok) {
            return toRemoteWsFailure({
                config,
                interaction,
                result: 'Remote WebSocket connect failed',
                details: {
                    connection: connectionName,
                    remote,
                    result
                }
            });
        }

        context.wsConnections[connectionName] = {
            remote: true,
            readyState: 1,
            url,
            close: (code?: number, reason?: string) => {
                void executeRallarRemoteBrowserCommand(
                    remote,
                    fetchFn,
                    context,
                    {
                        ...toRemoteWsCloseCommand(`${commandId}-auto-close`, interaction),
                        code,
                        reason
                    }
                );
            }
        };
        context.wsMessages[connectionName] = context.wsMessages[connectionName] || [];
        context.wsCloseEvents[connectionName] = context.wsCloseEvents[connectionName] || [];

        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            url,
            readyState: 1,
            remote,
            commandId,
            result: remoteResultValue(result)
        });
    }
    catch (error) {
        return toRemoteWsFailure({
            config,
            interaction,
            result: 'Remote WebSocket connect failed',
            details: {
                connection: connectionName,
                remote,
                exception: error instanceof Error ? error.message : String(error)
            }
        });
    }
}

async function sendRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);

    if (!context.wsConnections[connectionName]) {
        return toRemoteWsFailure({
            config,
            interaction,
            result: 'WebSocket connection is not open',
            details: {
                connection: connectionName
            }
        });
    }

    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-send', interaction);
    const sentPayload = toRemoteWsPayload(interaction.request);

    try {
        const command = toRemoteWsSendCommand(commandId, interaction, context);
        const sendStartedAtEpochMs = Date.now();
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        const sendEndedAtEpochMs = Date.now();
        if (!result.ok) {
            return toRemoteWsFailure({
                config,
                interaction,
                result: 'Remote WebSocket send failed',
                details: {
                    connection: connectionName,
                    remote,
                    result,
                    sent: sentPayload,
                    sendResult: {
                        status: 'failed',
                        connection: connectionName,
                        remoteResult: remoteResultValue(result)
                    },
                    sendStartedAtEpochMs,
                    sendEndedAtEpochMs,
                    sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
                }
            });
        }

        const details = {
            sentConnection: connectionName,
            sent: sentPayload,
            remote,
            commandId,
            result: remoteResultValue(result),
            sendResult: {
                status: 'sent',
                connection: connectionName,
                remoteResult: remoteResultValue(result)
            },
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
        };

        if (interaction.response?.count !== undefined) {
            return waitWithRemoteWsEventSync({
                remote,
                fetchFn,
                context,
                wait: () => waitForWsMessageCount({ interaction, config, context, details })
            });
        }

        if (interaction.response?.messages) {
            return waitWithRemoteWsEventSync({
                remote,
                fetchFn,
                context,
                wait: () => waitForWsMessages(interaction, config, context, details)
            });
        }

        if (interaction.response?.message) {
            return waitWithRemoteWsEventSync({
                remote,
                fetchFn,
                context,
                wait: () => waitForWsMessage(interaction, config, context, details)
            });
        }

        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            sent: sentPayload,
            remote,
            commandId,
            result: remoteResultValue(result),
            sendResult: details.sendResult,
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
        });
    }
    catch (error) {
        return toRemoteWsFailure({
            config,
            interaction,
            result: 'Remote WebSocket send failed',
            details: {
                connection: connectionName,
                remote,
                sent: sentPayload,
                sendResult: {
                    status: 'failed',
                    connection: connectionName,
                    exception: error instanceof Error ? error.message : String(error)
                },
                exception: error instanceof Error ? error.message : String(error)
            }
        });
    }
}

async function waitRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    return waitWithRemoteWsEventSync({
        remote,
        fetchFn,
        context,
        wait: () => {
            if (interaction.response?.absent !== undefined) {
                return waitForWsMessageAbsence({
                    interaction,
                    config,
                    context,
                    details: { remote }
                });
            }

            // Before `message`, which resolves on its first match and so cannot
            // tell "exactly one" from "at least one".
            if (interaction.response?.count !== undefined) {
                return waitForWsMessageCount({
                    interaction,
                    config,
                    context,
                    details: { remote }
                });
            }

            if (interaction.response?.close !== undefined) {
                return waitForWsClose(interaction, config, context, {
                    remote
                });
            }

            if (interaction.response?.messages) {
                return waitForWsMessages(interaction, config, context, {
                    remote
                });
            }

            if (interaction.response?.message) {
                return waitForWsMessage(interaction, config, context, {
                    remote
                });
            }

            return Promise.resolve(toRemoteWsFailure({
                config,
                interaction,
                result: 'WebSocket wait expects expect.message, expect.messages, expect.count, ' +
                    'expect.absent, or expect.close'
            }));
        }
    });
}

async function closeRemoteWs(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toWsConnectionName(interaction.request);
    const remote = toRemoteWsConfig(interaction, config, context);
    const fetchFn = remoteBrowserFetch(context);
    const commandId = toRallarRemoteBrowserCommandId('ws-close', interaction);
    const command = toRemoteWsCloseCommand(commandId, interaction);

    try {
        const result = await executeRallarRemoteBrowserCommand(remote, fetchFn, context, command);
        await syncRallarRemoteBrowserEvents(remote, fetchFn, context);
        delete context.wsConnections[connectionName];

        if (!result.ok) {
            return toRemoteWsFailure({
                config,
                interaction,
                result: 'Remote WebSocket close failed',
                details: {
                    connection: connectionName,
                    remote,
                    result
                }
            });
        }

        return toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            remote,
            commandId,
            result: remoteResultValue(result)
        });
    }
    catch (error) {
        return toRemoteWsFailure({
            config,
            interaction,
            result: 'Remote WebSocket close failed',
            details: {
                connection: connectionName,
                remote,
                exception: error instanceof Error ? error.message : String(error)
            }
        });
    }
}

export function executeRemoteWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';

    if (action === 'connect' || action === 'open') {
        return openRemoteWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendRemoteWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        return waitRemoteWs(interaction, config, context);
    }

    if (action === 'close') {
        return closeRemoteWs(interaction, config, context);
    }

    return Promise.resolve(toRemoteWsFailure({
        config,
        interaction,
        result: 'Unsupported WebSocket action: ' + action
    }));
}
