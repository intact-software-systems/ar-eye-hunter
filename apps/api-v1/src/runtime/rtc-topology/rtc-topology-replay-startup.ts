import type {
    RtcTopologyReplayDiagnosticsSink,
    RtcTopologyReplayWakeSource
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-diagnostics.ts';
import {
    RtcTopologyReplayService,
    type RtcTopologyReplayEntryHandler,
    type RtcTopologyReplayPort
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts';

import type { ApiV1TopologyReplayConfiguration } from '../../configuration/api-v1-configuration.ts';

interface ApiRtcTopologyReplayStartupOptions {
    readonly mode: ApiV1TopologyReplayConfiguration['mode'];
    readonly consumerStreamId: string;
    readonly repository: RtcTopologyReplayPort;
    readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
    readonly startupBarrier?: Promise<void>;
}

interface ApiRtcTopologyReplayAttachment {
    readonly entryHandler: RtcTopologyReplayEntryHandler;
    readonly hydrateGap: (signal: AbortSignal) => Promise<void>;
}

export interface ApiRtcTopologyReplayLifecycle {
    readonly readiness: Promise<void>;
    readonly healthFailure: Promise<never>;
    attach(attachment: ApiRtcTopologyReplayAttachment): void;
    wake(source: RtcTopologyReplayWakeSource): void;
    whenIdle(): Promise<void>;
    stop(): Promise<void>;
}

export function startApiRtcTopologyReplay(
    options: ApiRtcTopologyReplayStartupOptions
): ApiRtcTopologyReplayLifecycle {
    if (options.mode === 'disabled') {
        return disabledLifecycle();
    }

    let resolveReadiness: () => void = () => undefined;
    let rejectReadiness: (error: Error) => void = () => undefined;
    const readiness = new Promise<void>((resolve, reject) => {
        resolveReadiness = resolve;
        rejectReadiness = reject;
    });
    let rejectHealthFailure: (error: Error) => void = () => undefined;
    const healthFailure = new Promise<never>((_resolve, reject) => {
        rejectHealthFailure = reject;
    });
    void healthFailure.catch(() => undefined);

    const pendingWakeSources = new Set<RtcTopologyReplayWakeSource>();
    let service: RtcTopologyReplayService | undefined;
    let attached = false;
    let stopped = false;
    return {
        readiness,
        healthFailure,
        attach: (attachment) => {
            if (attached) {
                throw new Error('RTC topology replay is already attached');
            }
            attached = true;
            if (stopped) {
                rejectReadiness(new Error('RTC topology replay stopped before attachment'));
                return;
            }
            service = new RtcTopologyReplayService({
                consumerStreamId: options.consumerStreamId,
                repository: options.repository,
                entryHandler: attachment.entryHandler,
                hydrateGap: attachment.hydrateGap,
                diagnostics: options.diagnostics,
                onHealthFailure: rejectHealthFailure
            });
            void (options.startupBarrier ?? Promise.resolve())
                .then(async () => await service!.start())
                .then(resolveReadiness, (error) =>
                    rejectReadiness(
                        error instanceof Error
                            ? error
                            : new Error('RTC topology replay startup failed with a non-Error value')
                    ));
            for (const source of pendingWakeSources) {
                service.wake(source);
            }
            pendingWakeSources.clear();
        },
        wake: (source) => {
            if (stopped) {
                return;
            }
            if (service) {
                service.wake(source);
            }
            else {
                pendingWakeSources.add(source);
            }
        },
        whenIdle: async () => await service?.whenIdle(),
        stop: async () => {
            if (stopped) {
                return;
            }
            stopped = true;
            pendingWakeSources.clear();
            await service?.stop();
        }
    };
}

function disabledLifecycle(): ApiRtcTopologyReplayLifecycle {
    return {
        readiness: Promise.resolve(),
        healthFailure: new Promise<never>(() => undefined),
        attach: () => undefined,
        wake: () => undefined,
        whenIdle: () => Promise.resolve(),
        stop: () => Promise.resolve()
    };
}
