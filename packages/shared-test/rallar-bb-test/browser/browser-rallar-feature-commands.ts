import {
    normalizeRallarBlackBoxRuntimeDiagnostic
} from '../diagnostics.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome
} from '../rallar-black-box-test-contracts.ts';

import { toError } from '@shared/resilience/to-error.ts';
import { createBrowserCommandAbortScope, withBrowserCommandAbort } from './browser-command-cancellation.ts';
import {
    CommandWithId,
    RallarBlackBoxBrowserRallarCrdtMethod,
    RallarBlackBoxBrowserRallarCrdtRuntime,
    RallarBlackBoxBrowserRallarDirectorMethod,
    RallarBlackBoxBrowserRallarDirectorRuntime,
    RallarBlackBoxBrowserRallarFormationRuntime
} from './browser-command-contracts.ts';
import { BrowserCommandEnvironment } from './browser-command-environment.ts';
import { replaceCommandPlaceholders } from './browser-command-placeholders.ts';
import { toBrowserCommandRecord } from './browser-command-values.ts';

interface BrowserFeatureDiagnostic {
    readonly topic: string;
    readonly severity: 'info' | 'error';
    readonly value: unknown;
    readonly error: Error | undefined;
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
const FORMATION_COMMANDS = [{
    kind: 'formation.command',
    method: 'command',
    successTopic: 'rallar.bb.formation.commanded'
}, { kind: 'formation.readiness', method: 'readiness', successTopic: 'rallar.bb.formation.ready' }] as const;
export class BrowserRallarFeatureCommands {
    private readonly environment: BrowserCommandEnvironment;

    async dispatch(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const crdt = CRDT_COMMANDS.find((entry) => entry.kind === command.kind);
        if (crdt) {
            return await this.dispatchCrdt(command, context, crdt);
        }
        const director = DIRECTOR_COMMANDS.find((entry) => entry.kind === command.kind);
        if (director) {
            return await this.dispatchDirector(command, context, director);
        }
        const formation = FORMATION_COMMANDS.find((entry) => entry.kind === command.kind);
        return formation ? await this.dispatchFormation(command, context, formation) : undefined;
    }
    constructor(environment: BrowserCommandEnvironment) {
        this.environment = environment;
    }
    private requireRallarCrdtRuntime(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): RallarBlackBoxBrowserRallarCrdtRuntime {
        const crdt = this.environment.rallarRuntime?.crdt;
        if (crdt) {
            return crdt;
        }

        const message = 'Browser Rallar runtime does not support CRDT commands.';
        const payload = normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.crdt.failed',
            severity: 'error',
            commandId: command.commandId,
            message,
            data: {
                kind: command.kind,
                handle: toBrowserCommandRecord(command).handle,
                reason: 'unsupported-runtime'
            },
            payload: {
                kind: command.kind,
                handle: toBrowserCommandRecord(command).handle,
                reason: 'unsupported-runtime'
            },
            source: 'browser-adapter'
        });
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.crdt.failed',
            commandId: command.commandId,
            severity: 'error',
            payload
        });
        throw new Error(message);
    }

    private requireRallarDirectorRuntime(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): RallarBlackBoxBrowserRallarDirectorRuntime {
        const director = this.environment.rallarRuntime?.director;
        if (director) {
            return director;
        }

        const message = 'Browser Rallar runtime does not support director commands.';
        const payload = normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.director.failed',
            severity: 'error',
            commandId: command.commandId,
            message,
            data: {
                kind: command.kind,
                handle: toBrowserCommandRecord(command).handle,
                reason: 'unsupported-runtime'
            },
            payload: {
                kind: command.kind,
                handle: toBrowserCommandRecord(command).handle,
                reason: 'unsupported-runtime'
            },
            source: 'browser-adapter'
        });
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.director.failed',
            commandId: command.commandId,
            severity: 'error',
            payload
        });
        throw new Error(message);
    }

    private requireRallarFormationRuntime(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): RallarBlackBoxBrowserRallarFormationRuntime {
        const formation = this.environment.rallarRuntime?.formation;
        if (formation) {
            return formation;
        }

        const message = 'Browser Rallar runtime does not support formation commands.';
        const payload = normalizeRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.bb.formation.failed',
            severity: 'error',
            commandId: command.commandId,
            message,
            data: { kind: command.kind },
            payload: { kind: command.kind },
            source: 'browser-adapter'
        });
        context.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.bb.formation.failed',
            commandId: command.commandId,
            severity: 'error',
            payload
        });
        throw new Error(message);
    }

    private toCrdtRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Record<string, unknown> {
        const resolved = replaceCommandPlaceholders(command, {
            config: context.config(),
            session: this.environment.readSession()
        }) as Record<string, unknown>;

        if (command.kind === 'crdt.open') {
            const configuredRallar = toBrowserCommandRecord(context.config()?.rallar);
            return {
                ...resolved,
                handle: resolved.handle === undefined ? command.commandId : resolved.handle,
                apiBaseUrl: resolved.apiBaseUrl ??
                    context.config()?.apiBaseUrl ??
                    configuredRallar.apiBaseUrl,
                actor: resolved.actor ?? context.config()?.actor,
                sessionId: resolved.sessionId ??
                    context.config()?.sessionId ??
                    configuredRallar.sessionId,
                roomId: resolved.roomId ?? context.config()?.roomId,
                rallar: {
                    ...configuredRallar,
                    ...toBrowserCommandRecord(resolved.rallar)
                }
            };
        }

        return resolved;
    }

    private toRoomScopedRuntimeInput(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext
    ): Record<string, unknown> {
        const resolved = replaceCommandPlaceholders(command, {
            config: context.config(),
            session: this.environment.readSession()
        }) as Record<string, unknown>;
        const config = context.config();
        const configuredRallar = toBrowserCommandRecord(config?.rallar);
        const defaults = toBrowserCommandRecord(config?.defaults);
        const roomId = resolved.roomId ?? config?.roomId ?? defaults.groupId;
        const applicationId = resolved.applicationId ??
            configuredRallar.applicationId ??
            defaults.applicationId;
        const workspaceId = resolved.workspaceId ??
            configuredRallar.workspaceId ??
            defaults.workspaceId;

        return {
            ...resolved,
            ...(roomId !== undefined ? { roomId } : {}),
            ...(applicationId !== undefined ? { applicationId } : {}),
            ...(workspaceId !== undefined ? { workspaceId } : {}),
            actor: resolved.actor ?? config?.actor,
            sessionId: resolved.sessionId ?? config?.sessionId ?? configuredRallar.sessionId,
            rallar: {
                ...configuredRallar,
                ...toBrowserCommandRecord(resolved.rallar)
            }
        };
    }

    private async dispatchCrdt(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        selection: { readonly method: RallarBlackBoxBrowserRallarCrdtMethod; readonly successTopic: string; }
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireRallarCrdtRuntime(command, context);
        const input = this.toCrdtRuntimeInput(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        const { method, successTopic } = selection;
        if (method === 'wait') {
            this.recordDiagnostic(command, context, {
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
        try {
            const value = await withBrowserCommandAbort(runtime[method](input), abort.signal);
            this.recordDiagnostic(command, context, { topic: successTopic, severity: 'info', value, error: undefined });
            return { status: 'ok', value, nextStatus: context.state().status };
        }
        catch (caught) {
            const error = toError(caught);
            this.recordDiagnostic(command, context, {
                topic: 'rallar.bb.crdt.failed',
                severity: 'error',
                value: { method, kind: command.kind, handle: input.handle },
                error
            });
            throw error;
        }
        finally {
            abort.cleanup();
        }
    }

    private async dispatchDirector(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        selection: { readonly method: RallarBlackBoxBrowserRallarDirectorMethod; readonly successTopic: string; }
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireRallarDirectorRuntime(command, context);
        const input = this.toRoomScopedRuntimeInput(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        const { method, successTopic } = selection;

        try {
            const value = await withBrowserCommandAbort(runtime[method](input), abort.signal);
            this.recordDiagnostic(command, context, { topic: successTopic, severity: 'info', value, error: undefined });
            return { status: 'ok', value, nextStatus: context.state().status };
        }
        catch (caught) {
            const error = toError(caught);
            this.recordDiagnostic(command, context, {
                topic: 'rallar.bb.director.failed',
                severity: 'error',
                value: { method, kind: command.kind, handle: input.handle },
                error
            });
            throw error;
        }
        finally {
            abort.cleanup();
        }
    }

    private async dispatchFormation(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        selection: { readonly method: 'command' | 'readiness'; readonly successTopic: string; }
    ): Promise<RallarBlackBoxTestCommandOutcome> {
        const runtime = this.requireRallarFormationRuntime(command, context);
        const input = this.toRoomScopedRuntimeInput(command, context);
        const abort = createBrowserCommandAbortScope(command, context, this.environment.now);
        const { method, successTopic } = selection;

        try {
            const value = await withBrowserCommandAbort(runtime[method](input), abort.signal);
            this.recordDiagnostic(command, context, { topic: successTopic, severity: 'info', value, error: undefined });
            return { status: 'ok', value, nextStatus: context.state().status };
        }
        catch (caught) {
            const error = toError(caught);
            this.recordDiagnostic(command, context, {
                topic: 'rallar.bb.formation.failed',
                severity: 'error',
                value: { method, kind: command.kind },
                error
            });
            throw error;
        }
        finally {
            abort.cleanup();
        }
    }

    private recordDiagnostic(
        command: CommandWithId,
        context: RallarBlackBoxTestCommandContext,
        diagnostic: BrowserFeatureDiagnostic
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
}
