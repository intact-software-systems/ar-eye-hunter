import type { DistributedArtifactEvidenceEntry } from '../distributed-artifact-evidence-contracts.ts';
import { computeCanonicalDigest } from './compute-canonical-digest.ts';
import type { RawSearchValueReader } from './create-raw-search-value-reader.ts';

/** A source entry the catalog keeps, with the digest of its canonical form. */
export interface CatalogCandidate {
    readonly entry: DistributedArtifactEvidenceEntry;
    readonly digest: string;
    /** Absent when no recorded result or event value belongs to the entry. */
    readonly rawSearchValue?: string;
}

export interface DistinctCatalogCandidatesInput {
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly readRawSearchValue: RawSearchValueReader;
    /** Receives each distinct entry in source order, once its digest is known. */
    readonly onCandidate: (candidate: CatalogCandidate) => void;
}

interface CanonicalCatalogItem {
    readonly entry: DistributedArtifactEvidenceEntry;
    readonly rawSearchValue: string;
    readonly canonical: string;
}

const CATALOG_DIGEST_BATCH_SIZE = 128;

/**
 * Entries whose canonical form and raw value repeat exactly drop out; entries that share an id but differ keep a
 * collision id. Digests run in bounded batches, so a large artifact never holds more than one batch of pending
 * digests. Resolves to the number of distinct entries.
 */
export async function resolveDistinctCatalogCandidates(input: DistinctCatalogCandidatesInput): Promise<number> {
    const identities = new CatalogCandidateIdentities(input.entries);
    let distinctEntryCount = 0;
    for (let start = 0; start < input.entries.length; start += CATALOG_DIGEST_BATCH_SIZE) {
        const batch = input.entries
            .slice(start, start + CATALOG_DIGEST_BATCH_SIZE)
            .map((entry) => toCanonicalCatalogItem(entry, input.readRawSearchValue(entry)));
        const digests = await Promise.all(batch.map((item) => computeCanonicalDigest(item.canonical)));
        batch.forEach((item, index) => {
            const candidate = identities.resolveCandidate(item, digests[index]);
            if (candidate) {
                distinctEntryCount += 1;
                input.onCandidate(candidate);
            }
        });
    }
    return distinctEntryCount;
}

/** Owns which ids and digests the catalog has seen, so repeats drop out and id collisions get distinct ids. */
class CatalogCandidateIdentities {
    readonly #usedIds: Set<string>;

    readonly #digestsByBaseId = new Map<string, Set<string>>();

    constructor(entries: readonly DistributedArtifactEvidenceEntry[]) {
        this.#usedIds = new Set(entries.map((entry) => entry.id));
    }

    /** Undefined for an exact repeat of an entry already seen, or when the digest is missing. */
    resolveCandidate(item: CanonicalCatalogItem, digest: string | undefined): CatalogCandidate | undefined {
        if (!digest) {
            return undefined;
        }
        const knownDigests = this.#digestsByBaseId.get(item.entry.id) ?? new Set<string>();
        this.#digestsByBaseId.set(item.entry.id, knownDigests);
        if (knownDigests.has(digest)) {
            return undefined;
        }
        const isCollision = knownDigests.size > 0;
        knownDigests.add(digest);
        const entry = isCollision ? { ...item.entry, id: this.#resolveCollisionId(item.entry.id, digest) } : item.entry;
        this.#usedIds.add(entry.id);
        return {
            entry,
            digest,
            ...(item.rawSearchValue.length === 0 ? {} : { rawSearchValue: item.rawSearchValue })
        };
    }

    #resolveCollisionId(baseId: string, digest: string): string {
        const prefix = `${baseId}:collision:${digest}`;
        let id = prefix;
        let collisionIndex = 1;
        while (this.#usedIds.has(id)) {
            collisionIndex += 1;
            id = `${prefix}:${collisionIndex}`;
        }
        return id;
    }
}

function toCanonicalCatalogItem(entry: DistributedArtifactEvidenceEntry, rawSearchValue: string): CanonicalCatalogItem {
    const canonicalEntry = toCanonicalEvidenceEntry(entry);
    return {
        entry,
        rawSearchValue,
        canonical: rawSearchValue ? JSON.stringify([canonicalEntry, rawSearchValue]) : canonicalEntry
    };
}

function toCanonicalEvidenceEntry(entry: DistributedArtifactEvidenceEntry): string {
    return JSON.stringify([
        entry.id,
        entry.kind,
        entry.sourceFile,
        entry.atEpochMs ?? null,
        entry.agentId ?? null,
        entry.agentIds ?? null,
        entry.recipeId ?? null,
        entry.commandId ?? null,
        entry.topic ?? null,
        entry.diagnosticType ?? null,
        entry.severity ?? null,
        entry.transport ?? null,
        entry.status ?? null,
        entry.category ?? null,
        entry.summary,
        entry.payloadSummary,
        entry.failureDetails
            ? [
                entry.failureDetails.code ?? null,
                entry.failureDetails.name ?? null,
                entry.failureDetails.message ?? null,
                entry.failureDetails.stack ?? null
            ]
            : null
    ]);
}
