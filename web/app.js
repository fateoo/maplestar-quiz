(() => {
  'use strict';

  const get = (id) => document.getElementById(id);
  const catalog = window.MAPLE_CATALOG;
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const entriesById = new Map(entries.map((entry) => [`${entry.type}:${entry.id}`, entry]));
  const types = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
  const maxFileSize = 20 * 1024 * 1024;
  const catalogPageSize = 24;
  const candidateLimit = 5;
  const minimumCandidateScore = 0.8;
  const formatNumber = new Intl.NumberFormat('zh-TW');

  const fileInput = get('file-input');
  const stage = get('dropzone');
  const preview = get('preview');
  const screenshot = get('screenshot');
  const resultCard = get('result-card');
  const candidateList = get('candidate-list');
  const copyButton = get('copy-name');
  const candidateFeedback = get('candidate-feedback');
  const dialog = get('catalog-dialog');

  let worker;
  let workerState = 'pending';
  let workerIssue = '';
  let screenshotUrl;
  let currentFile;
  let requestId = 0;
  let inFlightId;
  let pendingRecognition = false;
  let startedAt;
  let screenshotLoaded = false;
  let catalogPage = 0;
  let selectedName;
  let pendingCopy;
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

    let sourceUrl;
    try {
      const source = [
        window.readMapleTemplates.toString(),
        window.readMapleIndex.toString(),
        `(${window.mapleRecognitionWorker.toString()})();`,
      ].join('\n');
      sourceUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(sourceUrl);
      worker.addEventListener('message', () => URL.revokeObjectURL(sourceUrl), { once: true });
      worker.addEventListener('error', () => {
        URL.revokeObjectURL(sourceUrl);
        setEngineState('error', '無法啟動辨識引擎', '請用新版 Chrome、Edge 或 Safari 重新開啟網頁。');
      });
      worker.addEventListener('message', handleWorkerMessage);
      worker.postMessage({ type: 'init', entries, packedIndex, packedTemplates });
      delete window.MAPLE_PREPARED_DATA;
      delete window.MAPLE_TEMPLATE_DATA;
    } catch {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setEngineState('error', '無法啟動辨識引擎', '請用新版 Chrome、Edge 或 Safari 重新開啟網頁。');
    }
  }

  function handleWorkerMessage({ data }) {
    if (data.type === 'ready') {
      setEngineState('ready', '本機圖鑑已就緒');
      if (screenshotLoaded) recognize();
      return;
    }

    if (data.type === 'error' && workerState === 'pending') {
      setEngineState('error', '辨識引擎載入失敗', '請確認圖鑑檔案完整，再用新版瀏覽器開啟網頁。');
      return;
    }

    if (data.requestId !== inFlightId) return;
    inFlightId = undefined;
    if (pendingRecognition && screenshotLoaded) {
      pendingRecognition = false;
      recognize();
      return;
    }
    if (data.requestId !== requestId || !screenshotLoaded) return;
    if (data.type === 'result') {
      renderResults(data.matches, performance.now() - startedAt);
    } else if (data.type === 'error') {
      showNotice('error', '辨識失敗', '請重試，或換一張圖片。', true);
    }
  }

  function showNotice(state, title, detail, canRetry = false) {
    get('elapsed').hidden = true;
    resultCard.hidden = true;
    candidateList.replaceChildren();
    copyButton.hidden = true;
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
    requestId += 1;
    pendingRecognition = false;
    screenshotLoaded = false;
    currentFile = undefined;
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    screenshotUrl = undefined;
    screenshot.removeAttribute('src');
    preview.hidden = true;
    stage.classList.remove('has-preview');
    get('drop-content').hidden = false;
    get('screenshot-actions').hidden = true;
    get('file-details').textContent = 'PNG、JPG、WebP · 上限 20 MB';
    showFileError('');
    showNotice('empty', '等待圖片', '貼上或選擇圖片後會自動辨識。');
  }

  async function chooseFile(file) {
    if (!file) return;
    if (!types.has(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
      showFileError('請選擇 PNG、JPG 或 WebP 圖片。');
      return;
    }
    if (file.size > maxFileSize) {
      showFileError('圖片超過 20 MB。請壓縮或裁切後再試。');
      return;
    }

    clearScreenshot();
    currentFile = file;
    screenshotUrl = URL.createObjectURL(file);
    screenshot.src = screenshotUrl;
    const loadingId = requestId;
    try {
      await screenshot.decode();
    } catch {
      if (loadingId !== requestId) return;
      clearScreenshot();
      showFileError('無法開啟這張圖片。請確認檔案後重試。');
      return;
    }
    if (loadingId !== requestId) return;

    screenshotLoaded = true;
    const { naturalWidth, naturalHeight } = screenshot;
    const previewScale = Math.max(1, Math.min(4, 180 / Math.max(naturalWidth, naturalHeight)));
    screenshot.style.setProperty('--preview-width', `${Math.round(naturalWidth * previewScale)}px`);
    preview.hidden = false;
    stage.classList.add('has-preview');
    get('drop-content').hidden = true;
    get('screenshot-actions').hidden = false;
    get('file-details').textContent = `${file.name || '剪貼簿圖片'} · ${naturalWidth} × ${naturalHeight}`;
    recognize();
  }

  function recognize() {
    if (!screenshotLoaded) return;
    if (workerState === 'error') {
      showNotice('error', '無法辨識圖片', workerIssue);
      return;
    }
    if (workerState === 'pending') {
      showNotice('busy', '正在載入圖鑑', '圖鑑就緒後會自動辨識這張圖片。');
      return;
    }
    if (inFlightId !== undefined) {
      pendingRecognition = true;
      showNotice('busy', '等待辨識', '上一輪比對完成後會辨識這張圖片。');
      return;
    }

    showNotice('busy', '正在辨識', '正在比對本機圖鑑中的怪物與 NPC。');
    const { naturalWidth, naturalHeight } = screenshot;
    const scale = Math.min(1, 4200 / Math.max(naturalWidth, naturalHeight), Math.sqrt(8_400_000 / (naturalWidth * naturalHeight)));
    const width = Math.max(1, Math.floor(naturalWidth * scale));
    const height = Math.max(1, Math.floor(naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingEnabled = false;
      context.drawImage(screenshot, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      const rgba = new Uint8Array(data.buffer);
      startedAt = performance.now();
      const jpeg = scale < 1 || ['image/jpeg', 'image/webp'].includes(currentFile.type) || /\.(jpe?g|webp)$/i.test(currentFile.name);
      const options = { single: true, limit: candidateLimit, jpeg };
      worker.postMessage({ type: 'recognize', requestId: ++requestId, rgba, width, height, options }, [rgba.buffer]);
      inFlightId = requestId;
    } catch {
      showNotice('error', '無法讀取圖片', '請換一張圖片，或縮小圖片尺寸後再試。', true);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
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
    copyButton.textContent = '複製名稱';
    candidateFeedback.textContent = '';
  }

  function selectCandidate(name) {
    if (selectedName === name) return;
    selectedName?.removeAttribute('id');
    selectedName = name;
    name.id = 'result-name';
    resetCopyFeedback();
  }

  function renderCandidate(result, index) {
    const match = loadEntry(result);
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
    const row = element('label', 'candidate-row');
    row.append(option, choice);
    return row;
  }

  function renderResults(matches, elapsed) {
    if (matches.length === 0) {
      showNotice('empty', '找不到符合的項目', '請只截取一隻怪物或一名 NPC，保留完整輪廓後再試。');
      return;
    }

    const visibleMatches = matches.filter(({ score }) => Number.isFinite(score) && score >= minimumCandidateScore);
    if (visibleMatches.length === 0) {
      showNotice('empty', '沒有候選達到 80% 相似度', '可以換一張圖片，或保留角色的完整輪廓後再試。');
      return;
    }

    candidateList.replaceChildren(...visibleMatches.slice(0, candidateLimit).map(renderCandidate));
    selectCandidate(candidateList.querySelector('.entity-name'));
    const elapsedNode = get('elapsed');
    elapsedNode.textContent = elapsed >= 1000 ? `耗時 ${(elapsed / 1000).toFixed(1)} 秒` : `耗時 ${Math.round(elapsed)} 毫秒`;
    get('results-notice').hidden = true;
    copyButton.hidden = false;
    elapsedNode.hidden = false;
    resultCard.hidden = false;
    candidateFeedback.textContent = `找到 ${candidateList.childElementCount} 個候選名稱，已選取 ${selectedName.textContent}。`;
  }

  copyButton.addEventListener('click', async () => {
    const name = selectedName;
    if (!name) return;
    clearTimeout(copyFeedbackTimer);
    const attempt = {};
    pendingCopy = attempt;
    const copied = await copyResultName(name, attempt);
    if (pendingCopy !== attempt) return;
    copyButton.textContent = copied ? '已複製' : '請手動複製';
    candidateFeedback.textContent = copied ? `已複製 ${name.textContent}` : '名稱已選取，可手動複製。';
    copyFeedbackTimer = setTimeout(resetCopyFeedback, 2000);
  });

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
    clearScreenshot();
    get('paste-file').focus();
  });
  get('retry').addEventListener('click', recognize);
  fileInput.addEventListener('change', () => {
    chooseFile(fileInput.files[0]);
    fileInput.value = '';
  });

  document.addEventListener('paste', (event) => {
    if (dialog.open) return;
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
    if (dialog.open) return;
    event.dataTransfer.dropEffect = 'copy';
    stage.classList.toggle('is-dragging', stage.contains(event.target));
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    stage.classList.remove('is-dragging');
    if (!dialog.open) chooseFile(event.dataTransfer.files[0]);
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

  startWorker();
})();
