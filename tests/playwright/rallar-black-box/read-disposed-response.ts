import type { APIResponse } from '@playwright/test';

/**
 * An `APIRequestContext` keeps every response body until the context is disposed, which for the `request` fixture is
 * the end of the test; a test that polls a growing snapshot retains every copy unless each response is disposed.
 */
export async function readDisposedResponse<DisposableResponse extends Pick<APIResponse, 'dispose'>, Value>(
    response: DisposableResponse,
    read: (response: DisposableResponse) => Promise<Value>
): Promise<Value> {
    let value: Value;
    try {
        value = await read(response);
    }
    catch (readFailure) {
        // The read failure says what went wrong; a failed dispose after it must not hide it.
        await response.dispose().catch(() => undefined);
        throw readFailure;
    }
    await response.dispose();
    return value;
}
