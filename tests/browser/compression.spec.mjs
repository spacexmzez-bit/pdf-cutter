import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";

async function imageHeavyPdf() {
  const width = 1280, height = 960;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const noise = ((x * 71 + y * 97) ^ (x * y * 3)) & 255;
      png.data[i] = noise;
      png.data[i + 1] = (noise * 3 + x) & 255;
      png.data[i + 2] = (noise * 5 + y) & 255;
      png.data[i + 3] = 255;
    }
  }
  const pngBytes = PNG.sync.write(png, { colorType: 2 });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([640, 480]);
  const embedded = await pdf.embedPng(pngBytes);
  page.drawImage(embedded, { x: 0, y: 0, width: 640, height: 480 });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("This remains selectable PDF text.", { x: 18, y: 20, size: 12, font });
  return Buffer.from(await pdf.save());
}

test("balanced compression reduces a scanned-style PDF without flattening pages", async ({ page }) => {
  const source = await imageHeavyPdf();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.locator("#mode-compress").click();
  await page.locator("#source-file").setInputFiles({
    name: "scanned-sample.pdf", mimeType: "application/pdf", buffer: source
  });
  await expect(page.locator("#file-info")).toContainText("1 pages", { timeout: 30_000 });
  await page.locator("#compress-level").selectOption("balanced");
  await page.locator("#preview-btn").click();
  await expect(page.locator("#preview-status")).toHaveText("COMPRESSION READY", { timeout: 120_000 });
  await expect(page.locator("#preview-summary")).toContainText("% smaller");
  await expect(page.locator("#compress-stats")).toContainText("embedded image");
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.locator("#create-btn").click()
  ]);
  const bytes = await readFile(await download.path());
  expect(bytes.length).toBeLessThan(source.length);
  const output = await PDFDocument.load(bytes);
  expect(output.getPageCount()).toBe(1);
  expect(pageErrors).toEqual([]);
});

test("lossless compression preserves pages and can download unchanged originals", async ({ page }) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]);
  const source = Buffer.from(await pdf.save());
  await page.goto("/");
  await page.locator("#mode-compress").click();
  await page.locator("#source-file").setInputFiles({
    name: "two-pages.pdf", mimeType: "application/pdf", buffer: source
  });
  await expect(page.locator("#file-info")).toContainText("2 pages");
  await page.locator("#compress-level").selectOption("lossless");
  await page.locator("#preview-btn").click();
  await expect(page.locator("#preview-status")).toHaveText("COMPRESSION READY", { timeout: 120_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.locator("#create-btn").click()
  ]);
  const bytes = await readFile(await download.path());
  expect(bytes.length).toBeLessThanOrEqual(source.length);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
});
