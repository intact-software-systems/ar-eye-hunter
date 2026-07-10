import { useState } from 'react';
import { json } from '../../shared/json-presentation.ts';
import type {
    CrdtAdminDocumentStatus,
    CrdtAdminListResult,
    CrdtPanelInput,
} from './crdt-contracts.ts';

export function useCrdtHealthController({
    bootstrap,
    authSession,
    globalValues,
}: CrdtPanelInput) {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [documents, setDocuments] = useState<
        readonly CrdtAdminDocumentStatus[]
    >([]);
    const [selectedDocumentKey, setSelectedDocumentKey] = useState<
        string | undefined
    >();
    const [lastResult, setLastResult] = useState<unknown>();
    const selectedDocument =
        documents.find(
            (document) => document.documentKey === selectedDocumentKey,
        ) ?? documents[0];
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canCallAdmin =
        providerReady && Boolean(authSession?.accessToken) && !busyAction;

    const adminRequestForAction = (
        action: string,
    ): { path: string; body: Record<string, unknown> } | undefined => {
        if (!selectedDocument) {
            return undefined;
        }
        const body = { document: selectedDocument.document };
        switch (action) {
            case 'integrity':
                return { path: '/api/crdt/admin/documents/integrity', body };
            case 'debug-export':
                return {
                    path: '/api/crdt/admin/documents/debug-export',
                    body: { ...body, reason: 'black-box-crdt-health' },
                };
            case 'backup-export':
                return { path: '/api/crdt/admin/documents/backup-export', body };
            case 'compact':
                return {
                    path: '/api/crdt/admin/documents/compact',
                    body: {
                        ...body,
                        reason: 'black-box-crdt-health-compaction',
                    },
                };
            case 'rebuild':
                return {
                    path: '/api/crdt/admin/documents/rebuild-projection',
                    body: { ...body, projectionId: 'black-box-health' },
                };
            case 'archive':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'archived',
                        changedAtEpochMs: Date.now(),
                    },
                };
            case 'destroy':
                return {
                    path: '/api/crdt/admin/documents/erase',
                    body: {
                        ...body,
                        mode: 'destroy-document',
                        reason: 'black-box-crdt-health-destroy',
                    },
                };
            case 'quarantine':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'quarantined',
                        changedAtEpochMs: Date.now(),
                    },
                };
            default:
                return undefined;
        }
    };

    const copyAdminRecipe = (action: string): void => {
        const request = adminRequestForAction(action);
        if (!request) {
            return;
        }
        const recipe = {
            schemaVersion: 1,
            recipeId: `crdt-admin-${action}`,
            name: `CRDT admin ${action}`,
            commands: [
                {
                    kind: 'http.request',
                    commandId: `crdt-admin-${action}`,
                    request: {
                        method: 'POST',
                        url: `${globalValues.apiBaseUrl}${request.path}`,
                        headers: {
                            authorization: 'Bearer ${RALLAR_ADMIN_ACCESS_TOKEN}',
                        },
                        body: request.body,
                    },
                    response: {
                        body: 'json',
                    },
                    timeoutMs: 10_000,
                },
            ],
        };
        void navigator.clipboard?.writeText(json(recipe));
    };

    const callAdmin = async <TResult,>(
        path: string,
        body: unknown,
    ): Promise<TResult> => {
        const response = await fetch(`${globalValues.apiBaseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(authSession?.accessToken
                    ? { authorization: `Bearer ${authSession.accessToken}` }
                    : {}),
            },
            body: JSON.stringify(body),
        });
        const payload = (await response.json()) as {
            ok?: boolean;
            result?: TResult;
            error?: string;
        };
        if (!response.ok || payload.ok === false) {
            throw new Error(
                payload.error ??
                    `CRDT admin request failed with ${response.status}.`,
            );
        }
        return payload.result as TResult;
    };

    const refresh = async (): Promise<void> => {
        setBusyAction('refresh');
        setError(undefined);
        try {
            const result = await callAdmin<CrdtAdminListResult>(
                '/api/crdt/admin/documents/list',
                {
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    limit: 50,
                },
            );
            setDocuments(result.documents);
            setSelectedDocumentKey((current) =>
                current &&
                result.documents.some(
                    (document) => document.documentKey === current,
                )
                    ? current
                    : result.documents[0]?.documentKey,
            );
            setLastResult(result);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDocumentAction = async (action: string): Promise<void> => {
        if (!selectedDocument) {
            return;
        }
        setBusyAction(action);
        setError(undefined);
        try {
            const body = { document: selectedDocument.document };
            let result: unknown;
            switch (action) {
                case 'integrity':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/integrity',
                        body,
                    );
                    break;
                case 'debug-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/debug-export',
                        {
                            ...body,
                            reason: 'black-box-crdt-health',
                        },
                    );
                    break;
                case 'backup-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/backup-export',
                        body,
                    );
                    break;
                case 'compact':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/compact',
                        {
                            ...body,
                            reason: 'black-box-crdt-health-compaction',
                        },
                    );
                    break;
                case 'rebuild':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/rebuild-projection',
                        {
                            ...body,
                            projectionId: 'black-box-health',
                        },
                    );
                    break;
                case 'archive':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'archived',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
                case 'destroy':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/erase',
                        {
                            ...body,
                            mode: 'destroy-document',
                            reason: 'black-box-crdt-health-destroy',
                        },
                    );
                    break;
                case 'quarantine':
                default:
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'quarantined',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
            }
            setLastResult(result);
            if (
                [
                    'archive',
                    'compact',
                    'destroy',
                    'quarantine',
                    'rebuild',
                ].includes(action)
            ) {
                await refresh();
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };
    return {
        busyAction,
        error,
        documents,
        setSelectedDocumentKey,
        lastResult,
        selectedDocument,
        providerReady,
        canCallAdmin,
        copyAdminRecipe,
        refresh,
        runDocumentAction,
    };
}

export type CrdtHealthControllerModel = ReturnType<
    typeof useCrdtHealthController
>;
