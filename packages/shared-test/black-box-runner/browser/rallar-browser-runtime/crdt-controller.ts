import type { BlackBoxRallarGenerationPort } from './ports.ts';

export type BlackBoxRallarCrdtLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarCrdtController<TDocument> = Readonly<{
    lease(): BlackBoxRallarCrdtLease;
    assertCurrent(lease: BlackBoxRallarCrdtLease, message: string): void;
    open(handle: string, effect: () => Promise<TDocument>): Promise<TDocument>;
    run<TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult>;
    require(handle: string): TDocument;
    take(handle: string): TDocument;
    delete(handle: string): boolean;
    entries(): readonly (readonly [string, TDocument])[];
    handles(): readonly string[];
    pending(): readonly Promise<unknown>[];
}>;

export function createBlackBoxRallarCrdtController<TDocument>(
    generationPort: BlackBoxRallarGenerationPort,
): BlackBoxRallarCrdtController<TDocument> {
    const documents = new Map<string, TDocument>();
    const pendingOpens = new Map<string, Promise<TDocument>>();
    const operationTails = new Map<string, Promise<unknown>>();

    const open = (handle: string, effect: () => Promise<TDocument>): Promise<TDocument> => {
        if (documents.has(handle) || pendingOpens.has(handle)) {
            return Promise.reject(new Error('CRDT document handle is already open: ' + handle));
        }

        const promise = (async () => {
            const document = await effect();
            documents.set(handle, document);
            return document;
        })();
        pendingOpens.set(handle, promise);
        void promise
            .finally(() => {
                if (pendingOpens.get(handle) === promise) {
                    pendingOpens.delete(handle);
                }
            })
            .catch(() => undefined);
        return promise;
    };

    const requireDocument = (handle: string): TDocument => {
        const document = documents.get(handle);
        if (!document) {
            throw new Error('CRDT document handle is not open: ' + handle);
        }
        return document;
    };

    const take = (handle: string): TDocument => {
        const document = requireDocument(handle);
        documents.delete(handle);
        return document;
    };

    const run = <TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult> => {
        const previous = operationTails.get(handle) ?? Promise.resolve();
        const promise = previous.catch(() => undefined).then(() => effect(requireDocument(handle)));
        operationTails.set(handle, promise);
        void promise
            .finally(() => {
                if (operationTails.get(handle) === promise) {
                    operationTails.delete(handle);
                }
            })
            .catch(() => undefined);
        return promise;
    };

    return {
        lease: () => ({ generation: generationPort.generation() }),
        assertCurrent: (lease, message) => {
            if (!generationPort.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        open,
        run,
        require: requireDocument,
        take,
        delete: handle => documents.delete(handle),
        entries: () => [...documents.entries()],
        handles: () => [...documents.keys()],
        pending: () => [...pendingOpens.values(), ...operationTails.values()],
    };
}
