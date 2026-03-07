import type { RoomAvAdapter } from './roomAvAdapter';

function mustEl<T extends Element>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el as T;
}

type RemoteTile = {
    readonly peerId: string;
    readonly video: HTMLVideoElement;
};

export class EhRoomAvPanel extends HTMLElement {
    private adapter: RoomAvAdapter | undefined = undefined;
    private remoteTiles = new Map<string, RemoteTile>();

    set roomAvAdapter(a: RoomAvAdapter) {
        this.adapter = a;

        a.onRemoteStream(({ peerId, stream }) => {
            this.upsertRemoteTile(peerId, stream);
        });

        a.onPeerLeft((peerId) => {
            this.removeRemoteTile(peerId);
        });

        this.render();
        this.wire();
        this.update();
    }

    connectedCallback(): void {
        this.render();
        this.wire();
        this.update();
    }

    private render(): void {
        this.innerHTML = `
      <div class="card" style="margin-top:12px;">
        <div class="row">
          <h3 style="margin:0;">A/V</h3>
          <span style="margin-left:auto" class="muted">
            <span id="stateText">Not joined</span>
          </span>
        </div>

        <div class="row" style="margin-top:8px;">
          <button id="joinBtn">Join A/V</button>
          <button id="leaveBtn">Leave A/V</button>
          <button id="micBtn">Mic: On</button>
          <button id="camBtn">Cam: On</button>
        </div>

        <div class="row" style="margin-top:12px; gap:12px; flex-wrap:wrap;">
          <div style="min-width:220px;">
            <div class="muted">Local</div>
            <video id="localVideo" autoplay playsinline muted style="width:220px; height:160px; border-radius:12px; background:rgba(255,255,255,0.06)"></video>
          </div>

          <div style="flex:1; min-width:260px;">
            <div class="muted">Remote</div>
            <div id="remoteGrid" style="display:flex; flex-wrap:wrap; gap:12px;"></div>
          </div>
        </div>

        <div id="status" class="status"></div>
      </div>
    `;
    }

    private wire(): void {
        const joinBtn = mustEl<HTMLButtonElement>(this, '#joinBtn');
        const leaveBtn = mustEl<HTMLButtonElement>(this, '#leaveBtn');
        const micBtn = mustEl<HTMLButtonElement>(this, '#micBtn');
        const camBtn = mustEl<HTMLButtonElement>(this, '#camBtn');

        let micEnabled = true;
        let camEnabled = true;

        joinBtn.addEventListener('click', async () => {
            if (!this.adapter) return;
            this.setStatus('Joining A/V...');
            try {
                await this.adapter.joinAv();
                this.setStatus('Joined A/V.');
                this.updateLocalPreview();
                this.update();
            } catch (e) {
                this.setStatus(`Join failed: ${(e as Error).message}`);
            }
        });

        leaveBtn.addEventListener('click', async () => {
            if (!this.adapter) return;
            await this.adapter.leaveAv();
            this.clearLocalPreview();
            this.clearRemoteTiles();
            this.setStatus('Left A/V.');
            this.update();
        });

        micBtn.addEventListener('click', () => {
            if (!this.adapter) return;
            micEnabled = !micEnabled;
            this.adapter.setMicEnabled(micEnabled);
            micBtn.textContent = `Mic: ${micEnabled ? 'On' : 'Off'}`;
        });

        camBtn.addEventListener('click', () => {
            if (!this.adapter) return;
            camEnabled = !camEnabled;
            this.adapter.setCamEnabled(camEnabled);
            camBtn.textContent = `Cam: ${camEnabled ? 'On' : 'Off'}`;
        });
    }

    private update(): void {
        const stateText = this.querySelector('#stateText') as HTMLSpanElement | null;
        if (!stateText || !this.adapter) return;
        stateText.textContent = this.adapter.isJoined() ? 'Joined' : 'Not joined';
    }

    private updateLocalPreview(): void {
        if (!this.adapter) return;
        const video = this.querySelector('#localVideo') as HTMLVideoElement | null;
        if (!video) return;

        const s = this.adapter.getLocalStream();
        if (!s) return;

        video.srcObject = s;
        // play() may fail if no gesture; join click is a gesture so should be ok
        void video.play().catch(() => {});
    }

    private clearLocalPreview(): void {
        const video = this.querySelector('#localVideo') as HTMLVideoElement | null;
        if (video) video.srcObject = null;
    }

    private upsertRemoteTile(peerId: string, stream: MediaStream): void {
        const grid = this.querySelector('#remoteGrid') as HTMLDivElement | null;
        if (!grid) return;

        const existing = this.remoteTiles.get(peerId);
        if (existing) {
            existing.video.srcObject = stream;
            void existing.video.play().catch(() => {});
            return;
        }

        const wrap = document.createElement('div');
        wrap.style.minWidth = '220px';

        const label = document.createElement('div');
        label.className = 'muted';
        label.textContent = peerId;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = false; // remote audio should play; may still require user gesture
        video.style.width = '220px';
        video.style.height = '160px';
        video.style.borderRadius = '12px';
        video.style.background = 'rgba(255,255,255,0.06)';

        video.srcObject = stream;
        void video.play().catch(() => {});

        wrap.appendChild(label);
        wrap.appendChild(video);
        grid.appendChild(wrap);

        this.remoteTiles.set(peerId, { peerId, video });
    }

    private removeRemoteTile(peerId: string): void {
        // simplest: clear and rebuild later; or track wrapper elements too
        this.remoteTiles.delete(peerId);
        const grid = this.querySelector('#remoteGrid') as HTMLDivElement | null;
        if (!grid) return;

        // rebuild from remaining tiles
        grid.innerHTML = '';
        for (const t of this.remoteTiles.values()) {
            this.upsertRemoteTile(t.peerId, t.video.srcObject as MediaStream);
        }
    }

    private clearRemoteTiles(): void {
        this.remoteTiles.clear();
        const grid = this.querySelector('#remoteGrid') as HTMLDivElement | null;
        if (grid) grid.innerHTML = '';
    }

    private setStatus(text: string): void {
        const el = this.querySelector('#status') as HTMLDivElement | null;
        if (el) el.textContent = text;
    }
}

customElements.define('eh-room-av-panel', EhRoomAvPanel);