import {
    compareDistributedRuns,
    distributedRecipeStateTone,
    filterDistributedRuns,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { useMemo, useState } from 'react';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../../control-run-manager.ts';
import { formatTime } from '../../../shared/time-format.ts';
import { uniqueValues } from '../../../shared/unique-values.ts';
import { DistributedRunComparePanel } from '../../distributed/DistributedRunComparePanel.tsx';
import {
    dateInputEndEpoch,
    dateInputStartEpoch,
} from './date-input-epoch.ts';

type DistributedRunHistorySectionProps = Readonly<{
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    selectedDistributedRun?: ControlDistributedRunSnapshot;
    run?: ControlRunSnapshot;
    loadDistributedRun(id: string): void | Promise<void>;
}>;

export function DistributedRunHistorySection({
    distributedRuns,
    selectedDistributedRun,
    run,
    loadDistributedRun,
}: DistributedRunHistorySectionProps) {
    const [historyQuery, setHistoryQuery] = useState('');
    const [historyStatus, setHistoryStatus] = useState('');
    const [historyGroup, setHistoryGroup] = useState('');
    const [historyRecipe, setHistoryRecipe] = useState('');
    const [historyProfile, setHistoryProfile] = useState('');
    const [historyUser, setHistoryUser] = useState('');
    const [historyFailureType, setHistoryFailureType] = useState('');
    const [historyFromDate, setHistoryFromDate] = useState('');
    const [historyToDate, setHistoryToDate] = useState('');
    const [compareLeftId, setCompareLeftId] = useState('');
    const [compareRightId, setCompareRightId] = useState('');
    const historyStatusOptions = useMemo(
        () => uniqueValues(distributedRuns.map((item) => item.state)),
        [distributedRuns],
    );
    const historyRecipeOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.flatMap((item) =>
                    item.manifest.recipes.map(
                        (selection, index) =>
                            selection.recipeId ??
                            selection.recipe?.recipeId ??
                            `recipe-${index + 1}`,
                    ),
                ),
            ),
        [distributedRuns],
    );
    const historyGroupOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.map((item) => item.manifest.group.groupId),
            ),
        [distributedRuns],
    );
    const historyProfileOptions = useMemo(
        () =>
            uniqueValues(
                distributedRuns.flatMap((item) =>
                    item.manifest.recipes
                        .map((selection) => selection.profile)
                        .filter((value): value is string => Boolean(value)),
                ),
            ),
        [distributedRuns],
    );
    const historyRows = useMemo(
        () =>
            filterDistributedRuns(distributedRuns, {
                query: historyQuery,
                groupId: historyGroup,
                recipeId: historyRecipe,
                profile: historyProfile,
                user: historyUser,
                status: historyStatus,
                failureType: historyFailureType,
                fromEpochMs: dateInputStartEpoch(historyFromDate),
                toEpochMs: dateInputEndEpoch(historyToDate),
            }),
        [
            distributedRuns,
            historyFailureType,
            historyFromDate,
            historyGroup,
            historyProfile,
            historyQuery,
            historyRecipe,
            historyStatus,
            historyToDate,
            historyUser,
        ],
    );
    const compareLeftRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareLeftId,
            ),
        [compareLeftId, distributedRuns],
    );
    const compareRightRun = useMemo(
        () =>
            distributedRuns.find(
                (item) => item.distributedRunId === compareRightId,
            ),
        [compareRightId, distributedRuns],
    );
    const compareSummary = useMemo(
        () =>
            compareLeftRun && compareRightRun
                ? compareDistributedRuns({
                      left: compareLeftRun,
                      right: compareRightRun,
                      leftControlRun:
                          compareLeftRun.controlRunId === run?.runId
                              ? run
                              : undefined,
                      rightControlRun:
                          compareRightRun.controlRunId === run?.runId
                              ? run
                              : undefined,
                  })
                : undefined,
        [compareLeftRun, compareRightRun, run],
    );

    return (
        <>
            <section className="distributed-subpanel distributed-history-panel">
                <div className="section-heading">
                    <h3>Historical Runs</h3>
                    <span>
                        {historyRows.length}/{distributedRuns.length}
                    </span>
                </div>
                <div className="distributed-history-filters">
                    <label className="field">
                        <span>Search</span>
                        <input
                            value={historyQuery}
                            onChange={(event) =>
                                setHistoryQuery(event.target.value)
                            }
                            placeholder="run, group, recipe, failure"
                        />
                    </label>
                    <label className="field">
                        <span>Status</span>
                        <select
                            value={historyStatus}
                            onChange={(event) =>
                                setHistoryStatus(event.target.value)
                            }
                        >
                            <option value="">Any</option>
                            {historyStatusOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Group</span>
                        <select
                            value={historyGroup}
                            onChange={(event) =>
                                setHistoryGroup(event.target.value)
                            }
                        >
                            <option value="">Any</option>
                            {historyGroupOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Recipe</span>
                        <select
                            value={historyRecipe}
                            onChange={(event) =>
                                setHistoryRecipe(event.target.value)
                            }
                        >
                            <option value="">Any</option>
                            {historyRecipeOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>Profile</span>
                        <select
                            value={historyProfile}
                            onChange={(event) =>
                                setHistoryProfile(event.target.value)
                            }
                        >
                            <option value="">Any</option>
                            {historyProfileOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span>User</span>
                        <input
                            value={historyUser}
                            onChange={(event) =>
                                setHistoryUser(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>Failure</span>
                        <select
                            value={historyFailureType}
                            onChange={(event) =>
                                setHistoryFailureType(event.target.value)
                            }
                        >
                            <option value="">Any</option>
                            <option value="any">Any failure</option>
                            <option value="run">Run</option>
                            <option value="participant">Participant</option>
                            <option value="recipe">Recipe</option>
                            <option value="timed-out">Timed out</option>
                        </select>
                    </label>
                    <label className="field">
                        <span>From</span>
                        <input
                            type="date"
                            value={historyFromDate}
                            onChange={(event) =>
                                setHistoryFromDate(event.target.value)
                            }
                        />
                    </label>
                    <label className="field">
                        <span>To</span>
                        <input
                            type="date"
                            value={historyToDate}
                            onChange={(event) =>
                                setHistoryToDate(event.target.value)
                            }
                        />
                    </label>
                </div>
                <div className="distributed-run-list distributed-history-list">
                    {historyRows.map((item) => (
                        <button
                            type="button"
                            key={item.distributedRunId}
                            className={`distributed-run-row ${item.distributedRunId === selectedDistributedRun?.distributedRunId ? 'selected' : ''}`}
                            onClick={() =>
                                void loadDistributedRun(
                                    item.distributedRunId,
                                )
                            }
                        >
                            <span>
                                <strong>{item.distributedRunId}</strong>
                                <small>
                                    {item.manifest.group.groupId} -{' '}
                                    {item.manifest.recipes
                                        .map(
                                            (selection, index) =>
                                                selection.recipeId ??
                                                selection.recipe
                                                    ?.recipeId ??
                                                `recipe-${index + 1}`,
                                        )
                                        .join(', ')}
                                </small>
                            </span>
                            <span
                                className={`pill ${distributedRecipeStateTone(item.state)}`}
                            >
                                {item.state}
                            </span>
                            <small>
                                {formatTime(item.updatedAtEpochMs)}
                            </small>
                        </button>
                    ))}
                    {historyRows.length === 0 && (
                        <div className="empty-state">
                            No distributed runs match the filters
                        </div>
                    )}
                </div>
            </section>
            <DistributedRunComparePanel
                runs={distributedRuns}
                leftId={compareLeftId}
                rightId={compareRightId}
                summary={compareSummary}
                onLeftChange={setCompareLeftId}
                onRightChange={setCompareRightId}
            />
        </>
    );
}
