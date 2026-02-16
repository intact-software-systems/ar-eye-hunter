// ComputeAsyncTask.test.ts
import { describe, expect, test } from "vitest";
import { Loop, Loops, Submit, TrackedTask, filterOutFinishedTasks, track, waitForAll } from "@shared/resilience/ComputeAsyncTask.ts";

function sleep(ms: number): Promise<void> {
    return new Promise<void>((r) => setTimeout(r, ms));
}

describe("ComputeAsyncTask", () => {
    const MAX_CONCURRENCY = 4;

    test("Submit.submitAsyncTasks creates at most maxConcurrency tasks in flight", async () => {
        let ongoing: TrackedTask[] = [];

        // runnable that completes a bit later
        const runnable = async () => {
            await sleep(5);
        };

        for (let i = 0; i < 50; i++) {
            const computed = Submit.submitAsyncTasks({
                runnable,
                ongoingTasks: ongoing,
                maxConcurrency: MAX_CONCURRENCY,
            });

            ongoing = computed.tasksInFlight;

            // At any moment, in-flight list should not exceed max (it may shrink as tasks complete)
            expect(ongoing.length).toBeLessThanOrEqual(MAX_CONCURRENCY);

            // Let some tasks complete
            await sleep(1);
            ongoing = filterOutFinishedTasks(ongoing);
        }

        const remaining = await waitForAll(ongoing, 100);
        expect(remaining).toEqual([]);
    });

    test("Loop.runWhileWork halts when isWork becomes false", async () => {
        let checks = 0;
        const numTimesIsWorkTrue = 10;

        const computed = await Loop.runWhileWork({
            maxConcurrency: () => MAX_CONCURRENCY,
            isWork: () => (++checks < numTimesIsWorkTrue),
            runnable: async () => {
                await sleep(1);
            },
            ongoingTasks: [],
            maxBackoffMs: 50,
            maxIsWorkIterations: 1000,
            // keep sleep short in tests
            sleep: async () => {},
        });

        const remaining = await waitForAll(computed.tasksInFlight, 200);
        expect(remaining).toEqual([]);

        // In the Java test they expect exact equals; here it depends on when allowed=true and checks happen.
        // With this structure, it should match numTimesIsWorkTrue.
        expect(checks).toBe(numTimesIsWorkTrue);
        expect(computed.tasksInFlight.length).toBeLessThanOrEqual(MAX_CONCURRENCY);
    });

    test("Loops.runWhileWork calls only tasks whose isWork is true", async () => {
        let c1 = 0;
        let c2 = 0;
        let c3 = 0;

        const input = {
            tasks: [
                {
                    name: "Task-1",
                    maxConcurrency: () => MAX_CONCURRENCY,
                    isWork: () => true,
                    runnable: async () => { c1++; },
                    ongoingTasks: [],
                },
                {
                    name: "Task-2",
                    maxConcurrency: () => MAX_CONCURRENCY,
                    isWork: () => true,
                    runnable: async () => { c2++; },
                    ongoingTasks: [],
                },
                {
                    name: "Task-3",
                    maxConcurrency: () => MAX_CONCURRENCY,
                    isWork: () => false,
                    runnable: async () => { c3++; },
                    ongoingTasks: [],
                },
            ],
            maxBackoffMs: 10,
            maxIsWorkIterations: 5,
            maxSuccessiveNoTasksCreated: 0,
            sleep: async () => {}, // keep test fast
        } satisfies Loops.InputDto;

        const computed = await Loops.runWhileWork(input);

        const allTasks = computed.tasks.flatMap((t) => t.tasksInFlight);
        const remaining = await waitForAll(allTasks, 200);
        expect(remaining).toEqual([]);

        expect(c1).toBeGreaterThan(0);
        expect(c2).toBeGreaterThan(0);
        expect(c3).toBe(0);
    });

    test("Circuit breaker gating via isWork is obeyed", async () => {
        // simple circuit breaker: allow while consecutive failures <= maxFailures
        const maxConsecutiveFailures = 5;

        let okCount = 0;
        let failCount = 0;

        let failures1 = 0;
        let failures2 = 0;

        const isAllowed1 = () => failures1 <= maxConsecutiveFailures;
        const isAllowed2 = () => failures2 <= maxConsecutiveFailures;

        const maxCounting = 10;

        const input: Loops.InputDto = {
            tasks: [
                {
                    name: "Task-1",
                    maxConcurrency: () => 1,
                    isWork: () => okCount < maxCounting && isAllowed1(),
                    runnable: async () => {
                        // success
                        okCount++;
                        failures1 = 0;
                    },
                    ongoingTasks: [],
                },
                {
                    name: "Task-2",
                    maxConcurrency: () => 1,
                    isWork: () => failCount < maxCounting && isAllowed2(),
                    runnable: async () => {
                        // failure
                        failCount++;
                        failures2++;
                    },
                    ongoingTasks: [],
                },
            ],
            maxBackoffMs: 10,
            maxIsWorkIterations: 100,
            maxSuccessiveNoTasksCreated: 5,
            sleep: async () => {},
        };

        const computed = await Loops.runWhileWork(input);

        const allTasks = computed.tasks.flatMap((t) => t.tasksInFlight);
        const remaining = await waitForAll(allTasks, 200);
        expect(remaining).toEqual([]);

        // Task-1 should hit maxCounting because it resets failures on success
        expect(okCount).toBe(maxCounting);

        // Task-2 should stop after maxConsecutiveFailures + 1 attempts (same as your Java assertion)
        expect(failCount).toBe(maxConsecutiveFailures + 1);
    });
});