// deno-lint-ignore-file no-explicit-any
import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import { toRemoteResultDetails } from './rallar-remote-browser-control-client.ts';
import type { RallarRemoteBrowserConfig } from './resolve-rallar-remote-browser-config.ts';

export interface RemoteCrdtCompletion {
    readonly remote: RallarRemoteBrowserConfig;
    readonly commandId: string;
    readonly result: ControlResultEnvelope;
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
}

export interface RemoteCrdtFailureStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly details: any;
}

export function toRemoteCrdtStatus(config: any, interaction: any, completion: RemoteCrdtCompletion): any {
    const { remote, commandId, result, startedAtEpochMs, endedAtEpochMs } = completion;
    const details = {
        remote,
        commandId,
        result: result.ok ? toRemoteResultDetails(result) : result,
        startedAtEpochMs,
        endedAtEpochMs,
        latencyMs: endedAtEpochMs - startedAtEpochMs
    };
    return result.ok
        ? toRemoteCrdtSuccessStatus(config, interaction, details)
        : toRemoteCrdtFailureStatus({ config, interaction, details });
}

export function toRemoteCrdtFailureStatus(input: RemoteCrdtFailureStatusInput): any {
    const { config, interaction, details } = input;
    return {
        name: config.interactionName,
        status: 'FAILURE',
        result: 'Remote CRDT command failed',
        transport: 'CRDT',
        ...toCrdtReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtReportFields(interaction),
            ...details
        },
        ...config
    };
}

function toRemoteCrdtSuccessStatus(config: any, interaction: any, details: any): any {
    return {
        name: config.interactionName,
        status: 'SUCCESS',
        transport: 'CRDT',
        ...toCrdtReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toCrdtReportFields(interaction),
            ...details
        },
        ...config
    };
}

function toCrdtReportFields(interaction: any): any {
    return {
        provider: interaction.request.provider,
        action: interaction.request.action,
        connection: interaction.request.connection,
        handle: interaction.request.handle,
        documentName: interaction.request.name,
        applicationId: interaction.request.applicationId,
        workspaceId: interaction.request.workspaceId,
        documentId: interaction.request.documentId,
        documentType: interaction.request.documentType,
        scope: interaction.request.scope,
        roomRef: interaction.request.roomRef,
        transportStrategy: interaction.request.transport,
        durableCatchUp: interaction.request.durableCatchUp
    };
}
