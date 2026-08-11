import {
  QRtcPeerConnection,
  type QRtcPeerConnectionDiagnostics,
} from '@shared/webrtc/QRtcPeerConnection.ts';
import { QRtcSignalingType } from '@shared/webrtc/QRtcSignalingContracts.ts';

export interface RtcPeerConnectionDiagnosticsInputDto {
  readonly peers: number;
  readonly iceCandidatesPerPeer: number;
  readonly offerCollisionsPerPeer: number;
}

export interface RtcPeerConnectionDiagnosticsPeerInput {
  readonly id: string;
  readonly isPolite: boolean;
  readonly onSend: () => void;
}

export interface RtcPeerConnectionDiagnosticsPeer {
  connect(): void;
  receiveIceCandidate(candidateIndex: number): Promise<void>;
  receiveOffer(): Promise<void>;
  beginOfferCollision(): void;
  receiveCollidingOffer(collisionIndex: number): Promise<void>;
  failConnection(): void;
  reconnect(): Promise<void>;
  drainSignaling(): Promise<void>;
  exhaustReconnects(): Promise<void>;
  readDiagnostics(): QRtcPeerConnectionDiagnostics;
}

export interface RtcPeerConnectionDiagnosticsDependencies {
  createPeer(input: RtcPeerConnectionDiagnosticsPeerInput): RtcPeerConnectionDiagnosticsPeer;
  reset(): void;
  drainTimers(): Promise<void>;
  getPendingTimerCount(): number;
  monotonicNowMs(): number;
}

export interface RtcPeerConnectionDiagnosticsCleanupState {
  readonly pendingIceCandidateQueueLength: number;
  readonly reconnectAttemptsInFlight: number;
  readonly activeReconnectTimerCount: number;
  readonly pendingTimerCount: number;
}

export interface RtcPeerConnectionDiagnosticsResult {
  readonly durationMs: number;
  readonly peerCount: number;
  readonly signalingMessagesSent: number;
  readonly diagnostics: Readonly<Record<string, number>>;
  readonly cleanup: RtcPeerConnectionDiagnosticsCleanupState;
}

interface RunRtcPeerConnectionDiagnosticsPeerInput {
  readonly diagnosticsInput: RtcPeerConnectionDiagnosticsInputDto;
  readonly index: number;
  readonly onSend: () => void;
}

interface QueuedTimer {
  readonly id: number;
  readonly callback: () => void | Promise<void>;
}

export async function runRtcPeerConnectionDiagnostics(
  input: RtcPeerConnectionDiagnosticsInputDto,
  dependencies: RtcPeerConnectionDiagnosticsDependencies,
): Promise<RtcPeerConnectionDiagnosticsResult> {
  dependencies.reset();
  const startedAt = dependencies.monotonicNowMs();
  const diagnostics: Record<string, number> = {};
  let signalingMessagesSent = 0;
  let activeReconnectTimerCount = 0;

  for (let index = 0; index < input.peers; index += 1) {
    const onSend = () => {
      signalingMessagesSent += 1;
    };
    const peerInput = { diagnosticsInput: input, index, onSend };
    const politeDiagnostics = await runPolitePeer(peerInput, dependencies);
    const impoliteDiagnostics = await runImpolitePeer(peerInput, dependencies);
    addNumericDiagnostics(diagnostics, politeDiagnostics);
    addNumericDiagnostics(diagnostics, impoliteDiagnostics);
    activeReconnectTimerCount += Number(politeDiagnostics.hasReconnectTimer);
    activeReconnectTimerCount += Number(impoliteDiagnostics.hasReconnectTimer);
  }

  return {
    durationMs: dependencies.monotonicNowMs() - startedAt,
    peerCount: input.peers * 2,
    signalingMessagesSent,
    diagnostics,
    cleanup: {
      pendingIceCandidateQueueLength: diagnostics.pendingIceCandidateQueueLength ?? 0,
      reconnectAttemptsInFlight: diagnostics.reconnectAttemptsInFlight ?? 0,
      activeReconnectTimerCount,
      pendingTimerCount: dependencies.getPendingTimerCount(),
    },
  };
}

async function runPolitePeer(
  input: RunRtcPeerConnectionDiagnosticsPeerInput,
  dependencies: RtcPeerConnectionDiagnosticsDependencies,
): Promise<QRtcPeerConnectionDiagnostics> {
  const peer = dependencies.createPeer({
    id: `polite-${input.index}`,
    isPolite: true,
    onSend: input.onSend,
  });
  peer.connect();
  for (
    let candidateIndex = 0;
    candidateIndex < input.diagnosticsInput.iceCandidatesPerPeer;
    candidateIndex += 1
  ) {
    await peer.receiveIceCandidate(candidateIndex);
  }
  await peer.receiveOffer();
  return peer.readDiagnostics();
}

async function runImpolitePeer(
  input: RunRtcPeerConnectionDiagnosticsPeerInput,
  dependencies: RtcPeerConnectionDiagnosticsDependencies,
): Promise<QRtcPeerConnectionDiagnostics> {
  const peer = dependencies.createPeer({
    id: `impolite-${input.index}`,
    isPolite: false,
    onSend: input.onSend,
  });
  peer.connect();
  peer.beginOfferCollision();
  for (
    let collisionIndex = 0;
    collisionIndex < input.diagnosticsInput.offerCollisionsPerPeer;
    collisionIndex += 1
  ) {
    await peer.receiveCollidingOffer(collisionIndex);
  }
  peer.failConnection();
  await peer.reconnect();
  await peer.reconnect();
  await dependencies.drainTimers();
  await peer.drainSignaling();
  await peer.exhaustReconnects();
  return peer.readDiagnostics();
}

function addNumericDiagnostics(
  aggregate: Record<string, number>,
  diagnostics: QRtcPeerConnectionDiagnostics,
): void {
  for (const [key, value] of Object.entries(diagnostics)) {
    if (typeof value === 'number') {
      aggregate[key] = (aggregate[key] ?? 0) + value;
    }
  }
}

export function createRtcPeerConnectionDiagnosticsDependencies(): {
  dependencies: RtcPeerConnectionDiagnosticsDependencies;
  restore(): void;
} {
  const hadPeerConnection = Object.hasOwn(globalThis, 'RTCPeerConnection');
  const originalPeerConnection = globalThis.RTCPeerConnection;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextTimerId = 1;
  let timers: QueuedTimer[] = [];
  Reflect.set(globalThis, 'RTCPeerConnection', FakeRTCPeerConnection);
  globalThis.setTimeout = ((callback: () => void | Promise<void>) => {
    const id = nextTimerId++;
    timers.push({ id, callback });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id);
  }) as typeof clearTimeout;
  return {
    dependencies: {
      createPeer: createPeerAdapter,
      reset() {
        FakeRTCPeerConnection.instances = [];
        timers = [];
      },
      async drainTimers() {
        while (timers.length > 0) {
          const pending = timers;
          timers = [];
          for (const timer of pending) {
            await timer.callback();
          }
        }
      },
      getPendingTimerCount: () => timers.length,
      monotonicNowMs: () => performance.now(),
    },
    restore() {
      if (hadPeerConnection) Reflect.set(globalThis, 'RTCPeerConnection', originalPeerConnection);
      else Reflect.deleteProperty(globalThis, 'RTCPeerConnection');
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createPeerAdapter(
  input: RtcPeerConnectionDiagnosticsPeerInput,
): RtcPeerConnectionDiagnosticsPeer {
  const peer = new QRtcPeerConnection(
    { send: async () => input.onSend() },
    {
      sessionId: `self-${input.id}`,
      token: 'token',
      peerSessionId: `peer-${input.id}`,
      iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
      isPolite: input.isPolite,
    },
  );
  let nativePeer: FakeRTCPeerConnection | undefined;
  const requireNativePeer = () => {
    if (!nativePeer) {
      throw new Error('Expected fake RTCPeerConnection instance.');
    }
    return nativePeer;
  };
  return {
    connect() {
      peer.connect();
      nativePeer = FakeRTCPeerConnection.instances.at(-1);
    },
    receiveIceCandidate: (index) =>
      peer.handleSignal(QRtcSignalingType.IceCandidate, {
        description: null,
        candidate: { candidate: `candidate-${input.id}-${index}`, sdpMid: '0', sdpMLineIndex: 0 },
      }),
    receiveOffer: () =>
      peer.handleSignal(QRtcSignalingType.Offer, {
        description: { type: 'offer', sdp: `remote-offer-${input.id}` } as RTCSessionDescription,
        candidate: null,
      }),
    beginOfferCollision() {
      peer.status.makingOffer = true;
      requireNativePeer().signalingState = 'have-local-offer';
    },
    receiveCollidingOffer: (index) =>
      peer.handleSignal(QRtcSignalingType.Offer, {
        description: {
          type: 'offer',
          sdp: `colliding-offer-${input.id}-${index}`,
        } as RTCSessionDescription,
        candidate: null,
      }),
    failConnection: () => {
      requireNativePeer().connectionState = 'failed';
    },
    reconnect: () => peer.handleReconnect(),
    drainSignaling: () => readSignalingChain(peer),
    exhaustReconnects: async () => {
      peer.status.reconnectAttempts = 5;
      await peer.handleReconnect();
    },
    readDiagnostics: () => peer.readDiagnostics(),
  };
}

function readSignalingChain(peer: QRtcPeerConnection): Promise<void> {
  const signalingChain = Reflect.get(peer, 'signalingChain');
  if (!(signalingChain instanceof Promise)) {
    throw new Error('Expected QRtcPeerConnection signaling chain.');
  }
  return signalingChain;
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => Promise<void>) | null =
    null;
  ondatachannel: ((event: RTCDataChannelEvent) => Promise<void>) | null = null;
  ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(_configuration: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }
  addEventListener(_type: string, _listener: (event?: Event) => void): void {}
  removeEventListener(_type: string, _listener: (event?: Event) => void): void {}
  getTransceivers(): Array<{ stop: () => void }> {
    return [];
  }
  close(): void {
    this.connectionState = 'closed';
  }
  restartIce(): void {}
  createDataChannel(_label: string): RTCDataChannel {
    return {} as RTCDataChannel;
  }
  addIceCandidate(_candidate?: RTCIceCandidateInit): Promise<void> {
    return Promise.resolve();
  }
  async setRemoteDescription(description: RTCSessionDescription): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = (description ?? {
      type: this.remoteDescription?.type === 'offer' ? 'answer' : 'offer',
      sdp: this.remoteDescription?.type === 'offer' ? 'answer-sdp' : 'offer-sdp',
    }) as RTCSessionDescription;
    this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';
  }
}
