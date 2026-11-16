import { createQpdfImageStreams } from "@lipoe/browser-qpdf";
import { canDecode, toImageBitmap } from "@lipoe/browser-qpdf/codecs";

export const COMPRESSION_LIMIT_BYTES = 256 * 1024 * 1024;
export const COMPRESSION_PRESETS = Object.freeze({
  lossless: { label: "Lossless", maxDimension: null, jpegQuality: null },
  balanced: { label: "Balanced", maxDimension: 1600, jpegQuality: 0.76 },
  maximum: { label: "Maximum", maxDimension: 1100, jpegQuality: 0.52 }
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

function supportedColorSpace(info) {
  const color = info.colorSpaceInfo;
  if (!color) return false;
  if (color.family === "DeviceRGB" || color.family === "DeviceGray") return true;
  if (color.family === "ICCBased") return color.components === 1 || color.components === 3;
  if (color.family === "Indexed") {
    return color.base?.family === "DeviceRGB" || color.base?.family === "DeviceGray";
  }
  return false;
}

function safeImageCandidate(info) {
  const masks = info.masks;
  // Preserve transparency dictionaries and their linked mask streams. We
  // recompress only the colour image, never a mask or a colour-key image.
  if (!masks || masks.isStencilMask || masks.mask || masks.softMaskInData != null ||
      masks.softMaskOf?.length || masks.maskOf?.length) return false;
  if (!supportedColorSpace(info)) return false;
  if (![1, 2, 4, 8, 16].includes(info.bitsPerComponent)) return false;
  if (!["jpeg", "samples"].includes(info.encoding?.kind)) return false;
  if (!canDecode(info).ok) return false;
  if (info.width < 128 || info.height < 128 || info.width * info.height < 40_000) return false;
  if (info.width * info.height > 40_000_000) return false;
  return Number.isFinite(info.streamLength) && info.streamLength >= 8_000;
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
    // Avoid quality loss when recompression would save only a negligible amount.
    if (blob.size >= info.streamLength * 0.97) return false;
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
  let imagesReencoded = 0;
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
        onProgress({ stage: "Finding compressible images…", percent: 12 });
        const images = assertSuccess(doc.getImages({ recursive: true }), "Could not inspect PDF images");
        imageCount = images.length;
        for (let i = 0; i < images.length; i += 1) {
          const info = images[i];
          if (safeImageCandidate(info)) {
            try {
              if (await reencodeImage(doc, info, preset)) imagesReencoded++;
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
    const optimized = output.slice();
    const improved = optimized.length < source.length;
    const result = improved ? optimized : source.slice();

    if (level === "lossless") {
      if (!improved) note = "No meaningful structural savings were found. The original PDF is kept unchanged.";
    } else if (!imagesReencoded) {
      const reason = !imageCount
        ? "No image objects were found to recompress; this PDF may be mostly text or vector artwork."
        : "None of the " + imageCount + " image object(s) matched the safe recompression rules. Common reasons include CCITT fax, JBIG2, JPEG2000, CMYK, masks, or unsupported image encodings.";
      note = reason + (improved
        ? " Only a structural rewrite reduced the file size. Try Extreme rasterization if editability is not required."
        : " The original PDF is kept unchanged. Try Extreme rasterization if editability is not required.");
    } else if (!improved) {
      note = imagesReencoded + " image(s) were recompressed, but the complete PDF did not become smaller. The original is kept unchanged.";
    } else {
      note = imagesReencoded + " of " + imageCount + " embedded image(s) recompressed; " + imagesSkipped + " left untouched. Text and vector content remain selectable.";
    }

    onProgress({ stage: "Compression complete", percent: 100 });
    return {
      bytes: result,
      originalSize: source.length,
      outputSize: result.length,
      imagesChanged: improved ? imagesReencoded : 0,
      imagesReencoded,
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
