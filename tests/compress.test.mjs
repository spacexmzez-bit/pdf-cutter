import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { compressPdfBytes, COMPRESSION_LIMIT_BYTES } from "../src/compress-engine.js";

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText("Selectable text stays in the PDF.", { x: 45, y: 790, size: 17, font });
  return new Uint8Array(await pdf.save());
}

test("lossless qpdf compression preserves pages and never grows output", async () => {
  const input = await samplePdf();
  const result = await compressPdfBytes(input, "lossless");
  assert.equal(result.originalSize, input.length);
  assert.ok(result.bytes.length <= input.length);
  const output = await PDFDocument.load(result.bytes);
  assert.equal(output.getPageCount(), 1);
  assert.equal(result.imagesChanged, 0);
});

test("balanced mode preserves PDF when browser image APIs are absent", async () => {
  const input = await samplePdf();
  const result = await compressPdfBytes(input, "balanced");
  assert.ok(result.bytes.length <= input.length);
  const output = await PDFDocument.load(result.bytes);
  assert.equal(output.getPageCount(), 1);
});

test("invalid presets and oversized inputs fail safely", async () => {
  const input = await samplePdf();
  await assert.rejects(compressPdfBytes(input, "unsafe"), /Unknown compression preset/);
  await assert.rejects(compressPdfBytes(new Uint8Array(COMPRESSION_LIMIT_BYTES + 1), "lossless"), /256 MB/);
});
