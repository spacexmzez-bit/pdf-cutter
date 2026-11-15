import test from "node:test";
import assert from "node:assert/strict";
import {
  createMultiOutputName,
  parseMultiCutsJson,
  parseMultiPageRange,
  sanitizePartName,
  validateMultiParts
} from "../src/multi-cuts.js";

test("parses mixed single pages and ranges with flexible whitespace", () => {
  assert.deepEqual(parseMultiPageRange("1- 4, 76, 88 - 90", 100), [1, 2, 3, 4, 76, 88, 89, 90]);
});

test("removes duplicate pages within a piece while allowing overlap between pieces", () => {
  const parts = validateMultiParts([
    { part_name: "Cover", pages_range: "1, 1-2" },
    { part_name: "Chapter", pages_range: "1, 3-4" }
  ], 4);
  assert.deepEqual(parts[0].pages, [1, 2]);
  assert.deepEqual(parts[1].pages, [1, 3, 4]);
});

test("imports the agreed two-field JSON format", () => {
  const parts = parseMultiCutsJson(JSON.stringify([
    { part_name: "Introduction", pages_range: "1-4, 76, 88 - 100" },
    { part_name: "Chapter 1", pages_range: "1, 5-25" }
  ]), 100);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].pages.slice(-2), [99, 100]);
});

test("rejects invalid JSON, unknown keys, duplicate names, and out-of-range pages", () => {
  assert.throws(() => parseMultiCutsJson("{"), /JSON could not be read/);
  assert.throws(() => validateMultiParts([{ part_name: "A", pages_range: "1", extra: true }], 3), /exactly part_name and pages_range/);
  assert.throws(() => validateMultiParts([
    { part_name: "Same", pages_range: "1" },
    { part_name: "same", pages_range: "2" }
  ], 3), /duplicated/);
  assert.throws(() => parseMultiPageRange("1-5", 4), /outside this PDF/);
});

test("rejects unsafe, empty, and excessive piece names", () => {
  assert.equal(sanitizePartName("  Intro / Overview.pdf  "), "Intro - Overview");
  assert.throws(() => sanitizePartName("   "), /non-empty name/);
  assert.throws(() => sanitizePartName("x".repeat(81)), /80 characters/);
  assert.equal(createMultiOutputName("source.pdf", "Part 1"), "source - Part 1.pdf");
});

test("caps output pieces and rejects reversed or malformed ranges", () => {
  assert.throws(() => validateMultiParts(Array.from({ length: 51 }, (_, i) => ({
    part_name: "Part " + i, pages_range: "1"
  })), 1), /maximum of 50/);
  assert.throws(() => parseMultiPageRange("5-2", 10), /reversed/);
  assert.throws(() => parseMultiPageRange("1-abc", 10), /Invalid page entry/);
});
