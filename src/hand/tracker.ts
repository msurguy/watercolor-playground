import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

// Keep in step with the installed @mediapipe/tasks-vision version (package.json): the wasm must match the JS.
const VERSION = '1.0.1';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
// To serve these yourself, copy node_modules/@mediapipe/tasks-vision/wasm/* and the model into public/ and point the two URLs there.
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

export interface Frame {
  /** The 21 landmarks of the first hand (x, y normalised to the camera frame), or null when no hand is seen. */
  landmarks: NormalizedLandmark[] | null;
  /** performance.now() of the frame. */
  t: number;
  /** Camera frame width / height, for distances in frame space. */
  aspect: number;
}

/** The webcam and the MediaPipe hand landmarker, feeding one callback per video frame. */
export class HandTracker {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private landmarker: HandLandmarker | null = null;
  private handle = 0;
  private useVfc = false;
  private stopped = false;
  private lastTs = -1;

  constructor(private onFrame: (f: Frame) => void, private onStream: (s: MediaStream) => void) {}

  /** The camera first (so a denied permission shows before the download), then the model. Throws on either failure. */
  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    this.onStream(stream);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.srcObject = stream;
    // not awaited: a camera that sends no frames yet would hold up the start; `tick` waits for readyState instead
    void v.play().catch(() => { /* autoplay refused; the frames still arrive */ });
    this.video = v;

    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const create = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO', numHands: 1,
    });
    try { this.landmarker = await create('GPU'); } catch { this.landmarker = await create('CPU'); }
    if (this.stopped) { this.release(); return; }

    this.useVfc = 'requestVideoFrameCallback' in v;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    this.release();
  }

  private schedule() {
    const v = this.video!;
    this.handle = this.useVfc ? v.requestVideoFrameCallback(this.tick) : requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.handle = 0;
    if (this.stopped || !this.video || !this.landmarker) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth > 0) {
      // MediaPipe wants strictly increasing timestamps
      const ts = Math.max(performance.now(), this.lastTs + 1);
      this.lastTs = ts;
      let landmarks: NormalizedLandmark[] | null = null;
      try {
        const res = this.landmarker.detectForVideo(v, ts);
        landmarks = res.landmarks[0] ?? null;
      } catch { /* a dropped frame */ }
      this.onFrame({ landmarks, t: ts, aspect: v.videoWidth / v.videoHeight });
    }
    if (!this.stopped) this.schedule();
  };

  private release() {
    if (this.handle) {
      if (this.useVfc) this.video?.cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
      this.handle = 0;
    }
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; this.video = null; }
  }
}
