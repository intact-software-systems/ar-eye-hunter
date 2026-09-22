// deno-lint-ignore-file no-explicit-any
import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    toRtcFailureStatus,
    toRtcSuccessStatus
} from '../rtc/rtc-wait-expectations.ts';
import { toRemoteResultDetails } from './rallar-remote-browser-control-client.ts';
import type { RallarRemoteBrowserConfig } from './resolve-rallar-remote-browser-config.ts';
import { toRallarScopeFields } from './to-rallar-scope-fields.ts';

export interface RemoteRtcFailureInput {
    readonly config: any;
    readonly interaction: any;
    readonly message: string;
    readonly error: Error;
}

export interface RemoteRtcSendSubmission {
    readonly remote: RallarRemoteBrowserConfig;
    readonly command: RallarBlackBoxTestCommand;
    readonly result: ControlResultEnvelope;
    readonly connectionName: string;
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
}

export interface RemoteRtcConnectCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connectionName: string;
    readonly result: ControlResultEnvelope;
    readonly connectStartedAtEpochMs: number;
    readonly connectedAtEpochMs: number;
}

export interface RemoteRtcConnectedState {
    readonly connection: any;
    readonly details: any;
}

export interface RemoteRtcCloseCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly connectionName: string;
    readonly result: ControlResultEnvelope;
}

export function toRemoteRtcFailure(input: RemoteRtcFailureInput): any {
    const { config, interaction, message, error } = input;
    return toRtcFailureStatus({
        config,
        interaction,
        result: message,
        details: {
            exception: error.message
        }
    });
}

export function toRemoteRtcSendDetails(interaction: any, submission: RemoteRtcSendSubmission): any {
    const { remote, command, result, connectionName, sendStartedAtEpochMs, sendEndedAtEpochMs } = submission;
    return {
        connection: connectionName,
        sent: command.kind === 'rtc.send' ? command.send : undefined,
        provider: interaction.request.provider,
        remote,
        commandId: command.commandId,
        ...toRallarScopeFields(interaction.request).right,
        result: toRemoteResultDetails(result),
        sendResult: toRemoteSendResult('sent', connectionName, result),
        sendStartedAtEpochMs,
        sendEndedAtEpochMs,
        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
    };
}

export function toRemoteRtcSendFailure(config: any, interaction: any, submission: RemoteRtcSendSubmission): any {
    const { remote, result, connectionName, sendStartedAtEpochMs, sendEndedAtEpochMs } = submission;
    return toRtcFailureStatus({
        config,
        interaction,
        result: 'Remote RTC send failed',
        details: {
            connection: connectionName,
            remote,
            result,
            sendResult: toRemoteSendResult('failed', connectionName, result),
            sendStartedAtEpochMs,
            sendEndedAtEpochMs,
            sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
        }
    });
}

export function computeRemoteRtcConnectedState(
    interaction: any,
    completion: RemoteRtcConnectCompletion
): RemoteRtcConnectedState {
    const { remote, commandId, connectionName, result, connectStartedAtEpochMs, connectedAtEpochMs } = completion;
    const diagnostics = toRemoteResultDetails(result);
    const metadata = {
        provider: interaction.request.provider,
        connectStartedAtEpochMs,
        connectedAtEpochMs,
        connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
        diagnostics,
        commandId
    };
    return {
        connection: {
            ...metadata,
            remote: true,
            actor: interaction.request.actor,
            roomId: interaction.request.roomId,
            request: interaction.request
        },
        details: {
            ...metadata,
            connection: connectionName,
            connected: true,
            remote,
            ...toRallarScopeFields(interaction.request).right,
            result: diagnostics
        }
    };
}

export function toRemoteRtcConnectFailure(config: any, interaction: any, completion: RemoteRtcConnectCompletion): any {
    const { remote, connectionName, result, connectStartedAtEpochMs, connectedAtEpochMs } = completion;
    return toRtcFailureStatus({
        config,
        interaction,
        result: 'Remote RTC connect failed',
        details: {
            connection: connectionName,
            remote,
            result,
            connectStartedAtEpochMs,
            connectFailedAtEpochMs: connectedAtEpochMs,
            connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs
        }
    });
}

export function toRemoteRtcCloseStatus(config: any, interaction: any, completion: RemoteRtcCloseCompletion): any {
    const { remote, commandId, connectionName, result } = completion;
    if (!result.ok) {
        return toRtcFailureStatus({
            config,
            interaction,
            result: 'Remote RTC close failed',
            details: { connection: connectionName, remote, result }
        });
    }
    return toRtcSuccessStatus(config, interaction, {
        connection: connectionName,
        closeRequested: true,
        closed: true,
        provider: interaction.request.provider,
        remote,
        commandId,
        result: toRemoteResultDetails(result)
    });
}

function toRemoteSendResult(status: 'sent' | 'failed', connectionName: string, result: ControlResultEnvelope): any {
    return {
        status,
        connection: connectionName,
        remoteResult: toRemoteResultDetails(result)
    };
}
