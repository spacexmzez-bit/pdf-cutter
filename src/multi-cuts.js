const MAX_PARTS = 50;
const MAX_PART_NAME_LENGTH = 80;
const MAX_RANGE_LENGTH = 2000;

export function parseMultiPageRange(value, pageCount = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Enter at least one page number or range.");
  }
  if (value.length > MAX_RANGE_LENGTH) {
    throw new Error("A page range is too long. Keep it under 2,000 characters.");
  }
  const parts = value.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
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
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error("Page numbers must be valid whole numbers.");
    }
    if (start < 1 || end < 1) throw new Error("Page numbers must start at 1.");
    if (end < start) throw new Error("Range " + part + " is reversed. Put the smaller page first.");
    if (Number.isInteger(pageCount) && pageCount > 0 && end > pageCount) {
      throw new Error("Page " + end + " is outside this PDF. It has " + pageCount + " pages.");
    }
    if (end - start > 100000) {
      throw new Error("A single range cannot contain more than 100,001 pages.");
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

export function sanitizePartName(value) {
  if (typeof value !== "string") throw new Error("Every piece needs a name.");
  const name = value.trim()
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name) throw new Error("Every piece needs a non-empty name.");
  if (name.length > MAX_PART_NAME_LENGTH) {
    throw new Error("Piece names must be 80 characters or fewer.");
  }
  return name;
}

export function validateMultiParts(input, pageCount = null) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("Add at least one output piece.");
  }
  if (input.length > MAX_PARTS) {
    throw new Error("A maximum of " + MAX_PARTS + " output pieces is supported at once.");
  }

  const seenNames = new Set();
  return input.map((part, index) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("Piece " + (index + 1) + " must be an object.");
    }
    const keys = Object.keys(part).sort();
    if (keys.length !== 2 || keys[0] !== "pages_range" || keys[1] !== "part_name") {
      throw new Error("Piece " + (index + 1) + " must contain exactly part_name and pages_range.");
    }
    const partName = sanitizePartName(part.part_name);
    const key = partName.toLocaleLowerCase();
    if (seenNames.has(key)) {
      throw new Error('Piece name "' + partName + '" is duplicated. Use a unique name for each output.');
    }
    seenNames.add(key);
    if (typeof part.pages_range !== "string") {
      throw new Error('The pages_range for "' + partName + '" must be text.');
    }
    const pages = parseMultiPageRange(part.pages_range, pageCount);
    return {
      part_name: partName,
      pages_range: part.pages_range.trim(),
      pages
    };
  });
}

export function parseMultiCutsJson(text, pageCount = null) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("The JSON could not be read: " + error.message);
  }
  return validateMultiParts(parsed, pageCount);
}

export function createMultiOutputName(sourceName, partName) {
  const sourceBase = String(sourceName || "document").replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim() || "document";
  return sourceBase + " - " + sanitizePartName(partName) + ".pdf";
}
