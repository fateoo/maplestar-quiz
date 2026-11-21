(() => {
  'use strict';

  const get = (id) => document.getElementById(id);
  const catalog = window.MAPLE_CATALOG;
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const entriesById = new Map(entries.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const types = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
  const maxFileSize = 20 * 1024 * 1024;
  const maxRefinementPixels = 1_500_000;
  const catalogPageSize = 24;
  const candidateLimit = 5;
  const preferredCandidateScore = 0.8;
  const spatialCandidateScore = 0.76;
  const raceDelay = 100;
  const recognitionTimeout = 5000;
  const trustedScore = 0.90;
  const trustedMargin = 0.025;
  const formatNumber = new Intl.NumberFormat('zh-TW');

  const fileInput = get('file-input');
  const stage = get('dropzone');
  const preview = get('preview');
  const screenshot = get('screenshot');
  const cropSurface = get('crop-surface');
  const cropOverlay = get('crop-overlay');
  const cropChoices = get('crop-choices');
  const resultCard = get('result-card');
  const candidateList = get('candidate-list');
  const copyButton = get('copy-name');
  const candidateFeedback = get('candidate-feedback');
  const dialog = get('catalog-dialog');
  const compareDialog = get('compare-dialog');
  const compareButton = get('open-compare');
  const compareSource = get('compare-source');
  const compareName = get('compare-name');
  const compareSprite = get('compare-sprite');
  const compareCopy = get('compare-copy');

  let worker;
  let workerSourceUrl;
  let workerInit;
  let workerState = 'pending';
  let workerIssue = '';
  let screenshotUrl;
  let currentFile;
  let capturedScreenshot = false;
  let requestId = 0;
  let workerRequestId = 0;
  let activeJob;
  let screenshotLoaded = false;
  let proposedRegions = [];
  // An undefined selection awaits a choice. Null means use the whole image.
  let selectedRegion = null;
  let tentativeRegion = null;
  let draftRegion;
  let cropPointer;
  let catalogPage = 0;
  let selectedName;
  let pendingCopy;
  let copyFeedbackButton;
  let copyFeedbackTimer;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  function typeLabel(type) {
    return type === 'npc' ? 'NPC' : '怪物';
  }

  function mainName(entry) {
    return entry.name_zh_tw || entry.name || `編號 ${entry.id}`;
  }

  function sprite(entry, lazy = false) {
    const container = element('span', 'sprite');
    if (entry.image) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      if (lazy) image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = entry.image;
      container.append(image);
    }
    return container;
  }

  function typeTag(type) {
    const tag = element('span', 'entity-type', typeLabel(type));
    tag.dataset.type = type;
    return tag;
  }

  function setEngineState(state, label, issue = '') {
    workerState = state;
    workerIssue = issue;
    const status = get('catalog-state');
    status.dataset.state = state;
    status.textContent = label;
    if (state === 'error' && currentFile) showNotice('error', '無法辨識圖片', issue);
  }

  function startWorker() {
    if (entries.length === 0) {
      setEngineState('error', '缺少本機圖鑑', '請將 index.html 和 catalog 資料夾放在同一層，再重新開啟網頁。');
      return;
    }

    const details = get('catalog-details');
    details.textContent = `${formatNumber.format(catalog.monsters)} 怪物 · ${formatNumber.format(catalog.npcs)} NPC`;
    details.hidden = false;
    get('open-catalog').disabled = false;
    if (catalog.version) {
      const version = get('catalog-version');
      version.textContent = `圖鑑版本 ${catalog.version}`;
      version.hidden = false;
    }

    const packedIndex = window.MAPLE_PREPARED_DATA;
    const packedTemplates = window.MAPLE_TEMPLATE_DATA;
    if ((typeof packedIndex !== 'string' && typeof packedTemplates !== 'string')
      || typeof window.readMapleIndex !== 'function' || typeof window.readMapleTemplates !== 'function'
      || typeof window.mapleRecognitionWorker !== 'function') {
      setEngineState('error', '辨識元件不完整', '請確認 recognition 和 catalog 資料夾與網頁位於同一層，再重新開啟。');
      return;
    }

    try {
      const source = [
        window.readMapleTemplates.toString(),
        window.readMapleIndex.toString(),
        `(${window.mapleRecognitionWorker.toString()})();`,
      ].join('\n');
      workerSourceUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      workerInit = { type: 'init', entries, packedIndex, packedTemplates };
      worker = createWorkerSlot();
      delete window.MAPLE_PREPARED_DATA;
      delete window.MAPLE_TEMPLATE_DATA;
    } catch {
      if (workerSourceUrl) URL.revokeObjectURL(workerSourceUrl);
      setEngineState('error', '無法啟動辨識引擎', '請用新版 Chrome、Edge 或 Safari 重新開啟網頁。');
    }
  }

  function createWorkerSlot() {
    const instance = new Worker(workerSourceUrl);
    const slot = { instance, ready: false, closed: false, lane: undefined };
    instance.addEventListener('message', ({ data }) => handleWorkerMessage(slot, data));
    instance.addEventListener('error', () => handleWorkerFault(slot));
    instance.addEventListener('messageerror', () => handleWorkerFault(slot));
    try {
      instance.postMessage(workerInit);
    } catch (error) {
      retireWorker(slot);
      throw error;
    }
    return slot;
  }

  function retireWorker(slot) {
    if (!slot || slot.closed) return;
    slot.closed = true;
    slot.lane = undefined;
    slot.instance.terminate();
  }

  function restartWarmWorker() {
    setEngineState('pending', '正在載入圖鑑');
    try {
      worker = createWorkerSlot();
    } catch {
      setEngineState('error', '無法啟動辨識引擎', '請用新版 Chrome、Edge 或 Safari 重新開啟網頁。');
    }
  }

  function handleWorkerMessage(slot, data) {
    if (slot.closed) return;
    if (data.type === 'ready') {
      slot.ready = true;
      if (slot === worker) {
        setEngineState('ready', '本機圖鑑已就緒');
        if (activeJob) startPrimary(activeJob);
      } else if (activeJob?.alternate?.slot === slot) {
        sendLane(activeJob.alternate);
      }
      return;
    }

    if (data.type === 'error' && !slot.ready) {
      handleWorkerFault(slot);
      return;
    }
    if (data.type !== 'result' && data.type !== 'error') return;
    const lane = slot.lane;
    if (!lane || data.requestId !== lane.requestId) return;
    slot.lane = undefined;
    if (lane.job === activeJob) finishLane(lane, data);
    else if (slot === worker && activeJob) startPrimary(activeJob);
  }

  function handleWorkerFault(slot) {
    if (slot.closed) return;
    const lane = slot.lane ?? (activeJob?.alternate?.slot === slot ? activeJob.alternate : undefined);
    retireWorker(slot);
    if (lane && lane.job === activeJob) {
      finishLane(lane, { type: 'error' });
    } else if (slot === worker) {
      if (slot.ready) restartWarmWorker();
      else {
        if (activeJob) {
          if (!canRunJob(activeJob)) return;
          releaseJob(activeJob);
        }
        setEngineState('error', '辨識引擎載入失敗', '請確認圖鑑檔案完整，再用新版瀏覽器開啟網頁。');
      }
    }
  }

  function releaseJob(job) {
    clearTimeout(job.deadline);
    clearTimeout(job.raceTimer);
    activeJob = undefined;
  }

  function discardJob(job, stopLoading = false) {
    releaseJob(job);
    retireAlternate(job.alternate);
    if (worker.lane?.job === job || (stopLoading && !worker.ready)) retireWorker(worker);
    if (worker.closed) setEngineState('pending', '等待重新辨識');
  }

  function timeOutJob(job) {
    if (job !== activeJob) return;
    const completed = [job.primary, job.alternate].filter(lane => lane?.response?.type === 'result'
      && lane.response.matches?.some(({ score }) => Number.isFinite(score)));
    const [winner] = completed.sort((first, second) =>
      compareLaneGrades(second.grade ?? gradeLane(second), first.grade ?? gradeLane(first)));
    if (winner) {
      let matches = winner.response.matches;
      if (winner.grade?.supported.length) {
        matches = winner.grade.supported;
      } else if (winner.subject) {
        matches = matches.map(match => ({ ...match, suggestion: true }));
      }
      finishJob(job, winner, matches);
      return;
    }
    discardJob(job, true);
    showNotice('error', '辨識逾時', '圖片辨識已超過 5 秒。請重新辨識，或裁切圖片後再試。', true);
  }

  function canRunJob(job) {
    if (job !== activeJob) return false;
    if (performance.now() - job.startedAt < recognitionTimeout) return true;
    timeOutJob(job);
    return false;
  }

  function invalidateRecognition() {
    requestId += 1;
    if (activeJob) discardJob(activeJob);
  }

  function showNotice(state, title, detail, canRetry = false) {
    if (compareDialog.open) compareDialog.close();
    get('elapsed').hidden = true;
    resultCard.hidden = true;
    candidateList.replaceChildren();
    get('result-actions').hidden = true;
    selectedName = undefined;
    resetCopyFeedback();
    const notice = get('results-notice');
    notice.dataset.state = state;
    get('notice-title').textContent = title;
    get('notice-detail').textContent = detail;
    get('retry').hidden = !canRetry;
    notice.hidden = false;
  }

  function showFileError(message) {
    const banner = get('screenshot-error');
    banner.textContent = message;
    banner.hidden = !message;
  }

  function clearScreenshot() {
    invalidateRecognition();
    screenshotLoaded = false;
    currentFile = undefined;
    capturedScreenshot = false;
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    screenshotUrl = undefined;
    screenshot.removeAttribute('src');
    preview.hidden = true;
    proposedRegions = [];
    selectedRegion = null;
    tentativeRegion = null;
    draftRegion = undefined;
    cropPointer = undefined;
    cropChoices.replaceChildren();
    cropOverlay.replaceChildren();
    get('crop-controls').hidden = true;
    stage.classList.remove('has-preview');
    get('drop-content').hidden = false;
    get('screenshot-actions').hidden = true;
    get('file-details').textContent = 'PNG、JPG、WebP · 上限 20 MB';
    showFileError('');
    showNotice('empty', '等待圖片', '貼上或選擇圖片後會自動辨識。');
  }

  async function chooseFile(file, captured = false) {
    if (!file) return false;
    if (!types.has(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
      showFileError('請選擇 PNG、JPG 或 WebP 圖片。');
      return false;
    }
    if (file.size > maxFileSize) {
      showFileError('圖片超過 20 MB。請壓縮或裁切後再試。');
      return false;
    }

    if (!captured) screenCapture?.stop();
    clearScreenshot();
    currentFile = file;
    capturedScreenshot = captured;
    screenshotUrl = URL.createObjectURL(file);
    screenshot.src = screenshotUrl;
    const loadingId = requestId;
    try {
      await screenshot.decode();
    } catch {
      if (loadingId !== requestId) return false;
      clearScreenshot();
      showFileError('無法開啟這張圖片。請確認檔案後重試。');
      return false;
    }
    if (loadingId !== requestId) return false;

    screenshotLoaded = true;
    const { naturalWidth, naturalHeight } = screenshot;
    const previewScale = captured ? 1 : Math.max(1, Math.min(4, 420 / Math.max(naturalWidth, naturalHeight)));
    screenshot.style.setProperty('--preview-width', `${Math.round(naturalWidth * previewScale)}px`);
    screenshot.style.setProperty('--preview-ratio', naturalWidth / naturalHeight);
    preview.hidden = false;
    stage.classList.add('has-preview');
    get('drop-content').hidden = true;
    get('screenshot-actions').hidden = false;
    get('file-details').textContent = `${file.name || '剪貼簿圖片'} · ${naturalWidth} × ${naturalHeight}`;
    const regions = detectRegions();
    if (captured) {
      const selected = regions.length === 1 ? regions[0] : null;
      selectCrop(selected, selected?.kind === 'sprite');
      return true;
    }
    proposedRegions = regions;
    cropChoices.replaceChildren(...proposedRegions.map((region, index) => {
      const button = element('button', 'secondary-button crop-choice', `範圍 ${index + 1}`);
      button.type = 'button';
      button.addEventListener('click', () => selectCrop(region));
      return button;
    }));
    get('crop-controls').hidden = false;
    const autoSelected = proposedRegions.length > 1 ? undefined : proposedRegions[0] ?? null;
    selectCrop(autoSelected, autoSelected?.kind === 'sprite');
  }

  function wholeImage() {
    return { x: 0, y: 0, width: screenshot.naturalWidth, height: screenshot.naturalHeight };
  }

  function drawScreenshot(canvas, region, maxSide, maxPixels, smooth, willReadFrequently = false) {
    const scale = Math.min(1, maxSide / Math.max(region.width, region.height), Math.sqrt(maxPixels / (region.width * region.height)));
    const width = Math.max(1, Math.floor(region.width * scale));
    const height = Math.max(1, Math.floor(region.height * scale));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently });
    context.imageSmoothingEnabled = smooth;
    context.drawImage(screenshot, region.x, region.y, region.width, region.height, 0, 0, width, height);
    return { context, width, height, scale };
  }

  function imagePixels(region, maxSide, maxPixels, smooth = false) {
    const canvas = document.createElement('canvas');
    try {
      const { context, width, height, scale } = drawScreenshot(canvas, region, maxSide, maxPixels, smooth, true);
      const { data } = context.getImageData(0, 0, width, height);
      return { rgba: new Uint8Array(data.buffer), width, height, scale };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function detectRegions() {
    if (typeof window.locateCardRegions !== 'function') return [];
    const image = wholeImage();
    try {
      const { rgba, width, height } = imagePixels(image, 720, 720 * 720, true);
      const sx = image.width / width;
      const sy = image.height / height;
      return window.locateCardRegions(rgba, width, height).slice(0, 4).flatMap((region) => {
        const x = Math.max(0, Math.floor(region.x * sx));
        const y = Math.max(0, Math.floor(region.y * sy));
        const right = Math.min(image.width, Math.ceil((region.x + region.width) * sx));
        const bottom = Math.min(image.height, Math.ceil((region.y + region.height) * sy));
        if (!(right - x >= 4 && bottom - y >= 4)) return [];
        const mapped = { x, y, width: right - x, height: bottom - y, kind: region.kind };
        return [refineCardRegion(mapped, image, Math.max(sx, sy))];
      });
    } catch {
      return [];
    }
  }

  function refineCardRegion(region, image, quantum) {
    if (region.kind !== 'card' || quantum <= 1) return region;
    const padding = Math.max(8, Math.ceil(2 * quantum));
    const right = region.x + region.width;
    const bottom = region.y + region.height;
    const x = Math.max(0, region.x - padding);
    const y = Math.max(0, region.y - padding);
    const searchRegion = { x, y, width: Math.min(image.width, right + padding) - x, height: Math.min(image.height, bottom + padding) - y };
    const card = findCardInWindow(searchRegion);
    if (!card) return region;
    const overlap = Math.max(0, Math.min(right, card.x + card.width) - Math.max(region.x, card.x))
      * Math.max(0, Math.min(bottom, card.y + card.height) - Math.max(region.y, card.y));
    return overlap >= 0.85 * Math.max(region.width * region.height, card.width * card.height) ? card : region;
  }

  function findCardInWindow(region) {
    if (typeof window.locateCardRegions !== 'function' || region.width * region.height > maxRefinementPixels) return null;
    try {
      const { rgba, width, height } = imagePixels(region, Infinity, maxRefinementPixels);
      const boxes = window.locateCardRegions(rgba, width, height, { refine: true });
      if (boxes.length === 1 && boxes[0].kind === 'card') {
        const box = boxes[0];
        return { ...box, x: region.x + box.x, y: region.y + box.y };
      }
    } catch {
      // Use the original region if its pixels cannot be read here.
    }
    return null;
  }

  function renderCropOverlay() {
    const multiple = proposedRegions.length > 1;
    const visible = draftRegion ? [draftRegion] : multiple ? [...proposedRegions] : [];
    if (!draftRegion && selectedRegion && !visible.includes(selectedRegion)) visible.push(selectedRegion);
    const image = wholeImage();
    cropOverlay.replaceChildren(...visible.map((region, index) => {
      const frame = element('div', 'crop-frame');
      frame.classList.toggle('is-selected', region === selectedRegion);
      frame.classList.toggle('is-draft', !!draftRegion);
      frame.style.left = `${region.x / image.width * 100}%`;
      frame.style.top = `${region.y / image.height * 100}%`;
      frame.style.width = `${region.width / image.width * 100}%`;
      frame.style.height = `${region.height / image.height * 100}%`;
      if (multiple && !draftRegion && index < proposedRegions.length) {
        frame.dataset.regionIndex = index;
        frame.append(element('span', 'crop-frame-label', index + 1));
      }
      return frame;
    }));
  }

  function renderCropControls() {
    const editing = !!draftRegion;
    const message = get('crop-message');
    message.hidden = !editing && selectedRegion !== undefined;
    message.textContent = editing
      ? '拖曳框選。方向鍵移動，Shift 加方向鍵調整大小，Enter 確認。'
      : '找到多個範圍，請選一個辨識。';
    cropSurface.toggleAttribute('data-editing', editing);
    if (editing) cropSurface.setAttribute('aria-describedby', 'crop-message');
    else cropSurface.removeAttribute('aria-describedby');
    cropSurface.tabIndex = editing ? 0 : -1;
    cropChoices.hidden = editing || proposedRegions.length < 2;
    Array.from(cropChoices.children).forEach((button, index) => {
      button.setAttribute('aria-pressed', String(proposedRegions[index] === selectedRegion));
    });
    get('adjust-crop').hidden = editing;
    get('use-full-image').hidden = editing || selectedRegion === null;
    get('confirm-crop').hidden = !editing;
    get('cancel-crop').hidden = !editing;
    renderCropOverlay();
  }

  function selectCrop(region, race = false) {
    invalidateRecognition();
    selectedRegion = region;
    tentativeRegion = race ? region : null;
    draftRegion = undefined;
    cropPointer = undefined;
    renderCropControls();
    if (selectedRegion === undefined) {
      showNotice('empty', '請選擇辨識範圍', '選取圖片中的一個範圍後，就會開始辨識。');
    } else {
      recognize();
    }
  }

  function startCropAdjustment() {
    invalidateRecognition();
    const image = wholeImage();
    const x = Math.floor(image.width * 0.1);
    const y = Math.floor(image.height * 0.1);
    draftRegion = { ...(selectedRegion ?? proposedRegions[0] ?? { x, y, width: image.width - 2 * x, height: image.height - 2 * y }) };
    renderCropControls();
    showNotice('empty', '正在調整辨識範圍', '確認範圍後開始辨識。');
    cropSurface.focus({ preventScroll: true });
  }

  function finishCropAdjustment(apply) {
    if (!draftRegion) return;
    const { x, y, width, height } = draftRegion;
    const region = { x, y, width, height };
    selectCrop(apply ? findCardInWindow(region) ?? region : selectedRegion);
    get('adjust-crop').focus({ preventScroll: true });
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function imagePoint(event) {
    const bounds = screenshot.getBoundingClientRect();
    return {
      x: Math.round(clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * screenshot.naturalWidth),
      y: Math.round(clamp((event.clientY - bounds.top) / bounds.height, 0, 1) * screenshot.naturalHeight),
    };
  }

  function moveCropPointer(event) {
    if (cropPointer?.id !== event.pointerId) return;
    const point = imagePoint(event);
    const { start, previous } = cropPointer;
    const width = Math.abs(point.x - start.x);
    const height = Math.abs(point.y - start.y);
    draftRegion = width >= 4 && height >= 4
      ? { x: Math.min(point.x, start.x), y: Math.min(point.y, start.y), width, height }
      : previous;
    renderCropOverlay();
  }

  get('adjust-crop').addEventListener('click', startCropAdjustment);
  get('use-full-image').addEventListener('click', () => {
    selectCrop(null);
    get('adjust-crop').focus({ preventScroll: true });
  });
  get('confirm-crop').addEventListener('click', () => finishCropAdjustment(true));
  get('cancel-crop').addEventListener('click', () => finishCropAdjustment(false));
  cropOverlay.addEventListener('click', (event) => {
    const frame = event.target.closest('[data-region-index]');
    if (!frame) return;
    const index = Number(frame.dataset.regionIndex);
    selectCrop(proposedRegions[index]);
    cropChoices.children[index].focus({ preventScroll: true });
  });

  cropSurface.addEventListener('pointerdown', (event) => {
    if (!draftRegion || cropPointer || event.button !== 0) return;
    event.preventDefault();
    cropPointer = { id: event.pointerId, start: imagePoint(event), previous: draftRegion };
    if (event.isTrusted) cropSurface.setPointerCapture(event.pointerId);
  });
  cropSurface.addEventListener('pointermove', moveCropPointer);
  cropSurface.addEventListener('pointerup', (event) => {
    if (cropPointer?.id !== event.pointerId) return;
    moveCropPointer(event);
    cropPointer = undefined;
  });
  cropSurface.addEventListener('pointercancel', (event) => {
    if (cropPointer?.id !== event.pointerId) return;
    draftRegion = cropPointer.previous;
    cropPointer = undefined;
    renderCropOverlay();
  });
  cropSurface.addEventListener('keydown', (event) => {
    if (!draftRegion) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      finishCropAdjustment(event.key === 'Enter');
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const image = wholeImage();
    const step = Math.max(1, Math.round(Math.max(draftRegion.width, draftRegion.height) / 100));
    const [dx, dy] = direction.map((value) => value * step);
    if (event.shiftKey) {
      draftRegion.width = clamp(draftRegion.width + dx, Math.min(4, image.width), image.width - draftRegion.x);
      draftRegion.height = clamp(draftRegion.height + dy, Math.min(4, image.height), image.height - draftRegion.y);
    } else {
      draftRegion.x = clamp(draftRegion.x + dx, 0, image.width - draftRegion.width);
      draftRegion.y = clamp(draftRegion.y + dy, 0, image.height - draftRegion.height);
    }
    renderCropOverlay();
  });

  function recognize() {
    if (!screenshotLoaded || selectedRegion === undefined || draftRegion) return;
    if (activeJob) return;
    const startedAt = performance.now();
    if (worker?.closed && workerState !== 'error') restartWarmWorker();
    if (workerState === 'error') {
      showNotice('error', '無法辨識圖片', workerIssue);
      return;
    }

    const job = { startedAt, tentative: tentativeRegion };
    let primaryRegion = selectedRegion;
    if (tentativeRegion) {
      const image = wholeImage();
      const heavilyPadded = tentativeRegion.width * tentativeRegion.height * 8 <= image.width * image.height;
      primaryRegion = heavilyPadded ? tentativeRegion : null;
    }
    job.primary = { job, slot: worker, region: primaryRegion };
    activeJob = job;
    const remaining = Math.max(0, recognitionTimeout - (performance.now() - startedAt));
    job.deadline = setTimeout(() => timeOutJob(job), remaining);
    startPrimary(job);
  }

  function startPrimary(job) {
    if (!canRunJob(job) || job.primary.started) return;
    if (!job.primary.slot.ready) {
      showNotice('busy', '正在載入圖鑑', '圖鑑就緒後會自動辨識這張圖片。');
      return;
    }
    if (job.primary.slot.lane) {
      showNotice('busy', '等待辨識', '上一輪比對完成後會辨識這張圖片。');
      return;
    }

    showNotice('busy', '正在辨識', '正在比對本機圖鑑中的怪物與 NPC。');
    sendLane(job.primary);
    if (job === activeJob && job.tentative && !job.primary.response) {
      job.raceTimer = setTimeout(() => startAlternate(job), raceDelay);
    }
  }

  function sendLane(lane) {
    if (!canRunJob(lane.job) || !lane.slot.ready || lane.slot.closed) return;
    lane.started = true;
    const region = lane.region ?? wholeImage();
    let pixels;
    try {
      pixels = imagePixels(region, 4200, 8_400_000);
    } catch {
      finishLane(lane, { type: 'error', unreadableImage: true });
      return;
    }
    if (!canRunJob(lane.job)) return;
    const { rgba, width, height, scale } = pixels;
    if (lane.job.tentative) {
      const subject = lane.job.tentative;
      const sx = width / region.width;
      const sy = height / region.height;
      lane.subject = { x: (subject.x - region.x) * sx, y: (subject.y - region.y) * sy, width: subject.width * sx, height: subject.height * sy };
    }
    const jpeg = scale < 1 || ['image/jpeg', 'image/webp'].includes(currentFile.type) || /\.(jpe?g|webp)$/i.test(currentFile.name);
    const options = { single: true, limit: candidateLimit, jpeg, suggestions: true };
    if (lane.region?.kind === 'card') options.card = true;
    lane.requestId = ++workerRequestId;
    lane.slot.lane = lane;
    try {
      lane.slot.instance.postMessage({ type: 'recognize', requestId: lane.requestId, rgba, width, height, options }, [rgba.buffer]);
    } catch {
      handleWorkerFault(lane.slot);
    }
  }

  function startAlternate(job) {
    if (!canRunJob(job)) return false;
    const primary = job.primary.slot;
    const warm = job.primary.response && primary.ready && !primary.closed && !primary.lane;
    if (job.alternate && (job.alternate.started || !warm)) return false;
    clearTimeout(job.raceTimer);
    retireAlternate(job.alternate);
    const lane = { job, region: job.primary.region ? null : job.tentative };
    job.alternate = lane;
    if (warm) {
      // Once the primary finishes, the fallback has no parallel work left to hedge.
      lane.slot = primary;
      sendLane(lane);
    } else {
      try {
        lane.slot = createWorkerSlot();
      } catch {
        finishLane(lane, { type: 'error' });
      }
    }
    return true;
  }

  function retireAlternate(lane) {
    if (!lane) return;
    if (lane.slot !== worker) retireWorker(lane.slot);
  }

  function coversSubject(match, subject) {
    if (!subject || !match || ![match.x, match.y, match.width, match.height].every(Number.isFinite)
      || match.width <= 0 || match.height <= 0) return false;
    const overlap = Math.max(0, Math.min(match.x + match.width, subject.x + subject.width) - Math.max(match.x, subject.x))
      * Math.max(0, Math.min(match.y + match.height, subject.y + subject.height) - Math.max(match.y, subject.y));
    return overlap >= 0.60 * subject.width * subject.height && overlap >= 0.45 * match.width * match.height;
  }

  function gradeLane(lane) {
    const matches = lane.response.matches?.filter(({ score }) => Number.isFinite(score)) ?? [];
    const top = matches[0];
    const verified = matches.find(({ suggestion, score }) => !suggestion && score >= preferredCandidateScore);
    const best = verified ?? top;
    const comparable = matches.slice(1).find(match => !match.suggestion && coversSubject(match, lane.subject));
    const supported = matches.filter(match => match.score >= spatialCandidateScore && coversSubject(match, lane.subject));
    const trusted = top && !top.suggestion && top.score >= trustedScore && coversSubject(top, lane.subject)
      && (!comparable || top.score - comparable.score >= trustedMargin);
    return {
      quality: verified ? 3 : best ? 2 : lane.response.type === 'result' ? 1 : 0,
      geometry: coversSubject(best, lane.subject),
      score: best?.score ?? -Infinity,
      supported,
      trusted,
    };
  }

  function compareLaneGrades(first, second) {
    return first.quality - second.quality || Number(first.geometry) - Number(second.geometry) || first.score - second.score;
  }

  function finishLane(lane, response) {
    const { job } = lane;
    if (!canRunJob(job)) return;
    lane.response = response;
    if (!job.tentative) {
      finishJob(job, lane);
      return;
    }
    lane.grade = gradeLane(lane);
    if (lane.grade.trusted) {
      finishJob(job, lane);
      return;
    }
    if (startAlternate(job) || job !== activeJob || !job.primary.response || !job.alternate.response) return;

    const primary = job.primary.grade;
    const alternate = job.alternate.grade;
    const primarySupported = primary.supported.length > 0;
    const alternateSupported = alternate.supported.length > 0;
    if (primary.quality >= 2 && alternate.quality >= 2 && primarySupported !== alternateSupported) {
      const winner = alternateSupported ? job.alternate : job.primary;
      finishJob(job, winner, winner.grade.supported);
    } else {
      finishJob(job, compareLaneGrades(alternate, primary) > 0 ? job.alternate : job.primary);
    }
  }

  function finishJob(job, winner, matches = winner.response.matches) {
    releaseJob(job);
    if (worker.lane?.job === job) retireWorker(worker);
    const alternateSlot = job.alternate?.slot;
    const spare = alternateSlot === worker ? undefined : alternateSlot;
    if (spare?.ready && !spare.closed && (worker.closed || (winner.slot === spare && winner.grade?.trusted))) {
      retireWorker(worker);
      worker = spare;
    } else {
      retireWorker(spare);
    }
    if (worker.closed) restartWarmWorker();
    if (job.tentative) {
      selectedRegion = winner.region;
      renderCropControls();
    }
    if (winner.response.type === 'result') {
      renderResults(matches, performance.now() - job.startedAt);
    } else if (winner.response.unreadableImage) {
      showNotice('error', '無法讀取圖片', '請換一張圖片，或縮小圖片尺寸後再試。', true);
    } else {
      showNotice('error', '辨識失敗', '請重試，或換一張圖片。', true);
    }
  }

  function loadEntry(match) {
    return { ...entriesById.get(`${match.type}:${match.id}`), ...match };
  }

  async function copyResultName(nameNode, attempt) {
    try {
      await navigator.clipboard.writeText(nameNode.textContent);
      return true;
    } catch {
      const selection = window.getSelection();
      if (!selection || pendingCopy !== attempt || !nameNode.isConnected) return false;
      const range = document.createRange();
      range.selectNodeContents(nameNode);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        const copied = document.execCommand('copy');
        if (copied) selection.removeAllRanges();
        return copied;
      } catch {
        return false;
      }
    }
  }

  function resetCopyFeedback() {
    pendingCopy = undefined;
    clearTimeout(copyFeedbackTimer);
    if (copyFeedbackButton) {
      const { button, label } = copyFeedbackButton;
      button.textContent = label;
      copyFeedbackButton = undefined;
    }
    candidateFeedback.textContent = '';
    get('compare-feedback').textContent = '';
  }

  function selectCandidate(name) {
    if (selectedName === name) return;
    selectedName?.removeAttribute('id');
    selectedName = name;
    name.id = 'result-name';
    resetCopyFeedback();
    compareButton.disabled = !name.closest('.candidate-row').querySelector('img');
    if (compareDialog.open) updateComparison();
  }

  function updateComparison() {
    const row = selectedName.closest('.candidate-row');
    const image = row.querySelector('img');
    if (image) compareSprite.src = image.src;
    else compareSprite.removeAttribute('src');
    compareName.textContent = selectedName.textContent;
    const count = candidateList.childElementCount;
    const position = Array.from(candidateList.children).indexOf(row) + 1;
    get('compare-navigation').hidden = count < 2;
    get('compare-position').textContent = `${position} / ${count}`;
    get('compare-prev').disabled = !row.previousElementSibling;
    get('compare-next').disabled = !row.nextElementSibling;
  }

  function moveComparison(direction) {
    const row = selectedName.closest('.candidate-row');
    const next = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!next) return;
    next.querySelector('.candidate-option').checked = true;
    selectCandidate(next.querySelector('.entity-name'));
  }

  compareButton.addEventListener('click', () => {
    if (!screenshotLoaded || !selectedName?.closest('.candidate-row').querySelector('img')) return;
    try {
      drawScreenshot(compareSource, selectedRegion ?? wholeImage(), 1200, 1200 ** 2, true);
    } catch {
      showFileError('無法放大這張圖片，請重新貼上後再試。');
      return;
    }
    get('compare-source-label').textContent = selectedRegion ? '待辨識範圍' : '待辨識圖片';
    updateComparison();
    compareDialog.showModal();
  });
  get('compare-prev').addEventListener('click', () => moveComparison(-1));
  get('compare-next').addEventListener('click', () => moveComparison(1));
  compareDialog.addEventListener('close', () => {
    if (compareDialog.open) return;
    compareSource.width = 0;
    compareSource.height = 0;
    compareSprite.removeAttribute('src');
    resetCopyFeedback();
  });

  function renderCandidate(match, index, shownNames) {
    const name = element('strong', 'entity-name', mainName(match));
    const option = element('input', 'candidate-option visually-hidden');
    option.type = 'radio';
    option.name = 'candidate';
    option.checked = index === 0;
    option.addEventListener('change', () => selectCandidate(name));

    const marker = element('span', 'candidate-marker');
    marker.setAttribute('aria-hidden', 'true');
    const meta = element('span', 'candidate-meta');
    meta.append(typeTag(match.type));
    if (Number.isFinite(match.score)) {
      const score = element('span', 'result-score', `${Math.round(match.score * 100)}%`);
      score.title = '圖片相似度';
      meta.append(score);
    }

    const choice = element('span', 'candidate-choice');
    choice.append(marker, sprite(match), name, meta);
    const label = element('label', 'candidate-label');
    label.append(option, choice);
    const row = element('div', 'candidate-row');
    row.append(label);

    const aliases = element('ul', 'candidate-aliases');
    aliases.setAttribute('aria-label', '同圖名稱');
    for (const alias of match.aliases ?? []) {
      const key = catalogSearchKey(alias);
      if (!key || shownNames.has(key)) continue;
      shownNames.add(key);
      const aliasName = element('span', 'candidate-alias-name', alias);
      const copy = element('button', 'secondary-button candidate-alias-copy', '複製');
      copy.type = 'button';
      copy.setAttribute('aria-label', `複製 ${alias}`);
      copy.addEventListener('click', () => copyName(aliasName, copy, candidateFeedback));
      const item = element('li', 'candidate-alias');
      item.append(aliasName, copy);
      aliases.append(item);
    }
    if (aliases.childElementCount) row.append(aliases);
    return row;
  }

  function renderResults(matches, elapsed) {
    const candidates = matches.filter(({ score }) => Number.isFinite(score));
    if (candidates.length === 0) {
      showNotice('empty', '找不到符合的項目', '請只截取一隻怪物或一名 NPC，保留完整輪廓後再試。');
      return;
    }

    const preferred = candidates.filter(({ score, suggestion }) => !suggestion && score >= preferredCandidateScore);
    const reviewing = preferred.length === 0;
    const visibleMatches = (reviewing ? candidates : preferred).slice(0, candidateLimit).map(loadEntry);
    const note = get('candidate-note');
    note.hidden = !reviewing;
    const shownNames = new Set(visibleMatches.map(match => catalogSearchKey(mainName(match))));
    candidateList.replaceChildren(...visibleMatches.map((match, index) => renderCandidate(match, index, shownNames)));
    selectCandidate(candidateList.querySelector('.entity-name'));
    const elapsedNode = get('elapsed');
    elapsedNode.textContent = elapsed >= 1000 ? `耗時 ${(elapsed / 1000).toFixed(1)} 秒` : `耗時 ${Math.round(elapsed)} 毫秒`;
    get('results-notice').hidden = true;
    get('result-actions').hidden = false;
    elapsedNode.hidden = false;
    resultCard.hidden = false;
    const reviewMessage = reviewing ? `${note.textContent} ` : '';
    candidateFeedback.textContent = `${reviewMessage}找到 ${candidateList.childElementCount} 個候選項目，已選取 ${selectedName.textContent}。`;
  }

  async function copyName(name, button, feedback) {
    if (!name) return;
    resetCopyFeedback();
    const attempt = {};
    pendingCopy = attempt;
    const copied = await copyResultName(name, attempt);
    if (pendingCopy !== attempt) return;
    copyFeedbackButton = { button, label: button.textContent };
    button.textContent = copied ? '已複製' : '請手動複製';
    feedback.textContent = copied ? `已複製 ${name.textContent}` : '名稱已選取，可手動複製。';
    copyFeedbackTimer = setTimeout(resetCopyFeedback, 2000);
  }

  copyButton.addEventListener('click', () => copyName(selectedName, copyButton, candidateFeedback));
  compareCopy.addEventListener('click', () => copyName(compareName, compareCopy, get('compare-feedback')));

  function catalogSearchKey(value) {
    return String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  }

  function renderCatalog() {
    const query = catalogSearchKey(get('catalog-search').value);
    const category = get('catalog-type').value;
    const matchesByName = new Map();
    for (const entry of entries) {
      const typeMatches = category === 'all' || (category === 'npc') === (entry.type === 'npc');
      if (!typeMatches) continue;
      const name = catalogSearchKey(mainName(entry));
      const id = catalogSearchKey(entry.id);
      if (query && !name.includes(query) && !id.includes(query)) continue;

      const priority = (query === id ? 2 : 0) + (entry.source === 'MapleQuiz' ? 1 : 0);
      const current = matchesByName.get(name);
      if (!current || priority > current.priority) matchesByName.set(name, { entry, priority });
    }
    const matches = Array.from(matchesByName.values(), ({ entry }) => entry);
    const pageCount = Math.ceil(matches.length / catalogPageSize);
    const start = catalogPage * catalogPageSize;
    const items = get('catalog-items');
    const cards = matches.slice(start, start + catalogPageSize).map((entry) => {
      const card = element('article', 'catalog-entity');
      const footer = document.createElement('footer');
      footer.append(typeTag(entry.type), element('span', '', `ID ${entry.id}`));
      card.append(sprite(entry, true), element('div', 'entity-name', mainName(entry)));
      card.append(footer);
      return card;
    });
    items.replaceChildren(...(cards.length ? cards : [element('p', 'catalog-empty', '沒有符合條件的項目。')]));
    items.scrollTop = 0;
    get('catalog-page').textContent = pageCount ? `${catalogPage + 1} / ${pageCount} 頁 · ${formatNumber.format(matches.length)} 筆` : '0 筆';
    get('catalog-prev').disabled = catalogPage === 0;
    get('catalog-next').disabled = catalogPage + 1 >= pageCount;
  }

  const pasteShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ + V' : 'Ctrl + V';
  get('paste-key').textContent = pasteShortcut;
  get('select-file').addEventListener('click', () => fileInput.click());
  get('replace-file').addEventListener('click', () => fileInput.click());
  get('clear-file').addEventListener('click', () => {
    screenCapture?.stop();
    clearScreenshot();
    get('paste-file').focus();
  });
  get('retry').addEventListener('click', recognize);
  fileInput.addEventListener('change', () => {
    chooseFile(fileInput.files[0]);
    fileInput.value = '';
  });

  document.addEventListener('paste', (event) => {
    if (dialog.open || compareDialog.open) return;
    const file = Array.from(event.clipboardData?.files || []).find((item) => item.type.startsWith('image/'))
      || Array.from(event.clipboardData?.items || []).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    chooseFile(file);
  });

  async function pasteFromClipboard() {
    try {
      const clipboard = await navigator.clipboard.read();
      for (const item of clipboard) {
        const type = item.types.find((mime) => types.has(mime));
        if (!type) continue;
        const blob = await item.getType(type);
        await chooseFile(new File([blob], `剪貼簿圖片.${types.get(type)}`, { type }));
        return;
      }
      showFileError('剪貼簿沒有 PNG、JPG 或 WebP 圖片。');
    } catch {
      showFileError(`請先複製圖片，回到網頁後按 ${pasteShortcut} 貼上。`);
    }
  }

  get('paste-file').addEventListener('click', pasteFromClipboard);
  get('replace-paste').addEventListener('click', pasteFromClipboard);

  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (dialog.open || compareDialog.open) return;
    event.dataTransfer.dropEffect = 'copy';
    stage.classList.toggle('is-dragging', stage.contains(event.target));
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    stage.classList.remove('is-dragging');
    if (!dialog.open && !compareDialog.open) chooseFile(event.dataTransfer.files[0]);
  });
  stage.addEventListener('dragleave', (event) => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove('is-dragging');
  });

  get('open-catalog').addEventListener('click', () => {
    renderCatalog();
    dialog.showModal();
  });
  const changeCatalogFilter = () => {
    catalogPage = 0;
    renderCatalog();
  };
  get('catalog-search').addEventListener('input', changeCatalogFilter);
  get('catalog-type').addEventListener('change', changeCatalogFilter);
  get('catalog-prev').addEventListener('click', () => { catalogPage -= 1; renderCatalog(); });
  get('catalog-next').addEventListener('click', () => { catalogPage += 1; renderCatalog(); });

  function cancelCapturedRecognition() {
    if (!capturedScreenshot) return;
    if (!screenshotLoaded) {
      clearScreenshot();
    } else if (activeJob) {
      invalidateRecognition();
      showNotice('empty', '已停止自動辨識', '可以重新辨識目前的圖片，或框選新的區域。', true);
    }
  }

  const screenCapture = window.createMapleScreenCapture?.({
    startButton: get('capture-start'),
    stopButton: get('capture-stop'),
    reselectButton: get('capture-select'),
    useLastButton: get('capture-use-last'),
    panel: get('capture-panel'),
    video: get('capture-video'),
    surface: get('capture-surface'),
    selection: get('capture-overlay'),
    status: get('capture-status'),
    // The first captured frame replaces any draft crop on the previous screenshot.
    canCapture: () => !activeJob && (!currentFile || screenshotLoaded) && !dialog.open && !compareDialog.open,
    onFrame: (file) => chooseFile(file, true),
    onReset: cancelCapturedRecognition,
    onStop: cancelCapturedRecognition,
  });

  startWorker();
})();
