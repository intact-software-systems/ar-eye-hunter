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
import { Either } from '@shared/resilience/Either.ts';

/** Creates the browser facade and owns document identity/default resolution. */
export function createRallarCrdtFacade(
    options: RallarCrdtFacadeOptions
): RallarCrdtFacade {
    return new BrowserRallarCrdtFacade(options);
}

export namespace BrowserRallarCrdtFacade {
    export interface OpenOptions<
        TValue = RallarCrdtJsonValue,
        TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    > extends RallarCrdtOpenOptions<TValue, TPayload> {
        readonly initialLiveAdmission?: BrowserRallarCrdtDocument.InitialLiveAdmission;
    }
}

/** Owns browser document identity, cached lifecycle, and initial construction. */
export class BrowserRallarCrdtFacade implements RallarCrdtFacade {
    readonly #options: RallarCrdtFacadeOptions;
    readonly #openDocuments = new Map<string, RallarCrdtDocument<RallarCrdtJsonValue>>();
    readonly #now: () => number;

    public constructor(options: RallarCrdtFacadeOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        // Public callers may retain open without its facade receiver.
        this.open = this.open.bind(this);
    }

    public async open<
        TValue = RallarCrdtJsonValue,
        TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    >(
        name: string,
        openOptions: BrowserRallarCrdtFacade.OpenOptions<TValue, TPayload> = {}
    ): Promise<RallarCrdtDocument<TValue, TPayload>> {
        const ref = toDocumentRef(name, openOptions, this.#options.readDefaults?.()).fold(
            (error) => {
                throw error;
            },
            (documentRef) => documentRef
        );
        const documentKey = toRallarCrdtDocumentKey(ref);
        const existing = this.#openDocuments.get(documentKey);
        if (existing) {
            return existing as RallarCrdtDocument<TValue, TPayload>;
        }

        const document = new BrowserRallarCrdtDocument<TValue, TPayload>({
            ref,
            documentKey,
            replicaId: openOptions.replicaId ??
                this.#options.createReplicaId?.() ??
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
                this.#options.readDurableCatchUp?.()) as
                    | RallarCrdtHttpCatchUpClient<TPayload>
                    | undefined,
            data: this.#options.data,
            dbName: openOptions.dbName ?? DEFAULT_RALLAR_CRDT_DB_NAME,
            readTransport: this.#options.readTransport,
            now: this.#now
        });

        await document.hydrate(openOptions.initialLiveAdmission);
        this.#openDocuments.set(
            documentKey,
            document as RallarCrdtDocument<RallarCrdtJsonValue>
        );
        document.onClosed(() => {
            if (this.#openDocuments.get(documentKey) === document) {
                this.#openDocuments.delete(documentKey);
            }
        });
        return document;
    }
}

function toDocumentRef<TValue>(
    name: string,
    options: RallarCrdtOpenOptions<TValue>,
    defaults: RallarCrdtFacadeDefaults | undefined
): Either<Error, RallarCrdtDocumentRef> {
    const scope = options.scope ?? toDefaultScope(defaults);
    const applicationId = options.applicationId ??
        (scope.kind === 'room' ? scope.roomRef.applicationId : undefined) ??
        defaults?.applicationId;
    const workspaceId = options.workspaceId ??
        (scope.kind === 'room' ? scope.roomRef.workspaceId : undefined) ??
        defaults?.workspaceId;

    if (!applicationId) {
        return Either.ofLeft(new Error('Cannot open CRDT document: applicationId is required.'));
    }

    const documentType = options.documentType ?? name;
    const documentId = options.documentId ??
        (scope.kind === 'room' ? scope.roomRef.groupId : name);

    switch (scope.kind) {
        case 'app':
            return Either.ofRight<Error, RallarCrdtDocumentRef>({
                applicationId,
                workspaceId,
                scope: 'app',
                documentType,
                documentId
            });
        case 'principal':
            return Either.ofRight<Error, RallarCrdtDocumentRef>({
                applicationId,
                workspaceId,
                scope: 'principal',
                documentType,
                documentId,
                principalId: scope.principalId
            });
        case 'room':
            return Either.ofRight<Error, RallarCrdtDocumentRef>({
                applicationId,
                workspaceId,
                scope: 'room',
                documentType,
                documentId,
                roomRef: scope.roomRef
            });
        case 'custom':
            return Either.ofRight<Error, RallarCrdtDocumentRef>({
                applicationId,
                workspaceId,
                scope: 'custom',
                documentType,
                documentId,
                customScope: scope.customScope
            });
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
