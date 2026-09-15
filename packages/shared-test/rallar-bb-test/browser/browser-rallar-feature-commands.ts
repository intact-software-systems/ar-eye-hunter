import { toError } from '@shared/resilience/to-error.ts';
import { normalizeRallarBlackBoxRuntimeDiagnostic } from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';

import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import type {
    CommandWithId,
    RallarBlackBoxBrowserRallarRuntime,
    RallarBlackBoxBrowserRallarRuntimeResult
} from './browser-command-contracts.ts';
import type { BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { decodeBrowserCommandRecord, toBrowserCommandFields } from './browser-command-values.ts';

type FeatureName = 'crdt' | 'director' | 'formation';

interface FeatureDiagnostic {
    readonly topic: string;
    readonly severity: 'info' | 'error';
    readonly value: RallarBlackBoxBrowserRallarRuntimeResult;
    readonly error: Error | undefined;
}

interface RunFeatureCommandInput {
    readonly command: CommandWithId;
    readonly context: RallarBlackBoxTestCommandContext;
    readonly successTopic: string;
    readonly failureTopic: string;
    readonly failureValue: RallarBlackBoxTestRecord;
    readonly invoke: () => Promise<RallarBlackBoxBrowserRallarRuntimeResult>;
}

const CRDT_COMMANDS = [
    { kind: 'crdt.open', method: 'open', successTopic: 'rallar.bb.crdt.opened' },
    { kind: 'crdt.apply', method: 'apply', successTopic: 'rallar.bb.crdt.applied' },
    { kind: 'crdt.read', method: 'read', successTopic: 'rallar.bb.crdt.read' },
    { kind: 'crdt.sync', method: 'sync', successTopic: 'rallar.bb.crdt.synced' },
    { kind: 'crdt.health', method: 'health', successTopic: 'rallar.bb.crdt.health' },
    { kind: 'crdt.wait', method: 'wait', successTopic: 'rallar.bb.crdt.wait_matched' },
    { kind: 'crdt.undo', method: 'undo', successTopic: 'rallar.bb.crdt.undone' },
    { kind: 'crdt.redo', method: 'redo', successTopic: 'rallar.bb.crdt.redone' },
    { kind: 'crdt.close', method: 'close', successTopic: 'rallar.bb.crdt.closed' },
    { kind: 'crdt.destroy', method: 'destroy', successTopic: 'rallar.bb.crdt.destroyed' }
] as const;

const DIRECTOR_COMMANDS = [
    { kind: 'director.appoint', method: 'appoint', successTopic: 'rallar.bb.director.appointed' },
    { kind: 'director.resign', method: 'resign', successTopic: 'rallar.bb.director.resigned' },
    { kind: 'director.status', method: 'status', successTopic: 'rallar.bb.director.status' },
    { kind: 'director.relay.start', method: 'relayStart', successTopic: 'rallar.bb.director.relay_started' },
    { kind: 'director.intent', method: 'intent', successTopic: 'rallar.bb.director.intent_sent' },
    { kind: 'director.sync.request', method: 'syncRequest', successTopic: 'rallar.bb.director.sync_requested' },
    { kind: 'director.relay.stop', method: 'relayStop', successTopic: 'rallar.bb.director.relay_stopped' }
] as const;

const FORMATION_COMMANDS = [
    { kind: 'formation.command', method: 'command', successTopic: 'rallar.bb.formation.commanded' },
    { kind: 'formation.readiness', method: 'readiness', successTopic: 'rallar.bb.formation.ready' }
] as const;

const UNSUPPORTED_FEATURE_MESSAGES: Readonly<Record<FeatureName, string>> = {
    crdt: 'Browser Rallar runtime does not support CRDT commands.',
    director: 'Browser Rallar runtime does not support director commands.',
    formation: 'Browser Rallar runtime does not support formation commands.'
};

/** Runs the CRDT, director and formation commands against the page runtime's optional feature runtimes. */
export class BrowserRallarFeatureCommands {
    private readonly environment: BrowserCommandEnvironment;

    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }

    async dispatch(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const crdt = CRDT_COMMANDS.find((entry) => entry.kind === command.kind);
        if (crdt) {
            return await this.runCrdtCommand(command, context, crdt);
        }
        const director = DIRECTOR_COMMANDS.find((entry) => entry.kind === command.kind);
        if (director) {
            const runtime = this.requireFeatureRuntime(command, context, 'director');
            const input = this.toRoomScopedRuntimeInput(command, context);
            return await runFeatureCommand(this.environment, {
                command,
                context,
                successTopic: director.successTopic,
                failureTopic: 'rallar.bb.director.failed',
                failureValue: { method: director.method, kind: command.kind, handle: input.handle },
                invoke: () => runtime[director.method](input)
            });
        }
        const formation = FORMATION_COMMANDS.find((entry) => entry.kind === command.kind);
        return formation ? await this.runFormationCommand(command, context, formation) : undefined;
    }

    private async runCrdtCommand(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        selection: (typeof CRDT_COMMANDS)[number]
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireFeatureRuntime(command, context, 'crdt');
        const input = this.toCrdtRuntimeInput(command, context);
        const { method, successTopic } = selection;
        if (method === 'wait') {
            recordFeatureDiagnostic(command, context, {
                topic: 'rallar.bb.crdt.waiting',
                severity: 'info',
                value: {
                    method,
                    kind: command.kind,
                    handle: input.handle,
                    conditions: input.conditions,
                    timeoutMs: input.timeoutMs,
                    intervalMs: input.intervalMs,
                    stableForMs: input.stableForMs
                },
                error: undefined
            });
        }
        return await runFeatureCommand(this.environment, {
            command,
            context,
            successTopic,
            failureTopic: 'rallar.bb.crdt.failed',
            failureValue: { method, kind: command.kind, handle: input.handle },
            invoke: () => runtime[method](input)
        });
    }

    private async runFormationCommand(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        selection: (typeof FORMATION_COMMANDS)[number]
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireFeatureRuntime(command, context, 'formation');
        const input = this.toRoomScopedRuntimeInput(command, context);
        return await runFeatureCommand(this.environment, {
            command,
            context,
            successTopic: selection.successTopic,
            failureTopic: 'rallar.bb.formation.failed',
            failureValue: { method: selection.method, kind: command.kind },
            invoke: () => runtime[selection.method](input)
        });
    }

    /** A provider without the feature records the refusal before the command fails. */
    private requireFeatureRuntime<F extends FeatureName>(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        feature: F
    ): NonNullable<RallarBlackBoxBrowserRallarRuntime[F]> {
        const runtime = this.environment.rallarRuntime?.[feature];
        if (runtime) {
            return runtime;
        }
        const message = UNSUPPORTED_FEATURE_MESSAGES[feature];
        const refusal = feature === 'formation'
            ? { kind: command.kind }
            : { kind: command.kind, handle: toBrowserCommandFields(command).handle, reason: 'unsupported-runtime' };
        const topic = `rallar.bb.${feature}.failed`;
        context.recordEvent({
            kind: 'diagnostic',
            topic,
            commandId: command.commandId,
            severity: 'error',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic,
                severity: 'error',
                commandId: command.commandId,
                message,
                data: refusal,
                payload: refusal,
                source: 'browser-adapter'
            })
        });
        throw new Error(message);
    }

    private toCrdtRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): RallarBlackBoxTestRecord {
        const config = context.config();
        const resolved = toBrowserCommandFields(replaceCommandPlaceholders(command, {
            config,
            session: this.environment.readSession(),
            wsTicket: undefined
        }));
        if (command.kind !== 'crdt.open') {
            return resolved;
        }
        const configuredRallar = config?.rallar ?? {};
        return {
            ...resolved,
            handle: resolved.handle === undefined ? command.commandId : resolved.handle,
            apiBaseUrl: resolved.apiBaseUrl ?? config?.apiBaseUrl ?? configuredRallar.apiBaseUrl,
            actor: resolved.actor ?? config?.actor,
            sessionId: resolved.sessionId ?? config?.sessionId ?? configuredRallar.sessionId,
            roomId: resolved.roomId ?? config?.roomId,
            rallar: { ...configuredRallar, ...decodeBrowserCommandRecord(resolved.rallar) }
        };
    }

    private toRoomScopedRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): RallarBlackBoxTestRecord {
        const config = context.config();
        const resolved = toBrowserCommandFields(replaceCommandPlaceholders(command, {
            config,
            session: this.environment.readSession(),
            wsTicket: undefined
        }));
        const configuredRallar = config?.rallar ?? {};
        const defaults = config?.defaults ?? {};
        const roomId = resolved.roomId ?? config?.roomId ?? defaults.groupId;
        const applicationId = resolved.applicationId ?? configuredRallar.applicationId ?? defaults.applicationId;
        const workspaceId = resolved.workspaceId ?? configuredRallar.workspaceId ?? defaults.workspaceId;
        return {
            ...resolved,
            ...(roomId !== undefined ? { roomId } : {}),
            ...(applicationId !== undefined ? { applicationId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            actor: resolved.actor ?? config?.actor,
            sessionId: resolved.sessionId ?? config?.sessionId ?? configuredRallar.sessionId,
            rallar: { ...configuredRallar, ...decodeBrowserCommandRecord(resolved.rallar) }
        };
    }
}

/** One feature command inside the command's abort scope, recording its success or its failure. */
async function runFeatureCommand(
    environment: BrowserCommandEnvironment,
    input: RunFeatureCommandInput
): Promise<RallarBlackBoxTestCommandOutcome> {
    const { command, context } = input;
    const abort = createBrowserCommandAbortScope(command, context, environment.now);
    try {
        const value = await withBrowserCommandAbort(input.invoke(), abort.signal);
        recordFeatureDiagnostic(command, context, {
            topic: input.successTopic,
            severity: 'info',
            value,
            error: undefined
        });
        return { status: 'ok', value, nextStatus: context.state().status };
    }
    catch (caught) {
        const error = toError(caught);
        recordFeatureDiagnostic(command, context, {
            topic: input.failureTopic,
            severity: 'error',
            value: input.failureValue,
            error
        });
        throw error;
    }
    finally {
        abort.cleanup();
    }
}

function recordFeatureDiagnostic(
    command: CommandWithId,
    context: RallarBlackBoxTestCommandContext,
    diagnostic: FeatureDiagnostic
): void {
    context.recordEvent({
        kind: 'diagnostic',
        topic: diagnostic.topic,
        commandId: command.commandId,
        severity: diagnostic.severity,
        payload: normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: diagnostic.topic,
            severity: diagnostic.severity,
            commandId: command.commandId,
            message: diagnostic.error?.message,
            data: diagnostic.value,
            payload: diagnostic.value,
            error: diagnostic.error,
            source: 'browser-adapter'
        })
    });
}
