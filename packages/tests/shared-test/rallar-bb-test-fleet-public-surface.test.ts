import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS,
    DEFAULT_FLEET_REPORT_DERIVATION_POLICY,
    FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
    RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUES,
    RALLAR_BLACK_BOX_FLEET_REPORT_VALIDATION_MAX_ISSUE_TEXT_LENGTH,
    createFleetReportAnalysisWork,
    deriveFleetGeography,
    deriveFleetReportAgentDetail,
    deriveFleetReportAnalysis,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportHeatmapRows,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportRegionRows,
    deriveFleetReportTimingDistribution,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingGroupsByRegion,
    fleetGeographyRouteEvidenceFromControlRun,
    resolveFleetGeographyDocumentedLocation,
    sortFleetRunReports,
    validateControlFleetReportBundle,
    validateControlFleetRunReportCollection,
    validateControlFleetReportsResponse,
    validateControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import type {
    ControlFleetReportBundleValidationResult,
    ControlFleetReportValidationIssue,
    ControlFleetReportValidationIssueCode,
    ControlFleetReportsResponseValidationResult,
    ControlFleetRunReportCollectionValidationResult,
    ControlFleetRunReportValidationResult,
    DeriveFleetGeographyInput,
    FleetGeographyAgentEvidence,
    FleetGeographyDocumentedLocation,
    FleetGeographyDocumentedLocationInput,
    FleetGeographyDocumentedLocationSource,
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
    FleetReportAnalysis,
    FleetReportAnalysisLimits,
    FleetReportAnalysisWork,
    FleetReportDerivationPolicy,
    FleetReportDisplaySummary,
    FleetReportHeatmap,
    FleetReportHeatmapRow,
    FleetReportTimingGroup,
    FleetReportWindow,
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
    analysisLimits: FleetReportAnalysisLimits;
    window: FleetReportWindow<string>;
    heatmap: FleetReportHeatmap;
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
}>;

const PUBLIC_FLEET_FUNCTIONS = [
    validateControlFleetRunReport,
    validateControlFleetRunReportCollection,
    validateControlFleetReportsResponse,
    validateControlFleetReportBundle,
    createFleetReportAnalysisWork,
    sortFleetRunReports,
    deriveFleetReportHeatmapRows,
    deriveFleetReportRegionRows,
    deriveFleetReportMissingLabelAgentIds,
    deriveFleetReportAgentDetail,
    deriveFleetReportDisplaySummary,
    deriveFleetReportFailureRows,
    deriveFleetReportTimingGroupsByRegion,
    deriveFleetReportTimingGroupsByRecipe,
    deriveFleetReportTimingDistribution,
    deriveFleetReportAnalysis,
    deriveFleetGeography,
    fleetGeographyRouteEvidenceFromControlRun,
    resolveFleetGeographyDocumentedLocation,
] as const;

describe('fleet report public surface', () => {
    it('exports every additive Fleet value through the package barrel', () => {
        expect(PUBLIC_FLEET_FUNCTIONS.every(value => typeof value === 'function'))
            .toBe(true);
        expect(DEFAULT_FLEET_REPORT_DERIVATION_POLICY).toEqual({
            reportOrder: 'deterministic',
            timedOutAsFailed: true,
            stableTieBreaks: true,
            textCollation: 'code-unit',
        });
        expect(DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS).toEqual({
            heatmapAgentRows: 32,
            heatmapRunColumns: 8,
            regionRows: 24,
            failureRows: 24,
            timingGroups: 24,
            missingLabelAgentIds: 40,
            agentDetailRuns: 12,
        });
        expect(FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL).toContain(
            'not a complete network topology',
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
        const typeSurfaceCompiles = true as PublicFleetTypeSurface extends object
            ? true
            : false;
        expect(typeSurfaceCompiles).toBe(true);
    });
});
