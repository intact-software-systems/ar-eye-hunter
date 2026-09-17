import {
    MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
    type ComputeDistributedArtifactEvidenceIndexInput,
    type DistributedArtifactEvidenceCatalog,
    type DistributedArtifactEvidenceCollections,
    type DistributedArtifactEvidenceEntry
} from './distributed-artifact-evidence-contracts.ts';
import {
    computeDistributedArtifactEvidenceIndexFromSource,
    computeDistributedArtifactEvidenceSource
} from './distributed-artifact-evidence-index.ts';
import { prepareDistributedArtifactEvidenceCatalogAuthority } from './distributed-artifact-evidence-window.ts';
import {
    BoundedNewestCandidates,
    CatalogAnchorSelection,
    computeRetainedCatalogCandidates,
    type CatalogAnchors
} from './distributed-artifact-evidence/catalog-candidate-retention.ts';
import { createRawSearchValueReader } from './distributed-artifact-evidence/create-raw-search-value-reader.ts';
import {
    resolveDistinctCatalogCandidates,
    type CatalogCandidate
} from './distributed-artifact-evidence/resolve-distinct-catalog-candidates.ts';

export async function computeDistributedArtifactEvidenceCollections(
    input: ComputeDistributedArtifactEvidenceIndexInput
): Promise<DistributedArtifactEvidenceCollections> {
    const source = computeDistributedArtifactEvidenceSource(input);
    const index = computeDistributedArtifactEvidenceIndexFromSource(input, source);
    const catalog = await createDistributedArtifactEvidenceCatalog(input, source.rawEntries);
    return { index, catalog };
}

/** The catalog reads every source row once, keeps its anchors and newest rows, and prepares its window authority. */
async function createDistributedArtifactEvidenceCatalog(
    input: ComputeDistributedArtifactEvidenceIndexInput,
    sourceEntries: readonly DistributedArtifactEvidenceEntry[]
): Promise<DistributedArtifactEvidenceCatalog> {
    const newest = new BoundedNewestCandidates(MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES);
    const anchorSelection = new CatalogAnchorSelection(
        input.analysis.ok ? undefined : input.analysis.failure.commandId
    );
    const distinctEntryCount = await resolveDistinctCatalogCandidates({
        entries: sourceEntries,
        readRawSearchValue: createRawSearchValueReader(input.snapshots),
        onCandidate: (candidate) => {
            newest.add(candidate);
            anchorSelection.add(candidate);
        }
    });
    const anchors = anchorSelection.toAnchors();
    const retained = computeRetainedCatalogCandidates(newest.getCandidates(), anchors);
    const catalog = toDistributedArtifactEvidenceCatalog(retained, anchors, distinctEntryCount);
    await prepareDistributedArtifactEvidenceCatalogAuthority(catalog, {
        artifactIdentity: [
            input.analysis.artifactSchemaVersion ?? null,
            input.analysis.distributedRunId,
            input.analysis.controlRunId ?? null
        ],
        modelValue: [
            catalog.totalEntries,
            catalog.retainedEntryCount,
            catalog.indexOmittedEntryCount,
            retained.map((candidate) => [candidate.entry.id, candidate.digest])
        ],
        searchValues: retained.map((candidate) => candidate.rawSearchValue ?? '')
    });
    return catalog;
}

function toDistributedArtifactEvidenceCatalog(
    retained: readonly CatalogCandidate[],
    anchors: CatalogAnchors,
    distinctEntryCount: number
): DistributedArtifactEvidenceCatalog {
    const entries = retained.map((candidate) => candidate.entry);
    return {
        entries,
        totalEntries: distinctEntryCount,
        retainedEntryCount: entries.length,
        indexOmittedEntryCount: distinctEntryCount - entries.length,
        limit: MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES,
        ...(anchors.primaryFailure ? { primaryFailureId: anchors.primaryFailure.entry.id } : {}),
        ...(anchors.latestDiagnostic ? { latestDiagnosticId: anchors.latestDiagnostic.entry.id } : {}),
        producerCompaction: { status: 'unavailable', reason: 'no-distributed-producer-compaction-contract' }
    };
}
