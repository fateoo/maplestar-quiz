(() => {
  const sampleSide = 32;
  const sampleInterval = 400;
  const settleTime = 350;
  const maxSettleTime = 1400;
  const frameInterval = 1000;
  const minRegionSide = 8;
  const maxFrameSide = 4200;
  const maxFramePixels = 4_800_000;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function differentFrame(first, second) {
    if (!first || first.length !== second.length) return true;
    let total = 0;
    let changed = 0;
    for (let i = 0; i < second.length; i += 4) {
      const delta = Math.abs(first[i] - second[i])
        + Math.abs(first[i + 1] - second[i + 1])
        + Math.abs(first[i + 2] - second[i + 2]);
      total += delta;
      if (delta >= 36) changed += 1;
      if (changed >= 6 || total >= sampleSide ** 2 * 6) return true;
    }
    return false;
  }

  function captureOptions() {
    const options = {
      video: { displaySurface: 'window', frameRate: { ideal: 8, max: 12 } },
      audio: false,
      selfBrowserSurface: 'exclude',
    };
    if (typeof window.CaptureController?.prototype?.setFocusBehavior === 'function') {
      try {
        const controller = new window.CaptureController();
        controller.setFocusBehavior('focus-capturing-application');
        options.controller = controller;
      } catch {
        // Other browsers retain their default selection and focus behavior.
      }
    }
    return options;
  }

  function captureError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
      return '未開始分享。請重新選擇要分享的畫面。';
    }
    if (error?.name === 'NotReadableError') return '無法讀取分享畫面，請確認系統的螢幕錄製權限。';
    if (error?.name === 'InvalidStateError') return '請回到此頁面，再按「分享畫面」。';
    return '無法開啟分享畫面，請重新選擇來源。';
  }

  window.createMapleScreenCapture = function ({
    startButton, stopButton, reselectButton, panel, video, surface, selection, status,
    canCapture = () => true, onFrame, onReset, onStop,
  }) {
    const devices = navigator.mediaDevices;
    const supported = typeof devices?.getDisplayMedia === 'function';
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = sampleSide;
    sampleCanvas.height = sampleSide;
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const frameCanvas = document.createElement('canvas');
    const frameContext = frameCanvas.getContext('2d');
    let generation = 0;
    let requesting = false;
    let stream;
    let track;
    let sourceWidth = 0;
    let sourceHeight = 0;
    let choosing = false;
    let region;
    let draft;
    let drag;
    let interval;
    let frameJob;
    let lastSample;
    let pendingSample;
    let pendingSince;
    let changedAt;
    let nextFrame = 0;

    function notice(message) {
      if (status.textContent !== message) status.textContent = message;
    }

    function renderControls() {
      startButton.disabled = !supported || requesting || !!stream;
      stopButton.disabled = !requesting && !stream;
      reselectButton.disabled = !stream || !video.videoWidth;
      panel.hidden = !stream;
      surface.toggleAttribute('data-selecting', choosing);
    }

    function renderSelection(rect) {
      selection.hidden = !rect;
      if (!rect) return;
      selection.style.left = `${rect.x * 100}%`;
      selection.style.top = `${rect.y * 100}%`;
      selection.style.width = `${rect.width * 100}%`;
      selection.style.height = `${rect.height * 100}%`;
    }

    function clearRegion() {
      clearInterval(interval);
      region = draft = drag = frameJob = lastSample = pendingSample = undefined;
      nextFrame = 0;
      renderSelection(null);
      frameCanvas.width = frameCanvas.height = 1;
    }

    function stop(message = '已停止自動擷取。') {
      if (!requesting && !stream) return;
      generation += 1;
      const previous = stream;
      requesting = choosing = false;
      stream = track = undefined;
      sourceWidth = sourceHeight = 0;
      clearRegion();
      video.pause();
      video.srcObject = null;
      surface.style.removeProperty('--capture-ratio');
      previous?.getTracks().forEach(mediaTrack => mediaTrack.stop());
      renderControls();
      notice(message);
      onStop?.();
    }

    function drawPreview() {
      if (!stream || !video.videoWidth || !video.videoHeight) return;
      const resized = sourceWidth !== video.videoWidth || sourceHeight !== video.videoHeight;
      sourceWidth = video.videoWidth;
      sourceHeight = video.videoHeight;
      surface.style.setProperty('--capture-ratio', video.videoWidth / video.videoHeight);
      if (resized && (region || draft)) {
        chooseAgain(false);
        return;
      }
      renderControls();
      if (choosing) notice('請在預覽畫面框選要辨識的區域。');
    }

    async function start() {
      if (!supported || requesting || stream) return;
      const id = ++generation;
      requesting = true;
      renderControls();
      notice('請在瀏覽器的分享視窗選擇來源。');
      try {
        const selected = await devices.getDisplayMedia(captureOptions());
        if (id !== generation) {
          selected.getTracks().forEach(mediaTrack => mediaTrack.stop());
          return;
        }
        stream = selected;
        track = stream.getVideoTracks()[0];
        if (!track || track.readyState === 'ended') {
          stop('分享來源已關閉，請重新選擇。');
          return;
        }
        requesting = false;
        choosing = true;
        track.addEventListener('ended', () => {
          if (id === generation) stop('瀏覽器已停止分享。');
        }, { once: true });
        notice('正在準備分享預覽。');
        renderControls();
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        if (id === generation) drawPreview();
      } catch (error) {
        if (id === generation) stop(captureError(error));
      }
    }

    function chooseAgain(focusPreview = true) {
      if (!stream || !video.videoWidth) return;
      clearRegion();
      choosing = true;
      renderControls();
      onReset?.();
      notice('請重新框選要辨識的區域。');
      if (focusPreview) surface.focus({ preventScroll: true });
    }

    function captureBounds(rect) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const x = Math.round(rect.x * width);
      const y = Math.round(rect.y * height);
      return {
        x, y,
        width: Math.min(width, Math.round((rect.x + rect.width) * width)) - x,
        height: Math.min(height, Math.round((rect.y + rect.height) * height)) - y,
      };
    }

    async function submitFrame(bounds, pixels, now) {
      const job = {};
      frameJob = job;
      nextFrame = now + frameInterval;
      pendingSample = undefined;
      try {
        const { x, y, width, height } = bounds;
        const scale = Math.min(1, maxFrameSide / Math.max(width, height), Math.sqrt(maxFramePixels / (width * height)));
        frameCanvas.width = Math.max(1, Math.floor(width * scale));
        frameCanvas.height = Math.max(1, Math.floor(height * scale));
        frameContext.drawImage(video, x, y, width, height, 0, 0, frameCanvas.width, frameCanvas.height);
        const blob = await new Promise(resolve => frameCanvas.toBlob(resolve, 'image/png'));
        if (frameJob !== job || !canCapture()) return;
        if (!blob) throw new Error('無法擷取畫面');
        const accepted = await onFrame(new File([blob], '螢幕擷取.png', { type: 'image/png' }));
        if (frameJob === job && accepted !== false) {
          lastSample = pixels;
          notice('自動辨識已啟用，畫面變動時會更新結果。');
        }
      } catch {
        if (frameJob === job) notice('暫時無法擷取此區域，請確認分享來源或重新框選。');
      } finally {
        if (frameJob === job) frameJob = undefined;
      }
    }

    function inspectFrame() {
      if (!region || frameJob || track?.muted || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || !video.videoWidth || !canCapture()) return;
      const bounds = captureBounds(region);
      if (bounds.width < minRegionSide || bounds.height < minRegionSide) return;
      let pixels;
      try {
        sampleContext.drawImage(video, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, sampleSide, sampleSide);
        pixels = sampleContext.getImageData(0, 0, sampleSide, sampleSide).data;
      } catch {
        return;
      }
      if (!differentFrame(lastSample, pixels)) {
        pendingSample = undefined;
        return;
      }
      const now = performance.now();
      if (!pendingSample) pendingSince = now;
      if (differentFrame(pendingSample, pixels)) {
        pendingSample = pixels;
        changedAt = now;
      }
      if (now >= nextFrame && (now - changedAt >= settleTime || now - pendingSince >= maxSettleTime)) {
        void submitFrame(bounds, pixels, now);
      }
    }

    function commitRegion(rect) {
      const bounds = captureBounds(rect);
      if (bounds.width < minRegionSide || bounds.height < minRegionSide) {
        draft = undefined;
        renderSelection(null);
        notice('框選範圍太小，請重新框選。');
        return;
      }
      region = rect;
      draft = undefined;
      choosing = false;
      renderControls();
      renderSelection(region);
      notice('自動辨識已啟用，畫面變動時會更新結果。');
      interval = setInterval(inspectFrame, sampleInterval);
      inspectFrame();
    }

    function pointerPosition(event) {
      const rect = video.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
      };
    }

    function updateDraft(event) {
      const { x, y } = pointerPosition(event);
      const { start } = drag;
      draft = {
        x: Math.min(x, start.x), y: Math.min(y, start.y),
        width: Math.abs(x - start.x), height: Math.abs(y - start.y),
      };
      renderSelection(draft);
    }

    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    surface.addEventListener('pointerdown', event => {
      if (!choosing || drag || event.button !== 0 || !video.videoWidth) return;
      event.preventDefault();
      surface.focus({ preventScroll: true });
      drag = { id: event.pointerId, start: pointerPosition(event) };
      if (event.isTrusted) surface.setPointerCapture?.(event.pointerId);
      updateDraft(event);
    });
    surface.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) updateDraft(event);
    });
    surface.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      updateDraft(event);
      drag = undefined;
      commitRegion(draft);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      surface.addEventListener(type, event => {
        if (drag?.id !== event.pointerId) return;
        draft = drag = undefined;
        renderSelection(null);
      });
    }
    surface.addEventListener('keydown', event => {
      if (!choosing || drag || !video.videoWidth) return;
      if (event.key === 'Escape') {
        draft = undefined;
        renderSelection(null);
        event.preventDefault();
        return;
      }
      if (event.key !== 'Enter' && !arrows[event.key]) return;
      event.preventDefault();
      draft ??= { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
      if (event.key === 'Enter') {
        commitRegion(draft);
        return;
      }
      const [dx, dy] = arrows[event.key];
      if (event.shiftKey) {
        draft.width = clamp(draft.width + dx * 0.02, minRegionSide / video.videoWidth, 1 - draft.x);
        draft.height = clamp(draft.height + dy * 0.02, minRegionSide / video.videoHeight, 1 - draft.y);
      } else {
        draft.x = clamp(draft.x + dx * 0.02, 0, 1 - draft.width);
        draft.y = clamp(draft.y + dy * 0.02, 0, 1 - draft.height);
      }
      renderSelection(draft);
    });

    startButton.addEventListener('click', start);
    stopButton.addEventListener('click', () => stop());
    reselectButton.addEventListener('click', () => chooseAgain());
    video.addEventListener('loadedmetadata', drawPreview);
    video.addEventListener('resize', drawPreview);
    window.addEventListener('pagehide', () => stop());
    renderControls();
    if (!supported) notice('目前瀏覽器無法分享螢幕，請使用支援螢幕分享的桌面瀏覽器。');

    return { get active() { return requesting || !!stream; }, stop };
  };
})();
