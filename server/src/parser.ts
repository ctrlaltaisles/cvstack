import type { ParsedResume, ResumeData } from './types';
import { defaultResumeData } from './defaults';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SECTION_HEADERS = [
  'SUMMARY',
  'PROFILE',
  'EXPERIENCE',
  'WORK EXPERIENCE',
  'EDUCATION',
  'SKILLS',
  'PROJECTS',
  'CERTIFICATIONS',
  'CONTACT',
  'ACHIEVEMENTS',
  'PUBLICATIONS',
];

type ExtractResult = { text: string; method: 'pdf-parse' | 'pdfjs-dist' | 'pdfkit' | 'none' };
const execFileAsync = promisify(execFile);

function normalizeLines(text: string): string[] {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function extractWithPdfParse(buffer: Buffer): Promise<string> {
  const parserModule = await new Function('m', 'return import(m)')('pdf-parse');
  const parsePdf = (
    parserModule as {
      default?: (data: Buffer) => Promise<{ text?: string }>;
      // Some builds expose the function as the module itself.
      [key: string]: unknown;
    }
  ).default ?? (typeof parserModule === 'function' ? parserModule : undefined) as ((data: Buffer) => Promise<{ text?: string }>) | undefined;
  if (!parsePdf) {
    throw new Error('pdf-parse export not found');
  }
  const result = await parsePdf(buffer);
  return String(result?.text ?? '').trim();
}

async function extractWithPdfJs(buffer: Buffer): Promise<string> {
  const pdfjsModule = await new Function('m', 'return import(m)')('pdfjs-dist/legacy/build/pdf.mjs');
  const getDocument = (pdfjsModule as { getDocument?: (input: unknown) => { promise: Promise<unknown> } }).getDocument;
  if (!getDocument) {
    throw new Error('pdfjs-dist getDocument not found');
  }

  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise as {
    numPages: number;
    getPage: (pageNum: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
  };

  const chunks: string[] = [];
  const maxPages = Math.min(doc.numPages, 5);

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) chunks.push(pageText);
  }

  return chunks.join('\n').trim();
}

async function extractWithPdfKit(buffer: Buffer): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvstack-pdf-'));
  const pdfPath = path.join(tempDir, 'input.pdf');
  fs.writeFileSync(pdfPath, buffer);

  const swiftScript = `
import Foundation
import PDFKit

let inputPath = CommandLine.arguments[1]
guard let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
  fputs("open-fail\\n", stderr)
  exit(1)
}

var output = ""
for idx in 0..<doc.pageCount {
  if let text = doc.page(at: idx)?.string {
    output += text + "\\n"
  }
}
print(output)
`;

  try {
    const { stdout } = await execFileAsync('swift', ['-e', swiftScript, pdfPath], {
      env: {
        ...process.env,
        SWIFT_MODULECACHE_PATH: process.env.SWIFT_MODULECACHE_PATH ?? path.join(os.tmpdir(), 'swift-cache'),
        CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH ?? path.join(os.tmpdir(), 'clang-cache'),
      },
      timeout: 20000,
      maxBuffer: 6 * 1024 * 1024,
    });
    return String(stdout ?? '').trim();
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  }
}

export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<ExtractResult> {
  try {
    const text = await extractWithPdfParse(buffer);
    return { text, method: 'pdf-parse' };
  } catch {
    // fallback to pdfjs-dist if installed
  }

  try {
    const text = await extractWithPdfJs(buffer);
    return { text, method: 'pdfjs-dist' };
  } catch {
    // fallback to native PDFKit on macOS when JS extractors are unavailable
  }

  try {
    const text = await extractWithPdfKit(buffer);
    return { text, method: 'pdfkit' };
  } catch {
    return { text: '', method: 'none' };
  }
}

export function isExtractionFailure(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  const head = trimmed.slice(0, 800).toLowerCase();
  // Detect raw PDF syntax patterns instead of broad substrings like "obj"
  // so normal words such as "objective" are not treated as failures.
  const hasRawPdfMarkers =
    /%pdf-\d\.\d/.test(head) ||
    /(^|\s)xref(\s|$)/.test(head) ||
    /\b\d+\s+\d+\s+obj\b/.test(head) ||
    /(^|\s)endobj(\s|$)/.test(head);

  if (hasRawPdfMarkers) {
    return true;
  }

  return false;
}

function detectSectionHeading(line: string): string | null {
  const normalized = line.replace(/[:\-]$/, '').toUpperCase().trim();
  if (SECTION_HEADERS.includes(normalized)) return normalized;

  if (/^[A-Z][A-Z\s]{2,30}$/.test(line.trim()) && SECTION_HEADERS.some((h) => normalized.includes(h))) {
    return normalized;
  }

  return null;
}

function findBestName(lines: string[]): string {
  const firstCandidates = lines.slice(0, 12);
  for (const line of firstCandidates) {
    if (line.includes('@')) continue;
    if (/\d/.test(line)) continue;
    if (/^(resume|curriculum vitae|cv)$/i.test(line.trim())) continue;
    if (/^[A-Za-z][A-Za-z\s.'-]{2,60}$/.test(line.trim())) {
      return line.trim();
    }
  }
  return '';
}

function findEmail(text: string): string {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? '';
}

function findPhone(text: string): string {
  const phoneRegex = /(?:\+?\d{1,2}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;
  return text.match(phoneRegex)?.[0] ?? '';
}

export function parseResumeText(text: string): ParsedResume {
  const lines = normalizeLines(text);
  const joined = lines.join(' ');

  const email = findEmail(joined);
  const phone = findPhone(joined);
  const name = findBestName(lines);

  const sections: ParsedResume['sections'] = [];
  let current: ParsedResume['sections'][number] = { heading: 'GENERAL', lines: [] };

  for (const line of lines) {
    const heading = detectSectionHeading(line);
    if (heading) {
      if (current.lines.length > 0) sections.push(current);
      current = { heading, lines: [] };
      continue;
    }
    current.lines.push(line);
  }

  if (current.lines.length > 0) sections.push(current);

  const bulletPoints = lines
    .filter((line) => /^([\-\u2022\*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([\-\u2022\*]|\d+\.)\s+/, '').trim());

  return { name, email, phone, sections, bulletPoints };
}

export function toResumeData(parsed: ParsedResume): ResumeData {
  const resume = defaultResumeData(parsed.email);
  resume.name = parsed.name || resume.name;
  resume.contact.phone = parsed.phone || '';

  const summary = parsed.sections.find((s) => s.heading.includes('SUMMARY') || s.heading.includes('PROFILE'));
  if (summary) resume.bio = summary.lines.join(' ').slice(0, 600);

  const skillsSection = parsed.sections.find((s) => s.heading.includes('SKILLS'));
  if (skillsSection) {
    const joined = skillsSection.lines.join(', ');
    resume.skills = joined
      .split(/,|\||\//)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  const expSection = parsed.sections.find((s) => s.heading.includes('EXPERIENCE'));
  if (expSection && parsed.bulletPoints.length > 0) {
    resume.workExperience = [{
      id: `exp-${Date.now()}`,
      company: 'Imported Company',
      role: expSection.lines[0] ?? 'Imported Role',
      startDate: { month: 1, year: 2020, present: false },
      endDate: { month: 1, year: 2026, present: true },
      bullets: parsed.bulletPoints.slice(0, 6),
    }];
  }

  return resume;
}
