import { DEFAULT_RALLAR_CRDT_DB_NAME } from '@shared-web/browser/crdt/browser-crdt-local-store.ts';
import { createBrowserCrdtRuntimeId } from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import { BrowserRallarCrdtDocument } from '@shared-web/browser/crdt/browser-rallar-crdt-document.ts';
import type {
    RallarCrdtDocument,
    RallarCrdtFacade,
    RallarCrdtFacadeDefaults,
    RallarCrdtFacadeOptions,
    RallarCrdtHttpCatchUpClient,
    RallarCrdtOpenOptions,
    RallarCrdtOpenScope
} from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentRef,
    type RallarCrdtJsonValue,
    type RallarCrdtOperationBatch
} from '@shared/crdt/mod.ts';

/** Creates the browser facade and owns document identity/default resolution. */
export function createRallarCrdtFacade(
    options: RallarCrdtFacadeOptions
): RallarCrdtFacade {
    const openDocuments = new Map<string, RallarCrdtDocument<RallarCrdtJsonValue>>();
    const now = options.now ?? Date.now;

    return {
        open: async <
            TValue = RallarCrdtJsonValue,
            TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
        >(
            name: string,
            openOptions: RallarCrdtOpenOptions<TValue, TPayload> = {}
        ): Promise<RallarCrdtDocument<TValue, TPayload>> => {
            const ref = toDocumentRef(name, openOptions, options.readDefaults?.());
            const documentKey = toRallarCrdtDocumentKey(ref);
            const existing = openDocuments.get(documentKey);
            if (existing) {
                return existing as RallarCrdtDocument<TValue, TPayload>;
            }

            const document = new BrowserRallarCrdtDocument<TValue, TPayload>({
                ref,
                documentKey,
                replicaId: openOptions.replicaId ??
                    options.createReplicaId?.() ??
                    createBrowserCrdtRuntimeId('replica'),
                actorId: openOptions.actorId,
                sessionId: openOptions.sessionId,
                schemaVersion: openOptions.schemaVersion ?? 1,
                initialValue: openOptions.initialValue,
                persist: openOptions.persist ?? true,
                tabSync: openOptions.tabSync ?? true,
                transport: openOptions.transport ?? 'local-only',
                policies: openOptions.policies ?? [],
                metrics: openOptions.metrics,
                encryption: openOptions.encryption,
                validation: openOptions.validation,
                durableCatchUp: (openOptions.durableCatchUp ??
                    options.readDurableCatchUp?.()) as
                        | RallarCrdtHttpCatchUpClient<TPayload>
                        | undefined,
                data: options.data,
                dbName: openOptions.dbName ?? DEFAULT_RALLAR_CRDT_DB_NAME,
                readTransport: options.readTransport,
                now
            });

            await document.hydrate();
            openDocuments.set(
                documentKey,
                document as RallarCrdtDocument<RallarCrdtJsonValue>
            );
            document.onClosed(() => {
                if (openDocuments.get(documentKey) === document) {
                    openDocuments.delete(documentKey);
                }
            });
            return document;
        }
    };
}

function toDocumentRef<TValue>(
    name: string,
    options: RallarCrdtOpenOptions<TValue>,
    defaults: RallarCrdtFacadeDefaults | undefined
): RallarCrdtDocumentRef {
    const scope = options.scope ?? toDefaultScope(defaults);
    const applicationId = options.applicationId ??
        (scope.kind === 'room' ? scope.roomRef.applicationId : undefined) ??
        defaults?.applicationId;
    const workspaceId = options.workspaceId ??
        (scope.kind === 'room' ? scope.roomRef.workspaceId : undefined) ??
        defaults?.workspaceId;

    if (!applicationId) {
        throw new Error('Cannot open CRDT document: applicationId is required.');
    }

    const documentType = options.documentType ?? name;
    const documentId = options.documentId ??
        (scope.kind === 'room' ? scope.roomRef.groupId : name);

    switch (scope.kind) {
        case 'app':
            return {
                applicationId,
                workspaceId,
                scope: 'app',
                documentType,
                documentId
            };
        case 'principal':
            return {
                applicationId,
                workspaceId,
                scope: 'principal',
                documentType,
                documentId,
                principalId: scope.principalId
            };
        case 'room':
            return {
                applicationId,
                workspaceId,
                scope: 'room',
                documentType,
                documentId,
                roomRef: scope.roomRef
            };
        case 'custom':
            return {
                applicationId,
                workspaceId,
                scope: 'custom',
                documentType,
                documentId,
                customScope: scope.customScope
            };
    }
}

function toDefaultScope(
    defaults: RallarCrdtFacadeDefaults | undefined
): RallarCrdtOpenScope {
    if (defaults?.room?.roomRef) {
        return { kind: 'room', roomRef: defaults.room.roomRef };
    }
    return { kind: 'app' };
}
