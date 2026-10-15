import { SingleFlight } from '@shared/resilience/single-flight.ts';

import type { BlackBoxRallarGenerationPort } from './ports.ts';

export namespace BlackBoxRallarCrdtResourceController {
    export interface Lease {
        readonly generation: number;
    }
}

export class BlackBoxRallarCrdtResourceController<TDocument> {
    readonly #generation: BlackBoxRallarGenerationPort;
    readonly #documents = new Map<string, TDocument>();
    readonly #opens = new SingleFlight<string, TDocument>();
    readonly #operationTails = new Map<string, Promise<void>>();
    readonly #pendingEffects = new Set<Promise<void>>();

    public constructor(generation: BlackBoxRallarGenerationPort) {
        this.#generation = generation;
    }

    public lease(): BlackBoxRallarCrdtResourceController.Lease {
        return { generation: this.#generation.generation() };
    }

    public assertCurrent(lease: BlackBoxRallarCrdtResourceController.Lease, message: string): void {
        if (!this.#generation.isCurrent(lease.generation)) {
            throw new Error(message);
        }
    }

    public open(handle: string, effect: () => Promise<TDocument>): Promise<TDocument> {
        if (this.#documents.has(handle) || this.#opens.isInFlight(handle)) {
            return Promise.reject(new Error('CRDT document handle is already open: ' + handle));
        }
        return this.#opens.run(handle, async () => {
            const document = await effect();
            this.#documents.set(handle, document);
            return document;
        });
    }

    public require(handle: string): TDocument {
        const document = this.#documents.get(handle);
        if (document === undefined) {
            throw new Error('CRDT document handle is not open: ' + handle);
        }
        return document;
    }

    public track<TResult>(effect: Promise<TResult>): Promise<TResult> {
        const completion = effect.finally(() => this.#pendingEffects.delete(completion)).then(() => undefined);
        this.#pendingEffects.add(completion);
        void completion.catch(() => undefined);
        return effect;
    }

    public run<TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult> {
        const previous = this.#operationTails.get(handle) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(() => effect(this.require(handle)));
        const completion = operation.finally(() => {
            if (this.#operationTails.get(handle) === completion) {
                this.#operationTails.delete(handle);
            }
        }).then(() => undefined);
        this.#operationTails.set(handle, completion);
        void completion.catch(() => undefined);
        return operation;
    }

    public release<TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult> {
        return this.run(handle, async (document) => {
            const result = await effect(document);
            this.#documents.delete(handle);
            return result;
        });
    }

    public delete(handle: string): boolean {
        return this.#documents.delete(handle);
    }

    public entries(): readonly (readonly [string, TDocument])[] {
        return [...this.#documents.entries()];
    }

    public handles(): readonly string[] {
        return [...this.#documents.keys()];
    }

    public pending(): readonly Promise<void>[] {
        return [...this.#opens.completions(), ...this.#operationTails.values(), ...this.#pendingEffects];
    }
}
