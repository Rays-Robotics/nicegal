<!--
  @component
  Full-media detail view: still images use a measured transform stage while video playback lives
  in VideoPlayer. Original files are requested through the restricted `original://` protocol.
-->
<script module lang="ts">
  export interface DetailViewStatus {
    filename: string;
    width: number | null;
    height: number | null;
    zoom: string | null;
    loading: boolean;
    failed: boolean;
  }
</script>

<script lang="ts">
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Maximize from "@lucide/svelte/icons/maximize";
  import Minimize from "@lucide/svelte/icons/minimize";
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import Scan from "@lucide/svelte/icons/scan";
  import { onMount } from "svelte";

  import { originalUrlOf, type GalleryItem } from "../lib/gallery/types";
  import VideoPlayer from "./VideoPlayer.svelte";

  type ZoomMode = "fit" | "actual" | "custom";

  type StagePoint = {
    x: number;
    y: number;
  };

  let {
    item,
    initialPlayback = null,
    hasPrev,
    hasNext,
    onclose,
    onprev,
    onnext,
    onstatuschange,
    onfilemenu,
  }: {
    item: GalleryItem;
    initialPlayback?: { currentTime: number; muted: boolean } | null;
    hasPrev: boolean;
    hasNext: boolean;
    onclose: () => void;
    onprev: () => void;
    onnext: () => void;
    onstatuschange: (status: DetailViewStatus) => void;
    onfilemenu: () => void;
  } = $props();

  let failed = $state(false);
  let loading = $state(true);
  const src = $derived(originalUrlOf(item));
  const isStillImage = $derived(item.mediaKind === "image");
  let viewer = $state<HTMLElement>();
  let stage = $state<HTMLDivElement>();
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let devicePixelRatio = $state(1);
  let zoomMode = $state<ZoomMode>("fit");
  let customScale = $state(1);
  let rawPanX = $state(0);
  let rawPanY = $state(0);
  let dragPointerId = $state<number | null>(null);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragStartPanX = $state(0);
  let dragStartPanY = $state(0);
  let fullscreen = $state(false);

  const imageReady = $derived(
    naturalWidth > 0 && naturalHeight > 0 && stageWidth > 0 && stageHeight > 0,
  );
  const actualScale = $derived(1 / devicePixelRatio);
  const fitScale = $derived(
    imageReady ? Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight) : 0,
  );
  const minScale = $derived(Math.min(fitScale, actualScale));
  const maxScale = $derived(Math.max(fitScale, actualScale * 16));
  const effectiveScale = $derived(
    !imageReady
      ? 0
      : zoomMode === "fit"
        ? fitScale
        : zoomMode === "actual"
          ? actualScale
          : clamp(customScale, minScale, maxScale),
  );
  const maxPanX = $derived(
    imageReady ? Math.max(0, (naturalWidth * effectiveScale - stageWidth) / 2) : 0,
  );
  const maxPanY = $derived(
    imageReady ? Math.max(0, (naturalHeight * effectiveScale - stageHeight) / 2) : 0,
  );
  const panX = $derived(clamp(rawPanX, -maxPanX, maxPanX));
  const panY = $derived(clamp(rawPanY, -maxPanY, maxPanY));
  const canPan = $derived(imageReady && (maxPanX > 0 || maxPanY > 0));
  const zoomLabel = $derived(
    zoomMode === "fit" ? "Fit" : `${Math.round((effectiveScale / actualScale) * 100)}%`,
  );
  $effect(() => {
    onstatuschange({
      filename: item.displayName,
      width: naturalWidth || item.sourceWidth || null,
      height: naturalHeight || item.sourceHeight || null,
      zoom: isStillImage && !failed ? (imageReady ? zoomLabel : null) : null,
      loading,
      failed,
    });
  });

  onMount(() => {
    syncDevicePixelRatio();
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  });

  $effect((): (() => void) | undefined => {
    const observedStage = stage;
    if (!observedStage) return undefined;

    const updateStageSize = (rect: DOMRectReadOnly): void => {
      stageWidth = rect.width;
      stageHeight = rect.height;
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateStageSize(entry.contentRect);
    });

    updateStageSize(observedStage.getBoundingClientRect());
    resizeObserver.observe(observedStage);
    return () => resizeObserver.disconnect();
  });

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function clearPan(): void {
    rawPanX = 0;
    rawPanY = 0;
  }

  function selectFit(): void {
    if (!imageReady) return;
    zoomMode = "fit";
    clearPan();
  }

  function selectActual(): void {
    if (!imageReady) return;
    zoomMode = "actual";
    clearPan();
  }

  function stagePoint(clientX: number, clientY: number): StagePoint | undefined {
    const bounds = stage?.getBoundingClientRect();
    if (!bounds) return undefined;

    return {
      x: clientX - bounds.left - bounds.width / 2,
      y: clientY - bounds.top - bounds.height / 2,
    };
  }

  function setCustomScale(nextScale: number, anchor: StagePoint = { x: 0, y: 0 }): void {
    if (!imageReady || effectiveScale <= 0) return;
    const targetScale = clamp(nextScale, minScale, maxScale);
    const scaleRatio = targetScale / effectiveScale;

    rawPanX = anchor.x - (anchor.x - panX) * scaleRatio;
    rawPanY = anchor.y - (anchor.y - panY) * scaleRatio;
    customScale = targetScale;
    zoomMode = "custom";
  }

  function changeScale(factor: number): void {
    setCustomScale(effectiveScale * factor);
  }

  function syncDevicePixelRatio(): void {
    devicePixelRatio = window.devicePixelRatio || 1;
  }

  function updateFullscreenState(): void {
    fullscreen = document.fullscreenElement === viewer;
  }

  async function toggleFullscreen(): Promise<void> {
    if (!viewer) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewer.requestFullscreen();
    } catch {
      // Native fullscreen can be unavailable or denied; retain the current viewer state.
    }
  }

  /** Cached images can be ready before the component's load listener is installed. */
  function observeImage(image: HTMLImageElement): () => void {
    const loaded = (): void => {
      naturalWidth = image.naturalWidth;
      naturalHeight = image.naturalHeight;
      loading = false;
    };
    image.addEventListener("load", loaded);
    image.addEventListener("error", handleMediaError);
    if (image.complete) {
      if (image.naturalWidth > 0) loaded();
      else handleMediaError();
    }
    return () => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", handleMediaError);
    };
  }

  function handleMediaError(): void {
    failed = true;
    loading = false;
  }

  function handleWheel(event: WheelEvent): void {
    if (!imageReady) return;
    event.preventDefault();

    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * stageHeight
          : event.deltaY;
    const anchor = stagePoint(event.clientX, event.clientY);
    if (!anchor || !Number.isFinite(delta)) return;

    setCustomScale(effectiveScale * 1.0015 ** -delta, anchor);
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || dragPointerId !== null || !canPan || !stage) return;
    event.preventDefault();

    stage.setPointerCapture(event.pointerId);
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    rawPanX = dragStartPanX + event.clientX - dragStartX;
    rawPanY = dragStartPanY + event.clientY - dragStartY;
  }

  function endPointerDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return;
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    dragPointerId = null;
  }

  function handleDoubleClick(event: MouseEvent): void {
    if (!imageReady) return;
    event.preventDefault();
    if (zoomMode === "fit") selectActual();
    else selectFit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest(".metadata-panel"))
    )
      return;
    if (
      item.mediaKind === "video" &&
      event.target instanceof Element &&
      event.target.closest(".video-player")
    )
      return;
    if (event.key === "ArrowLeft" && hasPrev) onprev();
    else if (event.key === "ArrowRight" && hasNext) onnext();
    else if (!isStillImage) return;
    else if (event.key === "0") {
      event.preventDefault();
      selectFit();
    } else if (event.key === "1") {
      event.preventDefault();
      selectActual();
    } else if (event.key.toLowerCase() === "f" && !event.repeat) {
      event.preventDefault();
      void toggleFullscreen();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onresize={syncDevicePixelRatio} />

<section
  class="detail-viewer"
  aria-label={item.displayName}
  bind:this={viewer}
  oncontextmenu={(event) => {
    event.preventDefault();
    onfilemenu();
  }}
>
  <header class="detail-toolbar app-toolbar">
    <div class="app-toolbar-group" role="toolbar" aria-label="Media navigation">
      <button
        class="app-toolbar-button app-toolbar-text-button"
        type="button"
        onclick={onclose}
        title="Return to gallery (Escape)"
        aria-label="Return to gallery (Escape)"
      >
        <ChevronLeft size={16} aria-hidden="true" />
        <span>Gallery</span>
      </button>
      <button
        class="app-toolbar-button"
        type="button"
        onclick={onprev}
        title="Previous"
        aria-label="Previous"
        disabled={!hasPrev}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button
        class="app-toolbar-button"
        type="button"
        onclick={onnext}
        title="Next"
        aria-label="Next"
        disabled={!hasNext}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
    <div class="app-toolbar-divider" role="separator"></div>
    <h1 class="detail-title" title={item.displayName}>{item.displayName}</h1>

    {#if isStillImage && !failed}
      <div class="app-toolbar-group image-tools" role="toolbar" aria-label="Image viewer controls">
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => changeScale(1 / 1.25)}
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!imageReady}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => changeScale(1.25)}
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!imageReady}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button"
          type="button"
          onclick={selectFit}
          title="Fit to window (0)"
          aria-label="Fit to window (0)"
          disabled={!imageReady}
        >
          <Scan size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button actual-size-button"
          type="button"
          onclick={selectActual}
          title="Actual size (1)"
          aria-label="Actual size (1)"
          disabled={!imageReady}
        >
          1:1
        </button>
      </div>
      <span class="app-toolbar-readout" aria-live="polite">{zoomLabel}</span>
      <div class="app-toolbar-group">
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => void toggleFullscreen()}
          title={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}
          aria-label={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}
        >
          {#if fullscreen}
            <Minimize size={16} aria-hidden="true" />
          {:else}
            <Maximize size={16} aria-hidden="true" />
          {/if}
        </button>
      </div>
    {/if}
  </header>

  <div class="detail-media">
    {#if failed}
      <div class="detail-error">
        <CircleAlert size={28} aria-hidden="true" />
        <p>Couldn't load the original file. It may have moved or been deleted.</p>
      </div>
    {:else if item.mediaKind === "video"}
      <VideoPlayer
        {src}
        {initialPlayback}
        onready={() => (loading = false)}
        onerror={handleMediaError}
      />
    {:else}
      <div
        class="detail-image-stage"
        class:is-pannable={canPan}
        class:is-dragging={dragPointerId !== null}
        role="presentation"
        bind:this={stage}
        onwheel={handleWheel}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={endPointerDrag}
        onpointercancel={endPointerDrag}
        ondblclick={handleDoubleClick}
      >
        <img
          class="detail-image"
          class:image-ready={imageReady}
          {src}
          alt={item.displayName}
          draggable={false}
          style:transform={`translate(${panX}px, ${panY}px) scale(${effectiveScale})`}
          {@attach observeImage}
        />
      </div>
    {/if}
  </div>
</section>

<style>
  .detail-viewer {
    position: absolute;
    z-index: var(--z-raised);
    inset: 0;
    display: flex;
    box-sizing: border-box;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface-2);
  }

  .detail-viewer:fullscreen {
    max-width: none;
    max-height: none;
    background: var(--surface-2);
  }

  .detail-title {
    overflow: hidden;
    min-width: 0;
    flex: 1;
    margin: 0;
    color: var(--text-primary);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-tools {
    margin-left: auto;
  }

  .detail-media {
    display: flex;
    width: 100%;
    flex: 1;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: center;
  }

  .detail-image-stage {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    touch-action: none;
  }

  .detail-image-stage.is-pannable {
    cursor: grab;
  }

  .detail-image-stage.is-dragging {
    cursor: grabbing;
  }

  .detail-image {
    position: absolute;
    max-width: none;
    max-height: none;
    transform-origin: center;
    user-select: none;
    -webkit-user-drag: none;
    will-change: transform;
  }

  .detail-image:not(.image-ready) {
    visibility: hidden;
  }

  .detail-error {
    display: flex;
    max-width: 320px;
    flex-direction: column;
    align-items: center;
    gap: var(--space-8);
    color: var(--text-primary);
    text-align: center;
  }

  .actual-size-button {
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
