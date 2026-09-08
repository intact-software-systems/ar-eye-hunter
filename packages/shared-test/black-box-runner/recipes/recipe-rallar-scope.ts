import type {
    BlackBoxRallarRoomRef,
    BlackBoxRallarScope
} from '../browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';

export interface RecipeRallarScopeFields {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: BlackBoxRallarScope;
    readonly roomRef?: BlackBoxRallarRoomRef;
}

export function toRallarScopeDiagnostics(request: any, fallbackRoomId?: string): RecipeRallarScopeFields {
    const scope = toRallarScope(request);
    const roomRef = toRallarRoomRef(request, scope, fallbackRoomId);

    return {
        ...(scope?.applicationId ? { applicationId: scope.applicationId } : {}),
        ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {})
    };
}

function toRallarScope(request: any): BlackBoxRallarScope | undefined {
    const rallar = asObject(request.rallar);
    const scope = asObject([request.scope, rallar.scope].find((value) => value !== undefined));
    const roomRef = asObject([request.roomRef, rallar.roomRef].find((value) => value !== undefined));
    const applicationId = [request.applicationId, rallar.applicationId, scope.applicationId, roomRef.applicationId]
        .find((value) => value !== undefined);
    if (applicationId === undefined) {
        return undefined;
    }

    const workspaceId = [request.workspaceId, rallar.workspaceId, scope.workspaceId, roomRef.workspaceId].find(
        (value) => value !== undefined
    );

    return {
        applicationId: String(applicationId),
        ...(workspaceId !== undefined ? { workspaceId: String(workspaceId) } : {})
    };
}

function toRallarRoomRef(
    request: any,
    scope: BlackBoxRallarScope | undefined,
    fallbackRoomId?: string
): BlackBoxRallarRoomRef | undefined {
    const rallar = asObject(request.rallar);
    const explicitRoomRef = asObject([request.roomRef, rallar.roomRef].find((value) => value !== undefined));
    if (explicitRoomRef.applicationId && explicitRoomRef.groupId) {
        return {
            applicationId: String(explicitRoomRef.applicationId),
            ...(explicitRoomRef.workspaceId !== undefined
                ? { workspaceId: String(explicitRoomRef.workspaceId) }
                : {}),
            groupId: String(explicitRoomRef.groupId)
        };
    }

    const roomId = [request.roomId, rallar.roomId, fallbackRoomId].find((value) => value !== undefined);
    if (!roomId || !scope?.applicationId) {
        return undefined;
    }

    return {
        applicationId: scope.applicationId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        groupId: String(roomId)
    };
}

function asObject(value: any): any {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
