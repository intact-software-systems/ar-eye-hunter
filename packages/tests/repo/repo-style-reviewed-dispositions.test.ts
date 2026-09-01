import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import {
    isReviewedDisposition,
    readReviewedDispositionContext,
    reviewedDispositions
} from '../../../scripts/repo-style-check/reviewed-dispositions.mjs';

const repoRoot = process.cwd();
const checkerPath = path.join(repoRoot, 'scripts/check-changed-repo-style.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const fixtureRoot of fixtureRoots.splice(0)) {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

describe('reviewed repository style dispositions', () => {
    it('freezes exactly the reviewed path, rule, symbol, and magnitude contracts', () => {
        expect(Object.isFrozen(reviewedDispositions)).toBe(true);
        expect(reviewedDispositions).toEqual([
            {
                path: 'packages/shared/resilience/to-error.ts',
                rule: 'boundary.unknown',
                symbol: 'toError'
            },
            {
                path: 'tests/playwright/rallar-black-box/live-rtc-evidence-json.ts',
                rule: 'boundary.unknown',
                symbol: 'normalizeJson'
            },
            {
                path: 'tests/playwright/rallar-black-box/live-rtc-evidence-json.ts',
                rule: 'boundary.unknown',
                symbol: 'normalizeJsonValue'
            },
            {
                path: 'packages/tests/repo/tests-typecheck-external-unit.test.ts',
                rule: 'boundary.unknown',
                symbol: 'readTestProjectIncludes'
            },
            {
                path: 'packages/shared-web/browser/rallar-data.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared/rallar-ai/rallar-ai-types.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared/alm/al-admission-backend.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared/alm/al-admission-resource-entry-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeResourceEntryRecord'
            },
            {
                path: 'packages/shared/alm/inbound/al-inbound-durable-effect-codec.ts',
                rule: 'boundary.unknown',
                symbol: 'assertControlMessage'
            },
            {
                path: 'packages/shared/alm/indexed-db-admission-backend.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/tests/shared/alm/al-inbound-persistence-validation.test.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
                rule: 'boundary.unknown',
                symbol: 'normalizeRtcBaselineJson'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
                rule: 'layout.primary-export-name',
                symbol: 'parseRtcBaselineCommand'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts',
                rule: 'layout.primary-export-name',
                symbol: 'createRtcBaselineDenoAcceptance'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts',
                rule: 'layout.primary-export-name',
                symbol: 'createRtcBaselineRepeatInitializer'
            },
            {
                path: 'packages/shared-server/rallar-system/app-inbox/' +
                    'app-inbox-command-decoding.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeAppInboxEnqueue'
            },
            {
                path: 'packages/shared-server/rallar-system/client-state/validation/' +
                    'client-record-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeClientValidationRecord'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
                    'validate-group-mutation-operation-input.ts',
                rule: 'boundary.unknown',
                symbol: 'validateActivateGroupInput'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
                    'validate-group-mutation-operation-input.ts',
                rule: 'boundary.unknown',
                symbol: 'isUnitIntervalNumber'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation-primitives.ts',
                rule: 'boundary.unknown',
                symbol: 'readRtcRttPersistedRecord'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation-primitives.ts',
                rule: 'boundary.unknown',
                symbol: 'assertExactRtcRttPersistedKeys'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation-primitives.ts',
                rule: 'boundary.unknown',
                symbol: 'assertNonEmptyRtcRttString'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation-primitives.ts',
                rule: 'boundary.unknown',
                symbol: 'assertRtcRttSafeInteger'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation-primitives.ts',
                rule: 'boundary.unknown',
                symbol: 'validateRtcRttCommandHash'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'validateRtcRttMutationReceipt'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'validateRtcRttMeasurement'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'validateRtcRttEndpointAdmission'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'validateCanonicalGroupRef'
            },
            {
                path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
                    'rtc-rtt-persistence-validation.ts',
                rule: 'boundary.unknown',
                symbol: 'validateExpectedRevision'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
                rule: 'boundary.unknown',
                symbol: 'consoleWarningPart'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
                rule: 'boundary.unknown',
                symbol: 'classifyConsoleWarning'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts',
                rule: 'boundary.unknown',
                symbol: 'ensurePatch'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'isBlackBoxCommandRecord'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxCommandString'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxCommandNumber'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxCommandScope'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxCommandRoomRef'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodePeerIds'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeAck'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeMessageFields'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'isRealtimeSendEnvelope'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarSendInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarWsSendInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'configRecord'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalString'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalNumber'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalBoolean'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'stringList'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'registration'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'messageSelector'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'dataChannelInit'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts',
                rule: 'boundary.unknown',
                symbol: 'flowControl'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'commandRecord'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalString'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalNumber'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalBoolean'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'stringList'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'numberList'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'isCrdtJsonValue'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'optionalJsonValue'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'transport'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'scope'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'registration'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'connection'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'operationKind'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'pathKind'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'pathSchema'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'validation'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'encryptionKey'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'encryption'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtHandle'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtOpenInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtApplyInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtUndoRedoInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'syncOptions'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtSyncInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'waitCondition'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeBlackBoxRallarCrdtWaitInput'
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared/webrtc/decode-rtc-signaling-message.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeRtcSignalingPayload'
            },
            {
                path: 'packages/shared/webrtc/decode-rtc-signaling-message.ts',
                rule: 'boundary.unknown',
                symbol: 'decodeIceCandidate'
            },
            {
                path: 'packages/tests/shared-server/rallar-system/group-state/presence/group-presence-summary-delta-emission.test.ts',
                rule: 'boundary.unknown',
                symbol: 'readEventRowPayload'
            },
            {
                path: 'packages/tests/shared-server/rallar-system/group-state/presence/group-state-delta-envelope.test.ts',
                rule: 'boundary.unknown',
                symbol: 'readGroupStateEventRowEnvelope'
            },
            {
                path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/tests/shared-test/rallar-browser-runtime/director.test.ts',
                rule: 'boundary.unknown',
                symbol: 'configureDirectorRelayScenario'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
                rule: 'boundary.unknown',
                symbol: 'isGroupInputRecord'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
                rule: 'boundary.unknown',
                symbol: 'validateGroupInputFields'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
                rule: 'boundary.unknown',
                symbol: 'resolveGroupInputFieldIssue'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
                rule: 'boundary.unknown',
                symbol: 'validateGroupInputJson'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-input-validation-issues.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
                rule: 'boundary.unknown',
                symbol: 'validateGroupLifecyclePolicyInputShape'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
                rule: 'boundary.unknown',
                symbol: 'validatePolicyObject'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
                rule: 'boundary.unknown',
                symbol: 'validatePolicyField'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
                rule: 'boundary.unknown',
                symbol: 'validateTrigger'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-lifecycle-policy-input-shape.ts',
                rule: 'boundary.unknown',
                symbol: 'validateNumber'
            },
            {
                path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts',
                rule: 'boundary.unknown',
                symbol: 'validateExpectedLayout'
            },
            {
                path: 'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/tests/shared-server/rallar-system/group-state/persistence/group-state-repository-identity.test.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'scripts/perf/api-v1-state-write-group-receipt-evidence.ts',
                rule: 'boundary.unknown',
                symbol: undefined
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts',
                rule: 'file.cognitive-load',
                symbol: undefined,
                maximumMagnitude: 117
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts',
                rule: 'file.cognitive-load',
                symbol: undefined,
                maximumMagnitude: 89
            },
            {
                path: 'packages/shared/services/web-rtc-connection-service.ts',
                rule: 'file.cognitive-load',
                symbol: undefined,
                maximumMagnitude: 105
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime',
                rule: 'layout.directory-density',
                symbol: 'rallar-browser-runtime',
                maximumMagnitude: 21
            },
            {
                path: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime',
                rule: 'layout.feature-prefix-cluster',
                symbol: 'prefix:black',
                maximumMagnitude: 12
            }
        ]);
    });

    it('passes only the reviewed RTC baseline findings', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('PASS: no new repository style findings');
    });

    it('emits checker-owned symbols for every reviewed RTC baseline key', () => {
        const findings = scanProductionSources({
            repoRoot,
            sources: reviewedSources(repoRoot),
            options: {
                layoutOnly: false,
                layoutDetails: true,
                constructionDetails: false,
                outputContracts: true,
                objectInterfaces: true
            }
        }).findings;

        const findingKeys = findings.map(({ file, ruleId, symbol }) => ({
            path: path.relative(repoRoot, file),
            ruleId,
            symbol
        }));
        const boundaryKeys = findingKeys.filter(({ ruleId }) => ruleId === 'boundary.unknown');

        expect(boundaryKeys).toHaveLength(6);
        expect(new Set(boundaryKeys.map(({ symbol }) => symbol))).toEqual(
            new Set(['normalizeRtcBaselineJson'])
        );
        expect(findingKeys.filter(({ ruleId }) => ruleId !== 'boundary.unknown')).toEqual([
            {
                path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'parseRtcBaselineCommand'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'createRtcBaselineDenoAcceptance'
            },
            {
                path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts',
                ruleId: 'layout.primary-export-name',
                symbol: 'createRtcBaselineRepeatInitializer'
            }
        ]);
        expect(findings.find(({ message }) => message.startsWith('... and '))).toMatchObject({
            affectedCount: 3,
            symbol: 'normalizeRtcBaselineJson'
        });
    });

    it('keeps a growing unknown overflow blocking', () => {
        const file = 'apps/example/decode-boundary.ts';
        const fixture = createGitFixture({ [file]: unknownSource('decodeBoundary', 7) });
        commitAll(fixture, 'base');
        writeFixture(fixture, file, unknownSource('decodeBoundary', 8));

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('boundary.unknown');
    });

    it.each([
        {
            label: 'path',
            file: 'packages/shared-rtc-bench/other-baseline/rtc-baseline-decoding.ts',
            source: decodingSource('normalizeRtcBaselineJson'),
            ruleId: 'boundary.unknown'
        },
        {
            label: 'rule',
            file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            source: 'export function normalizeRtcBaselineJson(value: string): string { return value; }\n',
            ruleId: 'layout.primary-export-name'
        },
        {
            label: 'symbol',
            file: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            source: decodingSource('normalizeOtherRtcBaselineJson'),
            ruleId: 'boundary.unknown'
        }
    ])('fails closed for a wrong $label', ({ file, source, ruleId }) => {
        const fixture = createGitFixture({ 'README.md': 'fixture\n' });
        commitAll(fixture, 'base');
        writeFixture(fixture, file, source);

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain(ruleId);
    });

    it('keeps an undispositioned finding blocking beside reviewed findings', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);
        appendFixture(
            fixture,
            'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
            '\nfunction undispositionedFinding(a: string, b: string, c: string, d: string) {\n  return a + b + c + d;\n}\n'
        );

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(result.stdout).toContain('function.input-contract');
    });

    it('keeps an unknown owned by another function blocking after reviewed overflow', () => {
        const fixture = createReviewedFixture();
        writeReviewedSources(fixture);
        appendFixture(
            fixture,
            'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
            '\nexport function decodeOther(value: unknown): string { return String(value); }\n'
        );

        const result = runChangedChecker(fixture);

        expect(result.status, result.stdout).toBe(1);
        expect(result.stdout).toContain('FAIL: 1 new or worsened repository style finding');
        expect(result.stdout).toContain('boundary.unknown');
    });

    it.each([
        { relativeFile: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts', maximumMagnitude: 117 },
        { relativeFile: 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts', maximumMagnitude: 89 },
        { relativeFile: 'packages/shared/services/web-rtc-connection-service.ts', maximumMagnitude: 105 }
    ])('keeps the reviewed cognitive magnitude bounded for $relativeFile', ({ relativeFile, maximumMagnitude }) => {
        const finding = {
            file: path.join(repoRoot, relativeFile),
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            message: `File cognitive load ${maximumMagnitude} reaches the review tier.`
        };
        expect(isReviewedDisposition(repoRoot, finding)).toBe(true);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: `File cognitive load ${maximumMagnitude - 1} reaches the review tier.`
        })).toBe(true);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: `File cognitive load ${maximumMagnitude + 1} reaches the review tier.`
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, {
            ...finding,
            message: 'File cognitive load 330 reaches the refactor-or-register tier.'
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, file: `${finding.file}.other.ts` })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, ruleId: 'file.length' })).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...finding, symbol: 'otherOwner' })).toBe(false);
    });

    it('bounds directory review and distinguishes checker-owned prefixes at the same path', () => {
        const directory = 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime';
        const sources = [
            ...Array.from({ length: 12 }, (_, index) => `black-owner-${index}.ts`),
            ...Array.from({ length: 9 }, (_, index) => `other-owner-${index}.ts`)
        ].map((file) => ({ file: path.join(repoRoot, directory, file), raw: '' }));
        const findings = scanProductionSources({ repoRoot, sources, options: { layoutOnly: true } }).findings;
        const density = findings.find(({ ruleId }) => ruleId === 'layout.directory-density');
        const black = findings.find(({ ruleId, symbol }) => ruleId === 'layout.feature-prefix-cluster' && symbol === 'prefix:black');
        const other = findings.find(({ ruleId, symbol }) => ruleId === 'layout.feature-prefix-cluster' && symbol === 'prefix:other');
        expect(density).toBeDefined();
        expect(black).toBeDefined();
        expect(other).toBeDefined();
        if (density === undefined || black === undefined || other === undefined) {
            throw new Error('Expected density and both independently owned prefix findings.');
        }
        expect(isReviewedDisposition(repoRoot, density)).toBe(true);
        expect(isReviewedDisposition(repoRoot, black)).toBe(true);
        expect(isReviewedDisposition(repoRoot, other)).toBe(false);
        expect(isReviewedDisposition(repoRoot, { ...black, symbol: undefined })).toBe(false);
        // Display wording cannot transfer the exact prefix ownership.
        expect(isReviewedDisposition(repoRoot, {
            ...other,
            message: black.message
        })).toBe(false);
        expect(isReviewedDisposition(repoRoot, {
            ...black,
            message: black.message.replace('prefix \'black\'', 'A reviewed feature cluster')
        })).toBe(true);
        const grown = scanProductionSources({
            repoRoot,
            sources: [...sources, { file: path.join(repoRoot, directory, 'black-owner-added.ts'), raw: '' }],
            options: { layoutOnly: true }
        }).findings;
        expect(
            grown.filter(({ ruleId }) => ruleId === 'layout.directory-density' || ruleId === 'layout.feature-prefix-cluster')
                .every((finding) => !isReviewedDisposition(repoRoot, finding))
        ).toBe(true);
    });

    it('keeps function-owned unknown findings blocking beside a reviewed module owner', () => {
        const relativeFile = 'packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts';
        const findings = scanProductionSources({
            repoRoot,
            sources: [{
                file: path.join(repoRoot, relativeFile),
                raw: 'export interface OpaqueData { value: unknown; }\n' +
                    'export function unreviewedDomain(value: unknown): string { return String(value); }\n'
            }],
            options: { layoutOnly: false }
        }).findings.filter(({ ruleId }) => ruleId === 'boundary.unknown');
        expect(findings.map((finding) => isReviewedDisposition(repoRoot, finding))).toEqual([true, false]);
    });

    it('matches a receipt disposition only at exact native magnitude and candidate head', () => {
        const file = path.join(repoRoot, 'packages/example/large-owner.ts');
        const finding = {
            file,
            ruleId: 'file.cognitive-load',
            symbol: undefined,
            message: 'File cognitive load 112 reaches the required-separation-review tier.'
        };
        const decision = {
            decisionId: 'd'.repeat(64),
            projection: {
                rule: 'file.cognitive-load',
                path: 'packages/example/large-owner.ts',
                symbol: null,
                magnitude: 112,
                candidateHead: 'a'.repeat(40)
            }
        };

        expect(
            isReviewedDisposition(repoRoot, finding, {
                candidateHead: 'a'.repeat(40),
                decisions: [decision]
            })
        ).toBe(true);
        expect(
            isReviewedDisposition(repoRoot, finding, {
                candidateHead: 'b'.repeat(40),
                decisions: [decision]
            })
        ).toBe(false);
        expect(
            isReviewedDisposition(
                repoRoot,
                { ...finding, message: finding.message.replace('112', '113') },
                {
                    candidateHead: 'a'.repeat(40),
                    decisions: [decision]
                }
            )
        ).toBe(false);
    });

    it('keeps trusted-main receipt verification issues visible and fail closed', () => {
        const context = readReviewedDispositionContext(repoRoot, 'a'.repeat(40), {
            readGovernanceDecisionIndex: () => ({
                decisions: [],
                duplicateDecisionIds: new Set(),
                issues: ['forged receipt was excluded']
            })
        });

        expect(context.decisions).toEqual([]);
        expect(context.issues).toEqual(['forged receipt was excluded']);
    });

    it('documents the fail-closed reviewed-disposition contract', () => {
        const guide = readFileSync(path.join(repoRoot, 'docs/repo-human-style-guide.md'), 'utf8');
        const normalizedGuide = guide.replace(/\s+/gu, ' ');

        for (
            const requiredText of [
                'Reviewed changed-file dispositions',
                '`scripts/repo-style-check/reviewed-dispositions.mjs`',
                'exact normalized path, rule identifier, and checker-owned symbol',
                'never parses or substring-matches human-readable finding messages',
                'Dormant entries are allowed',
                'Every unmatched finding remains blocking'
            ]
        ) {
            expect(normalizedGuide, requiredText).toContain(requiredText);
        }
    });
});

function createReviewedFixture(): string {
    const fixture = createGitFixture({ 'README.md': 'fixture\n' });
    commitAll(fixture, 'base');
    return fixture;
}

function reviewedSources(root: string) {
    return [
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts'
            ),
            raw: decodingSource('normalizeRtcBaselineJson')
        },
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts'
            ),
            raw: primaryExportSource('parseRtcBaselineCommand')
        },
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts'
            ),
            raw: primaryExportSource('createRtcBaselineDenoAcceptance')
        },
        {
            file: path.join(
                root,
                'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts'
            ),
            raw: primaryExportSource('createRtcBaselineRepeatInitializer')
        }
    ];
}

function writeReviewedSources(fixture: string): void {
    for (const source of reviewedSources(fixture)) {
        writeFixture(fixture, path.relative(fixture, source.file), source.raw);
    }
}

function decodingSource(symbol: string): string {
    return unknownSource(symbol, 7);
}

function primaryExportSource(symbol: string): string {
    return `export function ${symbol}(value: string): string { return value; }\n`;
}

function unknownSource(symbol: string, localCount: number): string {
    return [
        'export interface RtcBaselineJson { readonly value: string; }',
        `export function ${symbol}(value: unknown): string {`,
        ...Array.from({ length: localCount }, (_, index) => `  const value${index}: unknown = value;`),
        '  return String(value);',
        '}',
        ''
    ].join('\n');
}

function createGitFixture(files: Readonly<Record<string, string>>): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'reviewed-style-fixture-'));
    fixtureRoots.push(fixtureRoot);
    runGit(fixtureRoot, ['init', '--initial-branch=main']);
    runGit(fixtureRoot, ['config', 'user.name', 'Repo Style Test']);
    runGit(fixtureRoot, ['config', 'user.email', 'repo-style@example.invalid']);
    for (const [relativePath, source] of Object.entries(files)) {
        writeFixture(fixtureRoot, relativePath, source);
    }
    return fixtureRoot;
}

function writeFixture(fixtureRoot: string, relativePath: string, source: string): void {
    const filePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source);
}

function appendFixture(fixtureRoot: string, relativePath: string, source: string): void {
    const filePath = path.join(fixtureRoot, relativePath);
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}${source}`);
}

function commitAll(fixtureRoot: string, message: string): void {
    runGit(fixtureRoot, ['add', '.']);
    runGit(fixtureRoot, ['commit', '-m', message]);
}

function runChangedChecker(fixtureRoot: string) {
    return spawnSync(process.execPath, [checkerPath, 'HEAD'], {
        cwd: fixtureRoot,
        encoding: 'utf8'
    });
}

function runGit(fixtureRoot: string, args: readonly string[]): void {
    const result = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
}
