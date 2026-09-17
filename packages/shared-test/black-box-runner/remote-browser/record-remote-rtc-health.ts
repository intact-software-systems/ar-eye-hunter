// deno-lint-ignore-file no-explicit-any
import type { Either } from '../../../shared/resilience/Either.ts';

import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '../../rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { BlackBoxFetch } from '../execution/black-box-scenario-context.ts';
import {
    rememberRtcDiagnostic,
    toRtcExpectedConnectionName
} from '../rtc/rtc-wait-expectations.ts';
import {
    runRallarRemoteBrowserCommand,
    toRemoteResultDetails
} from './rallar-remote-browser-control-client.ts';
import type { RallarRemoteBrowserConfig } from './resolve-rallar-remote-browser-config.ts';

export interface RecordRemoteRtcHealthInput {
    readonly remote: RallarRemoteBrowserConfig;
    readonly fetch: BlackBoxFetch;
    readonly context: any;
    readonly interaction: any;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
}

/** Runs one health command and, when the agent answers it, records the health as the connection's diagnostics. */
export async function recordRemoteRtcHealth(
    input: RecordRemoteRtcHealthInput
): Promise<Either<Error, ControlResultEnvelope>> {
    const { remote, fetch, context, interaction, commandId, command } = input;
    const probe = await runRallarRemoteBrowserCommand({ remote, fetch, context, command: { ...command, commandId } });
    probe.foldRight((result) => {
        if (result.ok) {
            appendRemoteRtcHealthDiagnostic({
                ...input,
                result,
                connectionName: toRtcExpectedConnectionName(interaction)
            });
        }
    });
    return probe;
}

interface RemoteRtcHealthAnswer extends RecordRemoteRtcHealthInput {
    readonly result: ControlResultEnvelope;
    readonly connectionName: string;
}

function appendRemoteRtcHealthDiagnostic(answer: RemoteRtcHealthAnswer): void {
    const { context, commandId, result, connectionName } = answer;
    const health = toRemoteResultDetails(result);
    if (context.rtcConnections?.[connectionName]) {
        context.rtcConnections[connectionName].diagnostics = health;
    }
    rememberRtcDiagnostic(connectionName, {
        kind: 'diagnostic',
        topic: 'rallar.remote-browser.health',
        severity: 'info',
        atEpochMs: context.dependencies.now(),
        commandId,
        connection: connectionName,
        provider: 'rallar-remote-browser',
        data: health,
        event: result
    }, context);
}
