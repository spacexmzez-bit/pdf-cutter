import { PDFDocument } from "pdf-lib";
import { zipSync } from "fflate";
import { createMultiOutputName, parseMultiCutsJson, validateMultiParts } from "./multi-cuts.js";
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
  multiParts: [],
  multiResults: [],
  batchMode: false,
  batchInputs: [],
  batchPreviews: [],
  batchErrors: [],
  batchIndex: 0,
  nextJobSources: [],
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
  ["mode-cut", "mode-marker", "mode-compress", "mode-multi-cut", "source-file", "marker-file-input", "multi-json-file", "multi-json-text", "copy-multi-json", "choose-multi-json", "import-multi-json", "add-multi-part", "cut-pages", "marker-pages", "marker-position", "compress-level", "choose-marker", "replace-file", "reset-btn", "next-job-tool", "next-job-start", "next-job-yes", "next-job-no"].forEach((id) => {
    const control = $(id);
    if (control) control.disabled = busy;
  });
  $("preview-btn").classList.toggle("loading", busy && Boolean(message));
  if (message) $("preview-btn").textContent = message;
  else $("preview-btn").innerHTML = state.mode === "multi-cut"
    ? 'Preview pieces <span aria-hidden="true">→</span>'
    : 'Preview result <span aria-hidden="true">→</span>';
  $("create-btn").classList.toggle("loading", busy);
  $("create-btn").innerHTML = state.mode === "multi-cut"
    ? 'Generate all pieces <span aria-hidden="true">↓</span>'
    : 'Create &amp; download PDF <span aria-hidden="true">↓</span>';
  document.querySelectorAll("#tool-multi-cut input, #tool-multi-cut textarea, #tool-multi-cut button")
    .forEach((control) => { control.disabled = busy; });
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

function downloadBlob(bytes, fileName, mimeType) {
  if (!bytes) return;
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadPdf(bytes, fileName) {
  downloadBlob(bytes, fileName || "pdf-cutter-output.pdf", "application/pdf");
}

function downloadMultiZip(results, sourceName, archiveLabel) {
  const files = {};
  (results || []).forEach((result) => {
    if (!result || !result.outputName || !result.bytes) return;
    files[result.outputName] = result.bytes instanceof Uint8Array
      ? result.bytes : new Uint8Array(result.bytes);
  });
  if (!Object.keys(files).length) {
    showToast("There are no generated pieces to package.", "error");
    return;
  }
  try {
    const archive = zipSync(files, { level: 0 });
    const name = baseName(sourceName || state.fileName) + " - " + (archiveLabel || "Split Parts") + ".zip";
    downloadBlob(archive, name, "application/zip");
  } catch (error) {
    console.error(error);
    showToast("Could not create the ZIP archive. Try downloading the pieces individually.", "error");
  }
}

function setResultReady(record) {
  const ready = Boolean(record && record.outputBytes && state.mode !== "multi-cut" && !state.batchMode && !record.batchMode);
  $("result-ready").hidden = !ready;
  $("download-again").disabled = !ready;
  if (ready) $("result-name").textContent = record.outputName || "pdf-cutter-output.pdf";
}

function setMultiResultReady(record) {
  const results = record
    ? (Array.isArray(record.multiResults) ? record.multiResults : [])
    : state.multiResults;
  const batch = Boolean(state.batchMode || record?.batchMode);
  const ready = (state.mode === "multi-cut" || batch) && Array.isArray(results) && results.length > 0;
  const panel = $("multi-result-ready");
  panel.hidden = !ready;
  if (!ready) return;
  $("multi-result-summary").textContent = results.length + (batch ? " result" : " piece") + (results.length === 1 ? "" : "s") + " generated";
  panel.querySelector(".multi-results-heading span").textContent = batch
    ? "Each selected input was processed separately. Download individual results or collect them in one ZIP."
    : "Download each PDF separately or collect all pieces in one ZIP.";
  $("download-multi-zip").textContent = batch ? "Download all results as ZIP ↓" : "Download all as ZIP ↓";
  const errors = record?.batchErrors || state.batchErrors || [];
  const errorPanel = $("batch-result-errors");
  errorPanel.hidden = !batch || !errors.length;
  errorPanel.textContent = errors.length
    ? errors.map((item) => item.fileName + ": " + item.message).join(" · ")
    : "";
  const list = $("multi-results-list");
  list.replaceChildren();
  results.forEach((result, index) => {
    const row = document.createElement("div");
    row.className = "multi-result-item";
    const name = document.createElement("div");
    name.className = "multi-result-name";
    const title = document.createElement("strong");
    title.textContent = result.outputName || ("Part " + (index + 1) + ".pdf");
    const detail = document.createElement("span");
    detail.textContent = (result.pageCount || result.pages?.length || "—") + " pages · " + formatBytes(result.bytes?.byteLength || result.bytes?.length || 0);
    name.append(title, detail);
    const button = document.createElement("button");
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = "Download PDF ↓";
    button.addEventListener("click", () => downloadPdf(result.bytes, result.outputName));
    row.append(name, button);
    list.appendChild(row);
  });
}

function invalidatePreview() {
  state.preview = null;
  if (state.batchMode) state.batchPreviews = [];
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
  $("multi-preview-selector-wrap").hidden = true;
  $("batch-preview-selector-wrap").hidden = true;
  $("preview-empty").hidden = false;
  $("preview-btn").disabled = !state.sourceDoc || state.busy;
  $("create-btn").disabled = true;
}

function setMode(mode) {
  const previousMode = state.mode;
  state.mode = ["cut", "marker", "compress", "multi-cut"].includes(mode) ? mode : "cut";
  if (previousMode === "multi-cut" && state.mode !== "multi-cut" && !state.batchMode) {
    state.multiResults = [];
    if (state.currentRecord) state.currentRecord.multiResults = null;
  }
  if (state.mode === "multi-cut" && previousMode !== "multi-cut" && state.currentRecord) {
    state.currentRecord.outputBytes = null;
    state.currentRecord.outputName = null;
  }
  for (const option of ["cut", "marker", "compress", "multi-cut"]) {
    const active = state.mode === option;
    $("mode-" + option).classList.toggle("active", active);
    $("mode-" + option).setAttribute("aria-selected", String(active));
    $("tool-" + option).hidden = !active;
  }
  $("preview-empty-description").textContent = state.batchMode
    ? "The same tool settings will be applied independently to each selected PDF. Preview each input before generating the batch."
    : state.mode === "compress"
      ? "Upload a PDF, choose a compression level, then preview the smaller result before downloading."
      : state.mode === "multi-cut"
        ? "Create named PDF pieces, allow overlapping pages, and preview one piece at a time before generating all of them."
        : "Upload a PDF, choose the pages, then select Preview result to review the new page order.";
  if (state.mode === "multi-cut" && state.pageCount && !state.multiParts.length) {
    state.multiParts = [{ part_name: "Part 1", pages_range: "1-" + state.pageCount }];
  }
  invalidatePreview();
  renderMultiParts();
  if (state.currentRecord) state.currentRecord.operation = state.mode;
  setResultReady(state.currentRecord);
  setMultiResultReady(state.currentRecord);
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

function renderMultiParts() {
  const list = $("multi-parts-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.multiParts.length) {
    const empty = document.createElement("div");
    empty.className = "multi-parts-empty";
    empty.textContent = "No pieces yet. Select Add piece or import a JSON definition.";
    list.appendChild(empty);
    return;
  }
  state.multiParts.forEach((part, index) => {
    const row = document.createElement("div");
    row.className = "multi-part-row";
    row.dataset.index = String(index);
    const nameField = document.createElement("div");
    nameField.className = "multi-part-field";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Part " + (index + 1) + " name";
    const nameInput = document.createElement("input");
    nameInput.className = "text-input";
    nameInput.type = "text";
    nameInput.maxLength = 80;
    nameInput.value = part.part_name || "";
    nameInput.placeholder = "e.g. Introduction";
    nameInput.dataset.field = "part_name";
    nameInput.setAttribute("aria-label", "Part " + (index + 1) + " name");
    nameField.append(nameLabel, nameInput);
    const rangeField = document.createElement("div");
    rangeField.className = "multi-part-field";
    const rangeLabel = document.createElement("label");
    rangeLabel.textContent = "Pages to include";
    const rangeInput = document.createElement("input");
    rangeInput.className = "text-input";
    rangeInput.type = "text";
    rangeInput.value = part.pages_range || "";
    rangeInput.placeholder = "1-4, 76, 88-100";
    rangeInput.dataset.field = "pages_range";
    rangeInput.setAttribute("aria-label", "Part " + (index + 1) + " page ranges");
    rangeField.append(rangeLabel, rangeInput);
    const remove = document.createElement("button");
    remove.className = "multi-part-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove this piece";
    remove.setAttribute("aria-label", "Remove part " + (index + 1));
    remove.dataset.action = "remove-part";
    row.append(nameField, rangeField, remove);
    list.appendChild(row);
  });
}

function clearMultiResults() {
  state.multiResults = [];
  if (state.currentRecord) state.currentRecord.multiResults = null;
  setMultiResultReady(null);
}

function addMultiPart() {
  let number = state.multiParts.length + 1;
  const existing = new Set(state.multiParts.map((part) => String(part.part_name || "").toLowerCase()));
  while (existing.has(("Part " + number).toLowerCase())) number += 1;
  state.multiParts.push({ part_name: "Part " + number, pages_range: "" });
  clearMultiResults();
  renderMultiParts();
  invalidatePreview();
}

function handleMultiPartsInput(event) {
  const input = event.target.closest("input[data-field]");
  if (!input) return;
  const row = input.closest(".multi-part-row");
  const index = Number(row?.dataset.index);
  if (!Number.isInteger(index) || !state.multiParts[index]) return;
  state.multiParts[index][input.dataset.field] = input.value;
  clearMultiResults();
  invalidatePreview();
}

async function handleMultiPartsChange(event) {
  const input = event.target.closest("input[data-field]");
  if (!input) return;
  try { await saveCurrentProject(); }
  catch (error) { console.warn("Could not save multiple-cut settings:", error); }
}

async function handleMultiPartsClick(event) {
  const button = event.target.closest('button[data-action="remove-part"]');
  if (!button) return;
  const row = button.closest(".multi-part-row");
  const index = Number(row?.dataset.index);
  if (!Number.isInteger(index) || !state.multiParts[index]) return;
  state.multiParts.splice(index, 1);
  clearMultiResults();
  renderMultiParts();
  invalidatePreview();
  await saveCurrentProject();
}

async function importMultiJsonText() {
  try {
    const parts = parseMultiCutsJson($("multi-json-text").value, state.pageCount || null);
    state.multiParts = parts.map((part) => ({
      part_name: part.part_name,
      pages_range: part.pages_range
    }));
    clearMultiResults();
    renderMultiParts();
    invalidatePreview();
    await saveCurrentProject();
    showToast(parts.length + " piece definition" + (parts.length === 1 ? "" : "s") + " imported.", "success");
  } catch (error) {
    showToast(error.message || "Could not import the JSON definitions.", "error");
  }
}

async function importMultiJsonFile(file) {
  if (!file) return;
  if (!/\.json$/i.test(file.name) && file.type !== "application/json" && file.type !== "text/json") {
    showToast("Choose a JSON file.", "error");
    return;
  }
  try {
    const text = await file.text();
    $("multi-json-text").value = text;
    await importMultiJsonText();
  } catch (error) {
    showToast(error.message || "Could not read this JSON file.", "error");
  }
}

async function copyMultiJsonFormat() {
  const format = '[\n  {\n    "part_name": "",\n    "pages_range": ""\n  }\n]';
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(format);
    } else {
      const helper = document.createElement("textarea");
      helper.value = format;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand("copy");
      helper.remove();
      if (!copied) throw new Error("Clipboard access is unavailable.");
    }
    showToast("JSON format copied. Add your piece names and page ranges.", "success");
  } catch (_) {
    showToast("Could not copy automatically. You can copy the JSON example from the text area.", "error");
  }
}

function renderMultiPreviewSelection(index) {
  if (!state.preview || state.preview.mode !== "multi-cut") return;
  const selected = Math.max(0, Math.min(Number(index) || 0, state.preview.parts.length - 1));
  state.preview.selectedPartIndex = selected;
  const part = state.preview.parts[selected];
  const select = $("multi-preview-select");
  select.value = String(selected);
  $("multi-preview-selector-wrap").hidden = false;
  $("preview-summary").textContent = part.part_name;
  $("preview-subsummary").textContent = part.pages.length + " pages selected from " +
    state.pageCount + " original pages · Overlap with other pieces is allowed";
  $("preview-status").textContent = "PART " + (selected + 1) + " OF " + state.preview.parts.length;
  renderPreviewGrid(part.entries);
}

function createPreviewEntries(pages, mode, position, pageCount = state.pageCount) {
  if (mode === "cut") {
    return pages.map((pageNumber) => ({
      type: "source",
      pageNumber,
      label: "Original page " + pageNumber
    }));
  }

  const selected = new Set(pages);
  const entries = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
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
  const firstBatchInput = state.batchMode ? state.batchInputs[0] : null;
  record.sourceBytes = firstBatchInput ? firstBatchInput.bytes.slice() : state.sourceBytes.slice();
  record.markerBytes = state.markerBytes ? state.markerBytes.slice() : null;
  record.fileName = firstBatchInput ? firstBatchInput.name : state.fileName;
  record.pageCount = state.batchMode ? (record.pageCount || state.pageCount) : state.pageCount;
  record.batchMode = state.batchMode;
  record.batchInputs = state.batchMode
    ? state.batchInputs.map((input) => ({ name: input.name, bytes: input.bytes.slice() }))
    : null;
  record.operation = state.mode;
  record.updatedAt = Date.now();
  record.markerFileName = state.markerFileName || "";
  record.pageSpec = state.mode === "cut" ? $("cut-pages").value
    : state.mode === "marker" ? $("marker-pages").value : "";
  record.compressionLevel = $("compress-level").value;
  record.multiParts = state.mode === "multi-cut"
    ? state.multiParts.map((part) => ({ part_name: part.part_name, pages_range: part.pages_range }))
    : null;
  record.multiResults = (state.mode === "multi-cut" || state.batchMode) && state.multiResults.length
    ? state.multiResults.map((result) => ({
      part_name: result.part_name,
      outputName: result.outputName,
      pageCount: result.pageCount,
      pages: result.pages.slice(),
      bytes: result.bytes.slice()
    }))
    : null;
  record.batchErrors = state.batchMode ? state.batchErrors.slice() : [];
  if (state.mode === "multi-cut" || state.batchMode) {
    record.outputBytes = null;
    record.outputName = null;
  }
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

async function rasterizePdfBytes(sourceBytes, onProgress = () => {}) {
  if (sourceBytes.byteLength > 256 * 1024 * 1024) {
    throw new Error("Compression supports PDFs up to 256 MB to protect browser memory.");
  }
  const sourceDoc = await loadPdfDocument(sourceBytes);
  const output = await PDFDocument.create();
  const pageCount = sourceDoc.numPages;
  const targetScale = 110 / 72;
  const maxDimension = 2200;
  const quality = 0.48;
  try {
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await sourceDoc.getPage(index);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(targetScale, maxDimension / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not create a canvas for page rasterization.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode a rasterized page.")), "image/jpeg", quality);
      });
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const embedded = await output.embedJpg(jpeg);
      const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(embedded, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
      onProgress({
        stage: "Rasterizing page " + index + " of " + pageCount + "…",
        percent: Math.round(90 * index / pageCount)
      });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    const rasterized = new Uint8Array(await output.save({ useObjectStreams: true }));
    const improved = rasterized.length < sourceBytes.length;
    return {
      bytes: improved ? rasterized : sourceBytes.slice(),
      originalSize: sourceBytes.length,
      outputSize: improved ? rasterized.length : sourceBytes.length,
      usedOriginal: !improved,
      imagesReencoded: 0,
      imagesSkipped: 0,
      imageCount: 0,
      level: "rasterize",
      note: improved
        ? "Pages were flattened to JPEG at up to 110 DPI. Text is no longer selectable; links, forms, annotations, layers, metadata, and accessibility structure are not preserved."
        : "The rasterized copy was not smaller, so the original PDF is kept unchanged."
    };
  } finally {
    await sourceDoc.destroy();
  }
}

async function makeCompressionPreview() {
  invalidatePreview();
  try {
    setBusy(true, "Compressing PDF…");
    $("compress-progress-panel").hidden = false;
    $("compress-progress").value = 0;
    $("compress-progress-label").textContent = "Preparing the local compression engine…";
    const level = $("compress-level").value;
    const onProgress = (progress) => {
      $("compress-progress").value = progress.percent;
      $("compress-progress-label").textContent = progress.stage;
    };
    const result = level === "rasterize"
      ? await rasterizePdfBytes(state.sourceBytes, onProgress)
      : await runCompressionWorker(state.sourceBytes, level, onProgress);
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
        : result.imagesReencoded + " of " + result.imageCount + " embedded image(s) recompressed; text and page objects were not rasterized.");
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

function renderBatchPreviewSelection(index) {
  return (async () => {
    if (!state.batchPreviews.length) return;
    const selected = Math.max(0, Math.min(Number(index) || 0, state.batchPreviews.length - 1));
    state.batchIndex = selected;
    const item = state.batchPreviews[selected];
    if (state.sourceDoc) {
      try { await state.sourceDoc.destroy(); } catch (_) {}
    }
    if (state.compressedPreviewDoc) {
      try { await state.compressedPreviewDoc.destroy(); } catch (_) {}
      state.compressedPreviewDoc = null;
    }
    state.sourceBytes = item.input.bytes;
    state.fileName = item.input.name;
    state.pageCount = item.pageCount;
    state.sourceDoc = await loadPdfDocument(state.sourceBytes);
    state.preview = item.preview;
    $("file-name").textContent = state.fileName;
    $("file-info").textContent = state.pageCount + " pages · batch input " + (selected + 1) + " of " + state.batchPreviews.length;
    $("batch-preview-select").value = String(selected);
    $("batch-preview-selector-wrap").hidden = state.batchPreviews.length < 2;

    if (state.mode === "compress") {
      if (!item.preview.usedOriginal) {
        state.compressedPreviewDoc = await loadPdfDocument(item.preview.compressedBytes);
      }
      $("multi-preview-selector-wrap").hidden = true;
      const savings = item.preview.originalSize - item.preview.outputSize;
      $("preview-summary").textContent = savings
        ? (100 * savings / item.preview.originalSize).toFixed(1) + "% smaller"
        : "Already optimized";
      $("preview-subsummary").textContent = item.input.name + " · " +
        formatBytes(item.preview.originalSize) + " → " + formatBytes(item.preview.outputSize);
      $("compress-stats").hidden = false;
      $("compress-stats").textContent = item.preview.note || "Embedded images optimized.";
      $("preview-status").textContent = "FILE " + (selected + 1) + " OF " + state.batchPreviews.length;
      renderPreviewGrid(item.preview.entries);
    } else if (state.mode === "multi-cut") {
      const select = $("multi-preview-select");
      select.replaceChildren();
      item.preview.parts.forEach((part, partIndex) => {
        const option = document.createElement("option");
        option.value = String(partIndex);
        option.textContent = "Part " + (partIndex + 1) + " — " + part.part_name + " (" + part.pages.length + " pages)";
        select.appendChild(option);
      });
      $("multi-preview-selector-wrap").hidden = false;
      renderMultiPreviewSelection(0);
      $("preview-subsummary").textContent = item.input.name + " · " + $("preview-subsummary").textContent;
    } else {
      $("multi-preview-selector-wrap").hidden = true;
      $("compress-stats").hidden = true;
      $("preview-summary").textContent = item.preview.entries.length + " output " +
        (item.preview.entries.length === 1 ? "page" : "pages");
      $("preview-subsummary").textContent = state.mode === "cut"
        ? item.preview.pages.length + " selected from " + item.pageCount + " original pages · " + item.input.name
        : item.preview.pages.length + " marker pages inserted · " + item.pageCount + " originals kept · " + item.input.name;
      $("preview-status").textContent = "FILE " + (selected + 1) + " OF " + state.batchPreviews.length;
      renderPreviewGrid(item.preview.entries);
    }
    $("create-btn").disabled = false;
  })();
}

async function makeBatchPreview() {
  if (!state.batchInputs.length) {
    showToast("There are no selected PDFs to process.", "error");
    return;
  }
  const previews = [];
  try {
    setBusy(true, "Preparing batch previews…");
    if (state.mode === "compress") $("compress-progress-panel").hidden = false;
    for (let index = 0; index < state.batchInputs.length; index += 1) {
      const input = state.batchInputs[index];
      $("preview-btn").textContent = "Checking " + (index + 1) + " of " + state.batchInputs.length + "…";
      const sourceDoc = await loadPdfDocument(input.bytes);
      const pageCount = sourceDoc.numPages;
      await sourceDoc.destroy();
      let preview;
      if (state.mode === "multi-cut") {
        const validated = validateMultiParts(state.multiParts, pageCount);
        preview = {
          mode: "multi-cut",
          parts: validated.map((part) => ({
            part_name: part.part_name,
            pages_range: part.pages_range,
            pages: part.pages,
            outputName: createMultiOutputName(input.name, part.part_name),
            entries: part.pages.map((pageNumber) => ({
              type: "source", pageNumber,
              label: part.part_name + " · Original page " + pageNumber
            }))
          }))
        };
      } else if (state.mode === "compress") {
        const level = $("compress-level").value;
        const onProgress = (progress) => {
          $("compress-progress").value = Math.round(((index + progress.percent / 100) / state.batchInputs.length) * 100);
          $("compress-progress-label").textContent = input.name + " · " + progress.stage;
        };
        const result = level === "rasterize"
          ? await rasterizePdfBytes(input.bytes, onProgress)
          : await runCompressionWorker(input.bytes, level, onProgress);
        preview = {
          mode: "compress", compressedBytes: result.bytes, usedOriginal: result.usedOriginal,
          originalSize: result.originalSize, outputSize: result.outputSize,
          imagesReencoded: result.imagesReencoded || 0, imageCount: result.imageCount || 0,
          note: result.note, quality: level,
          entries: Array.from({ length: pageCount }, (_, pageIndex) => ({
            type: "compressed", pageNumber: pageIndex + 1, label: "Output page " + (pageIndex + 1)
          }))
        };
      } else {
        const raw = state.mode === "cut" ? $("cut-pages").value : $("marker-pages").value;
        const pages = parsePageSpec(raw, pageCount);
        const position = $("marker-position").value;
        preview = {
          mode: state.mode, pages, position,
          entries: createPreviewEntries(pages, state.mode, position, pageCount),
          pageSpec: raw, hasCustomMarker: Boolean(state.markerBytes)
        };
      }
      previews.push({ input, pageCount, preview });
    }
    state.batchPreviews = previews;
    state.batchIndex = 0;
    const select = $("batch-preview-select");
    select.replaceChildren();
    previews.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = (index + 1) + ". " + item.input.name + " (" + item.pageCount + " pages)";
      select.appendChild(option);
    });
    $("preview-empty").hidden = true;
    $("preview-content").hidden = false;
    $("batch-preview-selector-wrap").hidden = previews.length < 2;
    await renderBatchPreviewSelection(0);
    await saveCurrentProject();
    showToast(previews.length + " PDFs are ready. Switch the preview dropdown to inspect each input before generating results.", "success");
  } catch (error) {
    state.batchPreviews = [];
    state.preview = null;
    $("create-btn").disabled = true;
    showToast(error.message || "Could not prepare all batch previews.", "error");
  } finally {
    $("compress-progress-panel").hidden = true;
    setBusy(false);
  }
}

async function makePreview() {
  if (state.batchMode) {
    await makeBatchPreview();
    return;
  }
  if (!state.sourceDoc || !state.sourceBytes) {
    showToast("Choose a source PDF first.", "error");
    return;
  }
  if (state.mode === "compress") {
    await makeCompressionPreview();
    return;
  }
  try {
    setBusy(true, state.mode === "multi-cut" ? "Checking pieces…" : "Preparing preview…");
    if (state.mode === "multi-cut") {
      const validated = validateMultiParts(state.multiParts, state.pageCount);
      const names = new Set();
      const parts = validated.map((part) => {
        const outputName = createMultiOutputName(state.fileName, part.part_name);
        const key = outputName.toLocaleLowerCase();
        if (names.has(key)) throw new Error("Two pieces would create the same file name. Rename one of them.");
        names.add(key);
        return {
          part_name: part.part_name,
          pages_range: part.pages_range,
          pages: part.pages,
          outputName,
          entries: part.pages.map((pageNumber) => ({
            type: "source",
            pageNumber,
            label: part.part_name + " · Original page " + pageNumber
          }))
        };
      });
      state.preview = { mode: "multi-cut", parts, selectedPartIndex: 0 };
      const select = $("multi-preview-select");
      select.replaceChildren();
      parts.forEach((part, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = "Part " + (index + 1) + " — " + part.part_name + " (" + part.pages.length + " pages)";
        select.appendChild(option);
      });
      $("preview-empty").hidden = true;
      $("preview-content").hidden = false;
      renderMultiPreviewSelection(0);
      $("create-btn").disabled = false;
      await saveCurrentProject();
      showToast(parts.length + " pieces validated. Preview each piece using the dropdown.", "success");
      return;
    }

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
    $("multi-preview-selector-wrap").hidden = true;
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

async function createMultipleCutOutputs(preview) {
  const sourceDocument = await PDFDocument.load(state.sourceBytes.slice());
  const results = [];
  for (let index = 0; index < preview.parts.length; index += 1) {
    const part = preview.parts[index];
    $("create-btn").textContent = "Creating part " + (index + 1) + " of " + preview.parts.length + "…";
    const output = await PDFDocument.create();
    const indexes = part.pages.map((pageNumber) => pageNumber - 1);
    const copiedPages = await output.copyPages(sourceDocument, indexes);
    copiedPages.forEach((page) => output.addPage(page));
    const bytes = new Uint8Array(await output.save());
    const check = await PDFDocument.load(bytes);
    if (check.getPageCount() !== part.pages.length) {
      throw new Error('Output validation failed for "' + part.part_name + '". No pieces were downloaded.');
    }
    results.push({
      part_name: part.part_name,
      outputName: part.outputName,
      pageCount: check.getPageCount(),
      pages: part.pages.slice(),
      bytes
    });
  }
  return results;
}

function showNextJobPanel(outputs) {
  const normalized = (outputs || []).filter((item) => item && item.bytes).map((item) => ({
    name: item.outputName || item.name || "output.pdf",
    bytes: item.bytes instanceof Uint8Array ? item.bytes.slice() : new Uint8Array(item.bytes),
    pageCount: item.pageCount || null
  }));
  state.nextJobSources = normalized;
  const panel = $("next-job-panel");
  panel.hidden = normalized.length === 0;
  $("next-job-setup").hidden = true;
  $("next-job-inputs-wrap").hidden = normalized.length < 2;
  $("next-job-yes").hidden = false;
  $("next-job-no").hidden = false;
}

function renderNextJobInputs() {
  const list = $("next-job-inputs");
  list.replaceChildren();
  state.nextJobSources.forEach((input, index) => {
    const label = document.createElement("label");
    label.className = "next-job-input-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = String(index);
    checkbox.dataset.inputIndex = String(index);
    const name = document.createElement("span");
    name.textContent = input.name + (input.pageCount ? " · " + input.pageCount + " pages" : "");
    label.append(checkbox, name);
    list.appendChild(label);
  });
}

async function startNextJob() {
  let selected = state.nextJobSources.slice();
  if (selected.length > 1) {
    const checked = Array.from($("next-job-inputs").querySelectorAll("input[type=checkbox]:checked"));
    selected = checked.map((checkbox) => state.nextJobSources[Number(checkbox.dataset.inputIndex)]).filter(Boolean);
  }
  if (!selected.length) {
    showToast("Select at least one PDF to continue.", "error");
    return;
  }
  const targetMode = $("next-job-tool").value;
  state.batchMode = selected.length > 1;
  state.batchInputs = state.batchMode
    ? selected.map((input) => ({ name: input.name, bytes: input.bytes.slice() }))
    : [];
  state.batchPreviews = [];
  state.batchErrors = [];
  state.batchIndex = 0;
  state.multiResults = [];
  state.nextJobSources = [];
  $("next-job-panel").hidden = true;
  $("next-job-setup").hidden = true;
  setMode(targetMode);
  const first = selected[0];
  const file = new File([first.bytes], first.name, { type: "application/pdf" });
  await handleSourceFile(file, { preserveBatch: true });
  if (targetMode === "multi-cut") {
    state.multiParts = [{ part_name: "Part 1", pages_range: "1-" + state.pageCount }];
    renderMultiParts();
  }
  if (state.batchMode && state.currentRecord) {
    state.currentRecord.batchMode = true;
    state.currentRecord.batchInputs = state.batchInputs.map((input) => ({ name: input.name, bytes: input.bytes.slice() }));
    await saveCurrentProject();
  }
  showToast(state.batchMode
    ? selected.length + " PDFs loaded into " + targetMode + ". The same settings will be applied to each file separately."
    : first.name + " loaded directly into " + targetMode + ".", "success");
}

function reserveBatchOutputName(candidate, usedNames) {
  const normalized = String(candidate || "output.pdf");
  const base = normalized.replace(/\.pdf$/i, "");
  let name = normalized;
  let suffix = 2;
  while (usedNames.has(name.toLocaleLowerCase())) {
    name = base + " (" + suffix + ").pdf";
    suffix += 1;
  }
  usedNames.add(name.toLocaleLowerCase());
  return name;
}

async function createBatchOutputs() {
  const results = [];
  const errors = [];
  const usedNames = new Set();
  const markerDocument = state.mode === "marker" && state.markerBytes
    ? await PDFDocument.load(state.markerBytes.slice())
    : null;
  for (let index = 0; index < state.batchPreviews.length; index += 1) {
    const item = state.batchPreviews[index];
    const input = item.input;
    const preview = item.preview;
    $("create-btn").textContent = "Processing file " + (index + 1) + " of " + state.batchPreviews.length + "…";
    try {
      if (state.mode === "compress") {
        results.push({
          part_name: input.name,
          outputName: reserveBatchOutputName(baseName(input.name) + "-compressed.pdf", usedNames),
          pageCount: item.pageCount,
          pages: [],
          bytes: preview.compressedBytes.slice()
        });
        continue;
      }
      const sourceDocument = await PDFDocument.load(input.bytes.slice());
      if (state.mode === "multi-cut") {
        for (const part of preview.parts) {
          const output = await PDFDocument.create();
          const indexes = part.pages.map((pageNumber) => pageNumber - 1);
          const copied = await output.copyPages(sourceDocument, indexes);
          copied.forEach((page) => output.addPage(page));
          const bytes = new Uint8Array(await output.save());
          const check = await PDFDocument.load(bytes);
          if (check.getPageCount() !== part.pages.length) throw new Error('Output validation failed for "' + part.outputName + '".');
          results.push({
            part_name: part.part_name, sourceName: input.name,
            outputName: reserveBatchOutputName(part.outputName, usedNames),
            pageCount: check.getPageCount(), pages: part.pages.slice(), bytes
          });
        }
        continue;
      }
      const output = await PDFDocument.create();
      let outputName;
      if (state.mode === "cut") {
        const indexes = preview.pages.map((pageNumber) => pageNumber - 1);
        const copied = await output.copyPages(sourceDocument, indexes);
        copied.forEach((page) => output.addPage(page));
        outputName = reserveBatchOutputName(baseName(input.name) + "-cut.pdf", usedNames);
      } else {
        const originalPages = await output.copyPages(sourceDocument, sourceDocument.getPageIndices());
        const selected = new Set(preview.pages);
        for (let pageIndex = 0; pageIndex < originalPages.length; pageIndex += 1) {
          const pageNumber = pageIndex + 1;
          if (selected.has(pageNumber) && preview.position === "before") {
            await createMarkerPage(output, markerDocument, sourceDocument, pageIndex);
          }
          output.addPage(originalPages[pageIndex]);
          if (selected.has(pageNumber) && preview.position === "after") {
            await createMarkerPage(output, markerDocument, sourceDocument, pageIndex);
          }
        }
        outputName = reserveBatchOutputName(baseName(input.name) + "-with-markers.pdf", usedNames);
      }
      const bytes = new Uint8Array(await output.save());
      const check = await PDFDocument.load(bytes);
      results.push({
        part_name: input.name, outputName, pageCount: check.getPageCount(),
        pages: preview.pages.slice(), bytes
      });
    } catch (error) {
      errors.push({ fileName: input.name, message: error?.message || "Processing failed." });
    }
  }
  if (!results.length) {
    throw new Error(errors.map((item) => item.fileName + ": " + item.message).join("\n") || "No batch outputs were generated.");
  }
  return { results, errors };
}

async function createOutput() {
  if (!state.preview || !state.sourceBytes) {
    showToast("Create a fresh preview before generating the PDF.", "error");
    return;
  }

  const preview = state.preview;
  try {
    setBusy(true, state.batchMode ? "Processing selected PDFs…" : preview.mode === "multi-cut" ? "Creating pieces…" : "Creating PDF…");
    if (state.batchMode) {
      const batch = await createBatchOutputs();
      state.multiResults = batch.results;
      state.batchErrors = batch.errors;
      if (!state.currentRecord) {
        state.currentRecord = {
          id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
          createdAt: Date.now()
        };
      }
      state.currentRecord.batchMode = true;
      state.currentRecord.batchInputs = state.batchInputs.map((input) => ({ name: input.name, bytes: input.bytes.slice() }));
      state.currentRecord.batchErrors = batch.errors;
      state.currentRecord.outputBytes = null;
      state.currentRecord.outputName = null;
      state.currentRecord.operation = state.mode;
      state.currentRecord.multiResults = batch.results;
      state.currentRecord.updatedAt = Date.now();
      setResultReady(null);
      setMultiResultReady(state.currentRecord);
      await saveCurrentProject();
      showNextJobPanel(batch.results);
      showToast(batch.errors.length
        ? batch.results.length + " results generated; " + batch.errors.length + " file(s) could not be processed."
        : batch.results.length + " results generated successfully.", batch.errors.length ? "info" : "success");
      return;
    }
    if (preview.mode === "multi-cut") {
      const results = await createMultipleCutOutputs(preview);
      state.multiResults = results;
      if (!state.currentRecord) {
        state.currentRecord = {
          id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
          createdAt: Date.now()
        };
      }
      state.currentRecord.outputBytes = null;
      state.currentRecord.outputName = null;
      state.currentRecord.operation = "multi-cut";
      state.currentRecord.multiParts = preview.parts.map((part) => ({
        part_name: part.part_name,
        pages_range: part.pages_range
      }));
      state.currentRecord.multiResults = results;
      state.currentRecord.outputPageCount = results.reduce((total, result) => total + result.pageCount, 0);
      state.currentRecord.updatedAt = Date.now();
      setResultReady(null);
      setMultiResultReady(state.currentRecord);
      await saveCurrentProject();
      showNextJobPanel(results);
      showToast(results.length + " PDF pieces generated. Download them individually or as one ZIP.", "success");
      return;
    }

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
    state.multiResults = [];
    if (!state.currentRecord) {
      state.currentRecord = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
        createdAt: Date.now()
      };
    }
    state.currentRecord.outputBytes = resultBytes;
    state.currentRecord.outputName = outputName;
    state.currentRecord.operation = preview.mode;
    state.currentRecord.multiResults = null;
    state.currentRecord.pageSpec = preview.pageSpec;
    state.currentRecord.markerPosition = preview.position;
    state.currentRecord.outputPageCount = outputPageCount;
    state.currentRecord.compressionLevel = preview.quality || null;
    state.currentRecord.updatedAt = Date.now();
    setResultReady(state.currentRecord);
    setMultiResultReady(null);
    await saveCurrentProject();
    downloadPdf(resultBytes, outputName);
    showNextJobPanel([{ name: outputName, outputName, bytes: resultBytes, pageCount: outputPageCount }]);
    showToast("Your PDF was created and downloaded.", "success");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not create this PDF. It may be encrypted or damaged.", "error");
  } finally {
    setBusy(false);
  }
}

async function loadPdfDocument(bytes) {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  return task.promise;
}

async function handleSourceFile(file, options = {}) {
  if (!file) return;
  const preserveBatch = options.preserveBatch === true;
  if (!preserveBatch) {
    state.batchMode = false;
    state.batchInputs = [];
    state.batchPreviews = [];
    state.batchErrors = [];
    state.batchIndex = 0;
    state.nextJobSources = [];
    $("next-job-panel").hidden = true;
    $("next-job-setup").hidden = true;
  }
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
    state.multiParts = [{ part_name: "Part 1", pages_range: "1-" + documentToLoad.numPages }];
    state.multiResults = [];
    state.batchPreviews = [];
    state.batchErrors = [];
    state.batchIndex = 0;
    renderMultiParts();
    setMultiResultReady(null);
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
      const operation = record.batchMode ? "PDF multitool batch"
        : record.operation === "marker" ? "PDF marker"
          : record.operation === "compress" ? "PDF compressor"
            : record.operation === "multi-cut" ? "PDF multiple cuts" : "PDF cutter";
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

      if (record.outputBytes || (Array.isArray(record.multiResults) && record.multiResults.length)) {
        const downloadButton = document.createElement("button");
        downloadButton.className = "history-download";
        downloadButton.type = "button";
        const hasParts = Array.isArray(record.multiResults) && record.multiResults.length > 0;
        downloadButton.textContent = hasParts ? "ZIP" : "↓";
        downloadButton.title = hasParts ? "Download all saved pieces as ZIP" : "Download saved result";
        downloadButton.setAttribute("aria-label", downloadButton.title);
        downloadButton.addEventListener("click", () => hasParts
          ? downloadMultiZip(record.multiResults, record.fileName, record.batchMode ? "Results" : "Split Parts")
          : downloadPdf(record.outputBytes, record.outputName || "pdf-cutter-output.pdf"));
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
    state.batchMode = Boolean(record.batchMode);
    state.batchInputs = Array.isArray(record.batchInputs)
      ? record.batchInputs.map((input) => ({ name: input.name, bytes: new Uint8Array(input.bytes) }))
      : [];
    state.batchPreviews = [];
    state.batchErrors = Array.isArray(record.batchErrors) ? record.batchErrors.slice() : [];
    state.batchIndex = 0;
    state.sourceBytes = new Uint8Array(record.sourceBytes);
    state.sourceDoc = await loadPdfDocument(state.sourceBytes);
    state.fileName = record.fileName || "saved-document.pdf";
    state.pageCount = state.sourceDoc.numPages;
    state.markerBytes = record.markerBytes ? new Uint8Array(record.markerBytes) : null;
    state.markerDoc = state.markerBytes ? await loadPdfDocument(state.markerBytes) : null;
    state.markerFileName = record.markerFileName || "";
    state.multiParts = Array.isArray(record.multiParts)
      ? record.multiParts.map((part) => ({ part_name: part.part_name, pages_range: part.pages_range }))
      : [{ part_name: "Part 1", pages_range: "1-" + state.pageCount }];
    state.multiResults = Array.isArray(record.multiResults)
      ? record.multiResults.map((result) => ({ ...result, bytes: new Uint8Array(result.bytes) }))
      : [];
    renderMultiParts();

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
    setMultiResultReady(record);
    if (Array.isArray(record.multiResults) && record.multiResults.length) {
      showNextJobPanel(record.multiResults);
    } else if (record.outputBytes) {
      showNextJobPanel([{ name: record.outputName, bytes: record.outputBytes, pageCount: record.outputPageCount }]);
    }
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
  state.multiParts = [{ part_name: "Part 1", pages_range: "" }];
  state.multiResults = [];
  state.batchMode = false;
  state.batchInputs = [];
  state.batchPreviews = [];
  state.batchErrors = [];
  state.batchIndex = 0;
  state.nextJobSources = [];
  $("next-job-panel").hidden = true;
  $("next-job-setup").hidden = true;
  $("batch-preview-selector-wrap").hidden = true;
  if (state.compressedPreviewDoc) state.compressedPreviewDoc.destroy().catch(() => {});
  state.compressedPreviewDoc = null;

  $("source-file").value = "";
  $("marker-file-input").value = "";
  $("file-meta").hidden = true;
  $("cut-pages").value = "1-3";
  $("marker-pages").value = "1";
  $("compress-level").value = "balanced";
  $("multi-json-text").value = "";
  renderMultiParts();
  $("multi-preview-selector-wrap").hidden = true;
  setMultiResultReady(null);
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
  $("mode-multi-cut").addEventListener("click", () => setMode("multi-cut"));
  $("copy-multi-json").addEventListener("click", copyMultiJsonFormat);
  $("choose-multi-json").addEventListener("click", () => $("multi-json-file").click());
  $("multi-json-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) importMultiJsonFile(file);
    event.target.value = "";
  });
  $("import-multi-json").addEventListener("click", importMultiJsonText);
  $("add-multi-part").addEventListener("click", async () => {
    addMultiPart();
    await saveCurrentProject();
  });
  $("multi-parts-list").addEventListener("input", handleMultiPartsInput);
  $("multi-parts-list").addEventListener("change", handleMultiPartsChange);
  $("multi-parts-list").addEventListener("click", handleMultiPartsClick);
  $("multi-preview-select").addEventListener("change", (event) => renderMultiPreviewSelection(event.target.value));
  $("batch-preview-select").addEventListener("change", (event) => renderBatchPreviewSelection(event.target.value));
  $("download-multi-zip").addEventListener("click", () => downloadMultiZip(state.multiResults, state.fileName, state.batchMode ? "Results" : "Split Parts"));
  $("next-job-yes").addEventListener("click", () => {
    renderNextJobInputs();
    $("next-job-inputs-wrap").hidden = state.nextJobSources.length < 2;
    $("next-job-setup").hidden = false;
  });
  $("next-job-no").addEventListener("click", () => {
    $("next-job-panel").hidden = true;
    state.nextJobSources = [];
  });
  $("next-job-start").addEventListener("click", startNextJob);

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
        state.currentRecord.multiResults = null;
      }
      state.multiResults = [];
      setResultReady(null);
      setMultiResultReady(null);
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
