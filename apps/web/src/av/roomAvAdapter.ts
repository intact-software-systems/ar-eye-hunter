export type RemoteStreamUpdate = {
    readonly peerId: string;
    readonly stream: MediaStream;
};

export interface RoomAvAdapter {
    // lifecycle
    joinAv(): Promise<void>;
    leaveAv(): Promise<void>;

    // toggles
    setMicEnabled(enabled: boolean): void;
    setCamEnabled(enabled: boolean): void;

    // state
    isJoined(): boolean;
    getLocalStream(): MediaStream | undefined;

    // callbacks
    onRemoteStream(cb: (u: RemoteStreamUpdate) => void): void;
    onPeerLeft(cb: (peerId: string) => void): void; // optional but useful
}
