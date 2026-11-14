import { createQpdfImageStreams } from "@lipoe/browser-qpdf";
import { canDecode, toImageBitmap } from "@lipoe/browser-qpdf/codecs";

export const COMPRESSION_LIMIT_BYTES = 256 * 1024 * 1024;
export const COMPRESSION_PRESETS = Object.freeze({
  lossless: { label: "Lossless", maxDimension: null, jpegQuality: null },
  balanced: { label: "Balanced", maxDimension: 1800, jpegQuality: 0.82 },
  maximum: { label: "Maximum", maxDimension: 1200, jpegQuality: 0.62 }
});

function assertSuccess(result, context) {
  if (!result.ok) throw new Error(context + ": " + (result.error || result.code));
  return result.value;
}

function hasNondefaultDecode(info) {
  if (!info.decode) return false;
  const count = info.colorSpaceInfo?.family === "DeviceGray" ? 1 : 3;
  if (info.decode.length !== count * 2) return true;
  return info.decode.some((value, i) => value !== (i % 2));
}

function safeImageCandidate(info) {
  const masks = info.masks;
  // Never flatten alpha, stencil masks, ICC profiles, spot colors, CMYK,
  // JPEG2000/JBIG2, or images with nonstandard decode transformations.
  if (!masks || masks.isStencilMask || masks.softMask || masks.mask ||
      masks.softMaskInData != null || masks.softMaskOf?.length || masks.maskOf?.length) return false;
  if (!["DeviceRGB", "DeviceGray"].includes(info.colorSpaceInfo?.family)) return false;
  if (info.bitsPerComponent !== 8 || hasNondefaultDecode(info)) return false;
  if (!["jpeg", "samples"].includes(info.encoding?.kind)) return false;
  if (!canDecode(info).ok) return false;
  if (info.width < 320 || info.height < 320 || info.width * info.height < 250_000) return false;
  if (info.width * info.height > 35_000_000) return false;
  return Number.isFinite(info.streamLength) && info.streamLength >= 24_000;
}

async function reencodeImage(doc, info, preset) {
  const read = doc.readImage(info.objId, info.generation);
  if (!read.ok) return false;

  const maxSide = Math.max(info.width, info.height);
  const scale = Math.min(1, preset.maxDimension / maxSide);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));

  const bitmapResult = await toImageBitmap(read.value, info,
    scale < 1 ? { resizeWidth: width, resizeHeight: height, resizeQuality: "high" } : {});
  if (!bitmapResult.ok) return false;

  const bitmap = bitmapResult.value;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return false;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: preset.jpegQuality });
    if (blob.type !== "image/jpeg") return false;
    // Only replace an individual image if the encoding itself is clearly smaller.
    if (blob.size >= info.streamLength * 0.94) return false;
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const replaced = doc.replaceImageStream(info.objId, info.generation, jpeg, {
      width: canvas.width,
      height: canvas.height,
      bitsPerComponent: 8,
      colorSpace: "DeviceRGB",
      filter: "DCTDecode"
    });
    return replaced.ok;
  } finally {
    bitmap.close();
  }
}

/**
 * Lossless: qpdf structural rewrite with unchanged image pixels.
 * Balanced/Maximum: additionally recompress only safe image XObjects.
 * All PDF text, page contents, annotations and links remain PDF objects;
 * no full-page rasterization. This does not guarantee preservation of
 * digital signatures, which rewriting a PDF can invalidate.
 */
export async function compressPdfBytes(source, level, onProgress = () => {}, wasmUrl) {
  if (!(source instanceof Uint8Array) || source.length < 5)
    throw new Error("Choose a valid PDF.");
  if (source.byteLength > COMPRESSION_LIMIT_BYTES)
    throw new Error("Compression supports PDFs up to 256 MB to protect browser memory.");
  const preset = COMPRESSION_PRESETS[level];
  if (!preset) throw new Error("Unknown compression preset.");

  onProgress({ stage: "Loading local PDF engine…", percent: 4 });
  const options = wasmUrl ? { locateFile: (name) => name.endsWith(".wasm") ? wasmUrl : name } : undefined;
  const qpdf = await createQpdfImageStreams(options);
  let doc;
  let imagesChanged = 0;
  let imagesSkipped = 0;
  let imageCount = 0;
  let note = "";

  try {
    doc = assertSuccess(qpdf.loadPdf(source), "Could not open PDF");
    const pages = assertSuccess(doc.getPageCount(), "Could not read PDF pages");
    if (pages < 1) throw new Error("The PDF contains no pages.");

    if (level !== "lossless") {
      if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
        note = "This browser does not support image recompression in a worker. Structural optimization was used instead.";
      } else {
        onProgress({ stage: "Finding safe-to-compress images…", percent: 12 });
        const images = assertSuccess(doc.getImages({ recursive: true }), "Could not inspect PDF images");
        imageCount = images.length;
        for (let i = 0; i < images.length; i += 1) {
          const info = images[i];
          if (safeImageCandidate(info)) {
            try {
              if (await reencodeImage(doc, info, preset)) imagesChanged++;
              else imagesSkipped++;
            } catch {
              // A malformed or unsupported image is left untouched, not removed.
              imagesSkipped++;
            }
          } else {
            imagesSkipped++;
          }
          if (i % 2 === 0 || i === images.length - 1) {
            onProgress({
              stage: "Optimizing image " + (i + 1) + " of " + images.length + "…",
              percent: 14 + Math.round(70 * (i + 1) / Math.max(1, images.length))
            });
          }
        }
      }
    }
    onProgress({ stage: "Writing and checking the PDF…", percent: 91 });
    const output = assertSuccess(doc.writePdf(), "Could not write optimized PDF");
    // Copy out of WASM memory before closing the document.
    const optimized = output.slice();
    const improved = optimized.length < source.length;
    const result = improved ? optimized : source.slice();
    if (!improved) {
      note = note || "No smaller safe result was found; your original PDF is kept unchanged.";
    }
    onProgress({ stage: "Compression complete", percent: 100 });
    return {
      bytes: result,
      originalSize: source.length,
      outputSize: result.length,
      imagesChanged: improved ? imagesChanged : 0,
      imagesSkipped,
      imageCount,
      usedOriginal: !improved,
      level,
      note
    };
  } finally {
    doc?.close();
  }
}
