/**
 * 共通描画エンジンを Worker で型検査するために必要なページ側の型。
 *
 * 実行時の Worker は ExternalRenderingHost と WorkerVideo を使うため、DOM を操作する分岐には入りません。
 * ページ用 DOM と Worker 用 DOM の標準型を同じプログラムへ読み込まず、共有ソースが参照する境界だけをここで宣言します。
 */

interface TimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

interface VideoPlaybackQuality {
  readonly creationTime: number;
  readonly droppedVideoFrames: number;
  readonly totalVideoFrames: number;
  readonly corruptedVideoFrames: number;
}

interface VideoFrameCallbackMetadata {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly width: number;
  readonly height: number;
}

interface WorkerElementStyle {
  cssText: string;
  visibility: string;
  left: string;
  top: string;
  width: string;
  height: string;
}

interface HTMLElement extends EventTarget {
  readonly parentElement: HTMLElement | null;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly style: WorkerElementStyle;
  appendChild<T extends HTMLElement>(node: T): T;
  insertBefore<T extends HTMLElement>(node: T, child: HTMLElement | null): T;
  remove(): void;
}

interface HTMLCanvasElement extends HTMLElement, OffscreenCanvas {
  className: string;
  transferControlToOffscreen(): OffscreenCanvas;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  replaceWith(...nodes: HTMLElement[]): void;
}

declare var HTMLCanvasElement: {
  readonly prototype: HTMLCanvasElement;
};

interface HTMLVideoElement extends HTMLElement, VideoFrame {
  currentTime: number;
  playbackRate: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly buffered: TimeRanges;
  getVideoPlaybackQuality?(): VideoPlaybackQuality;
  requestVideoFrameCallback(
    callback: (
      now: DOMHighResTimeStamp,
      metadata: VideoFrameCallbackMetadata,
    ) => void,
  ): number;
  cancelVideoFrameCallback(handle: number): void;
}

declare var HTMLVideoElement: {
  readonly prototype: HTMLVideoElement;
};

interface ResizeObserver {
  observe(target: HTMLElement): void;
  disconnect(): void;
}

declare var ResizeObserver: {
  new (callback: () => void): ResizeObserver;
};

interface Document {
  createElement(tagName: "canvas"): HTMLCanvasElement;
  createElement(tagName: "div"): HTMLElement;
}

declare var document: Document;
