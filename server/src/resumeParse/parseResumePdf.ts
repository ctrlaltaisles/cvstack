import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultResumeData } from '../defaults';
import type { ResumeData } from '../types';
import { extractTextFromPdfBuffer, isExtractionFailure } from '../parser';

const execFileAsync = promisify(execFile);

export type ExtractedLine = {
  text: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize?: number;
};

export type SectionType = 'contact' | 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'other';

export type DetectedSection = {
  type: SectionType;
  startIdx: number;
  endIdx: number;
};

export type Block = {
  section: SectionType;
  lines: ExtractedLine[];
};

export type MonthYear = { month: number | null; year: number | null };

export type ExperienceItem = {
  start: MonthYear;
  end: MonthYear;
  isCurrent: boolean;
  role: string | null;
  company: string | null;
  description: string[];
};

export type EducationItem = {
  degree: string | null;
  school: string | null;
  location: string | null;
  start: MonthYear;
  end: MonthYear;
  isCurrent: boolean;
};

export type ParsedResume = {
  name: string | null;
  phone: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  country: string | null;
  currentTitle: string | null;
  summary?: string | null;
  experiences: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
};

export type ParseResumePdfResult = {
  data: ParsedResume;
  warnings: string[];
  debug?: {
    lines: ExtractedLine[];
    sections: DetectedSection[];
    blocks: Block[];
  };
};

type ParseOptions = { debug?: boolean; useLlm?: boolean };

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const SECTION_KEYWORDS: Array<{ type: SectionType; patterns: RegExp[] }> = [
  { type: 'experience', patterns: [
    /^(work\s+)?experience$/i,
    /professional\s+experience/i,
    /employment\s+history/i,
    /^relevant\s+experience$/i,
    /^career\s+history$/i,
    /^work\s+history$/i,
  ]},
  { type: 'education', patterns: [
    /^education$/i,
    /^academic\s+background$/i,
    /^academic\s+qualifications?$/i,
    /^qualifications?$/i,
  ]},
  { type: 'skills', patterns: [
    /^skills?$/i,
    /^technical\s+skills?$/i,
    /^core\s+skills?$/i,
    /^software$/i,
    /^tools?$/i,
    /^key\s+skills?$/i,
    /^design\s+skills?$/i,
    /^languages?\s*[&+]\s*tools?$/i,
    /^competenc(e|ies)$/i,
    /^expertise$/i,
    /^stack$/i,
  ]},
  { type: 'other', patterns: [
    /^certifications?$/i,
    /^licenses?$/i,
    /^awards?$/i,
    /^recognition$/i,
    /^achievements?$/i,
    /^honors?$/i,
    /^honours?$/i,
    /^publications?$/i,
    /^languages?$/i,
  ]},
  { type: 'projects', patterns: [
    /^projects?$/i,
    /^selected\s+projects?$/i,
    /^portfolio$/i,
    /^notable\s+projects?$/i,
  ]},
  { type: 'summary', patterns: [
    /^summary$/i,
    /^profile$/i,
    /^about$/i,
    /^about\s+me$/i,
    /^objective$/i,
    /^bio$/i,
    /^overview$/i,
    /^introduction$/i,
    /^professional\s+summary$/i,
    /^career\s+objective$/i,
  ]},
  { type: 'contact', patterns: [/^contact$/i, /^contact\s+info(rmation)?$/i] },
];

const TITLE_HINT = /\b(designer|manager|engineer|intern|analyst|lead|director|specialist|consultant|architect|developer|coach|instructor|trainer|assistant|marketing)\b/i;
const COMPANY_HINT = /(inc\.?|pte\.?\s+ltd|llc|ltd\.?|corp\.?|technologies|university|college|institute|labs?)/i;
const DEGREE_HINT = /\b(bachelor|master|phd|diploma|certificate|degree|b\.?a\.?|b\.?sc\.?|bsc|bs|bba|m\.?a\.?|m\.?sc\.?|msc|m\.?s\.?|mba|hons)\b/i;
const SCHOOL_HINT = /(university|college|polytechnic|school|institute|academy)/i;
const AWARD_HINT = /(award|awards|recognition|achievement|certification|certificate|medal|honou?r|finalist|winner)/i;
const COUNTRY_TOKEN_REGEX = /\b(singapore|malaysia|indonesia|thailand|vietnam|philippines|united kingdom|uk|united states|usa|australia|india|china|japan|canada)\b/i;
const ACTION_VERB_HINT = /^(led|conducted|partnered|worked|produced|rapidly|researched|designed|applied|redesigned|validated|created|drove|built|managed|launched|defined|optimized|improved)\b/i;

function cleanLineText(text: string): string {
  let out = text
    .replace(/\u00a0/g, ' ')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Merge fragmented OCR-like tokens: "K e yshot" -> "Keyshot"
  const parts = out.split(' ');
  const repaired: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (/^[A-Za-z]$/.test(token)) {
      let prefix = token;
      let j = i + 1;
      while (j < parts.length && /^[A-Za-z]$/.test(parts[j])) {
        prefix += parts[j];
        j += 1;
      }
      if (j < parts.length && /^[A-Za-z][A-Za-z'-]{1,}$/.test(parts[j])) {
        repaired.push(prefix + parts[j]);
        i = j;
        continue;
      }
      repaired.push(prefix);
      i = j - 1;
      continue;
    }
    repaired.push(token);
  }
  out = repaired.join(' ');

  // Merge lower-confidence OCR split words like "R ec ogni tion" and "E du c ation".
  const tokens = out.split(/\s+/).filter(Boolean);
  const stitched: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const cur = tokens[i] ?? '';
    const next = tokens[i + 1] ?? '';
    const canMergeTwo =
      /^[A-Za-z]{1,3}$/.test(cur)
      && /^[A-Za-z]{1,5}$/.test(next)
      && (
        cur.length === 1
        || next.length === 1
        || (/^[A-Z]/.test(cur) && /^[a-z]/.test(next))
      );
    if (!canMergeTwo) {
      stitched.push(cur);
      continue;
    }

    let merged = `${cur}${next}`;
    let j = i + 2;
    while (j < tokens.length && /^[A-Za-z]{1,4}$/.test(tokens[j] ?? '') && merged.length < 20) {
      merged += tokens[j];
      j += 1;
    }

    if (/^[A-Za-z]{4,20}$/.test(merged)) {
      stitched.push(merged);
      i = j - 1;
      continue;
    }
    stitched.push(cur);
  }
  out = stitched.join(' ');

  // Merge split suffix chars: "strateg y" -> "strategy", "efficienc y" -> "efficiency"
  out = out.replace(/\b([A-Za-z]{4,})\s+([a-z])\b/g, '$1$2');
  out = out.replace(/\b([A-Za-z]{2,3})\s+([a-z])\b/g, (m, a: string, b: string) => {
    if (/^(as|to|in|on|at|an)$/i.test(a)) return m;
    return `${a}${b}`;
  });
  out = out.replace(/\s*-\s*/g, '-');
  out = out.replace(/([a-z])-([A-Z])/g, '$1 - $2');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

export function normalizeOutputText(text: string): string {
  return cleanLineText(text)
    .replace(/\b([A-Za-z0-9]+)\s*-\s*([A-Za-z0-9]+)\b/g, '$1-$2')
    .replace(/\byofSingapore\b/gi, 'y of Singapore')
    .replace(/\byof([A-Z][a-z]+)/g, 'y of $1')
    .replace(/\bUniv\s*ersit\s*y\s*of\b/gi, 'University of')
    .replace(/\bUniv\s*ersit\s*y\b/gi, 'University')
    .replace(/\bSinga\s*pore\b/gi, 'Singapore')
    .replace(/\bTemase\s*kPolytechnic\b/gi, 'Temasek Polytechnic')
    .replace(/\bTemase\s*k\b/gi, 'Temasek')
    .replace(/\bPoly\s*technic\b/gi, 'Polytechnic')
    .replace(/\bDiplo\s*ma\b/gi, 'Diploma')
    .replace(/\bProgra\s*mme\b/gi, 'Programme')
    .replace(/\bofArts\b/g, 'of Arts')
    .replace(/\bGSuite\b/g, 'G Suite')
    .replace(/\bke yboard\b/gi, 'keyboard')
    .replace(/\bke ycap\b/gi, 'keycap')
    .replace(/\bpre vious\b/gi, 'previous')
    .replace(/\bre vie ws\b/gi, 'reviews')
    .replace(/\bde vice\b/gi, 'device')
    .replace(/\binter vie ws\b/gi, 'interviews')
    .replace(/\bfore valuations\b/gi, 'for evaluations')
    .replace(/\bbuildc ycles\b/gi, 'build cycles')
    .replace(/\bergonomice valuation\b/gi, 'ergonomic evaluation')
    .replace(/\bCADform\b/g, 'CAD form')
    .replace(/\bahybrid\b/gi, 'a hybrid')
    .replace(/\baDell\b/g, 'a Dell')
    .replace(/\btr yDell\b/gi, 'try Dell')
    .replace(/\bIfind\b/g, 'I find')
    .replace(/\bAsa\b/g, 'As a')
    .replace(/\s+,/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function headingKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function normalizeUrl(url: string): string {
  const cleaned = url.trim().replace(/[),.;]+$/, '');
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

function findRegex(lines: ExtractedLine[], regex: RegExp): string | null {
  for (const line of lines) {
    const m = line.text.match(regex);
    if (m?.[0]) return m[0];
  }
  return null;
}

function monthFromToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const t = token.toLowerCase().replace(/[^a-z]/g, '');
  return MONTH_INDEX[t] ?? null;
}

function parseYear(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function parseSingleDateToken(token: string): MonthYear {
  const t = token.trim();
  const monthMatch = t.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i);
  const yearMatch = t.match(/(19|20)\d{2}/);
  return { month: monthFromToken(monthMatch?.[0] ?? null), year: yearMatch ? Number(yearMatch[0]) : null };
}

function parseDateRange(text: string): { start: MonthYear; end: MonthYear; isCurrent: boolean; hasAnyDate: boolean } {
  const normalized = text
    .replace(/[–—]/g, '-')
    .replace(/\s+to\s+/gi, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const present = /\b(present|current|now)\b/i.test(normalized);
  const yearTokens = normalized.match(/(19|20)\d{2}/g) ?? [];

  const monthYearRange = normalized.match(
    /(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)?\s*(\d{4})?\s*-\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)?\s*(\d{4})?/i,
  );

  if (monthYearRange) {
    const start: MonthYear = {
      month: monthFromToken(monthYearRange[1]),
      year: parseYear(monthYearRange[2]),
    };
    const end: MonthYear = present
      ? { month: null, year: null }
      : {
          month: monthFromToken(monthYearRange[3]),
          year: parseYear(monthYearRange[4]),
        };

    if (!start.year && yearTokens.length > 0) start.year = Number(yearTokens[0]);
    if (!end.year && yearTokens.length > 1 && !present) end.year = Number(yearTokens[1]);

    return {
      start,
      end,
      isCurrent: present,
      hasAnyDate: Boolean(start.year || end.year || start.month || end.month),
    };
  }

  if (yearTokens.length > 0) {
    const startYear = Number(yearTokens[0]);
    const endYear = present ? null : Number(yearTokens[1] ?? yearTokens[0]);
    return {
      start: { month: null, year: startYear },
      end: { month: null, year: endYear },
      isCurrent: present,
      hasAnyDate: true,
    };
  }

  return {
    start: { month: null, year: null },
    end: { month: null, year: null },
    isCurrent: false,
    hasAnyDate: false,
  };
}

function stripDatePrefix(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/^(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)?\s*(?:19|20)\d{2}\s*-\s*(?:present|current|now|(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)?\s*(?:19|20)\d{2})?)\s*/i, '')
    .trim();
}

function parseRoleCompanyFromMixedLine(line: string): { role: string | null; company: string | null } {
  const normalized = line.replace(/[–—]/g, '-').trim();
  const trailingDateMatch = normalized.match(/^(.*?)(?:\s+)(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|\d{4})\b/i);
  if (trailingDateMatch && trailingDateMatch[1]) {
    const possibleRole = removeDateFragments(trailingDateMatch[1]);
    if (possibleRole && TITLE_HINT.test(possibleRole)) {
      return { role: possibleRole, company: null };
    }
  }

  const remainder = stripDatePrefix(normalized);
  if (!remainder) return { role: null, company: null };

  const words = remainder.split(/\s+/).filter(Boolean);
  const titleIdx = words.findIndex((w) => TITLE_HINT.test(w));
  if (titleIdx > 0) {
    const companyWords = words.slice(0, titleIdx);
    const roleWords = words.slice(titleIdx);
    const titleOnlyPrefix = companyWords.every((w) => /^(senior|sr|junior|jr|lead|principal|staff|product|ux|ui|industrial|software|growth|brand)$/i.test(w));
    const hasOrgSignal = companyWords.some((w) => COMPANY_HINT.test(w));
    if (titleOnlyPrefix && !hasOrgSignal && words.length <= 6) {
      return { role: remainder, company: null };
    }
    if (companyWords.length > 1 && roleWords.length === 1 && /(industrial|product|graphic|ux|ui|software|senior|junior|lead)$/i.test(companyWords[companyWords.length - 1] ?? '')) {
      roleWords.unshift(companyWords.pop() as string);
    }
    const company = companyWords.join(' ').trim();
    const role = roleWords.join(' ').trim();
    return { role: role || null, company: company || null };
  }

  if (remainder.includes(' at ')) {
    const [left, right] = remainder.split(/\s+at\s+/i);
    return { role: left?.trim() || null, company: right?.trim() || null };
  }

  return { role: null, company: null };
}

function removeDateFragments(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s*(?:19|20)\d{2}\b/gi, '')
    .replace(/\b(?:19|20)\d{2}\s*-\s*(?:present|current|now|(?:19|20)\d{2})\b/gi, '')
    .replace(/\b(?:present|current|now)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—,:]+|[\s\-–—,:]+$/g, '')
    .trim();
}

function isBulletText(text: string): boolean {
  return /^[•\-*\u2022]|^\d+\./.test(text.trim());
}

function hasDateText(text: string): boolean {
  const d = parseDateRange(text);
  return d.hasAnyDate || /\b(present|current|now)\b/i.test(text);
}

function looksExperienceEntryHeader(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (hasDateText(t) || isBulletText(t)) return false;
  if (AWARD_HINT.test(t)) return false;
  if (!TITLE_HINT.test(t)) return false;
  if (ACTION_VERB_HINT.test(t)) return false;
  if (/[.:]$/.test(t)) return false;
  const words = t.split(/\s+/).length;
  return words >= 2 && words <= 8 && t.length <= 90;
}

function looksExperienceOrgLine(text: string): boolean {
  if (COMPANY_HINT.test(text)) return true;
  if (/\b(singapore|united kingdom|uk|school|club|centre|university|college|academy|technologies)\b/i.test(text)) return true;
  // Short title-cased names that don't look like job titles or bullet points are
  // often tech-company names without corporate suffixes (e.g. "CoinGecko", "Binance",
  // "Grab", "Shopee", "Various Brands").
  const words = text.trim().split(/\s+/);
  if (
    words.length >= 1 &&
    words.length <= 3 &&
    words[0] != null &&
    /^[A-Z][a-zA-Z0-9]/.test(words[0]) &&
    !TITLE_HINT.test(text) &&
    !hasDateText(text) &&
    !isBulletText(text) &&
    !ACTION_VERB_HINT.test(text) &&
    !/[.!?,]/.test(text) &&
    text.length >= 2 &&
    text.length <= 50
  ) {
    return true;
  }
  return false;
}

function looksEducationSchoolLine(text: string): boolean {
  return SCHOOL_HINT.test(text) || /\b(singapore|united kingdom|uk)\b/i.test(text);
}

function dateWeight(value: MonthYear, isCurrent: boolean): number {
  if (isCurrent) return Number.MAX_SAFE_INTEGER;
  const y = value.year ?? 0;
  const m = value.month ?? 0;
  return y * 100 + m;
}

/** Merge a pre-sorted array of positioned spans into logical text lines. */
function buildLinesFromSpans(spans: ExtractedLine[]): ExtractedLine[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y0 - b.y0) > 2) return b.y0 - a.y0;
    return a.x0 - b.x0;
  });

  const lines: ExtractedLine[] = [];
  for (const span of sorted) {
    const last = lines[lines.length - 1];
    const sameLine =
      last &&
      last.page === span.page &&
      Math.abs(last.y0 - span.y0) <= Math.max(3, (span.fontSize ?? 10) * 0.35);

    if (!sameLine) {
      lines.push({ ...span });
      continue;
    }

    const gap = span.x0 - last.x1;
    const needsSpace = gap > Math.max(2, (span.fontSize ?? 10) * 0.25);
    last.text = cleanLineText(`${last.text}${needsSpace ? ' ' : ''}${span.text}`);
    last.x1 = Math.max(last.x1, span.x1);
    last.y1 = Math.max(last.y1, span.y1);
    last.fontSize = Math.max(last.fontSize ?? 10, span.fontSize ?? 10);
  }

  return lines.filter((line) => line.text.length > 0);
}

/**
 * Detect whether the page has a true two-column layout (e.g. left: experience,
 * right: skills + education) vs. a single-column layout where dates float to
 * the right margin.
 *
 * Returns the X-coordinate boundary between columns, or null if single-column.
 */
function detectColumnBoundary(spans: ExtractedLine[]): number | null {
  if (spans.length < 12) return null;

  const pageWidth = Math.max(...spans.map((s) => s.x1), 595);
  const searchMin = pageWidth * 0.25;
  const searchMax = pageWidth * 0.70;

  // Build sorted list of unique rounded x0 start-positions.
  const xs = [...new Set(spans.map((s) => Math.round(s.x0)))].sort((a, b) => a - b);

  let biggestGap = 0;
  let gapCenter = -1;

  for (let i = 1; i < xs.length; i += 1) {
    const prev = xs[i - 1]!;
    const curr = xs[i]!;
    // Evaluate mid-point of the gap so near-margin columns aren't missed.
    const mid = (prev + curr) / 2;
    if (mid < searchMin || mid > searchMax) continue;
    const gap = curr - prev;
    if (gap > biggestGap) {
      biggestGap = gap;
      gapCenter = mid;
    }
  }

  // Require a meaningful gap (≥ 5% of page width, minimum 20 pts).
  const threshold = Math.max(pageWidth * 0.05, 20);
  if (biggestGap < threshold || gapCenter < 0) return null;

  const leftSpans = spans.filter((s) => s.x0 < gapCenter);
  const rightSpans = spans.filter((s) => s.x0 >= gapCenter);

  // Both sides need meaningful content.
  if (leftSpans.length < 8 || rightSpans.length < 5) return null;

  // If the right "column" is almost entirely date strings it is just dates
  // floating to the right margin of a single-column layout — not a real column.
  const rightTexts = rightSpans.map((s) => s.text);
  const dateCount = rightTexts.filter((t) => hasDateText(t) || /^\d{4}\b/.test(t)).length;
  if (dateCount / rightTexts.length > 0.65) return null;

  // A real second column must contain at least one section-like heading on the right.
  const rightHasSectionHeading = rightSpans.some((s) => {
    const cleaned = s.text.toLowerCase().replace(/[:\-]+$/, '').trim();
    return SECTION_KEYWORDS.some((rule) => rule.patterns.some((p) => p.test(cleaned)));
  });
  if (!rightHasSectionHeading) return null;

  return gapCenter;
}

function extractLinesFromPdfJsContent(items: any[], page: number): ExtractedLine[] {
  const spans = items
    .map((item: any) => {
      const text = cleanLineText(String(item?.str ?? ''));
      if (!text) return null;
      const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4] ?? 0);
      const y = Number(transform[5] ?? 0);
      const fontSize = Math.max(8, Math.round(Math.abs(Number(transform[0] ?? 0)) || Number(item?.height ?? 10)));
      const width = Math.max(1, Number(item?.width ?? text.length * (fontSize * 0.45)));
      return {
        text,
        page,
        x0: x,
        y0: y,
        x1: x + width,
        y1: y + Math.max(10, fontSize),
        fontSize,
      } as ExtractedLine;
    })
    .filter((v): v is ExtractedLine => Boolean(v));

  const colBoundary = detectColumnBoundary(spans);

  // Single-column (or date-float) layout — use original behaviour.
  if (colBoundary === null) {
    return buildLinesFromSpans(spans);
  }

  // True two-column layout: build lines within each column separately so that
  // content from the left and right columns at the same Y position is never
  // merged into a single garbled line.
  const leftSpans = spans.filter((s) => s.x0 < colBoundary);
  const rightSpans = spans.filter((s) => s.x0 >= colBoundary);

  const leftLines = buildLinesFromSpans(leftSpans);
  const rightLines = buildLinesFromSpans(rightSpans);

  if (leftLines.length === 0) return rightLines;
  if (rightLines.length === 0) return leftLines;

  // Shift right-column Y values so they sort AFTER the left column.
  // PDF Y coords: higher = top; sort is descending (top first).
  // Putting right lines below left column bottom makes them appear later in
  // the reading-order sequence produced by parseResumeFromLines.
  const leftMinY = Math.min(...leftLines.map((l) => l.y0));
  const rightMaxY = Math.max(...rightLines.map((l) => l.y0));
  const yShift = leftMinY - rightMaxY - 30;

  const shiftedRight = rightLines.map((l) => ({
    ...l,
    y0: l.y0 + yShift,
    y1: l.y1 + yShift,
  }));

  return [...leftLines, ...shiftedRight];
}

async function extractLinesWithPdfJs(buffer: Buffer): Promise<ExtractedLine[]> {
  const pdfjsModule = await new Function('m', 'return import(m)')('pdfjs-dist/legacy/build/pdf.mjs');
  const getDocument = (pdfjsModule as { getDocument?: (input: unknown) => { promise: Promise<unknown> } }).getDocument;
  if (!getDocument) throw new Error('pdfjs-dist getDocument not found');

  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise as {
    numPages: number;
    getPage: (pageNum: number) => Promise<{ getTextContent: () => Promise<{ items: any[] }> }>;
  };

  const all: ExtractedLine[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    all.push(...extractLinesFromPdfJsContent(content.items, pageNum));
  }

  return all;
}

async function extractLinesWithPdfKit(buffer: Buffer): Promise<ExtractedLine[]> {
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

for pageIndex in 0..<doc.pageCount {
  print("__PAGE__\\(pageIndex + 1)")
  if let page = doc.page(at: pageIndex), let fullText = page.string {
    print(fullText)
  }
}
`;

  try {
    const { stdout } = await execFileAsync('swift', ['-e', swiftScript, pdfPath], {
      env: {
        ...process.env,
        SWIFT_MODULECACHE_PATH: process.env.SWIFT_MODULECACHE_PATH ?? path.join(os.tmpdir(), 'swift-cache'),
        CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH ?? path.join(os.tmpdir(), 'clang-cache'),
      },
      timeout: 25000,
      maxBuffer: 12 * 1024 * 1024,
    });

    const linesRaw = String(stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((acc, rawLine) => {
        const line = rawLine.trim();
        if (line.startsWith('__PAGE__')) {
          const pageNum = Number(line.replace('__PAGE__', '').trim());
          if (Number.isFinite(pageNum) && pageNum > 0) {
            acc.currentPage = pageNum;
            acc.lineIdx = 0;
          }
          return acc;
        }

        const text = cleanLineText(line);
        if (!text) return acc;

        const y = 1000 - (acc.lineIdx * 14);
        acc.lines.push({
          page: acc.currentPage,
          x0: 40,
          y0: y,
          x1: 560,
          y1: y + 12,
          fontSize: 12,
          text,
        });
        acc.lineIdx += 1;
        return acc;
      }, { lines: [] as ExtractedLine[], currentPage: 1, lineIdx: 0 })
      .lines;

    return linesRaw;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

function extractLinesFromPlainText(text: string): ExtractedLine[] {
  const cleaned = String(text ?? '').replace(/\r/g, '\n');
  if (!cleaned.trim()) return [];

  const lines: ExtractedLine[] = [];
  const rawLines = cleaned.split('\n').map((line) => cleanLineText(line)).filter(Boolean);
  let page = 1;
  let lineIdx = 0;

  for (const textLine of rawLines) {
    // Keep synthetic layout stable enough for downstream section heuristics.
    const y = 1000 - (lineIdx * 14);
    lines.push({
      page,
      x0: 40,
      y0: y,
      x1: 560,
      y1: y + 12,
      fontSize: 12,
      text: textLine,
    });
    lineIdx += 1;
    if (lineIdx > 65) {
      page += 1;
      lineIdx = 0;
    }
  }

  return lines;
}

export async function extractLayoutAwareLines(buffer: Buffer): Promise<ExtractedLine[]> {
  const isLowQuality = (lines: ExtractedLine[]) => {
    if (lines.length === 0) return true;
    const cleaned = lines.map((l) => l.text.trim()).filter(Boolean);
    const uniq = new Set(cleaned);
    const placeholderCount = cleaned.filter((t) => /^\([^)]{1,20}\)$/.test(t) || /^\(clean\)$/i.test(t)).length;
    const cleanWordCount = cleaned.filter((t) => /clean/i.test(t)).length;
    return uniq.size <= 3 || placeholderCount / cleaned.length > 0.4 || cleanWordCount / cleaned.length > 0.3;
  };

  const shouldTryPdfKit = process.platform === 'darwin' && process.env.CVSTACK_DISABLE_PDFKIT !== '1';
  // Prefer native PDFKit on macOS for layout-heavy resumes exported from design tools.
  if (shouldTryPdfKit) {
    try {
      const fromPdfKit = await extractLinesWithPdfKit(buffer);
      if (fromPdfKit.length > 0 && !isLowQuality(fromPdfKit)) return fromPdfKit;
    } catch {
      // fallback below
    }
  }

  try {
    const fromPdfJs = await extractLinesWithPdfJs(buffer);
    if (fromPdfJs.length > 0 && !isLowQuality(fromPdfJs)) return fromPdfJs;
  } catch {
    // fallback below
  }

  // Cross-platform text extraction fallback (especially useful in Linux prod
  // where native PDFKit is unavailable).
  try {
    const extracted = await extractTextFromPdfBuffer(buffer);
    if (extracted.text && !isExtractionFailure(extracted.text)) {
      const fromPlainText = extractLinesFromPlainText(extracted.text);
      if (fromPlainText.length > 0 && !isLowQuality(fromPlainText)) return fromPlainText;
    }
  } catch {
    // final fallback below
  }

  return [];
}

function classifyHeading(line: ExtractedLine, medianFont: number): SectionType | null {
  const text = line.text.toLowerCase().replace(/[:\-]+$/, '').trim();
  const key = headingKey(text);
  const looksHeading = text.length <= 40 && text.split(/\s+/).length <= 4;
  if (!looksHeading) return null;

  for (const rule of SECTION_KEYWORDS) {
    if (rule.patterns.some((p) => p.test(text))) {
      return rule.type;
    }
    if (rule.patterns.some((p) => p.test(key))) {
      return rule.type;
    }
  }

  if ((line.fontSize ?? medianFont) >= medianFont + 1.5) {
    if (/experience|employment/.test(text) || /experience|employment/.test(key)) return 'experience';
    if (/education|academic/.test(text) || /education|academic/.test(key)) return 'education';
    if (/skills?/.test(text) || /skills?/.test(key)) return 'skills';
    if (/project/.test(text) || /project/.test(key)) return 'projects';
    if (/summary|profile|about|objective/.test(text) || /summary|profile|about|objective/.test(key)) return 'summary';
    if (/award|recognition|achievement|certification/.test(text) || /award|recognition|achievement|certification/.test(key)) return 'other';
  }

  return null;
}

export function detectSections(lines: ExtractedLine[]): DetectedSection[] {
  if (lines.length === 0) return [];
  const fonts = lines.map((l) => l.fontSize ?? 12).sort((a, b) => a - b);
  const medianFont = fonts[Math.floor(fonts.length / 2)] ?? 12;

  const headings: Array<{ idx: number; type: SectionType }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const headingType = classifyHeading(lines[i], medianFont);
    if (headingType) headings.push({ idx: i, type: headingType });
  }

  const deduped: Array<{ idx: number; type: SectionType }> = [];
  for (const h of headings) {
    const last = deduped[deduped.length - 1];
    if (last && last.type === h.type && Math.abs(last.idx - h.idx) <= 2) continue;
    deduped.push(h);
  }

  if (deduped.length === 0) {
    return [{ type: 'contact', startIdx: 0, endIdx: Math.max(0, lines.length - 1) }];
  }

  const sections: DetectedSection[] = [];
  const firstHeading = deduped[0];
  if (firstHeading.idx > 0) {
    sections.push({ type: 'contact', startIdx: 0, endIdx: firstHeading.idx - 1 });
  }

  for (let i = 0; i < deduped.length; i += 1) {
    const current = deduped[i];
    const next = deduped[i + 1];
    const startIdx = current.idx + 1;
    const endIdx = (next ? next.idx - 1 : lines.length - 1);
    if (startIdx <= endIdx) {
      sections.push({ type: current.type, startIdx, endIdx });
    }
  }

  if (sections.length === 0) {
    sections.push({ type: 'other', startIdx: 0, endIdx: lines.length - 1 });
  }

  return sections;
}

function looksDateAnchor(line: ExtractedLine): boolean {
  const t = line.text;
  const date = parseDateRange(t);
  if (!date.hasAnyDate && !/\bpresent\b/i.test(t)) return false;
  if (t.length > 70 && !/\d{4}/.test(t)) return false;
  return true;
}

function groupSectionBlocks(section: DetectedSection, lines: ExtractedLine[]): Block[] {
  const sectionLines = lines.slice(section.startIdx, section.endIdx + 1);
  if (sectionLines.length === 0) return [];

  if (section.type !== 'experience' && section.type !== 'education') {
    return [{ section: section.type, lines: sectionLines }];
  }

  const xMid = sectionLines
    .map((l) => l.x0)
    .sort((a, b) => a - b)[Math.floor(sectionLines.length / 2)] ?? 0;

  const blocks: Block[] = [];
  let current: ExtractedLine[] = [];

  for (let i = 0; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    const prev = sectionLines[i - 1];
    const yGap = prev ? Math.abs(prev.y0 - line.y0) : 0;

    const hasEntryContent = current.some((l) => isBulletText(l.text) || ACTION_VERB_HINT.test(l.text));
    const currentAlreadyHasDate = current.some((l) => looksDateAnchor(l));
    // Only split on a date line if the current block already has meaningful content
    // (bullets, prose, or another date). This prevents the date that floats to
    // the right of a company/role line from prematurely starting a new block.
    const boundaryByDate =
      looksDateAnchor(line) &&
      (line.x0 > xMid || current.length >= 2) &&
      (hasEntryContent || currentAlreadyHasDate || current.length >= 3);
    const boundaryByGap = yGap > 22 && current.length > 0;
    const roleLikeHeader = section.type === 'experience' && looksExperienceEntryHeader(line.text);
    const schoolLikeHeader = section.type === 'education'
      && (DEGREE_HINT.test(line.text) || SCHOOL_HINT.test(line.text))
      && !isBulletText(line.text)
      && !hasDateText(line.text);
    const boundaryByHeader = current.length > 0 && (roleLikeHeader || schoolLikeHeader) && hasEntryContent && (yGap > 10 || current.some((l) => isBulletText(l.text)));

    if ((boundaryByDate || boundaryByGap || boundaryByHeader) && current.length > 0) {
      blocks.push({ section: section.type, lines: current });
      current = [];
    }

    current.push(line);
  }

  if (current.length > 0) blocks.push({ section: section.type, lines: current });
  return blocks;
}

export function groupBlocks(lines: ExtractedLine[], sections: DetectedSection[]): Block[] {
  return sections.flatMap((section) => groupSectionBlocks(section, lines));
}

function normalizeEntryBlocks(blocks: Block[]): Block[] {
  const out = blocks.map((b) => ({ section: b.section, lines: [...b.lines] }));
  for (let i = 0; i < out.length - 1; i += 1) {
    const current = out[i];
    const next = out[i + 1];
    if (!((current.section === 'experience' || current.section === 'education') && current.section === next.section)) continue;
    if (current.lines.length === 0 || next.lines.length === 0) continue;

    if (current.section === 'experience') {
      const currentHasDate = current.lines.some((l) => hasDateText(l.text));
      const currentHasBullets = current.lines.some((l) => isBulletText(l.text));
      const nextHasDate = next.lines.some((l) => hasDateText(l.text));
      if (currentHasDate && currentHasBullets && !nextHasDate && next.lines.length === 1 && looksExperienceEntryHeader(next.lines[0].text)) {
        current.lines.push(next.lines[0]);
        next.lines.splice(0, 1);
        continue;
      }
    }

    const nextHead = next.lines[0].text;
    const needAttachPrevHeader =
      hasDateText(nextHead) ||
      (next.section === 'experience' && TITLE_HINT.test(nextHead)) ||
      (next.section === 'education' && (DEGREE_HINT.test(nextHead) || hasDateText(nextHead)));
    if (!needAttachPrevHeader) continue;
    if (next.section === 'experience') {
      const nextHasHeader = next.lines.some((l, idx) =>
        idx < 3
        && !hasDateText(l.text)
        && !isBulletText(l.text)
        && (looksExperienceEntryHeader(l.text) || looksExperienceOrgLine(l.text)),
      );
      if (nextHasHeader) continue;
    }

    let moveIdx = -1;
    for (let j = current.lines.length - 1; j >= Math.max(0, current.lines.length - 5); j -= 1) {
      const cand = current.lines[j];
      const text = cand.text;
      if (hasDateText(text)) continue;
      if (isBulletText(text)) continue;
      const acceptable = next.section === 'experience'
        ? (looksExperienceOrgLine(text) && !TITLE_HINT.test(text))
        : looksEducationSchoolLine(text);
      if (acceptable) {
        moveIdx = j;
        break;
      }
    }
    if (moveIdx >= 0) {
      next.lines.unshift(current.lines[moveIdx]);
      current.lines.splice(moveIdx, 1);
    }
  }

  return out.filter((b) => b.lines.length > 0);
}

function parseContact(lines: ExtractedLine[], allLines: ExtractedLine[], warnings: string[]): {
  name: string | null;
  phone: string | null;
  email: string | null;
  linkedin: string | null;
  website: string | null;
  country: string | null;
  currentTitle: string | null;
} {
  if (lines.length === 0) {
    warnings.push('No contact lines detected.');
    return {
      name: null,
      phone: null,
      email: null,
      linkedin: null,
      website: null,
      country: null,
      currentTitle: null,
    };
  }

  const page1 = lines.filter((l) => l.page === 1);
  const top = (page1.length > 0 ? page1 : lines)
    .filter((l) => l.text.length <= 120)
    .slice(0, 12);

  const nameCandidate = [...top]
    .filter((line) => !/@/.test(line.text) && !/\d{3,}/.test(line.text) && !/https?:\/\//i.test(line.text) && !/linkedin/i.test(line.text))
    .filter((line) => !TITLE_HINT.test(line.text))
    .filter((line) => line.text.split(/\s+/).length >= 2 && line.text.split(/\s+/).length <= 5)
    .sort((a, b) => (b.fontSize ?? 12) - (a.fontSize ?? 12))[0];

  const email = findRegex(allLines, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phone = findRegex(allLines, /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/);
  const linkedin = findRegex(allLines, /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[A-Za-z0-9_\-\/]+/i);

  const websites = allLines
    .flatMap((line) => line.text.match(/(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[\w\-./?%&=]*)?/g) ?? [])
    .map((url) => normalizeUrl(url))
    .filter((url) => !/linkedin\.com/i.test(url) && !/@/.test(url));
  const website = websites[0] ?? null;

  const locationLine = top.find((line) => {
    if (COUNTRY_TOKEN_REGEX.test(line.text)) return true;
    return false;
  }) ?? top.find((line) => {
    if (/\d/.test(line.text)) return false;
    if (/@|linkedin|http/i.test(line.text)) return false;
    if (line.text.length > 70 || /[.!?]/.test(line.text)) return false;
    return line.text.split(',').length >= 2 || COUNTRY_TOKEN_REGEX.test(line.text);
  });

  let name = nameCandidate?.text ?? null;
  if (!name && email) {
    const local = email.split('@')[0] ?? '';
    const tokens = local
      .split(/[._-]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, 1).toUpperCase() + t.slice(1).toLowerCase());
    if (tokens.length >= 1) name = tokens.join(' ');
  }
  let currentTitle: string | null = null;
  if (nameCandidate) {
    const idx = lines.findIndex((l) => l === nameCandidate);
    const nearby = lines.slice(Math.max(0, idx + 1), idx + 5);
    currentTitle = nearby.find((l) =>
      TITLE_HINT.test(l.text)
      && !/@|https?:\/\//i.test(l.text)
      && !AWARD_HINT.test(l.text)
      && l.text.length <= 60
      && (l.text.match(/,/g)?.length ?? 0) <= 1,
    )?.text ?? null;
  }

  if (!name) warnings.push('Could not confidently detect full name.');
  if (!email) warnings.push('Could not detect email.');

  return {
    name,
    phone: phone ?? null,
    email: email ?? null,
    linkedin: linkedin ? normalizeUrl(linkedin) : null,
    website,
    country: locationLine ? detectCountryToken(locationLine.text) : null,
    currentTitle,
  };
}

function looksContinuationLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (hasDateText(t)) return false;
  if (isBulletText(t)) return false;
  if (/^[A-Z][A-Z\s]{3,}$/.test(t)) return false;
  if (/^\+?\s*add\s+/i.test(t)) return false;
  return /^[a-z(]/.test(t) || /^[A-Za-z0-9].{0,140}$/.test(t);
}

function stitchBullets(lines: ExtractedLine[]): { bullets: string[]; prose: string[] } {
  const bullets: string[] = [];
  const prose: string[] = [];
  const bulletBaseX = lines
    .filter((l) => isBulletText(l.text))
    .map((l) => l.x0)
    .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (/^\+?\s*add\s+/i.test(text)) continue;

    if (isBulletText(text)) {
      bullets.push(text.replace(/^[•\-*\u2022\d.\s]+/, '').trim());
      continue;
    }

    const canAppendToBullet = bullets.length > 0
      && looksContinuationLine(text)
      && line.x0 >= (Number.isFinite(bulletBaseX) ? bulletBaseX - 8 : line.x0)
      && !(ACTION_VERB_HINT.test(text) && /^[A-Z]/.test(text))
      && !TITLE_HINT.test(text)
      && !SCHOOL_HINT.test(text)
      && !AWARD_HINT.test(text);

    if (canAppendToBullet) {
      bullets[bullets.length - 1] = cleanLineText(`${bullets[bullets.length - 1]} ${text}`);
      continue;
    }

    const impliedBulletStart =
      ACTION_VERB_HINT.test(text)
      && !looksExperienceEntryHeader(text)
      && text.length >= 20;
    if (impliedBulletStart) {
      bullets.push(text);
      continue;
    }

    prose.push(text);
  }

  return { bullets, prose };
}

function swapRoleCompanyIfNeeded(role: string | null, company: string | null): { role: string | null; company: string | null; swapped: boolean } {
  if (!role || !company) return { role, company, swapped: false };
  const roleLooksCompany = COMPANY_HINT.test(role) && !TITLE_HINT.test(role);
  const companyLooksRole = TITLE_HINT.test(company) && !COMPANY_HINT.test(company);
  if (roleLooksCompany && companyLooksRole) {
    return { role: company, company: role, swapped: true };
  }
  return { role, company, swapped: false };
}

function parseExperienceBlock(block: Block, idx: number, warnings: string[]): ExperienceItem | null {
  const lines = block.lines;
  if (lines.length === 0) return null;

  const dateLine = lines.find((l) => looksDateAnchor(l));
  const dateInfo = parseDateRange(dateLine?.text ?? '');
  // When a date line also contains a company/role prefix (e.g. "CoinGecko Sep 2022 – Present"),
  // extract the non-date portion for role or company assignment below.
  const dateLinePrefix = dateLine ? removeDateFragments(dateLine.text).trim() : null;
  const roleFromDateLine = (() => {
    if (!dateLinePrefix) return null;
    return TITLE_HINT.test(dateLinePrefix) ? dateLinePrefix : null;
  })();
  const companyFromDateLine = (() => {
    if (!dateLinePrefix) return null;
    if (TITLE_HINT.test(dateLinePrefix)) return null; // it's a role, not a company
    if (looksExperienceOrgLine(dateLinePrefix)) return dateLinePrefix;
    return null;
  })();

  const stitched = stitchBullets(lines);
  const bulletLines = stitched.bullets.filter(Boolean);

  const contentLines = stitched.prose
    .filter((t) => !looksDateAnchor({ ...lines[0], text: t }))
    .filter((t) => !isBulletText(t))
    .filter((t) => !/^\+?\s*add\s+/i.test(t));

  let role: string | null = null;
  let company: string | null = null;
  const mixed = dateLine ? parseRoleCompanyFromMixedLine(dateLine.text) : { role: null, company: null };
  role = mixed.role;
  company = mixed.company;
  const headerLine = contentLines.find((t) => looksExperienceEntryHeader(t) && !ACTION_VERB_HINT.test(t)) ?? null;
  if ((!role || !company) && headerLine) {
    const fromHeader = parseRoleCompanyFromMixedLine(headerLine);
    role = role ?? fromHeader.role;
    company = company ?? fromHeader.company;
    if (!role) role = headerLine;
  }

  const firstHeader = contentLines[0] ?? '';
  if ((!role || !company) && firstHeader.includes(' at ')) {
    const parts = firstHeader.split(/\s+at\s+/i);
    role = parts[0]?.trim() || null;
    company = parts[1]?.trim() || null;
  } else if ((!role || !company) && /\s-\s/.test(firstHeader)) {
    const parts = firstHeader.split(/\s-\s/);
    role = parts[0]?.trim() || null;
    company = parts[1]?.trim() || null;
  }

  if (!role || !company) {
    const candidates = contentLines.filter((t) => !ACTION_VERB_HINT.test(t)).slice(0, 3);
    role = role ?? candidates.find((t) => TITLE_HINT.test(t)) ?? null;
    company = company ?? candidates.find((t) =>
      looksExperienceOrgLine(t)
      && !/[.:]/.test(t)
      && t.length <= 80,
    ) ?? null;
    if (!role && candidates.length > 0) role = candidates[0] ?? null;
    if (!company && candidates.length > 1) company = candidates[1] ?? null;
  }

  const firstNonDate = contentLines.find((t) => !hasDateText(t)) ?? null;
  if (role && company && role === company && firstNonDate) {
    const split = parseRoleCompanyFromMixedLine(firstNonDate);
    role = split.role ?? role;
    company = split.company ?? company;
  }

  const swapped = swapRoleCompanyIfNeeded(role, company);
  role = swapped.role;
  company = swapped.company;
  if (swapped.swapped) warnings.push(`Swapped role/company for experience #${idx + 1} based on heuristics.`);

  role = role ? removeDateFragments(role) : null;
  company = company ? removeDateFragments(company) : null;
  if (role && AWARD_HINT.test(role) && !TITLE_HINT.test(role)) role = null;
  if (company && AWARD_HINT.test(company) && !looksExperienceOrgLine(company)) company = null;
  if (company && !looksExperienceOrgLine(company) && /[.]/.test(company)) company = null;
  if (role && looksExperienceOrgLine(role) && roleFromDateLine) {
    if (!company || !looksExperienceOrgLine(company)) company = role;
    role = roleFromDateLine;
  }
  if (!role && roleFromDateLine) role = roleFromDateLine;
  if (company && TITLE_HINT.test(company) && !COMPANY_HINT.test(company)) company = null;
  // Apply the company extracted from the date-line prefix (e.g. "CoinGecko" from
  // "CoinGecko Sep 2022 – Present") as a last-resort fallback.
  if (!company) company = companyFromDateLine;
  if (!company) {
    company = contentLines.find((t) => looksExperienceOrgLine(t) && !hasDateText(t) && !isBulletText(t) && !/[.:]/.test(t) && t.length <= 80) ?? null;
    company = company ? removeDateFragments(company) : null;
  }
  const firstOrgLikeLine = contentLines.find((t) => looksExperienceOrgLine(t) && !hasDateText(t) && !isBulletText(t)) ?? null;
  if (firstOrgLikeLine && (!company || !looksExperienceOrgLine(company))) {
    company = removeDateFragments(firstOrgLikeLine);
  }

  const item: ExperienceItem = {
    start: dateInfo.start,
    end: dateInfo.end,
    isCurrent: dateInfo.isCurrent,
    role,
    company,
    description: bulletLines.length > 0
      ? bulletLines
      : contentLines
          .filter((line) => line !== role && line !== company && line !== headerLine)
          .map((line) => removeDateFragments(line))
          .filter(Boolean)
          .slice(0, 5),
  };

  const valid = Boolean(item.role || item.company) && Boolean(item.start.year || item.description.length > 0);
  if (AWARD_HINT.test(item.role ?? '') && !TITLE_HINT.test(item.role ?? '') && item.description.length === 0) {
    warnings.push(`Dropped award-like experience block #${idx + 1}.`);
    return null;
  }
  if (!valid) {
    warnings.push(`Dropped low-confidence experience block #${idx + 1}.`);
    return null;
  }

  if (!item.role) warnings.push(`Could not confidently detect role line for experience #${idx + 1}.`);
  if (!item.company) warnings.push(`Could not confidently detect company line for experience #${idx + 1}.`);

  return item;
}

function parseEducationBlock(block: Block, idx: number, warnings: string[]): EducationItem | null {
  const lines = block.lines;
  if (lines.length === 0) return null;

  const texts = lines.map((l) => l.text);
  const dateLine = lines.find((l) => looksDateAnchor(l));
  const dateInfo = parseDateRange(dateLine?.text ?? '');

  let school = texts.find((t) => SCHOOL_HINT.test(t)) ?? null;
  let degree = texts.find((t) => DEGREE_HINT.test(t)) ?? null;
  let location = texts.find((t) => /,/.test(t) && !/\d/.test(t) && !SCHOOL_HINT.test(t)) ?? null;

  if (dateLine) {
    const afterDate = stripDatePrefix(dateLine.text);
    if (afterDate && !school) school = afterDate;
  }

  if (!school && texts.length > 0) school = texts[0] ?? null;
  if (!degree && texts.length > 1) degree = texts[1] ?? null;
  if (!degree) {
    const degreeLike = texts.find((t) =>
      /\b(bsc|b\.?sc\.?|bachelor|hons|marketing|management|engineering|design|science|arts|business)\b/i.test(t)
      && !SCHOOL_HINT.test(t),
    ) ?? null;
    if (degreeLike) degree = degreeLike;
  }

  school = school ? removeDateFragments(school) : null;
  degree = degree ? removeDateFragments(degree) : null;
  if (school && DEGREE_HINT.test(school) && (!degree || !DEGREE_HINT.test(degree))) {
    const tmp = degree;
    degree = school;
    school = tmp ?? null;
  }
  if (!school) {
    school = texts.find((t) => looksEducationSchoolLine(t) && !hasDateText(t) && !isBulletText(t)) ?? null;
    school = school ? removeDateFragments(school) : null;
  }
  if (!degree) {
    degree = texts.find((t) => DEGREE_HINT.test(t) && !hasDateText(t)) ?? null;
    degree = degree ? removeDateFragments(degree) : null;
  }

  const item: EducationItem = {
    degree,
    school,
    location,
    start: dateInfo.start,
    end: dateInfo.end,
    isCurrent: dateInfo.isCurrent,
  };

  if (!item.school && !item.degree) {
    warnings.push(`Dropped low-confidence education block #${idx + 1}.`);
    return null;
  }

  return item;
}

function parseSkillsFromSections(lines: ExtractedLine[], sections: DetectedSection[]): string[] {
  const skillsSections = sections.filter((s) => s.type === 'skills');
  const allText = skillsSections
    .flatMap((s) => lines.slice(s.startIdx, s.endIdx + 1).map((l) => l.text))
    .join(' | ');

  if (!allText) return [];

  const tokens = allText
    .split(/[|,•\u2022;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^[-*]\s*/, ''))
    .map((s) => s.replace(/^(languages?|technical)\s*[:\-–—]?\s*/i, ''))
    .map((s) => removeDateFragments(s))
    .filter((s) => s.length > 1 && s.length <= 60)
    .filter((s) => !/^(languages?|technical|certifications?)$/i.test(s))
    .filter((s) => !/\b(certification|certified|council|academy|university)\b/i.test(s))
    .filter((s) => !/\b(recognition|award|achievement|medal)\b/i.test(s))
    .filter((s) => !/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(s))
    .filter((s) => !/(19|20)\d{2}/.test(s))
    .filter((s) => !/^[+\-]/.test(s));

  return unique(tokens).slice(0, 20);
}

function inferSummary(lines: ExtractedLine[], sections: DetectedSection[]): string | null {
  const summarySection = sections.find((s) => s.type === 'summary');
  if (summarySection) {
    const text = lines
      .slice(summarySection.startIdx, summarySection.endIdx + 1)
      .map((l) => l.text)
      .filter((t) => !isBulletText(t))
      .join(' ')
      .trim();
    return text || null;
  }

  const firstStructured = sections.find((s) =>
    s.type === 'experience' || s.type === 'education' || s.type === 'skills' || s.type === 'projects' || s.type === 'other',
  );
  if (!firstStructured || firstStructured.startIdx <= 1) return null;

  const intro = lines
    .slice(0, firstStructured.startIdx)
    .map((l) => l.text)
    .filter((t) => !/@|https?:\/\/|linkedin/i.test(t))
    .filter((t) => !looksDateAnchor({ ...lines[0], text: t }))
    .filter((t) => t.length >= 40);

  const introText = intro.join(' ').trim();
  // Only accept strong paragraph-like intros; avoids pulling work lines as About.
  if (intro.length >= 3 && introText.length >= 220) return introText;
  return null;
}

function sortRecentFirst<T extends { start: MonthYear; end: MonthYear; isCurrent: boolean }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const endWeightDiff = dateWeight(b.end, b.isCurrent) - dateWeight(a.end, a.isCurrent);
    if (endWeightDiff !== 0) return endWeightDiff;
    return dateWeight(b.start, false) - dateWeight(a.start, false);
  });
}

function inferCountryFromLines(lines: ExtractedLine[]): string | null {
  const hits = lines
    .slice(0, 120)
    .flatMap((l) => {
      const fromRegex = l.text.match(/\b(singapore|united kingdom|uk|united states|usa|australia|canada|india)\b/ig) ?? [];
      const key = headingKey(l.text);
      const fromKey = ['singapore', 'unitedkingdom', 'unitedstates', 'australia', 'canada', 'india']
        .filter((v) => key.includes(v))
        .map((v) => (v === 'unitedkingdom' ? 'united kingdom' : v === 'unitedstates' ? 'united states' : v));
      if (key === 'uk') fromKey.push('uk');
      if (key === 'usa') fromKey.push('usa');
      return [...fromRegex, ...fromKey];
    })
    .map((m) => m.toLowerCase());
  if (hits.length === 0) return null;
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0]?.[0] ?? null;
  if (!winner) return null;
  if (winner === 'uk') return 'United Kingdom';
  if (winner === 'usa') return 'United States';
  return winner.replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectCountryToken(text: string): string | null {
  const key = headingKey(text);
  const normalizedText = text.match(/\b(singapore|united kingdom|uk|united states|usa|australia|canada|india)\b/i)?.[0]
    ?? (key.includes('singapore') ? 'singapore' : null)
    ?? (key.includes('unitedkingdom') ? 'united kingdom' : null)
    ?? (key.includes('unitedstates') ? 'united states' : null)
    ?? (key.includes('australia') ? 'australia' : null)
    ?? (key.includes('canada') ? 'canada' : null)
    ?? (key.includes('india') ? 'india' : null)
    ?? (key === 'uk' ? 'uk' : null)
    ?? (key === 'usa' ? 'usa' : null);
  const match = normalizedText;
  if (!match) return null;
  const token = match.toLowerCase();
  if (token === 'uk') return 'United Kingdom';
  if (token === 'usa') return 'United States';
  return token.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseResumeFromLines(linesInput: ExtractedLine[], opts: ParseOptions = {}): ParseResumePdfResult {
  const warnings: string[] = [];
  const lines = linesInput
    .map((l) => ({ ...l, text: cleanLineText(l.text) }))
    .filter((l) => l.text.length > 0)
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y0 - b.y0) > 2) return b.y0 - a.y0;
      return a.x0 - b.x0;
    });

  if (lines.length === 0) warnings.push('No text lines extracted from PDF.');

  const sections = detectSections(lines);
  const blocks = normalizeEntryBlocks(groupBlocks(lines, sections));

  const contactLines = (() => {
    const contactSection = sections.find((s) => s.type === 'contact');
    if (contactSection) return lines.slice(contactSection.startIdx, contactSection.endIdx + 1);
    return lines.slice(0, Math.min(lines.length, 20));
  })();

  const contact = parseContact(contactLines, lines, warnings);

  const experiences = sortRecentFirst(
    blocks
      .filter((b) => b.section === 'experience')
      .map((b, idx) => parseExperienceBlock(b, idx, warnings))
      .filter((v): v is ExperienceItem => Boolean(v)),
  ).slice(0, 5);

  const education = sortRecentFirst(
    blocks
      .filter((b) => b.section === 'education')
      .map((b, idx) => parseEducationBlock(b, idx, warnings))
      .filter((v): v is EducationItem => Boolean(v)),
  ).slice(0, 2);

  const skills = parseSkillsFromSections(lines, sections);
  const summary = inferSummary(lines, sections);
  const experienceCountry = experiences
    .flatMap((e) => [e.company ?? '', e.role ?? ''])
    .map((t) => detectCountryToken(t))
    .find((v): v is string => Boolean(v)) ?? null;
  const inferredCountry = contact.country ?? experienceCountry ?? inferCountryFromLines(lines);

  const data: ParsedResume = {
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    linkedin: contact.linkedin,
    website: contact.website,
    country: inferredCountry,
    currentTitle: contact.currentTitle ?? experiences.find((e) => e.isCurrent)?.role ?? experiences[0]?.role ?? null,
    experiences,
    education,
    skills,
  };

  if (!data.currentTitle && summary) {
    const firstSentence = summary.split(/[.!?]/)[0]?.trim() ?? '';
    if (firstSentence && firstSentence.length <= 90 && TITLE_HINT.test(firstSentence)) {
      data.currentTitle = firstSentence;
    }
  }

  const normalizedData: ParsedResume = {
    ...data,
    name: data.name ? normalizeOutputText(data.name) : null,
    phone: data.phone ? normalizeOutputText(data.phone) : null,
    email: data.email ? normalizeOutputText(data.email) : null,
    linkedin: data.linkedin ? normalizeOutputText(data.linkedin) : null,
    website: data.website ? normalizeOutputText(data.website) : null,
    country: data.country ? normalizeOutputText(data.country) : null,
    currentTitle: data.currentTitle ? normalizeOutputText(data.currentTitle) : null,
    experiences: data.experiences.map((exp) => ({
      ...exp,
      role: exp.role ? normalizeOutputText(exp.role) : null,
      company: exp.company ? normalizeOutputText(exp.company) : null,
      description: exp.description.map((d) => normalizeOutputText(d)).filter(Boolean),
    })),
    education: data.education.map((edu) => ({
      ...edu,
      degree: edu.degree ? normalizeOutputText(edu.degree) : null,
      school: edu.school ? normalizeOutputText(edu.school) : null,
      location: edu.location ? normalizeOutputText(edu.location) : null,
    })),
    skills: unique(data.skills.map((s) => normalizeOutputText(s)).filter(Boolean)).slice(0, 20),
  };

  return {
    data: normalizedData,
    warnings: unique(warnings),
    ...(opts.debug ? { debug: { lines, sections, blocks } } : {}),
  };
}

/**
 * Use GPT-4.1 Mini (or the configured model) to extract structured resume
 * data from raw text.  Called automatically when rule-based parsing extracts
 * no experiences and no education, and OPENAI_API_KEY is available.
 */
async function parseResumeWithLLM(rawText: string): Promise<ParsedResume | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !rawText.trim()) return null;

  try {
    const { default: OpenAI } = await import('openai') as { default: typeof import('openai').default };
    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

    const systemPrompt =
      'You are an expert resume parser. Extract structured data from resume text and return ONLY valid JSON. ' +
      'Be thorough — extract ALL work experience and education entries you can identify. ' +
      'The input text may be imperfectly formatted due to PDF column extraction issues.';

    const userPrompt = `Parse the following resume text and return a single JSON object matching this exact schema (use null for unknown fields):

{
  "name": "Full Name",
  "email": "email@example.com",
  "phone": "+65 9000 1234",
  "linkedin": "https://linkedin.com/in/username",
  "website": "https://portfolio.com",
  "country": "Singapore",
  "currentTitle": "Product Designer",
  "summary": "Brief professional summary if present",
  "experiences": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "startYear": 2020,
      "startMonth": 6,
      "endYear": 2023,
      "endMonth": 3,
      "isCurrent": false,
      "bullets": ["Achievement 1", "Achievement 2"]
    }
  ],
  "education": [
    {
      "school": "University Name",
      "degree": "Bachelor of Design",
      "startYear": 2016,
      "endYear": 2020
    }
  ],
  "skills": ["Figma", "Protopie", "HTML", "CSS"]
}

Resume text:
${rawText.slice(0, 6000)}`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '';
    if (!content) return null;

    const parsed = JSON.parse(content) as Record<string, unknown>;

    const toStrOrNull = (v: unknown): string | null => {
      const s = String(v ?? '').trim();
      return s && s !== 'null' ? s : null;
    };
    const toIntOrNull = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const experiences: ExperienceItem[] = (Array.isArray(parsed.experiences) ? parsed.experiences : []).map((e: Record<string, unknown>) => ({
      company: toStrOrNull(e.company),
      role: toStrOrNull(e.role),
      start: { month: toIntOrNull(e.startMonth), year: toIntOrNull(e.startYear) },
      end: { month: toIntOrNull(e.endMonth), year: toIntOrNull(e.endYear) },
      isCurrent: Boolean(e.isCurrent),
      description: Array.isArray(e.bullets)
        ? (e.bullets as unknown[]).map((b) => String(b ?? '').trim()).filter(Boolean)
        : [],
    }));

    const education: EducationItem[] = (Array.isArray(parsed.education) ? parsed.education : []).map((e: Record<string, unknown>) => ({
      school: toStrOrNull(e.school),
      degree: toStrOrNull(e.degree),
      location: null,
      start: { month: null, year: toIntOrNull(e.startYear) },
      end: { month: null, year: toIntOrNull(e.endYear) },
      isCurrent: false,
    }));

    const skills: string[] = Array.isArray(parsed.skills)
      ? (parsed.skills as unknown[]).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 20)
      : [];

    return {
      name: toStrOrNull(parsed.name),
      email: toStrOrNull(parsed.email),
      phone: toStrOrNull(parsed.phone),
      linkedin: toStrOrNull(parsed.linkedin),
      website: toStrOrNull(parsed.website),
      country: toStrOrNull(parsed.country),
      currentTitle: toStrOrNull(parsed.currentTitle),
      experiences,
      education,
      skills,
      summary: toStrOrNull(parsed.summary),
    };
  } catch (err) {
    console.warn('[parseResumePdf] LLM extraction failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function parseResumePdf(buffer: Buffer, opts: ParseOptions = {}): Promise<ParseResumePdfResult> {
  const lines = await extractLayoutAwareLines(buffer);
  const result = parseResumeFromLines(lines, opts);

  // Auto-trigger LLM when rule-based parsing clearly failed (no experiences
  // AND no education), or when explicitly requested via opts.useLlm.
  const ruleBasedFailed =
    result.data.experiences.length === 0 && result.data.education.length === 0;

  if ((opts.useLlm || ruleBasedFailed) && process.env.OPENAI_API_KEY) {
    const rawText = lines.map((l) => l.text).join('\n');
    const llmResult = await parseResumeWithLLM(rawText);
    if (llmResult) {
      if (llmResult.experiences.length > result.data.experiences.length) {
        result.data.experiences = llmResult.experiences;
      }
      if (llmResult.education.length > result.data.education.length) {
        result.data.education = llmResult.education;
      }
      if (llmResult.skills.length > result.data.skills.length) {
        result.data.skills = llmResult.skills;
      }
      if (!result.data.name && llmResult.name) result.data.name = llmResult.name;
      if (!result.data.email && llmResult.email) result.data.email = llmResult.email;
      if (!result.data.phone && llmResult.phone) result.data.phone = llmResult.phone;
      if (!result.data.linkedin && llmResult.linkedin) result.data.linkedin = llmResult.linkedin;
      if (!result.data.website && llmResult.website) result.data.website = llmResult.website;
      if (!result.data.country && llmResult.country) result.data.country = llmResult.country;
      if (!result.data.currentTitle && llmResult.currentTitle) result.data.currentTitle = llmResult.currentTitle;
      result.warnings.push('Used AI-assisted extraction for improved accuracy.');
    }
  }

  return result;
}

export function toResumeDataFromParsedResume(parsed: ParsedResume): ResumeData {
  const data = defaultResumeData(parsed.email ?? '');
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const unknownStart = { month: 1, year: 2020, present: false as const };
  const unknownEnd = { month: currentMonth, year: currentYear };

  data.bio = parsed.summary?.slice(0, 1200) ?? '';
  data.name = parsed.name ?? data.name;
  data.title = parsed.currentTitle ?? data.title;
  data.contact.phone = parsed.phone ?? '';
  data.contact.location = parsed.country ?? '';
  data.contact.linkedin = parsed.linkedin ?? '';
  data.contact.website = parsed.website ?? '';
  data.skills = parsed.skills.slice(0, 20);
  data.workExperience = parsed.experiences.map((exp, idx) => ({
    id: `exp-${idx + 1}`,
    company: exp.company ?? 'Unknown Company',
    role: exp.role ?? 'Unknown Role',
    startDate: (exp.start.month == null || exp.start.year == null)
      ? unknownStart
      : { month: exp.start.month, year: exp.start.year, present: false },
    endDate: (exp.end.month == null || exp.end.year == null)
      ? { ...unknownEnd, present: exp.isCurrent }
      : { month: exp.end.month, year: exp.end.year, present: exp.isCurrent },
    bullets: exp.description,
    projectNotes: '',
  }));

  data.education = parsed.education.map((edu, idx) => ({
    id: `edu-${idx + 1}`,
    degree: edu.degree ?? 'Degree',
    school: edu.school ?? 'School',
    location: edu.location ?? '',
    startDate: (edu.start.month == null || edu.start.year == null)
      ? unknownStart
      : { month: edu.start.month, year: edu.start.year, present: false },
    endDate: (edu.end.month == null || edu.end.year == null)
      ? { ...unknownEnd, present: edu.isCurrent }
      : { month: edu.end.month, year: edu.end.year, present: edu.isCurrent },
  }));

  return data;
}

export function inferResumeSummaryFromDebug(debug: { lines: ExtractedLine[]; sections: DetectedSection[] } | undefined): string | null {
  if (!debug) return null;
  const summary = inferSummary(debug.lines, debug.sections);
  return summary ? normalizeOutputText(summary) : null;
}
