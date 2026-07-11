import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { useMemo, useState } from 'react';
import {
    deriveControlAgentBoardRows,
    summarizeControlAgentBoardRows,
} from '../../../control-agent-board.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    RallarBlackBoxDistributedTargetResolution,
} from '../../../control-run-manager.ts';
import {
    buildDistributedRunManifest,
    deriveDistributedWorldFleetTargetGate,
    distributedRecipePreflight,
    distributedRecipeTargetRows,
    type DistributedRecipeRolePattern,
    type DistributedRecipeTargetPolicyMode,
    type DistributedRunAgentProgressRow,
} from '../../../distributed-recipes.ts';
import {
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
} from '../../../recipe-fixtures.ts';
import { validateSchemaAuthoringValue } from '../../../schema-authoring.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { safeIdSegment } from '../../shared/safe-id-segment.ts';
import { uniqueValues } from '../../shared/unique-values.ts';
import {
    DISTRIBUTED_RECIPE_CATALOG,
    configuredDistributedRecipeCatalogItem,
    distributedRecipeMatches,
} from './distributed-recipe-catalog.ts';
import { validateDistributedRecipeManifest } from './distributed-manifest-validation.ts';

type UseDistributedRecipeBuilderInput = Readonly<{
    globalValues: CommandCenterGlobalValues;
    selectedRunId: string;
    run: ControlRunSnapshot | undefined;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    selectedDistributedRun: ControlDistributedRunSnapshot | undefined;
    targetResolutionPreview: RallarBlackBoxDistributedTargetResolution | undefined;
    monitorAgentProgress: readonly DistributedRunAgentProgressRow[] | undefined;
}>;

export function useDistributedRecipeBuilder({
    globalValues,
    selectedRunId,
    run,
    distributedRuns,
    selectedDistributedRun,
    targetResolutionPreview,
    monitorAgentProgress,
}: UseDistributedRecipeBuilderInput) {
    const [distributedRunId, setDistributedRunId] = useState(
        () =>
            `dist-${safeIdSegment(globalValues.roomId || 'group')}-${Date.now()}`,
    );
    const [query, setQuery] = useState('');
    const [profile, setProfile] = useState('');
    const [selectedRecipeIds, setSelectedRecipeIds] = useState<
        readonly string[]
    >(() => DISTRIBUTED_RECIPE_CATALOG.slice(0, 1).map((item) => item.itemId));
    const [rtcRealtimeDurationSeconds, setRtcRealtimeDurationSeconds] =
        useState(RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS);
    const [targetPolicyMode, setTargetPolicyMode] =
        useState<DistributedRecipeTargetPolicyMode>('selected-agents');
    const [rolePattern, setRolePattern] =
        useState<DistributedRecipeRolePattern>('all-agents');
    const [expectedParticipantCount, setExpectedParticipantCount] = useState(50);
    const [ackTimeoutMs, setAckTimeoutMs] = useState(15_000);
    const [barrierEnabled, setBarrierEnabled] = useState(false);
    const [barrierTimeoutMs, setBarrierTimeoutMs] = useState(15_000);
    const [startMode, setStartMode] =
        useState<RallarBlackBoxDistributedRunManifest['startMode']>('manual');
    const [startDelayMs, setStartDelayMs] = useState(3_000);
    const [selectedAgentIds, setSelectedAgentIds] = useState<readonly string[]>(
        [],
    );
    const groupRef = useMemo(
        () => ({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
        }),
        [
            globalValues.applicationId,
            globalValues.roomId,
            globalValues.workspaceId,
        ],
    );
    const recipeCatalog = useMemo(
        () =>
            DISTRIBUTED_RECIPE_CATALOG.map((item) =>
                configuredDistributedRecipeCatalogItem(item, {
                    group: groupRef,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    rtcRealtimeDurationSeconds,
                }),
            ),
        [globalValues.apiBaseUrl, groupRef, rtcRealtimeDurationSeconds],
    );
    const profileOptions = useMemo(
        () => uniqueValues(recipeCatalog.flatMap((item) => item.profiles)),
        [recipeCatalog],
    );
    const filteredRecipes = useMemo(
        () =>
            recipeCatalog.filter((item) =>
                distributedRecipeMatches(item, query, profile),
            ),
        [profile, query, recipeCatalog],
    );
    const selectedRecipes = useMemo(
        () =>
            recipeCatalog.filter((item) =>
                selectedRecipeIds.includes(item.itemId),
            ),
        [recipeCatalog, selectedRecipeIds],
    );
    const selectedRecipePreflights = useMemo(
        () =>
            selectedRecipes.map((item) => ({
                item,
                preflight: distributedRecipePreflight(item.recipe),
            })),
        [selectedRecipes],
    );
    const selectedPreflightEffectiveOperations =
        selectedRecipePreflights.reduce(
            (sum, entry) => sum + entry.preflight.effectiveCommandCount,
            0,
        );
    const selectedPreflightWarnings = selectedRecipePreflights.reduce(
        (sum, entry) => sum + entry.preflight.warnings.length,
        0,
    );
    const selectedPreflightErrors = selectedRecipePreflights.reduce(
        (sum, entry) => sum + entry.preflight.errors.length,
        0,
    );
    const selectedPreflightCommandKinds = useMemo(
        () =>
            Array.from(new Set(selectedRecipePreflights.flatMap(
                (entry) => entry.preflight.commandKinds,
            ))),
        [selectedRecipePreflights],
    );
    const targetRows = useMemo(
        () =>
            distributedRecipeTargetRows({
                run,
                group: groupRef,
                requiredCommandKinds: selectedPreflightCommandKinds,
                nowEpochMs: Date.now(),
            }),
        [groupRef, run, selectedPreflightCommandKinds],
    );
    const selectedAgentSet = useMemo(
        () => new Set(selectedAgentIds),
        [selectedAgentIds],
    );
    const targetableRows = targetRows.filter((row) => row.targetable);
    const usesWorldFleetTargets = targetPolicyMode === 'all-online-group-members';
    const manifest = useMemo(() => {
        if (
            !selectedRunId ||
            selectedRecipes.length === 0 ||
            !groupRef.groupId
        ) {
            return undefined;
        }
        return buildDistributedRunManifest({
            distributedRunId,
            controlRunId: selectedRunId,
            displayName: `Distributed ${selectedRecipes.map((item) => item.title).join(', ')}`,
            group: groupRef,
            recipes: selectedRecipes,
            targetAgentIds: usesWorldFleetTargets ? [] : selectedAgentIds,
            targetPolicyMode,
            rolePattern,
            ackTimeoutMs,
            barrier: barrierEnabled
                ? {
                      enabled: true,
                      timeoutMs: barrierTimeoutMs,
                  }
                : undefined,
            startMode: startMode ?? 'manual',
            startDeadlineEpochMs:
                startMode === 'scheduled'
                    ? Date.now() + Math.max(1, startDelayMs)
                    : undefined,
            expectedParticipantCount:
                usesWorldFleetTargets
                    ? expectedParticipantCount
                    : selectedAgentIds.length > 0
                    ? selectedAgentIds.length
                    : undefined,
        });
    }, [
        ackTimeoutMs,
        barrierEnabled,
        barrierTimeoutMs,
        distributedRunId,
        groupRef,
        expectedParticipantCount,
        rolePattern,
        selectedAgentIds,
        selectedRecipes,
        selectedRunId,
        startDelayMs,
        startMode,
        targetPolicyMode,
        usesWorldFleetTargets,
    ]);
    const manifestValidation = useMemo(
        () =>
            manifest
                ? validateDistributedRecipeManifest(manifest)
                : 'Select a run, group, and at least one recipe.',
        [manifest],
    );
    const worldFleetTargetGate = deriveDistributedWorldFleetTargetGate({
        usesWorldFleetTargets,
        expectedParticipantCount,
        targetResolutionPreview,
        selectedDistributedRun,
        distributedRunId,
    });
    const activeTargetResolution = worldFleetTargetGate.targetResolution;
    const worldFleetPreviewSelected = worldFleetTargetGate.previewSelected;
    const worldFleetStageStartBlocked = worldFleetTargetGate.blocked;
    const worldFleetBlockReason = worldFleetTargetGate.blockReason;
    const manifestAuthoringValidation = useMemo(
        () =>
            manifest
                ? validateSchemaAuthoringValue(
                      'distributed-run-manifest',
                      manifest,
                  )
                : undefined,
        [manifest],
    );
    const distributedTargetAgentRows = useMemo(
        () =>
            deriveControlAgentBoardRows({
                run,
                group: groupRef,
                requiredCommandKinds: selectedPreflightCommandKinds,
                distributedRuns,
                selectedDistributedRun,
                monitorAgentProgress: monitorAgentProgress ?? [],
                nowEpochMs: Date.now(),
            }),
        [
            distributedRuns,
            groupRef,
            run,
            selectedDistributedRun,
            monitorAgentProgress,
            selectedPreflightCommandKinds,
        ],
    );
    const distributedTargetAgentSummary = useMemo(
        () => summarizeControlAgentBoardRows(distributedTargetAgentRows),
        [distributedTargetAgentRows],
    );
    const liveSelectedRecipeCount = selectedRecipes.filter(
        (item) => item.live,
    ).length;
    const rtcRealtimeSelected = selectedRecipeIds.includes(
        RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    );
    const rtcRealtimeFrameCount =
        rtcRealtimeDurationSeconds * RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ;

    return {
        distributedRunId, setDistributedRunId, query, setQuery, profile, setProfile,
        selectedRecipeIds, setSelectedRecipeIds, rtcRealtimeDurationSeconds,
        setRtcRealtimeDurationSeconds, targetPolicyMode, setTargetPolicyMode,
        rolePattern, setRolePattern, expectedParticipantCount,
        setExpectedParticipantCount, ackTimeoutMs, setAckTimeoutMs,
        barrierEnabled, setBarrierEnabled, barrierTimeoutMs, setBarrierTimeoutMs,
        startMode, setStartMode, startDelayMs, setStartDelayMs,
        selectedAgentIds, setSelectedAgentIds, groupRef, profileOptions,
        filteredRecipes, selectedRecipes, selectedRecipePreflights,
        selectedPreflightEffectiveOperations, selectedPreflightWarnings,
        selectedPreflightErrors, targetRows, selectedAgentSet, targetableRows,
        usesWorldFleetTargets, manifest, manifestValidation,
        activeTargetResolution, worldFleetPreviewSelected,
        worldFleetStageStartBlocked, worldFleetBlockReason,
        manifestAuthoringValidation, distributedTargetAgentRows,
        distributedTargetAgentSummary, liveSelectedRecipeCount,
        rtcRealtimeSelected, rtcRealtimeFrameCount,
    };
}

export type DistributedRecipeBuilderModel =
    ReturnType<typeof useDistributedRecipeBuilder>;
