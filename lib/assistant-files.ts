import "server-only";
import { Buffer } from "node:buffer";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

export const MAX_ASSISTANT_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_ASSISTANT_FILE_TEXT_LENGTH = 80_000;
const MAX_OFFICE_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_ARCHIVE_ENTRIES = 300;

export type AssistantFileContent = {
  name: string;
  mimeType: string;
  size: number;
  text?: string;
  base64?: string;
};

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function validateFileSignature(extension: string, bytes: Buffer): void {
  if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("That file does not appear to be a valid PDF.");
  }
  if (extension === ".png" &&
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("That file does not appear to be a valid PNG image.");
  }
  if ((extension === ".jpg" || extension === ".jpeg") &&
      !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error("That file does not appear to be a valid JPEG image.");
  }
  if ((extension === ".docx" || extension === ".xlsx") &&
      !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new Error("That file does not appear to be a valid Office document.");
  }
}

function validateOfficeArchive(bytes: Buffer): void {
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let endRecord = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0 || endRecord + 22 > bytes.length) {
    throw new Error("That Office document has an invalid archive structure.");
  }
  const entryCount = bytes.readUInt16LE(endRecord + 10);
  const directorySize = bytes.readUInt32LE(endRecord + 12);
  const directoryOffset = bytes.readUInt32LE(endRecord + 16);
  if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES ||
      directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
      directoryOffset + directorySize > endRecord) {
    throw new Error("That Office document is too complex or uses an unsupported archive format.");
  }

  let position = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > endRecord || bytes.readUInt32LE(position) !== 0x02014b50) {
      throw new Error("That Office document has an invalid archive directory.");
    }
    const flags = bytes.readUInt16LE(position + 8);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const uncompressedSize = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        uncompressedSize > 8 * 1024 * 1024 || position + entryLength > endRecord) {
      throw new Error("That Office document contains an unsupported or oversized entry.");
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_OFFICE_EXPANDED_BYTES) {
      throw new Error("The expanded Office document exceeds the 20 MB safety limit.");
    }
    position += entryLength;
  }
  if (position !== directoryOffset + directorySize) {
    throw new Error("That Office document has an invalid archive directory.");
  }
}

function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This text file must use UTF-8 encoding.");
  }
}

async function extractSpreadsheetText(bytes: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // Guard against pathologically crafted XLSX files that have valid archive
  // structure but extremely complex cell references, which could hang indefinitely.
  // Race the load against a 10-second timeout to keep the serverless function safe.
  await Promise.race([
    workbook.xlsx.load(bytes),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The spreadsheet took too long to process. Try a smaller file.")), 10_000),
    ),
  ]);
  const output: string[] = [];
  for (const sheet of workbook.worksheets.slice(0, 8)) {
    output.push(`Sheet: ${sheet.name}`);
    const lastRow = Math.min(sheet.rowCount, 250);
    const lastColumn = Math.min(sheet.columnCount, 30);
    for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
      const cells = sheet.getRow(rowNumber);
      const values = Array.from({ length: lastColumn }, (_, column) =>
        cells.getCell(column + 1).text.replace(/\s+/g, " ").trim(),
      );
      while (values.length && !values.at(-1)) values.pop();
      if (values.some(Boolean)) output.push(values.join("\t"));
    }
    if (sheet.rowCount > lastRow) output.push(`[Additional rows omitted after ${lastRow}.]`);
  }
  if (workbook.worksheets.length > 8) output.push("[Additional sheets omitted after 8.]");
  return output.join("\n");
}

export async function extractAssistantFile(
  file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<AssistantFileContent> {
  if (!file.name || file.name.length > 180) throw new Error("Choose a file with a shorter name.");
  if (file.size <= 0 || file.size > MAX_ASSISTANT_FILE_BYTES) {
    throw new Error("Choose a file between 1 byte and 3 MB.");
  }
  const extension = fileExtension(file.name);
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error("Supported files are PDF, DOCX, TXT, Markdown, PNG/JPEG images, CSV, and XLSX.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error("The uploaded file could not be read completely.");
  validateFileSignature(extension, bytes);
  if (extension === ".docx" || extension === ".xlsx") validateOfficeArchive(bytes);

  let text: string | undefined;
  let base64: string | undefined;
  if (extension === ".txt" || extension === ".md" || extension === ".csv") {
    text = decodeText(bytes);
  } else if (extension === ".docx") {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else if (extension === ".xlsx") {
    text = await extractSpreadsheetText(bytes);
  } else {
    base64 = bytes.toString("base64");
  }

  if (text !== undefined) {
    text = text.slice(0, MAX_ASSISTANT_FILE_TEXT_LENGTH);
    if (!text.trim()) throw new Error("No readable text was found in that file.");
  }
  const safeName = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  return { name: safeName, mimeType, size: bytes.byteLength, ...(text !== undefined ? { text } : {}), ...(base64 ? { base64 } : {}) };
}
