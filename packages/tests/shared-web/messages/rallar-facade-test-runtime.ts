import { createRallarFacade } from '@shared-web/browser/composition/create-rallar-facade.ts';
import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { onTestFinished, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const rallarFacadeMocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    const { createBrowserRtcCaptureReceiptFixture } = await import('../rtc/browser-rtc-capture-fixture.ts');
    return {
        apiMiddleware: createDefaultApiMiddlewareTestDouble(),
        rtcCaptureReceipt: createBrowserRtcCaptureReceiptFixture(),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>()
    };
});
vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
    ...await original(),
    initialiseMiddleware: async () => ({
        middleware: rallarFacadeMocks.apiMiddleware.middleware,
        rtcCaptureReceipt: rallarFacadeMocks.rtcCaptureReceipt,
        checkpoints: []
    })
}));
vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
    ...await original(),
    readSession: () => rallarFacadeMocks.apiMiddleware.session,
    isLoggedIn: () => true
}));
vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), async (original): Promise<typeof GroupStateSnapshotsRepositoryModule> => ({
    ...await original(),
    findFirstGroupStateSnapshotRefSessionIdIsIn: rallarFacadeMocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: rallarFacadeMocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: rallarFacadeMocks.getAllGroupStateSnapshots
}));

setRallarFacadeRoomSnapshots([]);

/** The doubles behind a real facade: its middleware and session, renewed per test, and its room snapshot reads. */
export function getRallarFacadeMocks(): typeof rallarFacadeMocks {
    return rallarFacadeMocks;
}

/** A fresh middleware double, fresh cache repositories and no cached room snapshot. */
export function resetRallarFacadeTestRuntime(): void {
    configureTestCacheRepositories();
    rallarFacadeMocks.apiMiddleware = createDefaultApiMiddlewareTestDouble();
    setRallarFacadeRoomSnapshots([]);
}

/** The room snapshots the facade's cache reads return. */
export function setRallarFacadeRoomSnapshots(snapshots: readonly GroupSnapshot[]): void {
    rallarFacadeMocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    rallarFacadeMocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find((snapshot) =>
            snapshot.group.groupId === ref.groupId &&
            snapshot.group.applicationId === ref.applicationId &&
            snapshot.group.workspaceId === ref.workspaceId
        )
    );
    rallarFacadeMocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => snapshot.activeSessions.some((session) => session.sessionId === sessionId))?.group
    );
}

/** A real messages facade over the doubles, disconnected when the test finishes. */
export function createRallarTestFacade(): RallarFacade {
    const facade = createRallarFacade();
    onTestFinished(() => facade.disconnect());
    return facade;
}
