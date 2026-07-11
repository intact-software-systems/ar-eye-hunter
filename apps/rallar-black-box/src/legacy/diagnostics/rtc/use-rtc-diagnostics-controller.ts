import { useMemo, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
    runDirectRallarStatusCheck,
} from '../../../direct-rallar-operations.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    type ManualWorkbenchAction,
} from '../../../manual-workbench.ts';
import {
    deriveRtcDiagnostics,
    deriveRtcPerformanceView,
} from '../../../rtc-diagnostics.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export type UseRtcDiagnosticsControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}>;

export function useRtcDiagnosticsController({
    state,
    bootstrap,
    authSession,
    globalValues,
    busy,
    onSelectCommand,
}: UseRtcDiagnosticsControllerInput) {
    const diagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const rtcPerformance = useMemo(
        () => deriveRtcPerformanceView({ diagnostics, state }),
        [diagnostics, state],
    );
    const [sequence, setSequence] = useState(1);
    const [bundleVisible, setBundleVisible] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const providerMode = bootstrap.providerMode;
    const canRunDirect =
        providerMode === 'browser-rallar' && Boolean(authSession) && !busy;
    const bundleText = useMemo(
        () => redactedJson(diagnostics.bundle, state, authSession),
        [authSession, diagnostics.bundle, state],
    );
    const directContext = (): Parameters<
        typeof runDirectRallarStatusCheck
    >[0] => ({
        providerMode,
        apiBaseUrl: globalValues?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId:
            globalValues?.applicationId ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            globalValues?.workspaceId ??
            DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        roomId: globalValues?.roomId ?? bootstrap.roomId,
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'rtc-diagnostics',
        authSession,
        timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
    });
    const recordRtcDiagnostic = (
        topic: string,
        payload: unknown,
        lastAction: string,
        severity: RallarBlackBoxTestRuntimeEventInput['severity'] = 'info',
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: directContext(),
                transport: 'realtime',
                severity,
                payload,
            }),
            lastAction,
        );
    };
    const runAction = async (
        label: string,
        action: ManualWorkbenchAction | 'reconnect' | 'cleanup',
    ): Promise<void> => {
        setLocalError(undefined);
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'RTC Diagnostics actions require provider=browser-rallar.',
                );
            }
            if (!authSession) {
                throw new Error(
                    'RTC Diagnostics actions require a logged-in browser session.',
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
                    rtcStatus: facade.rtc.status(),
                };
            } else {
                const startResult = await facade.start({
                    connect: true,
                    refreshRooms: false,
                    refreshPeople: false,
                    timeoutMs: context.timeoutMs,
                });
                if (context.roomId) {
                    await facade.rooms.join(context.roomId, {
                        scope: {
                            applicationId: context.applicationId,
                            workspaceId: context.workspaceId,
                        },
                        timeoutMs: context.timeoutMs,
                    });
                }
                result = {
                    action,
                    connected: startResult.connected || facade.isConnected(),
                    status: facade.status(),
                    wsStatus: facade.ws.status(),
                    rtcStatus: facade.rtc.status(),
                    realtimeHealth: facade.realtime.health(),
                };
            }
            setSequence((current) => current + 1);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                result,
                label,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordRtcDiagnostic(
                `rallar.direct.rtc_diagnostics.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                { error: message },
                `${label} failed`,
                'error',
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
        copyBundle,
    };
}

export type RtcDiagnosticsControllerModel = ReturnType<
    typeof useRtcDiagnosticsController
>;
