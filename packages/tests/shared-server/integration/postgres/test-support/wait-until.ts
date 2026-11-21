/** Resolves on the wall clock at `epochMs`, or at once when that time has passed. */
export async function waitUntil(epochMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, epochMs - Date.now())));
}
