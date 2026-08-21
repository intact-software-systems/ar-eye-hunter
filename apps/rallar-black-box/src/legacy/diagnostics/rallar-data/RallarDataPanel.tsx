import type { RallarBlackBoxTestSeverity, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useRef, useState } from 'react';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import { createDirectRallarRuntimeEvent } from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import { json, parseJsonText } from '../../shared/json-presentation.ts';
import { Metric } from '../../shared/Metric.tsx';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

type RallarDataOperation =
    | 'define'
    | 'open'
    | 'lookup'
    | 'hydrate'
    | 'when-idle'
    | 'read'
    | 'get'
    | 'keys'
    | 'list-keys'
    | 'read-entries'
    | 'get-entries'
    | 'read-all'
    | 'get-all'
    | 'set'
    | 'update'
    | 'update-or-create'
    | 'set-if-absent'
    | 'compare-and-set'
    | 'get-and-set'
    | 'delete'
    | 'delete-expired'
    | 'clear'
    | 'flush'
    | 'export'
    | 'estimate-usage'
    | 'close'
    | 'destroy'
    | 'close-scope'
    | 'clear-scope'
    | 'destroy-scope';

type RallarDataChangeRow = Readonly<{
    rowId: string;
    atEpochMs: number;
    event: unknown;
}>;

type RallarDataUiStore = Awaited<ReturnType<Awaited<ReturnType<typeof loadBrowserRallarFacade>>['data']['open']>>;

export function RallarDataPanel({
    state,
    bootstrap,
    authSession,
    globalValues
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [storeName, setStoreName] = useState('rallar-black-box-store');
    const [scopeMode, setScopeMode] = useState<'app' | 'principal' | 'session' | 'custom'>('session');
    const [customScope, setCustomScope] = useState('custom:rallar-black-box');
    const [durability, setDurability] = useState<'write-through' | 'write-behind'>('write-through');
    const [hydrateMode, setHydrateMode] = useState<'eager' | 'lazy'>('eager');
    const [key, setKey] = useState('probe');
    const [valueText, setValueText] = useState(() =>
        json({
            text: 'hello from Rallar Data',
            seq: 1
        })
    );
    const [expectedText, setExpectedText] = useState('');
    const [operation, setOperation] = useState<RallarDataOperation>('open');
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [storeOpen, setStoreOpen] = useState(false);
    const [hydrated, setHydrated] = useState(false);
    const [result, setResult] = useState<unknown>();
    const [changes, setChanges] = useState<readonly RallarDataChangeRow[]>([]);
    const storeRef = useRef<RallarDataUiStore | undefined>(undefined);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && !busyAction;
    const resolvedScope = scopeMode === 'app'
        ? `app:${globalValues.applicationId}:${globalValues.workspaceId}`
        : scopeMode === 'principal'
        ? `principal:${globalValues.clientId || authSession?.clientId || bootstrap.actor}`
        : scopeMode === 'session'
        ? `session:${globalValues.sessionId || authSession?.sessionId || bootstrap.sessionId}`
        : customScope;

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
            void storeRef.current?.close();
        },
        []
    );

    const options = () => ({
        scope: resolvedScope,
        durability,
        hydrate: hydrateMode,
        sync: true
    });

    const recordDataEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string
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
                    actor: authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'rallar-data',
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
                },
                payload: {
                    storeName,
                    scope: resolvedScope,
                    ...optionalRecord(payload)
                },
                severity
            }),
            lastAction
        );
    };

    const loadFacade = async (): Promise<Awaited<ReturnType<typeof loadBrowserRallarFacade>>> => {
        if (!realBackendReady) {
            throw new Error(
                'Rallar Data console requires provider=browser-rallar.'
            );
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId
        });
        return facade;
    };

    const attachChangeListener = (store: RallarDataUiStore): void => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = store.onChange((event) => {
            const row = {
                rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                atEpochMs: Date.now(),
                event
            };
            setChanges((current) => [...current, row].slice(-50));
            recordDataEvent(
                'rallar.direct.data.change',
                'info',
                row,
                'Rallar Data changed'
            );
        });
    };

    const openStore = async (): Promise<RallarDataUiStore> => {
        if (storeRef.current) {
            return storeRef.current;
        }
        const facade = await loadFacade();
        const store = await facade.data.open<unknown>(storeName, options());
        storeRef.current = store;
        setStoreOpen(true);
        setHydrated(store.isHydrated());
        attachChangeListener(store);
        return store;
    };

    const resetOpenStore = (): void => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        storeRef.current = undefined;
        setStoreOpen(false);
        setHydrated(false);
    };

    const parseValue = (): unknown => parseJsonText(valueText, null);
    const parseExpected = (): unknown | undefined =>
        expectedText.trim()
            ? parseJsonText(expectedText, undefined)
            : undefined;

    const runOperation = async (): Promise<void> => {
        setBusyAction(operation);
        setLocalError(undefined);
        try {
            const facade = await loadFacade();
            let nextResult: unknown;
            if (operation === 'define') {
                nextResult = facade.data.define(storeName, options());
            }
            else if (operation === 'open') {
                nextResult = await openStore();
            }
            else if (operation === 'lookup') {
                const lookedUp = facade.data.lookup<unknown>(
                    storeName,
                    options()
                );
                if (lookedUp) {
                    storeRef.current = lookedUp;
                    setStoreOpen(true);
                    setHydrated(lookedUp.isHydrated());
                    attachChangeListener(lookedUp);
                }
                nextResult = lookedUp
                    ? {
                        name: lookedUp.name,
                        repositoryId: lookedUp.repositoryId,
                        hydrated: lookedUp.isHydrated()
                    }
                    : undefined;
            }
            else if (operation === 'close') {
                nextResult = await facade.data.close(storeName, options());
                resetOpenStore();
            }
            else if (operation === 'destroy') {
                nextResult = await facade.data.destroy(storeName, options());
                resetOpenStore();
            }
            else if (operation === 'close-scope') {
                nextResult = await facade.data.closeScope(resolvedScope);
                resetOpenStore();
            }
            else if (operation === 'clear-scope') {
                nextResult = await facade.data.clearScope(resolvedScope);
            }
            else if (operation === 'destroy-scope') {
                nextResult = await facade.data.destroyScope(resolvedScope);
                resetOpenStore();
            }
            else {
                const store = await openStore();
                switch (operation) {
                    case 'hydrate':
                        await store.hydrate();
                        nextResult = { hydrated: store.isHydrated() };
                        break;
                    case 'when-idle':
                        await store.whenIdle();
                        nextResult = { idle: true };
                        break;
                    case 'read':
                        nextResult = store.read(key);
                        break;
                    case 'get':
                        nextResult = await store.get(key);
                        break;
                    case 'keys':
                        nextResult = store.keys();
                        break;
                    case 'list-keys':
                        nextResult = await store.listKeys();
                        break;
                    case 'read-entries':
                        nextResult = store.readEntries();
                        break;
                    case 'get-entries':
                        nextResult = await store.getEntries();
                        break;
                    case 'read-all':
                        nextResult = store.readAllValues();
                        break;
                    case 'get-all':
                        nextResult = await store.getAll();
                        break;
                    case 'set':
                        await store.set(key, parseValue());
                        nextResult = await store.get(key);
                        break;
                    case 'update':
                        nextResult = await store.update(key, () => parseValue());
                        break;
                    case 'update-or-create':
                        nextResult = await store.updateOrCreate(key, () => parseValue());
                        break;
                    case 'set-if-absent':
                        nextResult = await store.setIfAbsent(key, () => parseValue());
                        break;
                    case 'compare-and-set':
                        nextResult = await store.compareAndSet(
                            key,
                            parseExpected(),
                            parseValue()
                        );
                        break;
                    case 'get-and-set':
                        nextResult = await store.getAndSet(key, parseValue());
                        break;
                    case 'delete':
                        nextResult = await store.delete(key);
                        break;
                    case 'delete-expired':
                        nextResult = await store.deleteExpired();
                        break;
                    case 'clear':
                        await store.clear();
                        nextResult = { cleared: true };
                        break;
                    case 'flush':
                        await store.flush();
                        nextResult = { flushed: true };
                        break;
                    case 'export':
                        nextResult = await store.exportData();
                        break;
                    case 'estimate-usage':
                        nextResult = await store.estimateUsage();
                        break;
                    default:
                        nextResult = undefined;
                }
                setHydrated(store.isHydrated());
            }
            setResult(nextResult);
            recordDataEvent(
                'rallar.direct.data.operation.completed',
                'info',
                {
                    operation,
                    result: nextResult
                },
                `Rallar Data ${operation} completed`
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            recordDataEvent(
                'rallar.direct.data.operation.failed',
                'error',
                {
                    operation,
                    error: message
                },
                `Rallar Data ${operation} failed`
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    storeName,
                    scope: resolvedScope,
                    durability,
                    hydrateMode,
                    storeOpen,
                    hydrated,
                    operation,
                    key,
                    result,
                    changes: changes.slice(-8)
                },
                state,
                authSession
            )
        );
    };

    const operations: readonly RallarDataOperation[] = [
        'define',
        'open',
        'lookup',
        'hydrate',
        'when-idle',
        'read',
        'get',
        'keys',
        'list-keys',
        'read-entries',
        'get-entries',
        'read-all',
        'get-all',
        'set',
        'update',
        'update-or-create',
        'set-if-absent',
        'compare-and-set',
        'get-and-set',
        'delete',
        'delete-expired',
        'clear',
        'flush',
        'export',
        'estimate-usage',
        'close',
        'destroy',
        'close-scope',
        'clear-scope',
        'destroy-scope'
    ];

    return (
        <section className="panel rallar-data-panel" aria-label="Rallar Data">
            <div className="panel-heading">
                <h2>Rallar Data</h2>
                <span
                    className={`pill ${storeOpen ? 'good' : realBackendReady ? 'muted' : 'warn'}`}
                >
                    {storeOpen
                        ? 'store open'
                        : realBackendReady
                        ? 'idle'
                        : 'real backend required'}
                </span>
            </div>
            <div className="rallar-data-summary-grid">
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={realBackendReady ? 'good' : 'warn'}
                />
                <Metric label="Store" value={storeName} />
                <Metric label="Scope" value={resolvedScope} />
                <Metric
                    label="Open"
                    value={storeOpen ? 'yes' : 'no'}
                    tone={storeOpen ? 'good' : 'muted'}
                />
                <Metric
                    label="Hydrated"
                    value={hydrated ? 'yes' : 'no'}
                    tone={hydrated ? 'good' : 'muted'}
                />
                <Metric label="Changes" value={String(changes.length)} />
            </div>
            <CollapsiblePanelSection
                title="Rallar Data Inputs"
                meta={`${storeName} / ${operation}`}
            >
                <div className="rallar-data-context-grid">
                    <label className="field">
                        <span>Store</span>
                        <input
                            value={storeName}
                            onChange={(event) => {
                                resetOpenStore();
                                setStoreName(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field">
                        <span>Scope</span>
                        <select
                            value={scopeMode}
                            onChange={(event) => {
                                resetOpenStore();
                                setScopeMode(
                                    event.target.value as typeof scopeMode
                                );
                            }}
                        >
                            <option value="app">app</option>
                            <option value="principal">principal</option>
                            <option value="session">session</option>
                            <option value="custom">custom</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Custom Scope</span>
                        <input
                            value={customScope}
                            onChange={(event) => setCustomScope(event.target.value)}
                        />
                    </label>
                    <label className="field">
                        <span>Durability</span>
                        <select
                            value={durability}
                            onChange={(event) => {
                                resetOpenStore();
                                setDurability(
                                    event.target.value as typeof durability
                                );
                            }}
                        >
                            <option value="write-through">write-through</option>
                            <option value="write-behind">write-behind</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Hydration</span>
                        <select
                            value={hydrateMode}
                            onChange={(event) => {
                                resetOpenStore();
                                setHydrateMode(
                                    event.target.value as typeof hydrateMode
                                );
                            }}
                        >
                            <option value="eager">eager</option>
                            <option value="lazy">lazy</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>Operation</span>
                        <select
                            value={operation}
                            onChange={(event) =>
                                setOperation(
                                    event.target.value as RallarDataOperation
                                )}
                        >
                            {operations.map((entry) => (
                                <option key={entry} value={entry}>
                                    {entry}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Key</span>
                        <input
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                        />
                    </label>
                </div>
            </CollapsiblePanelSection>
            <div className="rallar-data-actions">
                <button
                    type="button"
                    disabled={!canRun}
                    onClick={() => void runOperation()}
                >
                    Run data operation
                </button>
                <button type="button" onClick={copyDiagnostics}>
                    Copy diagnostics
                </button>
            </div>
            <CollapsiblePanelSection
                title="Rallar Data Values"
                meta={`${changes.length} changes`}
            >
                <div className="rallar-data-work-grid">
                    <label className="json-editor">
                        <span>Value JSON</span>
                        <textarea
                            value={valueText}
                            onChange={(event) => setValueText(event.target.value)}
                            spellCheck={false}
                        />
                    </label>
                    <label className="json-editor">
                        <span>Expected JSON</span>
                        <textarea
                            value={expectedText}
                            onChange={(event) => setExpectedText(event.target.value)}
                            spellCheck={false}
                        />
                    </label>
                    <section className="rallar-data-result-panel">
                        <div className="section-heading">
                            <h3>Result</h3>
                            <span>{busyAction ?? operation}</span>
                        </div>
                        <pre className="mini-json">
                            {redactedJson(result ?? {}, state, authSession)}
                        </pre>
                    </section>
                    <section className="rallar-data-result-panel">
                        <div className="section-heading">
                            <h3>Change Events</h3>
                            <span>{changes.length} rows</span>
                        </div>
                        <div className="websocket-received-list">
                            {changes.length === 0 && (
                                <div className="empty-state">
                                    No Rallar Data changes
                                </div>
                            )}
                            {changes
                                .slice()
                                .reverse()
                                .map((change) => (
                                    <article
                                        className="websocket-received-row"
                                        key={change.rowId}
                                    >
                                        <div>
                                            <strong>
                                                {formatTime(change.atEpochMs)}
                                            </strong>
                                            <small>{storeName}</small>
                                        </div>
                                        <pre className="mini-json">
                                            {redactedJson(
                                                change.event,
                                                state,
                                                authSession,
                                            )}
                                        </pre>
                                    </article>
                                ))}
                        </div>
                    </section>
                </div>
            </CollapsiblePanelSection>
            {(busyAction || localError || !realBackendReady) && (
                <div
                    className={localError ? 'workbench-error' : 'command-center-status'}
                    role="status"
                >
                    {localError ??
                        (!realBackendReady
                            ? 'Rallar Data requires provider=browser-rallar.'
                            : busyAction)}
                </div>
            )}
        </section>
    );
}
