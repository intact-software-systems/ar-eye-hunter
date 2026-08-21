export type TuneRunCatalogWork = Readonly<{
    controlRowsIndexed: number;
    distributedRowsIndexed: number;
    distributedIdentitiesVisited: number;
    identityProjections: number;
    manifestIdentityChecks: number;
    /** Recursive validation of at most the two selected control manifests. */
    manifestValidations: number;
    selectionBoundaryManifestValidations: number;
    selectionBoundaryPerformanceDerivations: number;
    selectionBoundaryProjectionReuses: number;
    retainedArtifactManifestValidations: number;
    retainedFacadeManifestValidations: number;
    controlPairLookups: number;
    performanceDerivations: number;
    retainedArtifactProjections: number;
    retainedFacadeProjections: number;
}>;

export type MutableTuneRunCatalogWork = {
    -readonly [Key in keyof TuneRunCatalogWork]: TuneRunCatalogWork[Key];
};

export function createTuneRunCatalogWork(): MutableTuneRunCatalogWork {
    return {
        controlRowsIndexed: 0,
        distributedRowsIndexed: 0,
        distributedIdentitiesVisited: 0,
        identityProjections: 0,
        manifestIdentityChecks: 0,
        manifestValidations: 0,
        selectionBoundaryManifestValidations: 0,
        selectionBoundaryPerformanceDerivations: 0,
        selectionBoundaryProjectionReuses: 0,
        retainedArtifactManifestValidations: 0,
        retainedFacadeManifestValidations: 0,
        controlPairLookups: 0,
        performanceDerivations: 0,
        retainedArtifactProjections: 0,
        retainedFacadeProjections: 0
    };
}
