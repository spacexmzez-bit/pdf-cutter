import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./styles.css";
import "./sketch.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);
const DB_NAME = "pdf-cutter-local";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const MAX_HISTORY = 12;
const MAX_PREVIEW_CARDS = 60;

const state = {
  mode: "cut",
  sourceBytes: null,
  sourceDoc: null,
  fileName: "",
  pageCount: 0,
  markerBytes: null,
  markerDoc: null,
  markerFileName: "",
  currentRecord: null,
  preview: null,
  previewObserver: null,
  compressedPreviewDoc: null,
  compressionCancel: null,
  remember: true,
  busy: false
};

let dbPromise = null;
let toastTimer = null;

function showToast(message, type) {
  const node = $("toast");
  node.textContent = message;
  node.className = "toast show " + (type || "info");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.className = "toast";
  }, 4200);
}

function setBusy(busy, message) {
  state.busy = busy;
  $("preview-btn").disabled = busy || !state.sourceDoc;
  $("create-btn").disabled = busy || !state.preview;
  ["mode-cut", "mode-marker", "mode-compress", "source-file", "marker-file-input", "cut-pages", "marker-pages", "marker-position", "compress-level", "choose-marker", "replace-file", "reset-btn"].forEach((id) => {
    const control = $(id);
    if (control) control.disabled = busy;
  });
  $("preview-btn").classList.toggle("loading", busy && Boolean(message));
  if (message) $("preview-btn").textContent = message;
  else $("preview-btn").innerHTML = 'Preview result <span aria-hidden="true">→</span>';
  $("create-btn").classList.toggle("loading", busy);
}

function openDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("IndexedDB is not available in this browser."));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local project storage."));
  });
  return dbPromise;
}

async function putRecord(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save this project locally."));
    transaction.onabort = () => reject(transaction.error || new Error("Local save was cancelled."));
  });
}

async function getAllRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Could not read local project history."));
  });
}

async function getRecord(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not open this saved project."));
  });
}

async function deleteRecord(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not delete this project."));
  });
}

async function clearRecords() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not clear local history."));
  });
}

async function trimHistory() {
  const records = await getAllRecords();
  records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const oldRecords = records.slice(MAX_HISTORY);
  if (!oldRecords.length) return;
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    oldRecords.forEach((record) => store.delete(record.id));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not trim local history."));
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDate(timestamp) {
  if (!timestamp) return "Saved project";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function baseName(fileName) {
  return (fileName || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-");
}

function downloadPdf(bytes, fileName) {
  if (!bytes) return;
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName || "pdf-cutter-output.pdf";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setResultReady(record) {
  const ready = Boolean(record && record.outputBytes);
  $("result-ready").hidden = !ready;
  $("download-again").disabled = !ready;
  if (ready) $("result-name").textContent = record.outputName || "pdf-cutter-output.pdf";
}

function invalidatePreview() {
  state.preview = null;
  if (state.compressedPreviewDoc) {
    state.compressedPreviewDoc.destroy().catch(() => {});
    state.compressedPreviewDoc = null;
  }
  $("compress-stats").hidden = true;
  if (state.previewObserver) {
    state.previewObserver.disconnect();
    state.previewObserver = null;
  }
  $("preview-content").hidden = true;
  $("preview-empty").hidden = false;
  $("preview-btn").disabled = !state.sourceDoc || state.busy;
  $("create-btn").disabled = true;
}

function setMode(mode) {
  state.mode = ["cut", "marker", "compress"].includes(mode) ? mode : "cut";
  for (const option of ["cut", "marker", "compress"]) {
    const active = state.mode === option;
    $("mode-" + option).classList.toggle("active", active);
    $("mode-" + option).setAttribute("aria-selected", String(active));
    $("tool-" + option).hidden = !active;
  }
  $("preview-empty-description").textContent = state.mode === "compress"
    ? "Upload a PDF, choose a compression level, then preview the smaller result before downloading."
    : "Upload a PDF, choose the pages, then select Preview result to review the new page order.";
  invalidatePreview();
  if (state.currentRecord) state.currentRecord.operation = state.mode;
}

function parsePageSpec(raw, pageCount) {
  const parts = String(raw || "").split(/[;,]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Enter at least one page number or range.");

  const pages = [];
  const seen = new Set();

  for (const part of parts) {
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) {
      throw new Error('Invalid page entry "' + part + '". Use numbers and ranges such as 2, 4-7.');
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < 1) throw new Error("Page numbers must start at 1.");
    if (end < start) throw new Error("Range " + part + " is reversed. Put the smaller page first.");
    if (end > pageCount) {
      throw new Error("Page " + end + " is outside this PDF. It has " + pageCount + " pages.");
    }
    for (let page = start; page <= end; page += 1) {
      if (!seen.has(page)) {
        seen.add(page);
        pages.push(page);
      }
    }
  }

  if (!pages.length) throw new Error("No valid pages were selected.");
  return pages;
}

function createPreviewEntries(pages, mode, position) {
  if (mode === "cut") {
    return pages.map((pageNumber) => ({
      type: "source",
      pageNumber,
      label: "Original page " + pageNumber
    }));
  }

  const selected = new Set(pages);
  const entries = [];
  for (let pageNumber = 1; pageNumber <= state.pageCount; pageNumber += 1) {
    if (position === "before" && selected.has(pageNumber)) {
      entries.push({
        type: state.markerBytes ? "marker" : "blank",
        pageNumber: 1,
        relatedPage: pageNumber,
        label: (state.markerBytes ? "Marker" : "Blank marker") + " · before page " + pageNumber
      });
    }
    entries.push({
      type: "source",
      pageNumber,
      label: "Original page " + pageNumber
    });
    if (position === "after" && selected.has(pageNumber)) {
      entries.push({
        type: state.markerBytes ? "marker" : "blank",
        pageNumber: 1,
        relatedPage: pageNumber,
        label: (state.markerBytes ? "Marker" : "Blank marker") + " · after page " + pageNumber
      });
    }
  }
  return entries;
}

async function renderEntry(entry, canvas) {
  const documentToRender = entry.type === "marker" ? state.markerDoc
    : entry.type === "compressed" ? (state.compressedPreviewDoc || state.sourceDoc)
    : state.sourceDoc;
  if (!documentToRender) return;
  const page = await documentToRender.getPage(entry.pageNumber);
  const viewport = page.getViewport({ scale: 0.48 });
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
}

function renderPreviewGrid(entries) {
  if (state.previewObserver) state.previewObserver.disconnect();
  const grid = $("preview-grid");
  grid.replaceChildren();

  const visibleEntries = entries.slice(0, MAX_PREVIEW_CARDS);
  const fragment = document.createDocumentFragment();

  visibleEntries.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "page-card" + (entry.type === "blank" ? " blank-card" : "");
    const media = document.createElement("div");
    media.className = "page-media";

    if (entry.type === "blank") {
      const blank = document.createElement("div");
      blank.className = "blank-page-preview";
      const plus = document.createElement("span");
      plus.textContent = "+";
      const label = document.createElement("small");
      label.textContent = "BLANK MARKER";
      blank.append(plus, label);
      media.appendChild(blank);
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "page-canvas";
      canvas.setAttribute("aria-label", entry.label);
      media.appendChild(canvas);
      media.dataset.previewIndex = String(index);
      media.dataset.pageType = entry.type;
      media.dataset.pageNumber = String(entry.pageNumber);
      media._previewEntry = entry;
    }

    const caption = document.createElement("div");
    caption.className = "page-caption";
    const pageLabel = document.createElement("strong");
    pageLabel.textContent = entry.type === "marker" || entry.type === "blank" ? "Marker" : "Page " + entry.pageNumber;
    const detail = document.createElement("span");
    detail.textContent = entry.type === "source" ? "Original" : entry.type === "compressed" ? "Compressed" : entry.label;
    caption.append(pageLabel, detail);
    card.append(media, caption);
    fragment.appendChild(card);
  });

  grid.appendChild(fragment);

  const renderMedia = async (media) => {
    if (media.dataset.rendered === "true" || media.dataset.rendering === "true") return;
    media.dataset.rendering = "true";
    const canvas = media.querySelector("canvas");
    try {
      await renderEntry(media._previewEntry, canvas);
      media.dataset.rendered = "true";
    } catch (error) {
      const fallback = document.createElement("div");
      fallback.className = "render-fallback";
      fallback.textContent = "Preview unavailable";
      media.replaceChildren(fallback);
      console.warn("Could not render a PDF preview page:", error);
    } finally {
      media.dataset.rendering = "false";
    }
  };

  if ("IntersectionObserver" in window) {
    state.previewObserver = new IntersectionObserver((observations) => {
      observations.forEach((observation) => {
        if (observation.isIntersecting) {
          renderMedia(observation.target);
          state.previewObserver.unobserve(observation.target);
        }
      });
    }, { rootMargin: "260px" });

    grid.querySelectorAll(".page-media[data-preview-index]").forEach((media) => {
      state.previewObserver.observe(media);
    });
  } else {
    grid.querySelectorAll(".page-media[data-preview-index]").forEach(renderMedia);
  }

  $("preview-overflow").hidden = entries.length <= MAX_PREVIEW_CARDS;
  if (entries.length > MAX_PREVIEW_CARDS) {
    $("preview-overflow").textContent = "Showing the first " + MAX_PREVIEW_CARDS + " pages of " + entries.length + ". The created PDF will include the complete page sequence.";
  }
}

async function saveCurrentProject() {
  if (!state.remember || !state.currentRecord || !state.sourceBytes) return;
  const record = state.currentRecord;
  record.sourceBytes = state.sourceBytes.slice();
  record.markerBytes = state.markerBytes ? state.markerBytes.slice() : null;
  record.fileName = state.fileName;
  record.pageCount = state.pageCount;
  record.operation = state.mode;
  record.updatedAt = Date.now();
  record.markerFileName = state.markerFileName || "";
  record.pageSpec = state.mode === "cut" ? $("cut-pages").value : state.mode === "marker" ? $("marker-pages").value : "";
  record.compressionLevel = $("compress-level").value;
  record.markerPosition = $("marker-position").value;
  try {
    await putRecord(record);
    await trimHistory();
    await loadHistory();
  } catch (error) {
    console.warn("Local project save failed:", error);
    showToast("Could not save locally. Check this browser's available storage.", "error");
  }
}


function runCompressionWorker(sourceBytes, level, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compress.worker.js", import.meta.url), { type: "module" });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      state.compressionCancel = null;
      if (error) reject(error);
      else resolve(result);
    };
    state.compressionCancel = () => finish(new Error("Compression cancelled. Your original PDF is unchanged."));
    worker.onerror = (event) => finish(new Error(event.message || "Compression worker could not start."));
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        onProgress(data);
      } else if (data.type === "error") {
        finish(new Error(data.message));
      } else if (data.type === "done") {
        finish(null, { ...data, bytes: new Uint8Array(data.bytes) });
      }
    };
    const input = sourceBytes.slice().buffer;
    worker.postMessage({ bytes: input, level }, [input]);
  });
}

async function makeCompressionPreview() {
  invalidatePreview();
  try {
    setBusy(true, "Compressing PDF…");
    $("compress-progress-panel").hidden = false;
    $("compress-progress").value = 0;
    $("compress-progress-label").textContent = "Preparing the local compression engine…";
    const level = $("compress-level").value;
    const result = await runCompressionWorker(state.sourceBytes, level, (progress) => {
      $("compress-progress").value = progress.percent;
      $("compress-progress-label").textContent = progress.stage;
    });
    let compressedDoc = null;
    if (!result.usedOriginal) {
      compressedDoc = await loadPdfDocument(result.bytes);
      if (compressedDoc.numPages !== state.pageCount) {
        await compressedDoc.destroy();
        throw new Error("The optimized PDF failed page-count validation. No result was saved.");
      }
    }
    state.compressedPreviewDoc = compressedDoc;
    const entries = Array.from({ length: state.pageCount }, (_, i) => ({
      type: "compressed", pageNumber: i + 1, label: "Output page " + (i + 1)
    }));
    state.preview = {
      mode: "compress", compressedBytes: result.bytes, quality: level,
      entries, pages: [], position: "", pageSpec: ""
    };
    const savings = result.originalSize - result.outputSize;
    const percent = (100 * savings / result.originalSize).toFixed(1);
    $("preview-empty").hidden = true;
    $("preview-content").hidden = false;
    $("preview-summary").textContent = savings ? percent + "% smaller" : "Already optimized";
    $("preview-subsummary").textContent = formatBytes(result.originalSize) + " → " +
      formatBytes(result.outputSize) + " · " + state.pageCount + " pages";
    $("preview-status").textContent = "COMPRESSION READY";
    $("compress-stats").hidden = false;
    $("compress-stats").textContent = result.note ||
      (level === "lossless"
        ? "Lossless structural optimization; original image pixels preserved."
        : result.imagesChanged + " embedded image(s) optimized. Text and page objects were not rasterized.");
    renderPreviewGrid(entries);
    $("create-btn").disabled = false;
    await saveCurrentProject();
    showToast(savings
      ? "Compressed PDF ready. Review it before downloading."
      : "No smaller safe result found. The original PDF will be downloaded.", "success");
  } catch (error) {
    state.preview = null;
    $("create-btn").disabled = true;
    showToast(error.message || "Compression failed. Your original PDF is unchanged.", "error");
  } finally {
    $("compress-progress-panel").hidden = true;
    setBusy(false);
  }
}

async function makePreview() {
  if (!state.sourceDoc || !state.sourceBytes) {
    showToast("Choose a source PDF first.", "error");
    return;
  }

  if (state.mode === "compress") {
    await makeCompressionPreview();
    return;
  }
  try {
    setBusy(true, "Preparing preview…");
    const raw = state.mode === "cut" ? $("cut-pages").value : $("marker-pages").value;
    const pages = parsePageSpec(raw, state.pageCount);
    const position = $("marker-position").value;
    const entries = createPreviewEntries(pages, state.mode, position);

    state.preview = {
      mode: state.mode,
      pages,
      position,
      entries,
      pageSpec: raw,
      hasCustomMarker: Boolean(state.markerBytes)
    };

    $("preview-empty").hidden = true;
    $("preview-content").hidden = false;
    $("preview-summary").textContent = entries.length + " output " + (entries.length === 1 ? "page" : "pages");
    $("preview-subsummary").textContent = state.mode === "cut"
      ? pages.length + " selected from " + state.pageCount + " original pages"
      : pages.length + " marker " + (pages.length === 1 ? "page" : "pages") + " inserted · " + state.pageCount + " originals kept";
    $("preview-status").textContent = "PREVIEW READY";
    renderPreviewGrid(entries);
    $("create-btn").disabled = false;
    await saveCurrentProject();
    showToast("Preview ready. Review the page order before creating the PDF.", "success");
  } catch (error) {
    state.preview = null;
    $("create-btn").disabled = true;
    showToast(error.message || "Could not create the preview.", "error");
  } finally {
    setBusy(false);
  }
}

async function createMarkerPage(output, markerDocument, sourceDocument, sourceIndex) {
  if (markerDocument) {
    const copied = await output.copyPages(markerDocument, [0]);
    output.addPage(copied[0]);
  } else {
    const size = sourceDocument.getPage(sourceIndex).getSize();
    output.addPage([size.width, size.height]);
  }
}

async function createOutput() {
  if (!state.preview || !state.sourceBytes) {
    showToast("Create a fresh preview before generating the PDF.", "error");
    return;
  }

  const preview = state.preview;
  try {
    setBusy(true, "Creating PDF…");
    $("create-btn").textContent = "Creating PDF…";
    let outputName = "";
    let resultBytes;
    let outputPageCount;
    if (preview.mode === "compress") {
      resultBytes = preview.compressedBytes.slice();
      outputName = baseName(state.fileName) + "-compressed.pdf";
      outputPageCount = state.pageCount;
    } else {
    const sourceDocument = await PDFDocument.load(state.sourceBytes.slice());
    const output = await PDFDocument.create();

    if (preview.mode === "cut") {
      const indexes = preview.pages.map((page) => page - 1);
      const copiedPages = await output.copyPages(sourceDocument, indexes);
      copiedPages.forEach((page) => output.addPage(page));
      outputName = baseName(state.fileName) + "-cut.pdf";
    } else {
      const markerDocument = state.markerBytes ? await PDFDocument.load(state.markerBytes.slice()) : null;
      const originalPages = await output.copyPages(sourceDocument, sourceDocument.getPageIndices());
      const selected = new Set(preview.pages);

      for (let index = 0; index < originalPages.length; index += 1) {
        const pageNumber = index + 1;
        if (selected.has(pageNumber) && preview.position === "before") {
          await createMarkerPage(output, markerDocument, sourceDocument, index);
        }
        output.addPage(originalPages[index]);
        if (selected.has(pageNumber) && preview.position === "after") {
          await createMarkerPage(output, markerDocument, sourceDocument, index);
        }
      }
      outputName = baseName(state.fileName) + "-with-markers.pdf";
    }

    const savedBytes = await output.save();
    resultBytes = new Uint8Array(savedBytes);
    outputPageCount = output.getPageCount();
    }
    if (!state.currentRecord) {
      state.currentRecord = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
        createdAt: Date.now()
      };
    }
    state.currentRecord.outputBytes = resultBytes;
    state.currentRecord.outputName = outputName;
    state.currentRecord.operation = preview.mode;
    state.currentRecord.pageSpec = preview.pageSpec;
    state.currentRecord.markerPosition = preview.position;
    state.currentRecord.outputPageCount = outputPageCount;
    state.currentRecord.compressionLevel = preview.quality || null;
    state.currentRecord.updatedAt = Date.now();

    setResultReady(state.currentRecord);
    await saveCurrentProject();
    downloadPdf(resultBytes, outputName);
    showToast("Your PDF was created and downloaded.", "success");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not create this PDF. It may be encrypted or damaged.", "error");
  } finally {
    setBusy(false);
    $("create-btn").innerHTML = 'Create &amp; download PDF <span aria-hidden="true">↓</span>';
    $("create-btn").disabled = !state.preview;
  }
}

async function loadPdfDocument(bytes) {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  return task.promise;
}

async function handleSourceFile(file) {
  if (!file) return;
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    showToast("Choose a PDF file.", "error");
    return;
  }

  try {
    setBusy(true, "Loading PDF…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const documentToLoad = await loadPdfDocument(bytes);

    if (state.sourceDoc) {
      try { await state.sourceDoc.destroy(); } catch (_) {}
    }
    if (state.markerDoc) {
      try { await state.markerDoc.destroy(); } catch (_) {}
    }

    state.sourceBytes = bytes;
    state.sourceDoc = documentToLoad;
    state.fileName = file.name;
    state.pageCount = documentToLoad.numPages;
    state.markerBytes = null;
    state.markerDoc = null;
    state.markerFileName = "";
    $("marker-file-input").value = "";
    state.currentRecord = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
      fileName: file.name,
      sourceBytes: bytes.slice(),
      markerBytes: null,
      operation: state.mode,
      pageCount: documentToLoad.numPages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      outputBytes: null
    };

    $("file-meta").hidden = false;
    $("file-name").textContent = file.name;
    $("file-info").textContent = documentToLoad.numPages + " pages · " + formatBytes(file.size);
    $("cut-pages").value = "1-" + documentToLoad.numPages;
    $("marker-pages").value = "1";
    $("marker-file-label").textContent = "A blank page is used by default";
    $("marker-file-label").classList.remove("has-file");
    $("preview-btn").disabled = false;
    setResultReady(null);
    invalidatePreview();
    await saveCurrentProject();
    showToast("PDF loaded locally. Select your pages to continue.", "success");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not open this PDF. It may be encrypted or damaged.", "error");
  } finally {
    setBusy(false);
  }
}

async function handleMarkerFile(file) {
  if (!file) return;
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    showToast("The marker template must be a PDF.", "error");
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const documentToLoad = await loadPdfDocument(bytes);
    if (state.markerDoc) {
      try { await state.markerDoc.destroy(); } catch (_) {}
    }
    state.markerBytes = bytes;
    state.markerDoc = documentToLoad;
    state.markerFileName = file.name;
    $("marker-file-label").textContent = file.name + " · first page will be used";
    $("marker-file-label").classList.add("has-file");
    invalidatePreview();
    await saveCurrentProject();
    showToast("Custom marker loaded. Its first page will be inserted.", "success");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not open the marker PDF.", "error");
  }
}

function showFilePicker() {
  $("source-file").click();
}

function setHistoryEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "history-empty";
  const icon = document.createElement("span");
  icon.textContent = "◷";
  empty.append(icon, document.createTextNode(message));
  $("history-list").replaceChildren(empty);
}

async function loadHistory() {
  const list = $("history-list");
  try {
    const records = await getAllRecords();
    records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!records.length) {
      setHistoryEmpty(state.remember ? "Your saved projects will appear here." : "Local history is turned off. Enable it to save projects on this device.");
      return;
    }

    const fragment = document.createDocumentFragment();
    records.slice(0, MAX_HISTORY).forEach((record) => {
      const item = document.createElement("article");
      item.className = "history-item";

      const icon = document.createElement("div");
      icon.className = "history-file-icon";
      icon.textContent = "PDF";

      const copy = document.createElement("div");
      copy.className = "history-item-copy";
      const title = document.createElement("strong");
      title.textContent = record.fileName || "Untitled PDF";
      const detail = document.createElement("span");
      const operation = record.operation === "marker" ? "PDF marker" : record.operation === "compress" ? "PDF compressor" : "PDF cutter";
      detail.textContent = operation + " · " + (record.pageCount || "—") + " original pages · " + formatDate(record.updatedAt || record.createdAt);
      copy.append(title, detail);

      const actions = document.createElement("div");
      actions.className = "history-item-actions";
      const openButton = document.createElement("button");
      openButton.className = "history-open";
      openButton.type = "button";
      openButton.textContent = "Open";
      openButton.addEventListener("click", () => openSavedProject(record.id));
      actions.appendChild(openButton);

      if (record.outputBytes) {
        const downloadButton = document.createElement("button");
        downloadButton.className = "history-download";
        downloadButton.type = "button";
        downloadButton.textContent = "↓";
        downloadButton.title = "Download saved result";
        downloadButton.setAttribute("aria-label", "Download saved result");
        downloadButton.addEventListener("click", () => downloadPdf(record.outputBytes, record.outputName || "pdf-cutter-output.pdf"));
        actions.appendChild(downloadButton);
      }

      const deleteButton = document.createElement("button");
      deleteButton.className = "history-delete";
      deleteButton.type = "button";
      deleteButton.textContent = "×";
      deleteButton.title = "Delete saved project";
      deleteButton.setAttribute("aria-label", "Delete saved project");
      deleteButton.addEventListener("click", async () => {
        try {
          await deleteRecord(record.id);
          await loadHistory();
          showToast("Saved project deleted from this browser.", "success");
        } catch (error) {
          showToast(error.message, "error");
        }
      });
      actions.appendChild(deleteButton);

      item.append(icon, copy, actions);
      fragment.appendChild(item);
    });
    list.replaceChildren(fragment);
  } catch (error) {
    console.warn(error);
    setHistoryEmpty("Local project history is unavailable in this browser.");
  }
}

async function openSavedProject(id) {
  try {
    setBusy(true, "Opening project…");
    const record = await getRecord(id);
    if (!record || !record.sourceBytes) throw new Error("This saved project is no longer available.");

    if (state.sourceDoc) {
      try { await state.sourceDoc.destroy(); } catch (_) {}
    }
    if (state.markerDoc) {
      try { await state.markerDoc.destroy(); } catch (_) {}
    }

    state.currentRecord = record;
    state.sourceBytes = new Uint8Array(record.sourceBytes);
    state.sourceDoc = await loadPdfDocument(state.sourceBytes);
    state.fileName = record.fileName || "saved-document.pdf";
    state.pageCount = state.sourceDoc.numPages;
    state.markerBytes = record.markerBytes ? new Uint8Array(record.markerBytes) : null;
    state.markerDoc = state.markerBytes ? await loadPdfDocument(state.markerBytes) : null;
    state.markerFileName = record.markerFileName || "";

    setMode(record.operation || "cut");
    $("cut-pages").value = record.operation === "cut" ? (record.pageSpec || "1-" + state.pageCount) : "1-" + state.pageCount;
    $("marker-pages").value = record.operation === "marker" ? (record.pageSpec || "1") : "1";
    $("marker-position").value = record.markerPosition || "before";
    $("compress-level").value = record.compressionLevel || "balanced";
    $("file-meta").hidden = false;
    $("file-name").textContent = state.fileName;
    $("file-info").textContent = state.pageCount + " pages · saved locally";
    $("marker-file-label").textContent = state.markerFileName
      ? state.markerFileName + " · first page will be used"
      : "A blank page is used by default";
    $("marker-file-label").classList.toggle("has-file", Boolean(state.markerFileName));
    $("preview-btn").disabled = false;
    invalidatePreview();
    setResultReady(record);
    showToast("Saved project opened from this browser.", "success");
  } catch (error) {
    showToast(error.message || "Could not open the saved project.", "error");
  } finally {
    setBusy(false);
  }
}

function resetWorkspace() {
  if (state.previewObserver) state.previewObserver.disconnect();
  if (state.sourceDoc) state.sourceDoc.destroy().catch(() => {});
  if (state.markerDoc) state.markerDoc.destroy().catch(() => {});
  state.sourceBytes = null;
  state.sourceDoc = null;
  state.fileName = "";
  state.pageCount = 0;
  state.markerBytes = null;
  state.markerDoc = null;
  state.markerFileName = "";
  state.currentRecord = null;
  state.preview = null;
  if (state.compressedPreviewDoc) state.compressedPreviewDoc.destroy().catch(() => {});
  state.compressedPreviewDoc = null;

  $("source-file").value = "";
  $("marker-file-input").value = "";
  $("file-meta").hidden = true;
  $("cut-pages").value = "1-3";
  $("marker-pages").value = "1";
  $("compress-level").value = "balanced";
  $("marker-file-label").textContent = "A blank page is used by default";
  $("marker-file-label").classList.remove("has-file");
  $("preview-grid").replaceChildren();
  $("preview-content").hidden = true;
  $("preview-empty").hidden = false;
  $("preview-overflow").hidden = true;
  $("preview-btn").disabled = true;
  $("create-btn").disabled = true;
  setResultReady(null);
  showToast("Workspace reset. Saved history has not been deleted.", "info");
}

function initEvents() {
  // The hand-lettered sketch style is the default; this toggles typography only.
  $("font-toggle").addEventListener("click", () => {
    const readable = document.body.classList.toggle("readable-font");
    $("font-toggle").setAttribute("aria-pressed", String(readable));
    $("font-toggle").setAttribute("aria-label", readable ? "Switch back to sketch font" : "Switch to a more readable font");
    $("font-toggle-label").textContent = readable ? "Sketch font" : "Readable font";
  });
  $("mode-cut").addEventListener("click", () => setMode("cut"));
  $("mode-marker").addEventListener("click", () => setMode("marker"));
  $("mode-compress").addEventListener("click", () => setMode("compress"));

  $("dropzone").addEventListener("click", (event) => {
    if (event.target.id !== "source-file") showFilePicker();
  });
  $("dropzone").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showFilePicker();
    }
  });
  $("replace-file").addEventListener("click", showFilePicker);
  $("source-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) handleSourceFile(file);
    event.target.value = "";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    $("dropzone").addEventListener(eventName, (event) => {
      event.preventDefault();
      $("dropzone").classList.add("drag-active");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    $("dropzone").addEventListener(eventName, (event) => {
      event.preventDefault();
      $("dropzone").classList.remove("drag-active");
    });
  });
  $("dropzone").addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleSourceFile(file);
  });

  $("choose-marker").addEventListener("click", () => $("marker-file-input").click());
  $("marker-file-input").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) handleMarkerFile(file);
    event.target.value = "";
  });

  $("cut-pages").addEventListener("input", invalidatePreview);
  $("marker-pages").addEventListener("input", invalidatePreview);
  $("marker-position").addEventListener("change", invalidatePreview);
  $("compress-level").addEventListener("change", invalidatePreview);
  $("cancel-compression").addEventListener("click", () => state.compressionCancel?.());

  document.querySelectorAll(".example-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $(button.dataset.target);
      input.value = button.dataset.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  $("preview-btn").addEventListener("click", makePreview);
  $("create-btn").addEventListener("click", createOutput);
  $("download-again").addEventListener("click", () => {
    if (state.currentRecord && state.currentRecord.outputBytes) {
      downloadPdf(state.currentRecord.outputBytes, state.currentRecord.outputName || "pdf-cutter-output.pdf");
    }
  });
  $("reset-btn").addEventListener("click", resetWorkspace);

  $("remember-projects").addEventListener("change", async (event) => {
    state.remember = event.target.checked;
    try { localStorage.setItem("pdf-cutter-remember", state.remember ? "true" : "false"); } catch (_) {}
    if (state.remember) {
      await saveCurrentProject();
      showToast("Local project history is enabled.", "success");
    } else {
      showToast("New projects will no longer be saved. Existing history remains until cleared.", "info");
    }
  });

  $("clear-history").addEventListener("click", async () => {
    if (!window.confirm("Delete all saved PDFs and project history from this browser? This cannot be undone.")) return;
    try {
      await clearRecords();
      await loadHistory();
      if (state.currentRecord) {
        state.currentRecord.outputBytes = null;
        state.currentRecord.sourceBytes = null;
        state.currentRecord.markerBytes = null;
      }
      setResultReady(null);
      showToast("Local history cleared from this browser.", "success");
    } catch (error) {
      showToast(error.message || "Could not clear local history.", "error");
    }
  });
}

let pendingInstallPrompt = null;

function initInstallableApp() {
  const button = $("install-app");
  const isInstalled = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (isInstalled()) button.hidden = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingInstallPrompt = event;
    if (!isInstalled()) button.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    pendingInstallPrompt = null;
    button.hidden = true;
    showToast("PDF Cutter was installed on this device.", "success");
  });

  button.addEventListener("click", async () => {
    if (isInstalled()) return;
    if (pendingInstallPrompt) {
      const prompt = pendingInstallPrompt;
      pendingInstallPrompt = null;
      try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome !== "accepted") {
          showToast("You can install PDF Cutter later from your browser menu.", "info");
        }
      } catch (_) {
        showToast("Use your browser menu to install this app.", "info");
      }
      return;
    }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    showToast(isIOS
      ? "On iPhone or iPad, tap Share, then Add to Home Screen."
      : "Open your browser menu and choose Install app or Add to Home Screen.", "info");
  });

  // GitHub Pages serves the generated service worker from this app's own path.
  // Never intercept local PDF data or send document contents to a server.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    const register = () => {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      navigator.serviceWorker.register(new URL("sw.js", base), { scope: base.href })
        .catch((error) => console.warn("Offline app cache is unavailable:", error));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
}

function init() {
  try {
    state.remember = localStorage.getItem("pdf-cutter-remember") !== "false";
  } catch (_) {
    state.remember = true;
  }
  $("remember-projects").checked = state.remember;
  initEvents();
  initInstallableApp();
  loadHistory();
}

init();
