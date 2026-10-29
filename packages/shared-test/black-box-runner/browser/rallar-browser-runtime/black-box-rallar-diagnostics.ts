import { isRoutineBrowserDiagnostic } from '@shared-test/rallar-bb-test/browser/diagnostic-recording/is-routine-browser-diagnostic.ts';
import {
    toRallarDiagnosticsPorts,
    type RallarDiagnosticsPorts
} from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarEvent,
    BlackBoxRallarTransport
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarScopeDiagnostics } from './black-box-rallar-operation-policy.ts';
import { toBlackBoxRallarSerializedError } from './black-box-rallar-serialized-error.ts';
import type { BlackBoxBrowserDiagnosticsDependency } from './browser-rallar-runtime-composition.ts';
import { toRtcNativeObservationProjection } from './rtc-native-observation-projection.ts';

export type BlackBoxRallarConsoleWarningPattern =
    | 'unhandled-ws-message'
    | 'no-callback-for-type-id'
    | 'data-channel-name-mismatch'
    | 'peer-id-mismatch'
    | 'no-channel-for-peer'
    | 'self-connection-attempt';

export interface BlackBoxRallarConsoleWarningDiagnostics {
    readonly pattern: BlackBoxRallarConsoleWarningPattern;
    readonly source: 'console.warn';
}

interface ConsoleWarning {
    readonly topic: string;
    readonly transport: BlackBoxRallarTransport | 'ws';
    readonly pattern: BlackBoxRallarConsoleWarningPattern;
}

interface ConsoleWarningRule extends ConsoleWarning {
    readonly literal: string;
}

const WS_WARNING = { topic: 'rallar.browser.ws.unhandled_message', transport: 'ws' } as const;
const RTC_WARNING = { topic: 'rallar.browser.rtc.data_channel_warning', transport: 'realtime' } as const;

const CONSOLE_WARNING_RULES: readonly ConsoleWarningRule[] = [
    { ...WS_WARNING, literal: 'Unhandled WS message', pattern: 'unhandled-ws-message' },
    { ...WS_WARNING, literal: 'No callback for typeId', pattern: 'no-callback-for-type-id' },
    {
        ...RTC_WARNING,
        literal: 'Received data channel for different data channel name',
        pattern: 'data-channel-name-mismatch'
    },
    { ...RTC_WARNING, literal: 'does not match peerId', pattern: 'peer-id-mismatch' },
    { ...RTC_WARNING, literal: 'No channel for peer', pattern: 'no-channel-for-peer' },
    { ...RTC_WARNING, literal: 'Ignoring self-connection attempt', pattern: 'self-connection-attempt' }
];

interface RuntimeEventContext extends BlackBoxRallarScopeDiagnostics {
    readonly connection: string;
    readonly actor: string | undefined;
    readonly transport: BlackBoxRallarTransport;
    readonly roomId: string | undefined;
    readonly laneId: string;
}

export namespace BlackBoxRallarRuntimeDiagnostics {
    export interface Input {
        now(): number;
        publish(event: BlackBoxRallarEvent): void | Promise<void>;
        onPublishError(error: Error): void;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        laneIdOf(config: BlackBoxRallarConnectionConfig): string;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): BlackBoxRallarScopeDiagnostics;
    }
    export interface ErrorInput {
        readonly config: BlackBoxRallarConnectionConfig | undefined;
        readonly topic: string;
        readonly error: Error;
        readonly data?: object;
    }
}

export class BlackBoxRallarRuntimeDiagnostics {
    readonly #input: BlackBoxRallarRuntimeDiagnostics.Input;
    constructor(input: BlackBoxRallarRuntimeDiagnostics.Input) {
        this.#input = input;
    }

    emit = (event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void => {
        try {
            void Promise.resolve(this.#input.publish({ ...event, atEpochMs: this.#input.now() }))
                .catch((caught) => this.#input.onPublishError(toError(caught)));
        }
        catch (caught) {
            this.#input.onPublishError(toError(caught));
        }
    };

    emitDiagnostic = (config: BlackBoxRallarConnectionConfig, topic: string, data?: object): void => {
        this.emit({ kind: 'diagnostic', topic, ...this.context(config), data });
    };

    emitRoutineDiagnostic = (config: BlackBoxRallarConnectionConfig, topic: string): void => {
        this.emit({ kind: 'diagnostic', topic, ...this.context(config), routineBrowserDiagnostic: true });
    };

    emitLifecycleDiagnostic = (config: BlackBoxRallarConnectionConfig, topic: string, data: object): void => {
        this.emit({
            kind: 'diagnostic',
            topic,
            ...this.context(config),
            data,
            ...(isRoutineBrowserDiagnostic(topic, data) ? { routineBrowserDiagnostic: true as const } : {})
        });
    };

    emitError = (input: BlackBoxRallarRuntimeDiagnostics.ErrorInput): void => {
        this.emit({
            kind: 'diagnostic',
            topic: input.topic,
            ...(input.config ? this.context(input.config) : {}),
            data: input.data,
            error: toBlackBoxRallarSerializedError(input.error)
        });
    };

    emitConnectPhaseStarted = (config: BlackBoxRallarConnectionConfig, phase: string, data?: object): void => {
        this.emitDiagnostic(config, 'rallar.browser.connect.phase_started', { phase, ...data });
    };

    emitConnectPhaseCompleted = (config: BlackBoxRallarConnectionConfig, phase: string, data?: object): void => {
        this.emitDiagnostic(config, 'rallar.browser.connect.phase_completed', { phase, ...data });
    };

    emitConsoleWarning = (config: BlackBoxRallarConnectionConfig, texts: readonly string[]): void => {
        const warning = toConsoleWarning(texts);
        if (!warning) {
            return;
        }
        this.emit({
            kind: 'diagnostic',
            ...this.context(config),
            topic: warning.topic,
            transport: warning.transport,
            severity: 'warning',
            data: { pattern: warning.pattern, source: 'console.warn' } satisfies BlackBoxRallarConsoleWarningDiagnostics
        });
    };

    private context(config: BlackBoxRallarConnectionConfig): RuntimeEventContext {
        return {
            connection: config.connection,
            actor: config.actor,
            transport: this.#input.transportOf(config),
            roomId: config.roomId,
            ...this.#input.scopeDiagnostics(config),
            laneId: this.#input.laneIdOf(config)
        };
    }
}

export function createBlackBoxRallarDiagnosticsPorts(
    diagnostics: BlackBoxRallarRuntimeDiagnostics,
    effects: BlackBoxBrowserDiagnosticsDependency,
    almDiagnostics = true
): RallarDiagnosticsPorts {
    return toRallarDiagnosticsPorts({
        transportFaultPort: effects.faults,
        submissionReadinessFaultPort: effects.faults,
        indexedDbOperationObserver: {
            observe: (operation) => {
                effects.storage.observe(operation);
                return effects.storageFaults.observe(operation);
            }
        },
        outboundDiagnostics: (event) => {
            effects.congestion.observe(event);
            if (almDiagnostics) {
                diagnostics.emit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.outbound_diagnostics',
                    data: { ...event }
                });
            }
        },
        inboundDiagnostics: almDiagnostics
            ? Object.assign((event: ALInboundRuntimeDiagnosticsEvent) =>
                diagnostics.emit({
                    kind: 'diagnostic',
                    topic: 'rallar.browser.alm.inbound_diagnostics',
                    data: { ...event }
                }), {
                acknowledgementCapture: {
                    evidence: ALInboundAcknowledgementEvidence,
                    batchObservations: ALWorkBatchObservations
                }
            })
            : undefined,
        signalingDiagnostics: (event) => publishBlackBoxRallarSignalingDiagnostic(diagnostics, event),
        storage: (event) => {
            effects.inboundStoreCounts.observe(event);
            if (almDiagnostics) {
                publishBlackBoxRallarStorageDiagnostic(diagnostics, event);
            }
        }
    });
}

function publishBlackBoxRallarSignalingDiagnostic(
    diagnostics: BlackBoxRallarRuntimeDiagnostics,
    event: RtcSignalingDiagnostics.Event
): void {
    const native = toRtcNativeObservationProjection(event);
    if (native.recognized && !native.event) {
        return;
    }
    diagnostics.emit({
        kind: 'diagnostic',
        topic: 'rallar.browser.rtc.signaling_diagnostics',
        data: native.event ?? { ...event },
        ...(!native.recognized && isRoutineBrowserDiagnostic('rallar.browser.rtc.signaling_diagnostics', event)
            ? { routineBrowserDiagnostic: true as const }
            : {})
    });
}

function publishBlackBoxRallarStorageDiagnostic(
    diagnostics: BlackBoxRallarRuntimeDiagnostics,
    event: ALStorageEvent
): void {
    diagnostics.emit({
        kind: 'diagnostic',
        topic: event.kind === 'reset' ? 'rallar.browser.alm.storage_reset' : 'rallar.browser.alm.storage',
        data: event.kind === 'reset' ? { ...event.event } : { ...event }
    });
}

function toConsoleWarning(texts: readonly string[]): ConsoleWarning | undefined {
    return CONSOLE_WARNING_RULES.find(({ literal }) => texts.some((text) => text.includes(literal)));
}

function isConsoleWarningText(value: unknown): value is string {
    return typeof value === 'string';
}

interface ConsoleTarget {
    warn(...args: unknown[]): void;
}

export interface BlackBoxRallarConsoleDiagnostics<TConfig> {
    install(config: TConfig): () => void;
    close(): void;
}

export interface BlackBoxRallarConsoleDiagnosticsOptions<TConfig> {
    readonly console: ConsoleTarget;
    activeConfig(): TConfig | undefined;
    /** Receives the string arguments only: an argument object can carry an application payload. */
    onWarning(config: TConfig, texts: readonly string[]): void;
    restoreExisting?(): void;
    publishRestore?(restore: (() => void) | undefined): void;
}

export function createBlackBoxRallarConsoleDiagnostics<TConfig>(
    options: BlackBoxRallarConsoleDiagnosticsOptions<TConfig>
): BlackBoxRallarConsoleDiagnostics<TConfig> {
    return new ConsoleDiagnosticsPatch(options);
}

class ConsoleDiagnosticsPatch<TConfig> implements BlackBoxRallarConsoleDiagnostics<TConfig> {
    private readonly configs = new Map<symbol, TConfig>();
    private restore: (() => void) | undefined;

    private readonly options: BlackBoxRallarConsoleDiagnosticsOptions<TConfig>;

    constructor(options: BlackBoxRallarConsoleDiagnosticsOptions<TConfig>) {
        this.options = options;
    }

    install(config: TConfig): () => void {
        const token = Symbol('black-box-rallar-console-diagnostics');
        this.configs.set(token, config);
        this.ensurePatch();
        return () => {
            this.configs.delete(token);
            if (this.configs.size === 0 && this.options.activeConfig() === undefined) {
                this.close();
            }
        };
    }

    close = (): void => {
        this.restore?.();
    };

    private ensurePatch(): void {
        if (this.restore) {
            return;
        }
        this.options.restoreExisting?.();
        const previousWarn = this.options.console.warn;
        this.options.console.warn = (...args: unknown[]) => {
            previousWarn(...args);
            const active = this.options.activeConfig() ?? [...this.configs.values()].at(-1);
            if (active !== undefined) {
                this.options.onWarning(active, args.filter(isConsoleWarningText));
            }
        };
        this.restore = () => {
            this.options.console.warn = previousWarn;
            this.restore = undefined;
            this.configs.clear();
            this.options.publishRestore?.(undefined);
        };
        this.options.publishRestore?.(this.close);
    }
}
