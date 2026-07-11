import { useEffect, useRef, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import { createDirectRallarRuntimeEvent } from '../../../direct-rallar-operations.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../shared/Metric.tsx';
import { json, parseJsonText } from '../../shared/json-presentation.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

type MediaRemoteStreamRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    peerId: string;
    streamId: string;
}>;

export function MediaConsolePanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [audioEnabled, setAudioEnabled] = useState(true);
    const [videoEnabled, setVideoEnabled] = useState(true);
    const [policyText, setPolicyText] = useState(() =>
        json({
            receiveAudio: true,
            receiveVideo: true,
        }),
    );
    const [localStreamId, setLocalStreamId] = useState<string | undefined>();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [result, setResult] = useState<unknown>();
    const [remoteStreams, setRemoteStreams] = useState<
        readonly MediaRemoteStreamRow[]
    >([]);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && Boolean(authSession) && !busyAction;

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
        },
        [],
    );

    const recordMediaEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor:
                        authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'media',
                    authSession,
                },
                transport: 'realtime',
                severity,
                payload,
            }),
            lastAction,
        );
    };

    const withFacade = async <T,>(
        action: (
            facade: Awaited<ReturnType<typeof loadBrowserRallarFacade>>,
        ) => Promise<T>,
    ): Promise<T> => {
        if (!realBackendReady) {
            throw new Error('Media console requires provider=browser-rallar.');
        }
        if (!authSession) {
            throw new Error(
                'Media console requires a logged-in browser session.',
            );
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            room: globalValues.roomId
                ? {
                      roomId: globalValues.roomId,
                      roomRef: {
                          applicationId: globalValues.applicationId,
                          workspaceId: globalValues.workspaceId,
                          groupId: globalValues.roomId,
                      },
                  }
                : undefined,
        });
        await facade.start({
            connect: true,
            refreshRooms: false,
            refreshPeople: false,
            timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
        });
        return await action(facade);
    };

    const runMediaAction = async (
        label: string,
        action: () => Promise<unknown>,
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        try {
            const nextResult = await action();
            setResult(nextResult);
            recordMediaEvent(
                `rallar.direct.media.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                'info',
                nextResult,
                `${label} completed`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordMediaEvent(
                `rallar.direct.media.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                'error',
                { error: message },
                `${label} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const attachLocal = (): Promise<void> =>
        runMediaAction('Attach local stream', async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error(
                    'Browser mediaDevices.getUserMedia is not available.',
                );
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: audioEnabled,
                video: videoEnabled,
            });
            await withFacade(async (facade) => {
                await facade.media.setLocalStream(stream);
            });
            setLocalStreamId(stream.id);
            return {
                streamId: stream.id,
                tracks: stream.getTracks().map((track) => ({
                    kind: track.kind,
                    enabled: track.enabled,
                    readyState: track.readyState,
                })),
            };
        });

    const toggleAudio = (): Promise<void> =>
        runMediaAction('Set audio', async () => {
            const next = !audioEnabled;
            await withFacade(async (facade) => {
                await facade.media.setAudioEnabled(next);
            });
            setAudioEnabled(next);
            return { audioEnabled: next };
        });

    const toggleVideo = (): Promise<void> =>
        runMediaAction('Set video', async () => {
            const next = !videoEnabled;
            await withFacade(async (facade) => {
                await facade.media.setVideoEnabled(next);
            });
            setVideoEnabled(next);
            return { videoEnabled: next };
        });

    const stopLocal = (kind: 'audio' | 'video' | 'all'): Promise<void> =>
        runMediaAction(`Stop ${kind}`, async () => {
            await withFacade(async (facade) => {
                await facade.media.stopLocal(kind);
            });
            if (kind === 'all') {
                setLocalStreamId(undefined);
            }
            return { stopped: kind };
        });

    const applyPolicy = (): Promise<void> =>
        runMediaAction('Apply media policy', async () => {
            const policy = parseJsonText(policyText, {});
            await withFacade(async (facade) => {
                await facade.media.setPolicy(
                    policy as Parameters<typeof facade.media.setPolicy>[0],
                );
            });
            return policy;
        });

    const subscribeRemote = (): Promise<void> =>
        runMediaAction('Subscribe remote streams', async () => {
            return await withFacade(async (facade) => {
                unsubscribeRef.current?.();
                unsubscribeRef.current = facade.media.onRemoteStream(
                    (remote) => {
                        const row = {
                            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            atEpochMs: Date.now(),
                            peerId: remote.peerId,
                            streamId: remote.stream.id,
                        };
                        setRemoteStreams((current) =>
                            [...current, row].slice(-30),
                        );
                        recordMediaEvent(
                            'rallar.direct.media.remote_stream',
                            'info',
                            row,
                            'Remote media stream observed',
                        );
                    },
                );
                return { subscribed: true };
            });
        });

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    localStreamId,
                    audioEnabled,
                    videoEnabled,
                    policy: (() => {
                        try {
                            return parseJsonText(policyText, {});
                        } catch {
                            return policyText;
                        }
                    })(),
                    remoteStreams,
                    result,
                    localError,
                },
                state,
                authSession,
            ),
        );
    };

    return (
        <section
            className="panel media-console-panel"
            aria-label="Media Console"
        >
            <div className="panel-heading">
                <h2>Media</h2>
                <span
                    className={`pill ${localStreamId ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {localStreamId
                        ? 'local attached'
                        : realBackendReady
                          ? 'idle'
                          : 'real backend required'}
                </span>
            </div>
            <div className="media-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric label="Local stream" value={localStreamId ?? '-'} />
                <Metric
                    label="Audio"
                    value={audioEnabled ? 'enabled' : 'disabled'}
                />
                <Metric
                    label="Video"
                    value={videoEnabled ? 'enabled' : 'disabled'}
                />
                <Metric
                    label="Remote streams"
                    value={String(remoteStreams.length)}
                />
            </div>
            <div className="media-action-grid">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void attachLocal()}
                >
                    Attach local stream
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void toggleAudio()}
                >
                    Toggle audio
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void toggleVideo()}
                >
                    Toggle video
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('audio')}
                >
                    Stop audio
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('video')}
                >
                    Stop video
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void stopLocal('all')}
                >
                    Stop all
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void applyPolicy()}
                >
                    Apply media policy
                </button>
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void subscribeRemote()}
                >
                    Subscribe remote streams
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
            </div>
            <CollapsiblePanelSection
                title="Media Inputs"
                meta={`${remoteStreams.length} remote`}
            >
                <div className="media-work-grid">
                    <label className="json-editor">
                        <span>Media Policy JSON</span>
                        <textarea
                            value={policyText}
                            onChange={(event) =>
                                setPolicyText(event.target.value)
                            }
                            spellCheck={false}
                        />
                    </label>
                    <section className="media-result-panel">
                        <div className="section-heading">
                            <h3>Remote Streams</h3>
                            <span>{remoteStreams.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {remoteStreams.length === 0 && (
                                <div className="empty-state">
                                    No remote streams
                                </div>
                            )}
                            {remoteStreams
                                .slice()
                                .reverse()
                                .map((remote) => (
                                    <article
                                        className="state-table-row"
                                        key={remote.rowId}
                                    >
                                        <div>
                                            <strong>{remote.peerId}</strong>
                                            <small>{remote.streamId}</small>
                                        </div>
                                        <span>
                                            {formatTime(remote.atEpochMs)}
                                        </span>
                                    </article>
                                ))}
                        </div>
                    </section>
                    <section className="media-result-panel">
                        <div className="section-heading">
                            <h3>Result</h3>
                            <span>{busyAction ?? 'idle'}</span>
                        </div>
                        <pre className="mini-json">
                            {redactedJson(result ?? {}, state, authSession)}
                        </pre>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(busyAction ||
                localError ||
                !realBackendReady ||
                !authSession) && (
                <div
                    className={
                        localError ? 'workbench-error' : 'command-center-status'
                    }
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'Media console requires provider=browser-rallar.'
                            : !authSession
                              ? 'Media console requires a logged-in browser session.'
                              : busyAction)}
                </div>
            )}
        </section>
    );
}
