import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { unzipSync } from "fflate";
import { readFile } from "node:fs/promises";

async function createSourcePdf(pageCount = 6) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pageCount; index += 1) {
    const page = pdf.addPage([595, 842]);
    page.drawText("Original page " + index, { x: 50, y: 780, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

test("multiple cuts supports overlaps, one-piece preview, individual downloads, and ZIP", async ({ page }) => {
  const source = await createSourcePdf(6);
  await page.goto("/");
  await page.locator("#mode-multi-cut").click();
  await page.locator("#source-file").setInputFiles({
    name: "source.pdf", mimeType: "application/pdf", buffer: source
  });
  await expect(page.locator("#file-info")).toContainText("6 pages");
  const definitions = [
    { part_name: "Cover and intro", pages_range: "1-2, 4" },
    { part_name: "Chapter 1", pages_range: "1, 3-4" },
    { part_name: "Chapter 2", pages_range: "1, 5-6" }
  ];
  await page.locator("#multi-json-text").fill(JSON.stringify(definitions, null, 2));
  await page.locator("#import-multi-json").click();
  await expect(page.locator("#multi-parts-list .multi-part-row")).toHaveCount(3);
  await page.locator("#preview-btn").click();
  await expect(page.locator("#preview-status")).toHaveText("PART 1 OF 3");
  await expect(page.locator("#multi-preview-select option")).toHaveCount(3);
  await expect(page.locator("#preview-grid .page-card")).toHaveCount(3);
  await page.locator("#multi-preview-select").selectOption("1");
  await expect(page.locator("#preview-status")).toHaveText("PART 2 OF 3");
  await expect(page.locator("#preview-grid .page-card")).toHaveCount(3);
  await page.locator("#multi-preview-select").selectOption("2");
  await expect(page.locator("#preview-grid .page-card")).toHaveCount(3);

  await page.locator("#create-btn").click();
  await expect(page.locator("#multi-result-ready")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#multi-result-summary")).toHaveText("3 pieces generated");
  await expect(page.locator("#multi-results-list .multi-result-item")).toHaveCount(3);

  const firstRow = page.locator("#multi-results-list .multi-result-item").nth(0);
  const [individualDownload] = await Promise.all([
    page.waitForEvent("download"),
    firstRow.locator("button").click()
  ]);
  expect(individualDownload.suggestedFilename()).toBe("source - Cover and intro.pdf");
  const individualBytes = await readFile(await individualDownload.path());
  expect((await PDFDocument.load(individualBytes)).getPageCount()).toBe(3);

  const [zipDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#download-multi-zip").click()
  ]);
  expect(zipDownload.suggestedFilename()).toBe("source - Split Parts.zip");
  const zipBytes = new Uint8Array(await readFile(await zipDownload.path()));
  const files = unzipSync(zipBytes);
  expect(Object.keys(files).sort()).toEqual([
    "source - Chapter 1.pdf",
    "source - Chapter 2.pdf",
    "source - Cover and intro.pdf"
  ]);
  expect((await PDFDocument.load(files["source - Cover and intro.pdf"])).getPageCount()).toBe(3);
  expect((await PDFDocument.load(files["source - Chapter 1.pdf"])).getPageCount()).toBe(3);
  expect((await PDFDocument.load(files["source - Chapter 2.pdf"])).getPageCount()).toBe(3);

  await page.reload();
  await expect(page.locator("#history-list .history-item")).toHaveCount(1);
  await page.locator("#history-list .history-open").click();
  await expect(page.locator("#multi-result-ready")).toBeVisible();
  await expect(page.locator("#multi-results-list .multi-result-item")).toHaveCount(3);
});

test("JSON file import and Copy JSON format are available", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator("#mode-multi-cut").click();
  const json = JSON.stringify([
    { part_name: "Opening", pages_range: "1-4, 76" },
    { part_name: "Ending", pages_range: "88-100" }
  ]);
  await page.locator("#multi-json-file").setInputFiles({
    name: "pieces.json", mimeType: "application/json", buffer: Buffer.from(json)
  });
  await expect(page.locator("#multi-parts-list .multi-part-row")).toHaveCount(2);
  await page.locator("#copy-multi-json").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe('[\n  {\n    "part_name": "",\n    "pages_range": ""\n  }\n]');
});
