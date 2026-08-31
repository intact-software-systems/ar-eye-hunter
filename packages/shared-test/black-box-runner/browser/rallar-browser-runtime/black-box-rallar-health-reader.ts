import type { RallarRealtimeLaneHealth } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcDiagnostics } from '@shared-web/browser/rallar-rtc-facade.ts';
import { resolveBlackBoxRallarLaneId, resolveBlackBoxRallarTransport } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from './browser-rallar-runtime-composition.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarHealthDiagnostics,
    BlackBoxRallarHealthInput
} from './contracts.ts';
import type { BlackBoxRallarRuntimeDiagnostics } from './diagnostics.ts';
import { blackBoxRallarScopeDiagnosticsOf } from './policy.ts';
export namespace BlackBoxRallarHealthReader {
    export interface Dependencies {
        readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    }
    export interface Read {
        readonly config: BlackBoxRallarConnectionConfig | undefined;
        readonly crdt: BlackBoxRallarHealthDiagnostics['crdt'];
        readonly director: BlackBoxRallarHealthDiagnostics['director'];
        readonly input: BlackBoxRallarHealthInput;
    }
    export interface Status {
        readonly rallarStatus: ReturnType<BlackBoxBrowserRallarRuntimeDependency['status']>;
        readonly rallarConnected: boolean;
        readonly wsStatus: ReturnType<BlackBoxBrowserRallarRuntimeDependency['ws']['status']>;
        readonly rtcStatus: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtc']['status']>;
    }
}
export class BlackBoxRallarHealthReader {
    readonly #rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly #runtimeDiagnostics: BlackBoxRallarRuntimeDiagnostics;
    constructor(dependencies: BlackBoxRallarHealthReader.Dependencies) {
        this.#rallar = dependencies.rallar;
        this.#runtimeDiagnostics = dependencies.diagnostics;
    }
    readHealth = (config: BlackBoxRallarConnectionConfig): readonly RallarRealtimeLaneHealth[] => {
        if (resolveBlackBoxRallarTransport(config) !== 'realtime') {
            return [];
        }

        return this.#rallar.realtime.health({
            laneIds: [resolveBlackBoxRallarLaneId(config)],
            peerIds: config.rallar.peerIds
        });
    };
    wsStatusFor = (): ReturnType<BlackBoxBrowserRallarRuntimeDependency['ws']['status']> => this.#rallar.ws.status();
    rtcStatusFor = (
        config: BlackBoxRallarConnectionConfig
    ): ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtc']['status']> =>
        this.#rallar.rtc.status({
            laneId: resolveBlackBoxRallarTransport(config) === 'realtime'
                ? resolveBlackBoxRallarLaneId(config)
                : undefined
        });
    #rtcDiagnosticsFor = async (
        config: BlackBoxRallarConnectionConfig | undefined
    ): Promise<RallarRtcDiagnostics> => {
        const laneId = config && resolveBlackBoxRallarTransport(config) === 'realtime'
            ? resolveBlackBoxRallarLaneId(config)
            : undefined;
        return await this.#rallar.rtc.diagnostics(laneId ? { laneIds: [laneId] } : undefined);
    };
    statusDiagnostics = (config: BlackBoxRallarConnectionConfig): BlackBoxRallarHealthReader.Status => {
        return {
            rallarStatus: this.#rallar.status(),
            rallarConnected: this.#rallar.isConnected(),
            wsStatus: this.wsStatusFor(),
            rtcStatus: this.rtcStatusFor(config)
        };
    };
    health = async (
        read: BlackBoxRallarHealthReader.Read
    ): Promise<BlackBoxRallarHealthDiagnostics> => {
        const config = read.config;
        const transport = config ? resolveBlackBoxRallarTransport(config) : undefined;
        const rtcLaneId = transport === 'realtime' && config ? resolveBlackBoxRallarLaneId(config) : undefined;
        const rtcStatus = this.#rallar.rtc.status({ laneId: rtcLaneId });
        let rtcDiagnostics: RallarRtcDiagnostics | undefined;
        let rtcDiagnosticsError: unknown;
        if (read.input.includeRtcDiagnostics === true) {
            try {
                rtcDiagnostics = await this.#rtcDiagnosticsFor(config);
            }
            catch (error) {
                rtcDiagnosticsError = this.#runtimeDiagnostics.serializeError(error);
                this.#runtimeDiagnostics.emitError(config, 'rallar.browser.rtc.diagnostics_failed', error);
            }
        }
        return {
            connected: this.#rallar.isConnected(),
            status: this.#rallar.status(),
            wsStatus: this.wsStatusFor(),
            rtcStatus,
            connection: config?.connection,
            actor: config?.actor,
            transport,
            roomId: config?.roomId,
            ...(config ? blackBoxRallarScopeDiagnosticsOf(config) : {}),
            session: this.#rallar.session(),
            health: config ? this.readHealth(config) : [],
            ...(rtcDiagnostics !== undefined ? { rtcDiagnostics } : {}),
            ...(rtcDiagnosticsError !== undefined ? { rtcDiagnosticsError } : {}),
            crdt: read.crdt,
            director: read.director
        };
    };
}
