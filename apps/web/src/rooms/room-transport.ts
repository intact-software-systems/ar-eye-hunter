import { AppTopics, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ALPayload } from '@shared/al-contracts/al-contract.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import * as roomApi from '@shared-web/browser/api-workflows.ts';
import { addWebSocketInboxCallback } from '@shared-web/browser/ws-message-router.ts';
import { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import * as stateCaches from '@shared-web/browser/data-caches.ts';
import { RoomMember, RoomSummary, RoomUiState, RoomUiStatus, } from './room-ui-types.ts';

export function createRoomDriverWs(mw: ApiMiddleware): RoomDriver {
    const myOwnClientData: ClientInfo = {
        clientId: mw.session.clientId,
        sessionId: mw.session.sessionId,
        isOnline: true,
    };
    const roomTransport = new RoomTransport(
        mw.middleware.webRtcGroupManager,
        myOwnClientData,
    );
    roomTransport.addRooms(
        groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
    );
    roomTransport.refreshSelectedGroupFromRooms();

    addWebSocketInboxCallback(
        AppTopics.groupStateSnapshot,
        (payload: ALPayload) => {
            const groupSnapshot = JSON.parse(payload.resource) as GroupSnapshot;
            roomTransport.addRooms([groupSnapshot]);
            roomTransport.refreshSelectedGroupFromRooms();
            roomTransport.sinkToUi();
            return Promise.resolve();
        },
    );

    addWebSocketInboxCallback(
        AppTopics.clientStateSnapshot,
        (_payload: ALPayload) => {
            roomTransport.refreshSelectedGroupFromRooms();
            roomTransport.sinkToUi();
            return Promise.resolve();
        },
    );

    return roomTransport;
}

export interface RoomDriver {
    setStateSink(sink: (state: RoomUiState) => void): void;

    listRooms(): Promise<void>;

    createRoom(name: string): Promise<void>;

    joinRoom(roomId: string): Promise<void>;

    leaveRoom(): Promise<void>;

    dispose(): void;
}

class RoomTransport implements RoomDriver {
    public roomDataById = new Map<string, GroupSnapshot>();
    public selectedGroup: GroupSnapshot | undefined = undefined;
    public sink: (state: RoomUiState) => void;

    constructor(
        public readonly webRtcGroupManager: WebRtcGroupManager,
        public readonly myOwnClientData: ClientInfo,
    ) {
        this.sink = () => {
            console.log('RoomTransport sink not set');
        };
    }

    addRooms(rooms: readonly GroupSnapshot[]): void {
        for (const room of rooms) {
            if (room.group.status !== 'active') {
                this.roomDataById.delete(room.group.groupId);
                continue;
            }

            this.roomDataById.set(room.group.groupId, room);
        }
    }

    refreshSelectedGroupFromRooms(): void {
        if (this.selectedGroup) {
            this.selectedGroup = this.roomDataById.get(
                this.selectedGroup.group.groupId,
            );
        }

        if (this.selectedGroup && this.isMySessionInGroup(this.selectedGroup)) {
            return;
        }

        this.selectedGroup = [...this.roomDataById.values()]
            .find((group) => this.isMySessionInGroup(group));
    }

    setStateSink(sink: (state: RoomUiState) => void): void {
        this.sink = sink;
    }

    sinkToUi(): void {
        this.sink({
            status: RoomUiStatus.Ready,
            rooms: this.toRooms(this.roomDataById),
            selectedRoomId: this.selectedGroup?.group.groupId || 'NA',
            selectedRoomName: this.selectedGroup?.group.displayName || 'NA',
            members: this.toRoomMembers(this.selectedGroup),
            message: 'Ready',
        });
    }

    dispose(): void {
        console.log('RoomTransport dispose called but not implemented');
    }

    async leaveRoom(): Promise<void> {
        if (!this.selectedGroup) {
            return;
        }

        const groupId = this.selectedGroup.group.groupId;
        const updatedGroup = await roomApi.leaveStateGroup(
            groupId,
            this.myOwnClientData.clientId,
            this.myOwnClientData.sessionId,
        );

        await this.acceptSnapshots([], [updatedGroup]);
        this.selectedGroup = undefined;
        this.sinkToUi();
    }

    async joinRoom(roomId: string): Promise<void> {
        if (this.selectedGroup?.group.groupId === roomId) {
            this.sinkToUi();
            return;
        }

        await this.leaveRoom();

        const group = await roomApi.joinStateGroup(
            roomId,
            this.myOwnClientData.clientId,
            this.myOwnClientData.sessionId,
        );

        await this.acceptSnapshots([], [group]);
        this.selectedGroup = this.roomDataById.get(group.group.groupId) ?? group;
        this.sinkToUi();
    }

    async createRoom(name: string): Promise<void> {
        const group = await roomApi.createAndJoinStateGroup(
            name,
            this.myOwnClientData.clientId,
            this.myOwnClientData.sessionId,
        );

        await this.acceptSnapshots([], [group]);
        this.selectedGroup = this.roomDataById.get(group.group.groupId) ?? group;
        this.sinkToUi();
    }

    async listRooms(): Promise<void> {
        const { clients, groups } = await roomApi.refreshStateSnapshots();

        await this.acceptSnapshots(clients, groups);
        this.sinkToUi();
    }

    private async acceptSnapshots(
        clientSnapshots: readonly ClientSnapshot[],
        groupSnapshots: readonly GroupSnapshot[],
    ): Promise<void> {
        await stateCaches.hydrateStateCaches(
            this.webRtcGroupManager,
            this.myOwnClientData,
            clientSnapshots,
            groupSnapshots,
        );

        this.addRooms(groupSnapshots);
        this.refreshSelectedGroupFromRooms();
    }

    private toRooms(groupById: Map<string, GroupSnapshot>): RoomSummary[] {
        return [...groupById.values()]
            .sort((left, right) =>
                left.group.displayName.localeCompare(right.group.displayName)
            )
            .map((group) => ({
                roomId: group.group.groupId,
                name: group.group.displayName,
                memberCount: group.memberCount,
            }));
    }

    private toRoomMembers(
        selectedGroup: GroupSnapshot | undefined,
    ): RoomMember[] {
        if (!selectedGroup) {
            return [];
        }

        const onlinePrincipalIds = new Set(
            selectedGroup.activeSessions.map((session) => session.principalId),
        );

        return selectedGroup.members
            .filter((member) =>
                member.status === 'active' || member.status === 'invited'
            )
            .map((member) => {
                const clientSnapshot = clientStateSnapshotsRepository
                    .findClientStateSnapshotByPrincipalId(
                        member.principalId,
                    );

                return {
                    clientId: member.principalId,
                    username: clientSnapshot?.principal.displayName ??
                        clientSnapshot?.principal.username ??
                        member.principalId,
                    isOwner: member.role === 'owner',
                    isOnline: onlinePrincipalIds.has(member.principalId),
                };
            });
    }

    private isMySessionInGroup(group: GroupSnapshot): boolean {
        return group.activeSessions.some((session) =>
            session.sessionId === this.myOwnClientData.sessionId
        );
    }
}
