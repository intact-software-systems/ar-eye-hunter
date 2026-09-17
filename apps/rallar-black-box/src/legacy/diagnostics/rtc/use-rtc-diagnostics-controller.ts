import type {
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useMemo, useState } from 'react';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
    runDirectRallarStatusCheck
} from '../../../direct-rallar-operations.ts';
import type { ManualWorkbenchAction } from '../../../manual-workbench.ts';
import {
    computeRtcDiagnostics,
    computeRtcPerformanceView,
    DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT
} from '../../../rtc-diagnostics.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export interface UseRtcDiagnosticsControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    /** Absent while the browser is signed out; the direct RTC actions then stay disabled. */
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
    readonly busy: boolean;
    onSelectCommand(commandId: string): void;
}

export function useRtcDiagnosticsController({
    state,
    bootstrap,
    authSession,
    globalValues,
    busy,
    onSelectCommand
}: UseRtcDiagnosticsControllerInput) {
    const diagnostics = useMemo(() => computeRtcDiagnostics(state, Date.now()), [state]);
    const rtcPerformance = useMemo(
        () =>
            computeRtcPerformanceView({
                diagnostics,
                state,
                distributedMonitor: undefined,
                histogramBucketCount: DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT
            }),
        [diagnostics, state]
    );
    const [sequence, setSequence] = useState(1);
    const [bundleVisible, setBundleVisible] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const providerMode = bootstrap.providerMode;
    const canRunDirect = providerMode === 'browser-rallar' && Boolean(authSession) && !busy;
    const bundleText = useMemo(
        () => redactedJson(diagnostics.bundle, state, authSession),
        [authSession, diagnostics.bundle, state]
    );
    const directContext = (): Parameters<typeof runDirectRallarStatusCheck>[0] => ({
        providerMode,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        roomId: globalValues.roomId,
        actor: authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'rtc-diagnostics',
        authSession,
        timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
    });
    const recordRtcDiagnostic = (
        topic: string,
        payload: unknown,
        lastAction: string,
        severity: RallarBlackBoxTestRuntimeEventInput['severity'] = 'info'
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                kind: 'diagnostic',
                topic,
                context: directContext(),
                transport: 'realtime',
                severity,
                payload
            }),
            lastAction
        );
    };
    const runAction = async (
        label: string,
        action: ManualWorkbenchAction | 'reconnect' | 'cleanup'
    ): Promise<void> => {
        setLocalError(undefined);
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'RTC Diagnostics actions require provider=browser-rallar.'
                );
            }
            if (!authSession) {
                throw new Error(
                    'RTC Diagnostics actions require a logged-in browser session.'
                );
            }
            const facade = await loadBrowserRallarFacade();
            const context = directContext();
            configureDirectRallarFacade(facade, context);
            if (
                action === 'reconnect' ||
                action === 'cleanup' ||
                action === 'close'
            ) {
                await facade.disconnect();
            }
            let result: unknown;
            if (
                action === 'cleanup' ||
                action === 'close' ||
                action === 'reset'
            ) {
                result = {
                    action,
                    disconnected: true,
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status()
                };
            }
            else {
                const startResult = await facade.start({
                    connect: true,
                    refreshRooms: false,
                    refreshPeople: false,
                    timeoutMs: context.timeoutMs
                });
                if (context.roomId) {
                    await facade.rooms.join(context.roomId, {
                        scope: {
                            applicationId: context.applicationId,
                            workspaceId: context.workspaceId
                        },
                        timeoutMs: context.timeoutMs
                    });
                }
                result = {
                    action,
                    connected: startResult.connected || facade.isConnected(),
                    status: facade.status(),
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status(),
                    realtimeHealth: facade.realtime.health()
                };
            }
            setSequence((current) => current + 1);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                result,
                label
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                { error: message },
                `${label} failed`,
                'error'
            );
        }
    };
    const copyBundle = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(bundleText);
        }
    };

    return {
        diagnostics,
        rtcPerformance,
        bundleVisible,
        setBundleVisible,
        canRunDirect,
        bundleText,
        localError,
        runAction,
        copyBundle
    };
}

export type RtcDiagnosticsControllerModel = ReturnType<typeof useRtcDiagnosticsController>;
