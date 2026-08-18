import {
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtOperationBatch,
  type RallarCrdtSnapshotEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';

export interface InMemoryCrdtDocumentState<TPayload extends RallarCrdtOperationBatch, TValue> {
  readonly metadata: RallarCrdtDocumentMetadata;
  readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
  readonly snapshot?: RallarCrdtSnapshotEnvelope<TValue>;
}

export class InMemoryCrdtDocumentStore<TPayload extends RallarCrdtOperationBatch, TValue> {
  private readonly documents = new Map<string, InMemoryCrdtDocumentState<TPayload, TValue>>();

  get(document: RallarCrdtDocumentRef): InMemoryCrdtDocumentState<TPayload, TValue> | undefined {
    return this.documents.get(toRallarCrdtDocumentKey(document));
  }

  getByKey(documentKey: string): InMemoryCrdtDocumentState<TPayload, TValue> | undefined {
    return this.documents.get(documentKey);
  }

  getOrCreate(
    document: RallarCrdtDocumentRef,
    createdAtEpochMs: number,
  ): InMemoryCrdtDocumentState<TPayload, TValue> {
    const documentKey = toRallarCrdtDocumentKey(document);
    const existing = this.documents.get(documentKey);
    if (existing) {
      return existing;
    }

    const created: InMemoryCrdtDocumentState<TPayload, TValue> = {
      metadata: {
        document,
        documentKey,
        documentRevision: 0,
        lifecycle: 'active',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 0,
        updateCount: 0,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: null,
        quota: null,
        projectionIds: [],
      },
      records: [],
    };
    this.documents.set(documentKey, created);
    return created;
  }

  set(state: InMemoryCrdtDocumentState<TPayload, TValue>): void {
    this.documents.set(state.metadata.documentKey, state);
  }

  entries(): IterableIterator<[string, InMemoryCrdtDocumentState<TPayload, TValue>]> {
    return this.documents.entries();
  }
}
