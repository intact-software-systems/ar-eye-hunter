import type * as Playwright from '@playwright/test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, vi } from 'vitest';

import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The most fake timer turns a measured harness run may take before it is taken to hang. */
const MEASURED_RUN_TURN_LIMIT = 10_000;

const polling = new AsyncLocalStorage<true>();

const COUNTED_LOCATOR = Symbol('counted locator');

/**
 * Spends one bounded wait on the fake clock. A wait inside a counted poll spends nothing: the poll counts by its own
 * limit.
 */
export async function spendBoundedWait(waitMs: number): Promise<void> {
    if (polling.getStore()) {
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/** Reads a poll's value once, then spends the poll's whole limit, as the timeouts count a poll. */
async function pollBoundedWait<T>(read: () => Promise<T> | T, timeoutMs: number): Promise<T> {
    const value = await polling.run(true, async () => await read());
    await spendBoundedWait(timeoutMs);
    return value;
}

/**
 * Runs every test of the calling file under fake timers for the clock a harness waits on. `vi.mock` is hoisted above
 * a file's imports, so each file still names the counted `@playwright/test` module itself, through
 * `toCountedPlaywrightModule`.
 */
export function useBoundedWaitClock(): void {
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date']
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });
}

/**
 * Runs a harness operation to its end under fake timers, advancing the fake clock through every wait it spends. The
 * run's rejection is observed as it settles, so a run that fails while the clock advances rejects only the returned
 * promise and is never reported unhandled.
 */
export async function settleUnderFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    let settled = false;
    const markSettled = (): void => {
        settled = true;
    };
    const pending = run();
    pending.then(markSettled, markSettled);
    for (let turn = 0; !settled; turn++) {
        if (turn === MEASURED_RUN_TURN_LIMIT) {
            throw new Error('The measured harness run did not settle.');
        }
        await vi.runAllTimersAsync();
    }
    return await pending;
}

/**
 * Runs a harness operation under fake timers whose every bounded wait spends its bound, and returns the fake time it
 * took: the sum of its bounded waits in order, waits side by side counting by the longest.
 */
export async function measureBoundedWaitsMs<T>(run: () => Promise<T>): Promise<number> {
    const startedAtMs = performance.now();
    await settleUnderFakeTimers(run);
    return performance.now() - startedAtMs;
}

/** Any argument a Playwright matcher or poll may be given. */
type PlaywrightArgument = string | number | boolean | bigint | symbol | object | null | undefined;

/** A locator of a counted page, marked so the counted `expect` can tell it from any other value. */
interface CountedLocator {
    readonly [COUNTED_LOCATOR]: true;
}

/** Whether a value is a locator of a counted page. */
function isCountedLocator(value: PlaywrightArgument): value is CountedLocator {
    return typeof value === 'object' && value !== null && COUNTED_LOCATOR in value;
}

/** The limit a Playwright matcher's or poll's options name, if they name one. */
function decodeTimeoutOption(options: PlaywrightArgument): number | undefined {
    return typeof options === 'object' && options !== null && 'timeout' in options &&
            typeof options.timeout === 'number'
        ? options.timeout
        : undefined;
}

/** Every matcher of a counted locator spends its named limit, or the configuration's default assertion limit. */
function toCountedLocatorMatchers(expectTimeoutMs: number): object {
    const matchers: object = new Proxy({}, {
        get: (_target, property) =>
            property === 'not'
                ? matchers
                : async (...args: readonly PlaywrightArgument[]) => {
                    await spendBoundedWait(decodeTimeoutOption(args.at(-1)) ?? expectTimeoutMs);
                }
    });
    return matchers;
}

/** Every matcher of a counted poll reads the value once, spends the poll's limit, then asserts as Playwright does. */
function toCountedPollMatchers<T>(
    actual: Playwright.Expect,
    read: () => Promise<T> | T,
    options: PlaywrightArgument,
    expectTimeoutMs: number
): object {
    return new Proxy({}, {
        get: (_target, matcher) => async (...expected: readonly PlaywrightArgument[]) => {
            const value = await pollBoundedWait(read, decodeTimeoutOption(options) ?? expectTimeoutMs);
            const matchers: object = actual(value);
            Reflect.apply(Reflect.get(matchers, matcher), matchers, expected);
        }
    });
}

/**
 * The `@playwright/test` module with an `expect` whose polls and counted locators' assertions spend their limits on the
 * fake clock; every other assertion runs as Playwright's own.
 */
export function toCountedPlaywrightModule(
    actualModule: typeof Playwright,
    expectTimeoutMs: number
): typeof Playwright {
    const actual = actualModule.expect;
    const expect = new Proxy(actual, {
        apply: (_target, _thisArgument, [value, message]: readonly PlaywrightArgument[]) =>
            isCountedLocator(value)
                ? toCountedLocatorMatchers(expectTimeoutMs)
                : actual(value, typeof message === 'string' ? message : undefined),
        get: (_target, property) =>
            property === 'poll'
                ? <T>(read: () => Promise<T> | T, options?: PlaywrightArgument) => toCountedPollMatchers(actual, read, options, expectTimeoutMs)
                : Reflect.get(actual, property)
    });
    return { ...actualModule, expect };
}

/** A locator whose every query returns a locator and whose every action does nothing. */
function createCountedLocator(): CountedLocator {
    const locator: CountedLocator = new Proxy({ [COUNTED_LOCATOR]: true as const }, {
        get: (_target, property) => property === COUNTED_LOCATOR ? true : property === 'then' ? undefined : () => locator
    });
    return locator;
}

/**
 * A page whose locators are counted, whose `waitForTimeout` spends its delay and whose evaluations answer `evaluate`;
 * every other call does nothing.
 */
export function createCountedPage(evaluate: () => PlaywrightArgument = () => undefined): Playwright.Page {
    const page: object = new Proxy({}, {
        get: (_target, property) => {
            if (property === 'then') {
                return undefined;
            }
            if (property === 'waitForTimeout') {
                return spendBoundedWait;
            }
            if (property === 'evaluate') {
                return async () => await evaluate();
            }
            return () => createCountedLocator();
        }
    });
    return page as Playwright.Page;
}

/** A command a counted control request context was sent. */
export interface PostedControlCommand {
    readonly agentId: string;
    readonly commandId: string;
    readonly command: RallarBlackBoxTestCommand;
}

/** The options a harness gives a control request; every request on a counted path names its timeout. */
interface CountedRequestOptions {
    readonly data?: Readonly<{ commandId: string; command: RallarBlackBoxTestCommand; }>;
    readonly timeout?: number;
}

/**
 * A response answering `body`. It stands for Playwright's whole `APIResponse`, of which the harnesses read only the
 * status, the body and the disposal: the fixture's one typing seam for the request context.
 */
function toCountedResponse(status: number, body: object): Playwright.APIResponse {
    const response: Pick<Playwright.APIResponse, 'status' | 'ok' | 'json' | 'text' | 'dispose'> = {
        status: () => status,
        ok: () => status < 300,
        json: async () => body,
        text: async () => JSON.stringify(body),
        dispose: async () => undefined
    };
    return response as Playwright.APIResponse;
}

/** Spends a request's named timeout as a request outside any poll counts it; inside a counted poll it spends nothing. */
async function spendRequestTimeout(options: CountedRequestOptions | undefined): Promise<void> {
    if (options?.timeout === undefined) {
        throw new Error('A counted control request names no timeout of its own.');
    }
    await spendBoundedWait(options.timeout);
}

/**
 * A control request context whose every request spends its own named timeout, then answers: each posted command is
 * accepted and recorded, and each read answers the run `readRun` makes of every command posted so far.
 */
export function createCountedControlRequest(
    readRun: (posted: readonly PostedControlCommand[]) => object
): Pick<Playwright.APIRequestContext, 'get' | 'post'> {
    const posted: PostedControlCommand[] = [];
    return {
        get: async (_url: string, options?: CountedRequestOptions) => {
            await spendRequestTimeout(options);
            return toCountedResponse(200, readRun(posted));
        },
        post: async (url: string, options?: CountedRequestOptions) => {
            await spendRequestTimeout(options);
            if (options?.data !== undefined) {
                posted.push({ agentId: decodeURIComponent(url.split('/').at(-2) ?? ''), ...options.data });
            }
            return toCountedResponse(202, {});
        }
    };
}
