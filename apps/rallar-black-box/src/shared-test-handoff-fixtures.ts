export {
    BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT as RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT,
    BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG as RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG,
    BLACK_BOX_RUNNER_COVERAGE_HANDOFF as RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF,
} from '@shared-test/black-box-runner/handoff-contract.ts';

export {
    BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION as RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_SCHEMA_VERSION,
    BLACK_BOX_RUNNER_RECIPE_CATALOG_SCHEMA_VERSION as RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG_SCHEMA_VERSION,
    parseBlackBoxRunnerArtifactBundle as parseRallarBlackBoxSharedTestArtifactBundle,
    validateBlackBoxRunnerRecipeCatalog as validateRallarBlackBoxSharedTestRecipeCatalog,
    validateBlackBoxRunnerRecipeCatalogEntryFixture as validateRallarBlackBoxSharedTestRecipeCatalogEntryFixture,
} from '@shared-test/black-box-runner/artifact-reader.ts';

export type {
    BlackBoxRunnerArtifactBundleContract as RallarBlackBoxSharedTestArtifactContract,
    BlackBoxRunnerCoverageHandoff as RallarBlackBoxSharedTestCoverageHandoff,
    BlackBoxRunnerRecipeCatalog as RallarBlackBoxSharedTestRecipeCatalog,
    BlackBoxRunnerRecipeCatalogEntry as RallarBlackBoxSharedTestRecipeCatalogEntry,
} from '@shared-test/black-box-runner/handoff-contract.ts';

export type {
    BlackBoxRunnerArtifactBundleFiles as RallarBlackBoxSharedTestArtifactBundleFiles,
    BlackBoxRunnerArtifactValidationIssue as RallarBlackBoxSharedTestArtifactValidationIssue,
    BlackBoxRunnerArtifactValidationResult as RallarBlackBoxSharedTestArtifactValidationResult,
    BlackBoxRunnerParsedArtifactBundle as RallarBlackBoxSharedTestParsedArtifactBundle,
    BlackBoxRunnerRecipeCatalogEntryFixture as RallarBlackBoxSharedTestRecipeCatalogEntryFixture,
} from '@shared-test/black-box-runner/artifact-reader.ts';
