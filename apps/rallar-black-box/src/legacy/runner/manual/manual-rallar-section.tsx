import { useEffect, useState } from 'react';

import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarConnectionOperations } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { useNow } from '../../shared/use-now.ts';
import { CommandHistoryPanel } from '../advanced/CommandHistoryPanel.tsx';
import { ManualRallarWorkbenchPanel, type ManualRallarWorkbenchPanelProps } from './manual-rallar-workbench-panel.tsx';
import { ReceivedDataInboxPanel } from './received-data-inbox-panel.tsx';

export interface ManualRallarSectionProps extends ManualRallarWorkbenchPanelProps {
    readonly active: boolean;
    readonly history: readonly RallarBlackBoxTestResult[];
    /** Absent until the operator selects a command in the history. */
    readonly selectedCommandId: string | undefined;
}

export function ManualRallarSection({
    active,
    state,
    bootstrap,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    history,
    selectedCommandId,
    onSelectCommand,
    onGlobalValueChange
}: ManualRallarSectionProps) {
    return (
        <>
            <ManualRallarWorkbenchPanel
                state={state}
                bootstrap={bootstrap}
                authSession={authSession}
                globalValues={globalValues}
                globalValuesEdited={globalValuesEdited}
                busy={busy}
                onSelectCommand={onSelectCommand}
                onGlobalValueChange={onGlobalValueChange}
            />
            {active && (
                <>
                    <ManualCurrentRtcCaptureReadout />
                    <ReceivedDataInboxPanel
                        state={state}
                        onSelectCommand={onSelectCommand}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={onSelectCommand}
                    />
                </>
            )}
        </>
    );
}

function ManualCurrentRtcCaptureReadout() {
    const [facade, setFacade] = useState<RallarConnectionOperations | undefined>();
    const [loadFailed, setLoadFailed] = useState(false);
    useEffect(() => {
        let active = true;
        loadBrowserRallarFacade().then(
            (loaded) => {
                if (active) {
                    setFacade(loaded);
                }
            },
            () => {
                if (active) {
                    setLoadFailed(true);
                }
            }
        );
        return () => {
            active = false;
        };
    }, []);
    useNow(250);

    return (
        <section className="panel" aria-label="Current RTC capture">
            <div className="panel-heading">
                <h2>Current RTC capture</h2>
            </div>
            <p>
                {facade
                    ? toCurrentRtcCaptureText(facade.rtcCapture())
                    : loadFailed
                    ? 'Unavailable: read-failed'
                    : 'Loading current capture receipt'}
            </p>
        </section>
    );
}

function toCurrentRtcCaptureText(receipt: RtcSignalingDiagnostics.CaptureReceipt | undefined): string {
    if (receipt === undefined) {
        return 'Unavailable: absent';
    }
    const application = receipt.application.status === 'applied'
        ? `Applied ${receipt.application.mode}`
        : `Unavailable: ${receipt.application.reason}`;
    return `Requested ${receipt.configuration.mode} (${receipt.configuration.origin}); ${application}; ` +
        `connection ${toRtcCaptureReadoutText(receipt.connectionId)}; ` +
        `native scope ${toRtcCaptureReadoutText(receipt.nativeScopeId)}; ` +
        `native ${toRtcCaptureReadoutText(receipt.nativeAvailability)}; coverage ${receipt.nativeCoverage}`;
}

function toRtcCaptureReadoutText(readout: RtcSignalingDiagnostics.Readout<string>): string {
    return readout.status === 'observed' ? readout.value : `unavailable: ${readout.reason}`;
}
