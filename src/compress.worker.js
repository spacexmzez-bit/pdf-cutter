import wasmUrl from "@lipoe/browser-qpdf/qpdf-image-stream.wasm?url";
import { compressPdfBytes } from "./compress-engine.js";

self.onmessage = async (event) => {
  const { bytes, level } = event.data;
  try {
    const result = await compressPdfBytes(new Uint8Array(bytes), level,
      (progress) => self.postMessage({ type: "progress", ...progress }), wasmUrl);
    self.postMessage({ type: "done", ...result, bytes: result.bytes.buffer }, [result.bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || "Compression failed." });
  }
};
