import { describe, expect, it } from 'vitest';
import {
    createFleetGeographyHistoricalCollection,
    createFleetReportAnalysisCollection,
    createFleetReportAnalysisWork,
    DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS,
    DEFAULT_FLEET_REPORT_DERIVATION_POLICY,
    deriveFleetGeography,
    deriveFleetGeographyFromHistoricalCollection,
    deriveFleetReportAgentDetail,
    deriveFleetReportAgentDetailWindow,
    deriveFleetReportAnalysis,
    deriveFleetReportAnalysisFromCollection,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportFailureWindow,
    deriveFleetReportHeatmapRows,
    deriveFleetReportHeatmapWindow,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportMissingLabelAgentIdWindow,
    deriveFleetReportRecipeTimingWindow,
    deriveFleetReportRegionRows,
    deriveFleetReportRegionTimingWindow,
    deriveFleetReportRegionWindow,
    deriveFleetReportTimingDistribution,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingGroupsByRegion,
    FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
    fleetGeographyRouteEvidenceFromControlRun,
    RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES,
    resolveFleetGeographyDocumentedLocation,
    sortFleetRunReports,
    validateControlFleetReportBundle,
    validateControlFleetReportsResponse,
    validateControlFleetRunReport,
    validateControlFleetRunReportCollection
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import type {
    ControlFleetReportBundleValidationResult,
    ControlFleetReportsResponseValidationResult,
    ControlFleetReportValidationIssue,
    ControlFleetReportValidationIssueCode,
    ControlFleetRunReportCollectionValidationResult,
    ControlFleetRunReportValidationResult,
    DeriveFleetGeographyInput,
    FleetGeographyAgentEvidence,
    FleetGeographyDocumentedLocation,
    FleetGeographyDocumentedLocationInput,
    FleetGeographyDocumentedLocationSource,
    FleetGeographyHistoricalCollection,
    FleetGeographyHistoricalCollectionWork,
    FleetGeographyHistoricalOutcome,
    FleetGeographyLiveAgentEvidence,
    FleetGeographyLiveState,
    FleetGeographyLocation,
    FleetGeographyLocationSource,
    FleetGeographyModel,
    FleetGeographyRegionEvidence,
    FleetGeographyRoute,
    FleetGeographyRouteEvidenceWindow,
    FleetGeographyRouteExtractionOptions,
    FleetGeographyRouteObservation,
    FleetReportAgentDetail,
    FleetReportAgentDetailWindow,
    FleetReportAnalysis,
    FleetReportAnalysisCollection,
    FleetReportAnalysisLimits,
    FleetReportAnalysisWork,
    FleetReportBoundedWindow,
    FleetReportDerivationPolicy,
    FleetReportDisplaySummary,
    FleetReportHeatmap,
    FleetReportHeatmapRow,
    FleetReportHeatmapWindow,
    FleetReportHeatmapWindowRequest,
    FleetReportTimingGroup,
    FleetReportWindow,
    FleetReportWindowRequest
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';

type PublicFleetTypeSurface = Readonly<{
    validationIssueCode: ControlFleetReportValidationIssueCode;
    validationIssue: ControlFleetReportValidationIssue;
    reportValidation: ControlFleetRunReportValidationResult;
    collectionValidation: ControlFleetRunReportCollectionValidationResult;
    responseValidation: ControlFleetReportsResponseValidationResult;
    bundleValidation: ControlFleetReportBundleValidationResult;
    analysisWork: FleetReportAnalysisWork;
    derivationPolicy: FleetReportDerivationPolicy;
    heatmapRow: FleetReportHeatmapRow;
    timingGroup: FleetReportTimingGroup;
    displaySummary: FleetReportDisplaySummary;
    agentDetail: FleetReportAgentDetail;
    agentDetailWindow: FleetReportAgentDetailWindow;
    analysisCollection: FleetReportAnalysisCollection;
    analysisLimits: FleetReportAnalysisLimits;
    window: FleetReportWindow<string>;
    boundedWindow: FleetReportBoundedWindow<string>;
    windowRequest: FleetReportWindowRequest;
    heatmap: FleetReportHeatmap;
    heatmapWindow: FleetReportHeatmapWindow;
    heatmapWindowRequest: FleetReportHeatmapWindowRequest;
    analysis: FleetReportAnalysis;
    liveState: FleetGeographyLiveState;
    liveAgent: FleetGeographyLiveAgentEvidence;
    locationSource: FleetGeographyLocationSource;
    documentedLocationSource: FleetGeographyDocumentedLocationSource;
    documentedLocationInput: FleetGeographyDocumentedLocationInput;
    documentedLocation: FleetGeographyDocumentedLocation;
    location: FleetGeographyLocation;
    historicalOutcome: FleetGeographyHistoricalOutcome;
    agentEvidence: FleetGeographyAgentEvidence;
    regionEvidence: FleetGeographyRegionEvidence;
    routeObservation: FleetGeographyRouteObservation;
    routeWindow: FleetGeographyRouteEvidenceWindow;
    routeOptions: FleetGeographyRouteExtractionOptions;
    route: FleetGeographyRoute;
    geography: FleetGeographyModel;
    geographyInput: DeriveFleetGeographyInput;
    geographyHistory: FleetGeographyHistoricalCollection;
    geographyHistoryWork: FleetGeographyHistoricalCollectionWork;
}>;

const PUBLIC_FLEET_FUNCTIONS = [
    validateControlFleetRunReport,
    validateControlFleetRunReportCollection,
    validateControlFleetReportsResponse,
    validateControlFleetReportBundle,
    createFleetReportAnalysisCollection,
    createFleetReportAnalysisWork,
    sortFleetRunReports,
    deriveFleetReportHeatmapRows,
    deriveFleetReportHeatmapWindow,
    deriveFleetReportRegionRows,
    deriveFleetReportRegionWindow,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportMissingLabelAgentIdWindow,
    deriveFleetReportAgentDetail,
    deriveFleetReportAgentDetailWindow,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportFailureWindow,
    deriveFleetReportTimingGroupsByRegion,
    deriveFleetReportRegionTimingWindow,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportRecipeTimingWindow,
    deriveFleetReportTimingDistribution,
    deriveFleetReportAnalysis,
    deriveFleetReportAnalysisFromCollection,
    createFleetGeographyHistoricalCollection,
    deriveFleetGeography,
    deriveFleetGeographyFromHistoricalCollection,
    fleetGeographyRouteEvidenceFromControlRun,
    resolveFleetGeographyDocumentedLocation
] as const;

describe('fleet report public surface', () => {
    it('exports every additive Fleet value through the package barrel', () => {
        expect(PUBLIC_FLEET_FUNCTIONS.every((value) => typeof value === 'function'))
            .toBe(true);
        expect(DEFAULT_FLEET_REPORT_DERIVATION_POLICY).toEqual({
            reportOrder: 'deterministic',
            timedOutAsFailed: true,
            stableTieBreaks: true,
            textCollation: 'code-unit'
        });
        expect(DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS).toEqual({
            heatmapAgentRows: 32,
            heatmapRunColumns: 8,
            regionRows: 24,
            failureRows: 24,
            timingGroups: 24,
            missingLabelAgentIds: 40,
            agentDetailRuns: 12
        });
        expect(FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL).toContain(
            'not a complete network topology'
        );
        expect(RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES).toBe(64);
        expect(RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH)
            .toBe(512);
        expect(RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES)
            .toBe(16 * 1_024 * 1_024);
        expect(RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES)
            .toBe(48 * 1_024 * 1_024);
    });

    it('keeps every additive Fleet type available from the package barrel', () => {
        const typeSurfaceCompiles = true as PublicFleetTypeSurface extends object ? true :
            false;
        expect(typeSurfaceCompiles).toBe(true);
    });
});
