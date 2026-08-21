import type { RallarBlackBoxTestSeverity } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarCrdtOperationBatch, RallarCrdtTransportStrategy } from '@shared/crdt/crdt-types.ts';
import { useEffect, useRef, useState } from 'react';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import {
    createCrdtEditorInitialValue,
    type CrdtEditorTransport,
    type CrdtEditorValue,
    type CrdtEditorView
} from '../../../crdt-editor.ts';
import { createDirectRallarRuntimeEvent } from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import type { CrdtEditorDocument, CrdtPanelInput } from './crdt-contracts.ts';

type BrowserRallarFacade = Awaited<ReturnType<typeof loadBrowserRallarFacade>>;

export function useCrdtEditorController({
    bootstrap,
    authSession,
    globalValues
}: CrdtPanelInput) {
    const [documentName, setDocumentName] = useState('black-box-crdt-editor');
    const [documentId, setDocumentId] = useState(() => `crdt-editor-${globalValues.roomId || 'local'}`);
    const [transport, setTransport] = useState<CrdtEditorTransport>('local-only');
    const [persist, setPersist] = useState(true);
    const [tabSync, setTabSync] = useState(true);
    const [view, setView] = useState<CrdtEditorView>('board');
    const [newColumnTitle, setNewColumnTitle] = useState('Review');
    const [newCardTitle, setNewCardTitle] = useState('Coordinate move');
    const [selectedColumnId, setSelectedColumnId] = useState('column-backlog');
    const [selectedCardId, setSelectedCardId] = useState('card-first');
    const [cardStatus, setCardStatus] = useState('done');
    const [tagLabel, setTagLabel] = useState('needs-sync');
    const [entityId, setEntityId] = useState('entity-player-1');
    const [entityType, setEntityType] = useState('player');
    const [entityX, setEntityX] = useState(4);
    const [entityY, setEntityY] = useState(6);
    const [entityStatus, setEntityStatus] = useState('moving');
    const [entityDelta, setEntityDelta] = useState(5);
    const [cooldownMin, setCooldownMin] = useState(2);
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [opened, setOpened] = useState(false);
    const [value, setValue] = useState<CrdtEditorValue>(() => createCrdtEditorInitialValue());
    const [health, setHealth] = useState<unknown>();
    const [lastResult, setLastResult] = useState<unknown>();
    const [lastBatch, setLastBatch] = useState<RallarCrdtOperationBatch>();
    const [lastOperationGroupId, setLastOperationGroupId] = useState<string>();
    const documentRef = useRef<CrdtEditorDocument | undefined>(undefined);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canUseLiveTransport = providerReady && Boolean(authSession);
    const canRun = !busyAction &&
        (transport === 'local-only' || canUseLiveTransport);
    const columns = value.columns ?? createCrdtEditorInitialValue().columns ?? [];
    const entities = value.entities ?? createCrdtEditorInitialValue().entities ?? [];
    const selectedColumn = columns.find(
        (column) => column.id === selectedColumnId
    );
    const selectedCard = selectedColumn?.cards.find((card) => card.id === selectedCardId) ??
        columns.flatMap((column) => column.cards).find(
            (card) => card.id === selectedCardId
        );

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
            void documentRef.current?.close();
        },
        []
    );

    const recordCrdtEditorEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode: bootstrap.providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor: authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'crdt-editor',
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
                },
                payload: optionalRecord(payload),
                severity
            }),
            lastAction
        );
    };

    const loadFacade = async (): Promise<BrowserRallarFacade> => {
        if (transport !== 'local-only' && !providerReady) {
            throw new Error(
                'Live CRDT editor transports require provider=browser-rallar.'
            );
        }
        if (transport !== 'local-only' && !authSession) {
            throw new Error('Login is required for live CRDT transports.');
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            room: globalValues.roomId
                ? {
                    roomRef: {
                        applicationId: globalValues.applicationId,
                        workspaceId: globalValues.workspaceId,
                        groupId: globalValues.roomId
                    }
                }
                : undefined
        });
        return facade;
    };

    const openDocument = async (): Promise<CrdtEditorDocument> => {
        if (documentRef.current) {
            return documentRef.current;
        }
        const facade = await loadFacade();
        const document = await facade.crdt.open<CrdtEditorValue, RallarCrdtOperationBatch>(documentName, {
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            documentId,
            documentType: 'black-box-crdt-editor',
            transport: transport as RallarCrdtTransportStrategy,
            persist,
            tabSync,
            actorId: authSession?.clientId ??
                authSession?.username ??
                bootstrap.actor,
            sessionId: authSession?.sessionId ?? bootstrap.sessionId,
            initialValue: createCrdtEditorInitialValue()
        });
        documentRef.current = document;
        unsubscribeRef.current = document.subscribe((snapshot) => {
            setValue(snapshot.value);
            setHealth(document.health());
        });
        setValue(document.read());
        setHealth(document.health());
        setOpened(true);
        setLastResult({
            action: 'open',
            ref: document.ref,
            health: document.health(),
            value: document.read()
        });
        recordCrdtEditorEvent(
            'rallar.direct.crdt.editor.opened',
            'info',
            {
                document: document.ref,
                transport,
                persist,
                tabSync
            },
            'CRDT editor opened'
        );
        return document;
    };

    const runEditorAction = async (
        action: string,
        runner: (document: CrdtEditorDocument) => Promise<unknown>
    ): Promise<void> => {
        setBusyAction(action);
        setError(undefined);
        try {
            const document = await openDocument();
            const result = await runner(document);
            setValue(document.read());
            setHealth(document.health());
            setLastResult(result);
            recordCrdtEditorEvent(
                `rallar.direct.crdt.editor.${action}`,
                'info',
                {
                    document: document.ref,
                    transport,
                    result,
                    health: document.health()
                },
                `CRDT editor ${action}`
            );
        }
        catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setError(message);
            recordCrdtEditorEvent(
                'rallar.direct.crdt.editor.failed',
                'error',
                {
                    action,
                    error: message,
                    transport
                },
                `CRDT editor ${action} failed`
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const applyBatch = async (
        action: string,
        batch: RallarCrdtOperationBatch
    ): Promise<void> => {
        setLastBatch(batch);
        setLastOperationGroupId(batch.operationGroupId);
        await runEditorAction(action, async (document) => {
            const update = await document.applyLocal(batch);
            return {
                action,
                updateId: update.updateId,
                operationGroupId: batch.operationGroupId,
                operations: batch.operations
            };
        });
    };

    const closeDocument = async (): Promise<void> => {
        await runEditorAction('close', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.close();
            documentRef.current = undefined;
            setOpened(false);
            return { action: 'close', document: document.ref };
        });
    };

    const destroyDocument = async (): Promise<void> => {
        await runEditorAction('destroy', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.destroy();
            documentRef.current = undefined;
            setOpened(false);
            setValue(createCrdtEditorInitialValue());
            return { action: 'destroy', document: document.ref };
        });
    };
    return {
        documentName,
        setDocumentName,
        documentId,
        setDocumentId,
        transport,
        setTransport,
        persist,
        setPersist,
        tabSync,
        setTabSync,
        view,
        setView,
        newColumnTitle,
        setNewColumnTitle,
        newCardTitle,
        setNewCardTitle,
        selectedColumnId,
        setSelectedColumnId,
        selectedCardId,
        setSelectedCardId,
        cardStatus,
        setCardStatus,
        tagLabel,
        setTagLabel,
        entityId,
        setEntityId,
        entityType,
        setEntityType,
        entityX,
        setEntityX,
        entityY,
        setEntityY,
        entityStatus,
        setEntityStatus,
        entityDelta,
        setEntityDelta,
        cooldownMin,
        setCooldownMin,
        busyAction,
        error,
        opened,
        value,
        health,
        lastResult,
        lastBatch,
        lastOperationGroupId,
        providerReady,
        canUseLiveTransport,
        canRun,
        columns,
        entities,
        selectedColumn,
        selectedCard,
        runEditorAction,
        applyBatch,
        closeDocument,
        destroyDocument
    };
}

export type CrdtEditorControllerModel = ReturnType<typeof useCrdtEditorController>;
