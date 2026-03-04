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
  {
    type: 'experience',
    patterns: [
      /^(work\s+)?experience[s]?$/i,
      /^work$/i,                          // "Work" used as lone section heading
      /^workexperiences?$/i,              // camelCase merged "WorkExperience(s)"
      /^work\s*experiences?$/i,
      /professional\s+experience/i,
      /employment\s+history/i,
    ],
  },
  { type: 'education', patterns: [/^education$/i, /^academic\s+background$/i, /^qualifications?$/i] },
  { type: 'skills', patterns: [/^skills?$/i, /^skillset$/i, /^technical\s+skills?$/i, /^core\s+skills?$/i, /^software$/i, /^tools$/i, /^proficiency$/i, /^expertise$/i] },
  {
    type: 'other',
    patterns: [
      /^certifications?$/i, /^licenses?$/i, /^awards?$/i, /^recognition$/i, /^achievements?$/i,
      /^extra[\s-]?curricular(\s+activities?)?$/i,
      /^co[\s-]?curricular(\s+activities?)?$/i,
      /^activities$/i,
      /^involvement$/i,
      /^leadership$/i,
      /^volunteering?$/i,
    ],
  },
  { type: 'projects', patterns: [/^projects?$/i, /^selected\s+projects?$/i] },
  { type: 'summary', patterns: [/^summary$/i, /^profile$/i, /^about$/i, /^objective$/i, /^introduction$/i] },
  { type: 'contact', patterns: [/^contact$/i] },
];

const TITLE_HINT = /\b(designer|manager|engineer|intern|analyst|lead|director|specialist|consultant|architect|developer|coach|instructor|trainer|assistant|marketing)\b/i;
const COMPANY_HINT = /(inc\.?|pte\.?\s+ltd|llc|ltd\.?|corp\.?|technologies|university|college|institute|labs?)/i;
const DEGREE_HINT = /\b(bachelor|master|phd|diploma|certificate|degree|b\.?a\.?|b\.?sc\.?|bsc|bs|bba|m\.?a\.?|m\.?sc\.?|msc|m\.?s\.?|mba|hons|gce|gcse|o[\s-]?level|a[\s-]?level|n[\s-]?level)\b/i;
const SCHOOL_HINT = /(university|college|polytechnic|school|institute|academy)/i;
const AWARD_HINT = /(award|awards|recognition|achievement|certification|certificate|medal|honou?r|finalist|winner|first\s+place|second\s+place|third\s+place|issued\s+by)/i;
const COUNTRY_TOKEN_REGEX = /\b(singapore|malaysia|indonesia|thailand|vietnam|philippines|united kingdom|uk|united states|usa|australia|india|china|japan|canada)\b/i;
const ACTION_VERB_HINT = /^(led|conducted|partnered|worked|produced|rapidly|researched|designed|applied|redesigned|validated|created|drove|built|managed|launched|defined|optimized|improved)\b/i;
// Employment-type qualifiers that belong in the role string, e.g. "(Contract)", "(Freelance)".
// Matches variations like "Part-time", "Part - Time", "Part Time", "Full-time" etc.
const EMPLOYMENT_TYPE = /^(contract|freelance|part[-\s]*time|full[-\s]*time|temporary|temp|permanent|perm|secondment|attachment)$/i;
// Strong indicators that a parenthetical is a job title rather than a company qualifier.
const STRONG_ROLE_SUFFIX = /\b(intern|trainee|graduate|scholar)\b/i;

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

  // Separate year-dash-month so the month chars can be merged: "2019-F" → "2019 - F"
  // This allows "2019-F ebr uary" to reconstruct "February" via the char-stitching below.
  out = out.replace(/\b((?:19|20)\d{2})-([A-Za-z])/g, '$1 - $2');

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
  // Merge fragment suffixes when the second part is a recognizable English suffix (not a standalone word).
  // e.g. "Experie nces" -> "Experiences", "Desig ner" -> "Designer", "Design er" -> "Designer"
  // Using a whitelist of known suffix fragments avoids merging "creative side" -> "creativeside"
  out = out.replace(/\b([A-Za-z]{3,})\s+([a-z]{2,5})\b/g, (m, a: string, b: string) => {
    if (!/^(?:nces?|nce|ner|ners?|ing|ings|ance|ences?|tion|tions|ment|ments|ess|ist|ists|ism|ity|ure|age|ful|less|ness|ble|ives?|ous|ers?|est|ary|ory|ery|ate|ent|ents|ant|ants|al|ary|ize|ise|ify|ical|ial|ual|ous|ium|ary|ular|ward|ling|uary)$/i.test(b)) return m;
    return `${a}${b}`;
  });
  out = out.replace(/\s*-\s*/g, '-');
  out = out.replace(/([a-z])-([A-Z])/g, '$1 - $2');
  // Fix year digits split by char-by-char PDF encoding: "202 4" → "2024", "20 24" → "2024", "201 9" → "2019"
  out = out.replace(/\b((?:19|20)\d{0,2})\s+(\d{1,2})\b/g, (m, a: string, b: string) => {
    const combined = a + b;
    return /^(?:19|20)\d{2}$/.test(combined) ? combined : m;
  });
  // Fix month name splits common in char-by-char PDFs (full names)
  out = out
    .replace(/\bJan\s+uary\b/gi, 'January')
    .replace(/\bFebr\s+uary\b/gi, 'February')
    .replace(/\bMar\s+ch\b/gi, 'March')
    .replace(/\bApr\s+il\b/gi, 'April')
    .replace(/\bAugus\s+t\b/gi, 'August')
    .replace(/\bSep\s+tember\b/gi, 'September')
    .replace(/\bSept\s+ember\b/gi, 'September')
    .replace(/\bOct\s+ober\b/gi, 'October')
    .replace(/\bNov\s+ember\b/gi, 'November')
    .replace(/\bDec\s+ember\b/gi, 'December');
  // Fix 3-char month abbreviation splits: "M ay" → "May" (3-char merged result fails {4,20} test)
  out = out
    .replace(/\bM\s+ay\b/g, 'May')
    .replace(/\bJ\s+an\b/gi, 'Jan')
    .replace(/\bM\s+ar\b/gi, 'Mar')
    .replace(/\bJ\s+ul\b/gi, 'Jul')
    .replace(/\bA\s+ug\b/gi, 'Aug')
    .replace(/\bS\s+ep\b/gi, 'Sep')
    .replace(/\bO\s+ct\b/gi, 'Oct')
    .replace(/\bN\s+ov\b/gi, 'Nov')
    .replace(/\bD\s+ec\b/gi, 'Dec');
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
    // § marks a sub-column gap inserted by the PDF extractor.  For non-skills output:
    // • If what follows § starts with a dash, closing paren/bracket, or lowercase letter it is
    //   a mid-word or mid-parenthetical continuation — keep it (replace § with a space).
    //   e.g. "Industrial Designer (Part § - Time)" → "Industrial Designer (Part - Time)"
    // • Otherwise it is column-bleed from an adjacent layout column → truncate.
    .replace(/\s*§\s*([-);a-z])/g, ' $1')  // continuation: replace § with space
    .replace(/\s*§.*$/, '')                  // genuine column-bleed: truncate
    // Repair common OCR fragment where "Experience" is split with an interior uppercase join:
    // "UserEx perience" → "User Experience", "DesignerEx perience" → "Designer Experience"
    .replace(/([A-Za-z]+)Ex\s+perience\b/g, (_, pre) => `${pre} Experience`)
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
    // Strip leading day-of-month numbers so "22 February 2016" parses the same as "February 2016".
    .replace(/\b([012]?\d)\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/gi, '$2')
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
  // Strip trailing comma before matching (e.g. "Communication Designer (Contract),").
  const normalized = line.replace(/[–—]/g, '-').replace(/,\s*$/, '').trim();

  // Pattern: "Role (Company)" – company name in parentheses at the end of the line.
  // e.g. "UX/ UI Design Intern (Changi Airport Group)" → role=Intern, company=Changi...
  // Also handles camelCase roles: "WebDesigner (NUS)" → role="Web Designer", company="NUS".
  // Inverted case: "Company (Role)" – role inside parens, e.g. "Marketing Team (Graphic Design Intern)".
  const parentheticalMatch = normalized.match(/^(.*?)\s+\(([^)]+)\)\s*$/);
  if (parentheticalMatch?.[1] && parentheticalMatch?.[2]) {
    const beforeParen = parentheticalMatch[1].trim();
    const insideParen = parentheticalMatch[2].trim();
    // Expand camelCase (e.g. "WebDesigner" → "Web Designer") before checking TITLE_HINT.
    const beforeParenExpanded = beforeParen.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Employment-type qualifier: "(Contract)", "(Freelance)" etc. → append to role.
    // e.g. "Communication Designer (Contract)" → role="Communication Designer (Contract)".
    if (EMPLOYMENT_TYPE.test(insideParen) && TITLE_HINT.test(beforeParenExpanded)) {
      return { role: `${beforeParenExpanded} (${insideParen})`, company: null };
    }
    if (TITLE_HINT.test(beforeParenExpanded) && !TITLE_HINT.test(insideParen)) {
      return { role: beforeParenExpanded, company: insideParen };
    }
    // Strong role suffix in parens: "Marketing Team (Graphic Design Intern)" → role=insideParen.
    // This handles the inverted case where both sides have TITLE_HINT but insideParen is
    // definitively a role because it contains "intern"/"trainee"/"graduate".
    if (STRONG_ROLE_SUFFIX.test(insideParen) && !STRONG_ROLE_SUFFIX.test(beforeParen)) {
      return { role: insideParen, company: null };
    }
    // Inverted: company (role) – role keyword only in insideParen.
    if (TITLE_HINT.test(insideParen) && !TITLE_HINT.test(beforeParen) && !COMPANY_HINT.test(beforeParen)) {
      return { role: insideParen, company: null };
    }
  }

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
    const titleOnlyPrefix = companyWords.every((w) => /^(senior|sr|junior|jr|lead|principal|staff|product|ux|ui|industrial|software|growth|brand|design|service|creative|digital|data|research|graphic|visual|motion|web|university|college|institute|freelance)$/i.test(w));
    // hasStrongOrgSignal excludes university/college/institute so that "University Research Assistant"
    // is treated as a role phrase rather than split into company="University Research", role="Assistant".
    const hasStrongOrgSignal = companyWords.some((w) => /(inc\.?|pte\.?\s+ltd|llc|ltd\.?|corp\.?|technologies|labs?)/.test(w));
    if (titleOnlyPrefix && !hasStrongOrgSignal && words.length <= 6) {
      return { role: remainder, company: null };
    }
    if (companyWords.length > 1 && roleWords.length === 1 && /(industrial|product|graphic|ux|ui|software|senior|junior|lead|design|service|creative|digital|visual|motion|web)$/i.test(companyWords[companyWords.length - 1] ?? '')) {
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
  // Recognise various bullet-open markers used across different PDF encodings:
  // • U+2022 standard bullet  • - / * common text bullets
  // Ñ U+00D1  – Evelyn's PDF font encoding
  // È U+00C8  – Cheryl Pang's PDF font encoding
  // ↳ U+21B3  – Ziling's resume arrow bullets
  // + at line start – Cherie's resume
  // ● U+25CF  – Saffren Choo's PDF (BLACK CIRCLE, distinct from U+2022 BULLET)
  // ▪ U+25AA  – other common square bullet
  return /^[•\-*+\u2022\u00d1\u00c8\u21b3\u2197\u25cf\u25aa]|^\d+\./.test(text.trim());
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

/** Returns true when a short text is PURELY a location (city, country, or work-mode). */
function looksLikeLocation(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  if (COMPANY_HINT.test(t)) return false;
  if (TITLE_HINT.test(t)) return false;
  const LOCATION_ONLY = /^(?:singapore|hong\s+kong|malaysia|indonesia|thailand|philippines|vietnam|india|china|japan|united\s+kingdom|uk|united\s+states|usa|australia|canada|germany|france|new\s+zealand|remote|hybrid|onsite)(?:\s*,\s*(?:singapore|hong\s+kong|malaysia|indonesia|thailand|philippines|vietnam|india|china|japan|united\s+kingdom|uk|united\s+states|usa|australia|canada|germany|france|new\s+zealand|remote|hybrid|onsite))*$/i;
  return LOCATION_ONLY.test(t);
}

function looksExperienceOrgLine(text: string): boolean {
  if (looksLikeLocation(text)) return false;
  if (text.length > 60) return false; // company names are short; reject long sentences
  if (!/^[A-Z(']/.test(text.trim())) return false; // org names start with uppercase or quote
  // If the text has a job-title keyword AND no strong incorporated-entity signal (like "Pte Ltd",
  // "Inc", "Corp"), it is more likely a role description (e.g. "University Research Assistant")
  // than a company name.
  const hasStrongCompanySignal = /(inc\.?|pte\.?\s+ltd|llc|ltd\.?|corp\.?|technologies|labs?)/.test(text);
  if (!hasStrongCompanySignal && TITLE_HINT.test(text)) return false;
  if (COMPANY_HINT.test(text)) return true;
  return /\b(group|studio|agency|labs?|school|club|centre|university|college|academy|technologies|hong\s+kong|design|creatives?)\b/i.test(text);
}

function looksEducationSchoolLine(text: string): boolean {
  if (SCHOOL_HINT.test(text)) return true;
  // Location token can hint at a school name only when it's not a pure location string
  // (e.g. "Singapore Polytechnic" ✓ but "Singapore" alone ✗).
  return /\b(singapore|hong\s+kong|united\s+kingdom|uk)\b/i.test(text) && !looksLikeLocation(text);
}

function dateWeight(value: MonthYear, isCurrent: boolean): number {
  if (isCurrent) return Number.MAX_SAFE_INTEGER;
  const y = value.year ?? 0;
  const m = value.month ?? 0;
  return y * 100 + m;
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

  const sorted = spans.sort((a, b) => {
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
    // If the horizontal gap is very large (> 100 pts) the two spans are almost certainly in
    // different layout columns.  Keep them as separate lines so the column-reorder logic in
    // parseResumeFromLines can place them in the correct section order.
    // Similarly, if the span starts far to the LEFT of the current line's end (gap < -20 pts),
    // the span belongs to a different visual column that was sorted before/after the current
    // one — treat it as a new line to prevent concatenation like "Service DesignUser Research".
    if (gap > 100 || gap < -20) {
      lines.push({ ...span });
      continue;
    }
    // When the gap is in the "sub-column" range (larger than a single word-space but still
    // within 100 pts), insert a § separator so parseSkillsFromSections can split the
    // concatenated skills from a 2-column skill grid.
    // Empirical data: Yuan Jie's 8.4pt skill items have ~8pt inter-item gaps; normal word
    // spaces at that size are ~2.5pt.  Using 6 pt as the fixed threshold safely covers
    // 8-pt gaps without triggering on typical 2-5 pt word spaces.
    // normalizeOutputText() strips any stray § from non-skills output fields.
    const isSubColumnGap = gap > 6;
    const needsSpace = gap > -3;
    const spacer = isSubColumnGap ? ' § ' : (needsSpace ? ' ' : '');
    last.text = cleanLineText(`${last.text}${spacer}${span.text}`);
    last.x1 = Math.max(last.x1, span.x1);
    last.y1 = Math.max(last.y1, span.y1);
    last.fontSize = Math.max(last.fontSize ?? 10, span.fontSize ?? 10);
  }

  return lines.filter((line) => line.text.length > 0);
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
  // Strip trailing punctuation that can appear on section headings in styled resumes
  // (e.g. "work.", "skills.", "education." used in Cherie-style minimalist layouts)
  const text = line.text.toLowerCase().replace(/[:\-\.!?]+$/, '').trim();
  const key = headingKey(text);
  const looksHeading = text.length <= 40 && text.split(/\s+/).length <= 4;

  if (looksHeading) {
    for (const rule of SECTION_KEYWORDS) {
      if (rule.patterns.some((p) => p.test(text))) return rule.type;
      if (rule.patterns.some((p) => p.test(key))) return rule.type;
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

  // Handle section headers merged with first entry content (e.g. "Education Diploma in ...").
  // Only match when the first word is a known section keyword AND the remainder looks like
  // entry content (degree/school/date/company), not a skill or role description.
  const firstWord = text.split(/\s+/)[0] ?? '';
  const remainder = text.slice(firstWord.length).trim();
  if (/^education$/i.test(firstWord) && remainder.length > 0) return 'education';
  if (/^experience$/i.test(firstWord) && remainder.length > 0) {
    // Only classify as merged experience section header if the remainder contains an actual
    // entry signal (date, company indicator, or role title) — not a skill description.
    if (hasDateText(remainder) || COMPANY_HINT.test(remainder) || TITLE_HINT.test(remainder)) {
      return 'experience';
    }
  }
  if (/^skills?$/i.test(firstWord) && remainder.length > 0) return 'skills';
  if (/^skillset$/i.test(firstWord) && remainder.length > 0) return 'skills';

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

  // Post-process: when the contact section spans many lines and no experience section was
  // detected before the first skills/education section, scan for "Role / Date" pattern lines
  // (e.g. "UX Manager / 03 October 2016-Present") and inject an implied experience section.
  const contactIdx = sections.findIndex((s) => s.type === 'contact');
  if (contactIdx >= 0) {
    const contact = sections[contactIdx];
    const contactLineCount = contact.endIdx - contact.startIdx + 1;
    if (contactLineCount > 12) {
      let firstExpLine = -1;
      for (let i = contact.startIdx + 1; i <= contact.endIdx; i += 1) {
        const text = lines[i]?.text ?? '';
        const slashIdx = text.indexOf(' / ');
        if (slashIdx > 0) {
          const leftPart = text.slice(0, slashIdx).trim();
          const rightPart = text.slice(slashIdx + 3).trim();
          if (TITLE_HINT.test(leftPart) && hasDateText(rightPart)) {
            // The company line is typically one line above the role/date line.
            firstExpLine = Math.max(contact.startIdx + 3, i - 1);
            break;
          }
        }
      }
      if (firstExpLine > contact.startIdx + 2) {
        const expEndIdx = contact.endIdx;
        sections[contactIdx] = { ...contact, endIdx: firstExpLine - 1 };
        sections.splice(contactIdx + 1, 0, { type: 'experience', startIdx: firstExpLine, endIdx: expEndIdx });
      }
    }
  }

  return sections;
}

function looksDateAnchor(line: ExtractedLine): boolean {
  const t = line.text;
  const date = parseDateRange(t);
  if (!date.hasAnyDate && !/\bpresent\b/i.test(t)) return false;
  if (t.length > 70 && !/\d{4}/.test(t)) return false;
  // Prose-sentence guard: lines that end with a full-stop or start with a lowercase letter AND
  // contain 4+ non-date words are descriptive bullets/sentences, not date anchors.
  // e.g. "of an exhibition piece featured at Singapore Design Week 2022." → NOT a date anchor.
  // e.g. "design for Tan Ean Kiam Arts Awards 2023" (starts lowercase) → NOT a date anchor.
  const nonDateWords = t.split(/\s+/).filter(
    (w) => !/^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|(19|20)\d{2}|present|current|now|[-–—])$/i.test(w),
  );
  if (nonDateWords.length >= 4 && (/[.]$/.test(t.trim()) || /^[a-z]/.test(t.trim()))) return false;
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

    const boundaryByDate = looksDateAnchor(line) && (line.x0 > xMid || current.length >= 2);
    const boundaryByGap = yGap > 22 && current.length > 0;
    const roleLikeHeader = section.type === 'experience' && looksExperienceEntryHeader(line.text);
    const schoolLikeHeader = section.type === 'education'
      && (DEGREE_HINT.test(line.text) || SCHOOL_HINT.test(line.text))
      && !isBulletText(line.text)
      && !hasDateText(line.text);
    const hasEntryContent = current.some((l) => isBulletText(l.text) || ACTION_VERB_HINT.test(l.text));
    const boundaryByHeader = current.length > 0 && (roleLikeHeader || schoolLikeHeader) && hasEntryContent && (yGap > 10 || current.some((l) => isBulletText(l.text)));
    // For education sections that use "School / dates" slash format: when a degree-like line
    // appears after a slash-format date line, it's the start of a new entry (not a continuation).
    const prevHasSlashDate = section.type === 'education' && current.some((l) => {
      const si = l.text.indexOf(' / ');
      return si > 0 && hasDateText(l.text.slice(si + 3));
    });
    const boundaryByNewEdEntry = prevHasSlashDate
      && DEGREE_HINT.test(line.text)
      && !hasDateText(line.text)
      && !isBulletText(line.text);

    if ((boundaryByDate || boundaryByGap || boundaryByHeader || boundaryByNewEdEntry) && current.length > 0) {
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

      // Orphaned header merge: when current block has NO date (no bullets either) and the
      // next block starts with a date, the current block is a "Company / Location / Role"
      // header that got split off. Move all its non-action lines to the front of next.
      const nextStartsWithDate = next.lines.length > 0 && looksDateAnchor(next.lines[0]);
      if (!currentHasDate && !currentHasBullets && nextStartsWithDate && current.lines.length <= 6) {
        const headerLines = current.lines.filter((l) => !ACTION_VERB_HINT.test(l.text) && !isBulletText(l.text));
        if (headerLines.length > 0) {
          next.lines.unshift(...headerLines);
          current.lines = current.lines.filter((l) => !headerLines.includes(l));
          continue;
        }
      }
    }

    const nextHead = next.lines[0].text;
    const needAttachPrevHeader =
      hasDateText(nextHead) ||
      (next.section === 'experience' && TITLE_HINT.test(nextHead)) ||
      (next.section === 'education' && (DEGREE_HINT.test(nextHead) || hasDateText(nextHead)));
    if (!needAttachPrevHeader) continue;
    if (next.section === 'experience') {
      // Only skip if the next block already has BOTH a role AND a company/org line.
      // If it has a role but no company, we still need to look for a company in current's tail.
      const nextHasRoleLine = next.lines.some((l, idx) =>
        idx < 3 && !hasDateText(l.text) && !isBulletText(l.text) && looksExperienceEntryHeader(l.text),
      );
      const nextHasOrgLine = next.lines.some((l, idx) =>
        idx < 5 && !hasDateText(l.text) && !isBulletText(l.text) && looksExperienceOrgLine(l.text),
      );
      if (nextHasRoleLine && nextHasOrgLine) continue;
    }

    const nextHeadHasDate = hasDateText(next.lines[0]?.text ?? '');
    const nextHeadIsRole = TITLE_HINT.test(nextHead) && !hasDateText(nextHead);

    let moveIdx = -1;
    for (let j = current.lines.length - 1; j >= Math.max(0, current.lines.length - 5); j -= 1) {
      const cand = current.lines[j];
      const text = cand.text;
      if (hasDateText(text)) continue;
      if (isBulletText(text)) continue;
      const strictAcceptable = next.section === 'experience'
        ? (looksExperienceOrgLine(text) && !TITLE_HINT.test(text))
        : looksEducationSchoolLine(text);
      // Looser fallback: trailing short non-title/non-location/non-action line is likely a company name.
      const looseAcceptable = next.section === 'experience'
        && (nextHeadHasDate || nextHeadIsRole)
        && !TITLE_HINT.test(text)
        && !ACTION_VERB_HINT.test(text)
        && !looksLikeLocation(text)
        && text.length >= 2
        && text.length <= 80
        && !/[.!?]$/.test(text);
      if (strictAcceptable || looseAcceptable) {
        moveIdx = j;
        break;
      }
    }
    if (moveIdx >= 0) {
      // Also grab any immediately-following header lines (location, role) that belong
      // to the same entry as the company — stop at first bullet, action verb, or long prose.
      let moveEnd = moveIdx + 1;
      while (moveEnd < current.lines.length) {
        const t = current.lines[moveEnd].text;
        if (isBulletText(t) || ACTION_VERB_HINT.test(t) || hasDateText(t)) break;
        if (t.length > 80 || /[.!?]$/.test(t)) break;
        moveEnd += 1;
      }
      const toMove = current.lines.slice(moveIdx, moveEnd);
      next.lines.unshift(...toMove);
      current.lines.splice(moveIdx, moveEnd - moveIdx);
    }
  }

  // Second pass: move a trailing role-like header from the end of one block to the front of
  // the next block when the next block has no role line yet.  This handles PDFs where the
  // role label for entry N appears as the last line of entry N-1's block (e.g. Edwind's PDF).
  for (let i = 0; i < out.length - 1; i += 1) {
    const current = out[i];
    const next = out[i + 1];
    if (current.section !== 'experience' || next.section !== 'experience') continue;
    if (current.lines.length === 0 || next.lines.length === 0) continue;
    const nextHasRoleLine = next.lines.some((l, idx) =>
      idx < 3 && !hasDateText(l.text) && !isBulletText(l.text) && looksExperienceEntryHeader(l.text),
    );
    if (nextHasRoleLine) continue;
    const lastLine = current.lines[current.lines.length - 1];
    if (
      lastLine
      && looksExperienceEntryHeader(lastLine.text)
      && !hasDateText(lastLine.text)
      && !isBulletText(lastLine.text)
    ) {
      next.lines.unshift(lastLine);
      current.lines.pop();
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

  // For multi-column resumes, the first line may be a merged navigation bar like
  // "Introduction Experience DEBBIE NG SI MIN". Extract the all-caps suffix as the name.
  function extractNameFromMergedLine(text: string): string | null {
    const caps = text.match(/\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,3})\s*$/);
    if (!caps?.[1]) return null;
    const candidate = caps[1].trim();
    if (/^(EXPERIENCE|EDUCATION|SKILLS|PROJECTS|ABOUT|CONTACT|SUMMARY|INTRODUCTION)$/i.test(candidate)) return null;
    if (candidate.split(/\s+/).length < 2) return null;
    return candidate.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b([A-Z]{2,})\b/g, (t) =>
      t.slice(0, 1) + t.slice(1).toLowerCase(),
    );
  }

  // Candidate pool: first 12 lines of contact section + first 12 lines of whole document,
  // so that resumes with tiny contact sections (e.g. only 2 lines) can still find the name.
  const allTop = allLines.filter((l) => l.page === 1).slice(0, 12);
  const combinedTop = [...new Set([...top, ...allTop])];  // dedup while preserving order

  const nameCandidate = [...combinedTop]
    .filter((line) => !/@/.test(line.text) && !/\d{3,}/.test(line.text) && !/https?:\/\//i.test(line.text) && !/linkedin/i.test(line.text))
    .filter((line) => !isBulletText(line.text))
    .filter((line) => !TITLE_HINT.test(line.text))
    .filter((line) => !DEGREE_HINT.test(line.text))
    // Exclude greeting lines: use simple word-boundary check so we aren't tripped up by smart-quote apostrophes
    .filter((line) => !/^(hi\b|hello\b|hey\b|i\s+am\b)/i.test(line.text.trim()))
    .filter((line) => !/\b(resume|curriculum\s+vitae|\bcv\b)\b/i.test(line.text))
    // Filter academic discipline field names like "Industrial Design", "Computer Science"
    .filter((line) => !/\b(design|engineering|sciences?|technology|computing|innovation|management)\s*$/i.test(line.text.trim()))
    // Names have ALL words starting with uppercase (filters "grounded in User", "aStoryteller and" etc.)
    .filter((line) => {
      const asciiWords = line.text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
      return asciiWords.length > 0 && asciiWords.every((w) => /^[A-Z]/.test(w));
    })
    .filter((line) => line.text.split(/\s+/).length >= 2 && line.text.split(/\s+/).length <= 5)
    .sort((a, b) => (b.fontSize ?? 12) - (a.fontSize ?? 12))[0];

  // Fallback: two adjacent single-word TitleCase lines that together form a full name.
  // E.g. "Edwind" (line 0) + "Tan." (line 1) → "Edwind Tan"
  const adjacentNameCandidate = (() => {
    for (let i = 0; i < combinedTop.length - 1; i++) {
      const a = (combinedTop[i]?.text ?? '').trim().replace(/[.,!?:;]+$/, '');
      const b = (combinedTop[i + 1]?.text ?? '').trim().replace(/[.,!?:;]+$/, '');
      if (!a || !b) continue;
      if (a.split(/\s+/).length !== 1 || b.split(/\s+/).length !== 1) continue;
      if (!/^[A-Z]/.test(a) || !/^[A-Z]/.test(b)) continue;
      if (/[@\d\/:]/.test(a) || /[@\d\/:]/.test(b)) continue;
      if (TITLE_HINT.test(a) || TITLE_HINT.test(b)) continue;
      if (DEGREE_HINT.test(a) || DEGREE_HINT.test(b)) continue;
      if (/^(experience|education|skills|work|contact|summary|about|projects|introduction)$/i.test(a)) continue;
      if (/^(experience|education|skills|work|contact|summary|about|projects|introduction)$/i.test(b)) continue;
      return `${a} ${b}`;
    }
    return null;
  })();

  // Fallback: detect camelCase single-word names (e.g. "CherylPang" → "Cheryl Pang")
  // Used when the PDF merges first/last name into one word with interior uppercase.
  const camelCaseNameCandidate = (() => {
    for (const line of combinedTop.slice(0, 8)) {
      const t = line.text.trim();
      if (!/^[A-Za-z]+$/.test(t)) continue;           // letters only (no digits, punctuation)
      if (!/^[A-Z]/.test(t)) continue;                 // must start uppercase
      if (!/[a-z][A-Z]/.test(t)) continue;             // must have an interior uppercase boundary
      if (TITLE_HINT.test(t) || DEGREE_HINT.test(t)) continue;
      const split = t.replace(/([a-z])([A-Z])/g, '$1 $2');
      const parts = split.split(' ');
      if (parts.length < 2 || parts.length > 3) continue;
      if (parts.some((p) => (p?.length ?? 0) < 2)) continue;
      return split;
    }
    return null;
  })();

  // Always try to extract a name from a merged navigation bar line (e.g. "Intro Experience DEBBIE NG").
  // This has higher confidence than a plain short line for resumes with nav bars.
  const mergedNameCandidate = top.reduce((found: string | null, line) => {
    if (found) return found;
    if (line.text.split(/\s+/).length <= 5) return null; // short lines already handled by nameCandidate
    return extractNameFromMergedLine(line.text);
  }, null);

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

  // Prefer merged nav-bar name over plain candidate (nav bar is more reliable for styled resumes).
  let name = mergedNameCandidate ?? nameCandidate?.text ?? camelCaseNameCandidate ?? adjacentNameCandidate ?? null;

  // Post-process: strip Chinese/CJK suffix and "|" separator
  // e.g. "Loo Zi Ling | 呂紫寧" → "Loo Zi Ling"
  if (name) {
    name = name.replace(/\s*[|\/]\s*[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff].*/u, '').trim();
    name = name.replace(/\s+[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff].*/u, '').trim();
    // Strip trailing punctuation from name (e.g. "Loo Zi Ling.")
    name = name.replace(/[.,!?:;]+$/, '').trim();
  }

  if (!name && email) {
    const rawLocal = email.split('@')[0] ?? '';
    // Strip trailing digits that are often appended to email handles (e.g. "edwindtan13" → "edwindtan")
    const local = rawLocal.replace(/\d+$/, '');
    const tokens = local
      .split(/[._-]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, 1).toUpperCase() + t.slice(1).toLowerCase());
    if (tokens.length >= 1) name = tokens.join(' ');
  }
  let currentTitle: string | null = null;
  if (mergedNameCandidate) {
    // When name comes from a merged nav bar, the title is typically the first short non-nav,
    // non-contact-info line immediately after the nav bar.
    const navBarLine = top.find((l) => extractNameFromMergedLine(l.text) === mergedNameCandidate);
    const afterNav = navBarLine ? top.filter((l) => l !== navBarLine) : top;
    currentTitle = afterNav.find((l) =>
      !/@|\+?\d{4,}|https?:\/\//i.test(l.text)
      && !/^References/i.test(l.text)
      && l.text.split(/\s+/).length <= 6
      && l.text.length <= 60,
    )?.text ?? null;
  } else if (nameCandidate) {
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

  // Pre-clean: strip PDF bullet-close markers and adjacent-column bleed content.
  // Ç (U+00C7) – Evelyn's PDF encoding  © (U+00A9) – Cheryl Pang's PDF encoding
  // Also strip ASCII control characters that sometimes leak in from PDF encoding.
  const cleanedLines = lines.map((l) => ({
    ...l,
    text: l.text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\s*[\u00c7\u00a9].*$/, '')
      .trim() || l.text.trim(),
  }));

  const bulletBaseX = cleanedLines
    .filter((l) => isBulletText(l.text))
    .map((l) => l.x0)
    .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;

  for (const line of cleanedLines) {
    const text = line.text.trim();
    if (!text) continue;
    if (/^\+?\s*add\s+/i.test(text)) continue;

    if (isBulletText(text)) {
      // Strip all leading bullet markers (Ñ/È/↳/+ PDF-encoded and standard)
      bullets.push(text.replace(/^[•\-*+\u2022\u00d1\u00c8\u21b3\u2197\d.\s]+/, '').trim());
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

  // Handle "Role / Date Range" combined lines (e.g. "UX Manager / 03 October 2016-Present").
  let roleFromSlashFormat: string | null = null;
  let slashDateText: string | null = null;
  if (dateLine) {
    const slashIdx = dateLine.text.indexOf(' / ');
    if (slashIdx > 0) {
      const leftPart = dateLine.text.slice(0, slashIdx).trim();
      const rightPart = dateLine.text.slice(slashIdx + 3).trim();
      if (TITLE_HINT.test(leftPart) && hasDateText(rightPart)) {
        roleFromSlashFormat = removeDateFragments(leftPart);
        // Parse dates from the right-hand side only to avoid false-positive "-" matches
        // in the role text (e.g. "UX Lead (Singapore)-User Experience Group Asia").
        slashDateText = rightPart;
      }
    }
  }

  const dateInfo = parseDateRange(slashDateText ?? dateLine?.text ?? '');

  const roleFromDateLine = roleFromSlashFormat ?? (() => {
    if (!dateLine) return null;
    const cleaned = removeDateFragments(dateLine.text);
    return TITLE_HINT.test(cleaned) ? cleaned : null;
  })();

  // If the date anchor line has text remaining after removing the date, that text is a
  // strong candidate for the company name.
  // e.g. "Shopee Dec 2021-May 2023" → "Shopee"
  // e.g. "Keppel Land | Part-time | Apr 2022-Apr 2023" → "Keppel Land" (strip pipe-separated tokens)
  const companyFromDateLine = (() => {
    if (!dateLine) return null;
    let remainder = removeDateFragments(dateLine.text).trim();
    if (!remainder) return null;
    // Strip pipe-separated job-type/mode suffixes (e.g. "Shopee | Internship |" → "Shopee").
    remainder = remainder.replace(/\s*\|.*/s, '').trim();
    if (!remainder || TITLE_HINT.test(remainder) || hasDateText(remainder)) return null;
    if (/^\(/.test(remainder)) return null;  // duration fragments like "(8 months)"
    if (!/^[A-Z'"]/.test(remainder)) return null;  // company names start with uppercase
    return remainder;
  })();

  const stitched = stitchBullets(lines);
  const bulletLines = stitched.bullets.filter(Boolean);

  const contentLines = stitched.prose
    .filter((t) => !looksDateAnchor({ ...lines[0], text: t }))
    .filter((t) => !isBulletText(t))
    .filter((t) => !/^\+?\s*add\s+/i.test(t));

  let role: string | null = null;
  let company: string | null = null;

  if (roleFromSlashFormat) {
    role = roleFromSlashFormat;
  } else {
    const mixed = dateLine ? parseRoleCompanyFromMixedLine(dateLine.text) : { role: null, company: null };
    role = mixed.role;
    company = mixed.company;
  }

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
    const left = parts[0]?.trim() || null;
    const right = parts.slice(1).join(' - ').trim() || null;
    // Guard: don't split if the left part has an unclosed parenthetical.
    // e.g. "Industrial Designer (Part - Time)" splits to left="Industrial Designer (Part"
    // which is wrong — the " - " is inside a parenthetical, not a role/company separator.
    const leftOpenParens = (left?.match(/\(/g) ?? []).length;
    const leftCloseParens = (left?.match(/\)/g) ?? []).length;
    if (left && leftOpenParens <= leftCloseParens) {
      const leftWords = left.split(/\s+/).length;
      const rightWords = right?.split(/\s+/).length ?? 0;
      if (right && !TITLE_HINT.test(left) && rightWords > leftWords + 1) {
        role = right;
        company = left;
      } else {
        role = left;
        company = right;
      }
    }
  }

  if (!role || !company) {
    const candidates = contentLines.filter((t) => !ACTION_VERB_HINT.test(t)).slice(0, 4);
    role = role ?? candidates.find((t) => TITLE_HINT.test(t)) ?? null;
    company = company ?? candidates.find((t) =>
      looksExperienceOrgLine(t)
      && !/[.:]/.test(t)
      && t.length <= 80
      && !EMPLOYMENT_TYPE.test(t),
    ) ?? null;
    if (!role && candidates.length > 0) role = candidates[0] ?? null;
    // Only use candidates[1] as fallback company if it's short enough to be a name (not prose)
    // AND it is a different string from role (to avoid setting company = role when the same
    // text (e.g. "Product Designer II") was already assigned to both slots).
    if (!company && candidates.length > 1) {
      const c1 = candidates[1] ?? null;
      // Don't use a bare employment-type word (e.g. "Freelance") as the company fallback.
      if (c1 && c1 !== role && c1.length <= 60 && !EMPLOYMENT_TYPE.test(c1)) company = c1;
    }
  }

  // If company was set to a location string, clear it and find the real company name.
  if (company && looksLikeLocation(company)) {
    company = contentLines.find((t) =>
      !looksLikeLocation(t)
      && !hasDateText(t)
      && !isBulletText(t)
      && !ACTION_VERB_HINT.test(t)
      && t !== role
      && t.length <= 80
      && !/[.!?]$/.test(t),
    ) ?? null;
  }

  // Fallback: if role found but no company, pick first short non-role, non-location line.
  // Use a word-count limit (≤ 6 words) to exclude prose/description sentences.
  // Exclude bare employment-type words (e.g. "Freelance") from being used as the company.
  if (role && !company) {
    company = contentLines.find((t) =>
      t !== role
      && !looksLikeLocation(t)
      && !hasDateText(t)
      && !isBulletText(t)
      && !ACTION_VERB_HINT.test(t)
      && t.split(/\s+/).length <= 6
      && !/[.!?]$/.test(t)
      && !EMPLOYMENT_TYPE.test(t),
    ) ?? null;
  }

  const firstNonDate = contentLines.find((t) => !hasDateText(t)) ?? null;
  if (role && company && role === company && firstNonDate) {
    const split = parseRoleCompanyFromMixedLine(firstNonDate);
    role = split.role ?? role;
    company = split.company ?? company;
  }
  // If role and company are still identical and the value looks like an org name (not a title),
  // it was set as a fallback from a company-only block — clear role so only company is kept.
  // e.g. "STUCK Design" block → role=null, company="STUCK Design".
  if (role && company && role === company && looksExperienceOrgLine(role) && !TITLE_HINT.test(role)) {
    role = null;
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
  // Only promote role→company when roleFromDateLine is a DIFFERENT string; if they're the same
  // (e.g. both come from the slash-format line), swapping achieves nothing and causes bad data.
  if (role && looksExperienceOrgLine(role) && roleFromDateLine && role !== roleFromDateLine) {
    if (!company || !looksExperienceOrgLine(company)) company = role;
    role = roleFromDateLine;
  }
  if (!role && roleFromDateLine) role = roleFromDateLine;
  if (company && TITLE_HINT.test(company) && !COMPANY_HINT.test(company)) company = null;
  if (!company) {
    company = contentLines.find((t) => looksExperienceOrgLine(t) && !TITLE_HINT.test(t) && !hasDateText(t) && !isBulletText(t) && !/[.:]/.test(t) && t.length <= 80 && !EMPLOYMENT_TYPE.test(t)) ?? null;
    company = company ? removeDateFragments(company) : null;
  }
  // firstOrgLikeLine: only genuine org names (not role-like headers, not prose sentences ending with punctuation).
  const firstOrgLikeLine = contentLines.find((t) => looksExperienceOrgLine(t) && !TITLE_HINT.test(t) && !hasDateText(t) && !isBulletText(t) && !/[.:]/.test(t) && !EMPLOYMENT_TYPE.test(t)) ?? null;
  if (firstOrgLikeLine && (!company || !looksExperienceOrgLine(company))) {
    company = removeDateFragments(firstOrgLikeLine);
  }

  // Company fallback: use text remaining from the date anchor line
  // (e.g. "Shopee" from "Shopee Dec 2021-May 2023", "Keppel Land" from "Keppel Land | Part-time | dates").
  if (!company && companyFromDateLine && !looksLikeLocation(companyFromDateLine) && !AWARD_HINT.test(companyFromDateLine)) {
    company = companyFromDateLine;
  }
  // Override wrongly-parsed company (from role-splitting) with the date-anchor company when available.
  // e.g. role="Marketing Creative Designer", company="Brand & Growth" → use companyFromDateLine "Shopee" instead.
  if (companyFromDateLine && company !== companyFromDateLine && !looksExperienceOrgLine(company ?? '') && !looksLikeLocation(companyFromDateLine) && !AWARD_HINT.test(companyFromDateLine)) {
    company = companyFromDateLine;
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
  // Drop contact-info blocks: when there are no dates AND the role has no job-title keywords.
  // This catches contact lines that leak into the experience section (e.g. "Saffren Choo Jing Xuan").
  if (item.start.year === null && item.end.year === null && !item.isCurrent
    && !TITLE_HINT.test(item.role ?? '') && !TITLE_HINT.test(item.company ?? '')) {
    warnings.push(`Dropped no-date/no-title block #${idx + 1} (likely contact info).`);
    return null;
  }
  // Drop spurious continuation blocks: role starts with lowercase (prose fragment) or is a
  // parenthetical duration "(8 months |)", and company also has no title/org signal.
  const roleBad = !item.role || (!TITLE_HINT.test(item.role) && /^[a-z(]/.test(item.role.trim()));
  const companyBad = !item.company || (!TITLE_HINT.test(item.company) && !looksExperienceOrgLine(item.company) && /^[a-z(]/.test(item.company.trim()));
  // Also treat a company that ends with sentence-terminal punctuation as "bad":
  // e.g. "Singapore Design Week 2022." is not a real company name.
  const companyEndsPunct = Boolean(item.company && /[.!]$/.test(item.company.trim()));
  if (roleBad && (companyBad || companyEndsPunct)) {
    warnings.push(`Dropped spurious continuation block #\${idx + 1} (no job-title signal).`);
    return null;
  }
  // Drop bio/profile blocks where role is a single non-title word (e.g. nationality "Singaporean").
  if (item.role && item.role.split(/\s+/).length === 1 && !TITLE_HINT.test(item.role)) {
    warnings.push(`Dropped single-word non-title role block #\${idx + 1} (${item.role}).`);
    return null;
  }
  // Drop garbled or non-experience blocks with no company and no job-title signal in role.
  if (item.start.year && !item.company && !TITLE_HINT.test(item.role ?? '') && !item.isCurrent) {
    warnings.push(`Dropped no-company/no-title-hint block #\${idx + 1}.`);
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

  // Merge single-char uppercase degree prefixes with the next line
  // e.g. ["B", "(Hons) Industrial Design"] → ["B(Hons) Industrial Design"].
  const texts = (() => {
    const raw = lines.map((l) => l.text);
    const merged: string[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const cur = raw[i] ?? '';
      const next = raw[i + 1] ?? '';
      if (/^[A-Z]{1,2}$/.test(cur) && next && DEGREE_HINT.test(next)) {
        merged.push(cur + next);
        i += 1;
      } else {
        merged.push(cur);
      }
    }
    return merged;
  })();
  const dateLine = lines.find((l) => looksDateAnchor(l));
  const dateInfo = parseDateRange(dateLine?.text ?? '');

  let school = texts.find((t) => SCHOOL_HINT.test(t)) ?? null;
  let degree = texts.find((t) => DEGREE_HINT.test(t)) ?? null;
  let location = texts.find((t) => /,/.test(t) && !/\d/.test(t) && !SCHOOL_HINT.test(t)) ?? null;

  if (dateLine) {
    const afterDate = stripDatePrefix(dateLine.text);
    if (afterDate && !school) school = afterDate;
  }

  // Don't use texts[0] as school fallback if it is a degree phrase (e.g. "Bachelor of Arts,").
  if (!school && texts.length > 0 && !DEGREE_HINT.test(texts[0] ?? '')) school = texts[0] ?? null;
  // Exclude bullet-text lines from being used as a fallback degree (e.g. "+ Dean's List").
  // Only use texts[1] as degree fallback if it is short (≤ 6 words), not bullet, not date.
  // Long lines are description/prose text, not degree titles.
  if (!degree && texts.length > 1 && !isBulletText(texts[1] ?? '') && !hasDateText(texts[1] ?? '') && (texts[1] ?? '').split(/\s+/).length <= 6) degree = texts[1] ?? null;
  if (!degree) {
    const degreeLike = texts.find((t) =>
      /\b(bsc|b\.?sc\.?|bachelor|hons|marketing|management|engineering|design|science|arts|business)\b/i.test(t)
      && !SCHOOL_HINT.test(t)
      // Exclude sentence fragments: lines ending with a preposition/connector or exceeding 8 words.
      && !/\b(to|in|and|of|for|the|a|an|at|by|from|with|that|like|or)\s*$/i.test(t)
      && t.split(/\s+/).length <= 8,
    ) ?? null;
    if (degreeLike) degree = degreeLike;
  }

  // If the degree line ends with a conjunction ("and", ",") append the immediately-following
  // line when it is not a date, school, or another degree (handles multi-line degree names
  // like "Diploma in Visual Communication and" + "Media Design").
  if (degree) {
    const degreeIdx = texts.indexOf(degree);
    const nextText = degreeIdx >= 0 ? (texts[degreeIdx + 1] ?? '') : '';
    if (
      nextText
      && /\band\s*$|,\s*$/.test(degree)
      && !hasDateText(nextText)
      && !SCHOOL_HINT.test(nextText)
      && !DEGREE_HINT.test(nextText)
    ) {
      degree = `${degree} ${nextText}`;
    }
  }

  school = school ? removeDateFragments(school).replace(/\s*\/\s*$/, '').trim() : null;
  degree = degree ? removeDateFragments(degree).replace(/\s*\/\s*$/, '').replace(/[,;.]\s*$/, '').trim() : null;
  // Drop any degree that turned out to be a bullet line after date-fragment removal.
  if (degree && isBulletText(degree)) degree = null;
  // Clear school names that are bare years — artifacts from date-only blocks (e.g. "2020").
  if (school && /^\d{4}$/.test(school.trim())) school = null;

  // Strip leading "Location, Location" prefix from school names that occur when a location
  // annotation placed in a middle column merges with the school name (e.g. in multi-column
  // PDF layouts): "Singapore, Remote National University of Singapore" → "National University
  // of Singapore".  The comma-separated form distinguishes this from school names that
  // legitimately start with a country (e.g. "Singapore Polytechnic").
  if (school) {
    const LOC_LIST = '(?:singapore|remote|malaysia|hong\\s+kong|uk|usa|australia|hybrid|onsite|united\\s+kingdom|united\\s+states)';
    const locPrefixRe = new RegExp(`^${LOC_LIST}\\s*,\\s*${LOC_LIST}\\s*,?\\s*`, 'i');
    const stripped = school.replace(locPrefixRe, '').trim();
    if (stripped && SCHOOL_HINT.test(stripped)) school = stripped;
  }

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

/**
 * Attempt to split a token that is several concatenated Title Case skill names without a
 * separator.  PDF grid layouts often produce lines like "Interaction Design Visual Design"
 * when two adjacent skill-cell text items are merged.  We split 4+ all-Title-Case word
 * sequences into 2-word groups (most skills are 1–2 words).
 */
// Words that commonly PRECEDE a second word to form a single compound skill name
// (e.g. "User Research", "Visual Design", "Adobe Illustrator").
// 2-word tokens starting with one of these are kept together rather than being split.
const COMPOUND_SKILL_PREFIXES = new Set([
  // UX/Design method descriptors
  'user', 'interaction', 'visual', 'motion', 'service', 'brand', 'digital',
  'ui', 'ux', 'graphic', 'creative', 'art', 'print', 'concept', 'experience',
  'persona', 'information', 'journey', 'usability', 'accessibility', 'inclusive',
  'content', 'editorial', 'typography', 'color', 'layout', 'composition',
  // Engineering/tech descriptors
  'data', 'machine', 'deep', 'natural', 'cloud', 'cyber', 'info', 'artificial',
  'front', 'back', 'full', 'cross', 'open', 'end', 'micro', 'server', 'object',
  'test', 'unit', 'version', 'source', 'continuous', 'automated',
  // Management/business descriptors
  'project', 'product', 'business', 'social', 'email',
  'search', 'agile', 'lean', 'scrum', 'team', 'account', 'customer', 'client',
  'stakeholder', 'change', 'risk', 'quality', 'process', 'program', 'portfolio',
  // Analysis/research descriptors
  'competitive', 'market', 'needs', 'root', 'cost', 'impact',
  'quantitative', 'qualitative', 'primary', 'secondary', 'behavioral', 'strategic',
  // Common compound-skill head words
  'design', 'web', 'app', 'mobile', 'responsive', 'planning', 'strategy',
  'mapping', 'testing', 'research', 'analysis', 'architecture', 'engineering',
  'systems', 'thinking', 'problem', 'critical', 'storytelling',
  // Known product-family brand prefixes (always compound)
  'adobe', 'microsoft', 'google', 'apple', 'amazon', 'aws', 'meta',
  'github', 'gitlab', 'jetbrains', 'atlassian',
  // Video/creative suite sub-product prefixes ("Premiere Pro", "After Effects")
  'premiere', 'after',
]);

function splitConcatenatedSkills(token: string): string[] {
  const trimmed = token.trim();
  const words = trimmed.split(/\s+/);
  // Require all words to start with an uppercase letter or digit (e.g. HTML, CSS, 3D).
  // Any lowercase word (connector or prose) means this is probably a sentence, not skills.
  const allCaps = words.every((w) => /^[A-Z\/\d]/.test(w));
  const hasLowerConnector = words.some((w) =>
    /^(and|or|in|at|the|a|an|of|to|for|with|by|as|on|is|are|was|were|from|into)$/i.test(w),
  );
  if (!allCaps || hasLowerConnector) return [trimmed];

  // For exactly 2 words: split unless the first word is a known compound-skill prefix.
  // This catches adjacent single-tool names merged by the PDF encoder (e.g. "Webflow Shopify").
  if (words.length === 2) {
    const firstWordLower = (words[0] ?? '').toLowerCase();
    if (COMPOUND_SKILL_PREFIXES.has(firstWordLower)) return [trimmed];
    return words as string[];
  }

  if (words.length < 4) return [trimmed];

  // 4+ words: split into 2-word groups.
  const result: string[] = [];
  for (let i = 0; i < words.length; i += 2) {
    if (i + 1 < words.length) {
      result.push(`${words[i]} ${words[i + 1]}`);
    } else {
      result.push(words[i] as string);
    }
  }
  return result;
}

function parseSkillsFromSections(lines: ExtractedLine[], sections: DetectedSection[]): string[] {
  const skillsSections = sections.filter((s) => s.type === 'skills');
  const allText = skillsSections
    .flatMap((s) => lines.slice(s.startIdx, s.endIdx + 1)
      .map((l) => l.text)
      // Skip section sub-headers: lines ending with ":" or bare category labels.
      .filter((t) => !t.endsWith(':'))
      .filter((t) => !/^(proficiency|practice|knowledge|expertise|competency|category|type|level|additional)$/i.test(t))
      // Skip hobby/interest sentences: "Other interest include ...", "Hobbies: ..."
      .filter((t) => !/\b(other\s+interest|hobby|hobbies|pastimes?)\b/i.test(t)))
    .join(' | ');

  if (!allText) return [];

  const tokens = allText
    .split(/[|,•\u2022;\n§]/)
    .flatMap((s) => splitConcatenatedSkills(s.trim()))
    .filter(Boolean)
    .map((s) => s.replace(/^[+\-*]\s*/, ''))   // strip leading bullet chars incl. "+" (Cherie)
    .map((s) => s.replace(/^(languages?|technical)\s*[:\-–—]?\s*/i, ''))
    .map((s) => removeDateFragments(s))
    .filter((s) => s.length > 1 && s.length <= 60)
    .filter((s) => !/^(languages?|technical|certifications?)$/i.test(s))
    .filter((s) => !/\b(certification|certified|council|academy|university)\b/i.test(s))
    .filter((s) => !/\b(recognition|award|achievement|medal)\b/i.test(s))
    .filter((s) => !/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(s))
    .filter((s) => !/(19|20)\d{2}/.test(s))
    .filter((s) => !/^[+\-]/.test(s))
    // Filter out language-proficiency sentences ("Fluent in English and Chinese", "Proficient in Photoshop")
    .filter((s) => !/^(proficient|fluent|conversant|native|basic|intermediate|advanced)\s+in\s+/i.test(s))
    // Filter out sentence-like tokens: if 3+ words, all must start with uppercase (no prose connectors)
    .filter((s) => {
      const ws = s.trim().split(/\s+/);
      return ws.length <= 2 || ws.every((w) => /^[A-Z\d]/.test(w));
    })
    // Remove pure location strings that leak in from multi-column PDFs (e.g. "Singapore", "Remote").
    .filter((s) => !looksLikeLocation(s));

  return unique(tokens).slice(0, 8);
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

/**
 * Merge consecutive lines where a very short all-uppercase fragment (1–4 chars) followed
 * by the next line together form a recognised section-keyword (e.g. "E" + "DUCATION" →
 * "EDUCATION"). Also merges single-char degree prefixes like "B" + "(Hons) …" so the
 * education-block parser can match the full degree string.
 */
/**
 * Some PDFs render a section keyword merged with the first content item on the same line,
 * e.g. "Education Diploma in Digital Media Design (Interactive Media)".
 * Split such lines so detectSections sees a clean heading and the content is preserved.
 */
function splitMergedSectionHeadings(lines: ExtractedLine[]): ExtractedLine[] {
  const result: ExtractedLine[] = [];
  for (const line of lines) {
    const t = line.text.trim();
    // Match "Education <content>" where content looks like a degree or school name.
    const edMatch = t.match(/^education\s+(.+)$/i);
    if (edMatch) {
      const content = edMatch[1].trim();
      if (DEGREE_HINT.test(content) || SCHOOL_HINT.test(content)) {
        result.push({ ...line, text: 'Education' });
        result.push({ ...line, text: content });
        continue;
      }
    }
    // Match "Experience <company>" where content looks like an organisation name (e.g.
    // "Experience Nurun Hong Kong (Publicis Groupe)").  Only split when the remainder
    // passes looksExperienceOrgLine so we don't accidentally split "Experience Planning/Strategy".
    const expMatch = t.match(/^experience\s+(.+)$/i);
    if (expMatch) {
      const content = expMatch[1].trim();
      if (looksExperienceOrgLine(content) || COMPANY_HINT.test(content)) {
        result.push({ ...line, text: 'Experience' });
        result.push({ ...line, text: content });
        continue;
      }
    }
    result.push(line);
  }
  return result;
}

function mergeFragmentedLines(lines: ExtractedLine[]): ExtractedLine[] {
  if (lines.length === 0) return lines;
  const result: ExtractedLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.text.trim();
    // Only consider very-short all-uppercase fragments as merge candidates.
    if (i + 1 < lines.length && /^[A-Z]{1,4}$/.test(trimmed)) {
      const next = lines[i + 1];
      const combined = trimmed + next.text.trim();
      // Case 1: combined text matches a section keyword → merge (fixes "E"+"DUCATION").
      const combinedLower = combined.toLowerCase();
      const isSection = SECTION_KEYWORDS.some((rule) =>
        rule.patterns.some((p) => p.test(combinedLower)),
      );
      if (isSection) {
        result.push({
          ...line,
          text: combined,
          x1: Math.max(line.x1, next.x1),
          y1: Math.max(line.y1, next.y1),
        });
        i += 2;
        continue;
      }
    }
    result.push(line);
    i += 1;
  }
  return result;
}

/**
 * Detects if the extracted lines come from a 2-column resume layout (e.g. design-tool exports
 * with left-column = Experience/Projects and right-column = Skills/Education).
 *
 * When a large horizontal gap (> 150 pts) is detected on page 1, the function re-orders lines so
 * that:
 *   1. Header lines from both columns (above the first section heading in each column) are
 *      merged and sorted by y-coordinate (natural reading order).
 *   2. Left-column section content (Experience, Projects, etc.) follows.
 *   3. Right-column section content (Skills, Education, etc.) follows.
 *
 * This prevents the section detector from seeing "SKILLS" (right col, y=707) immediately after
 * "WORK EXPERIENCE" (left col, y=716), which would produce an empty experience section.
 */
function reorderColumnsIfNeeded(lines: ExtractedLine[]): ExtractedLine[] {
  const page1Lines = lines.filter((l) => l.page === 1);
  if (page1Lines.length < 8) return lines;

  // Collect unique x0 positions bucketed to nearest 5 pts to reduce per-character noise.
  const xs = Array.from(new Set(page1Lines.map((l) => Math.round(l.x0 / 5) * 5))).sort(
    (a, b) => a - b,
  );

  // Find the largest consecutive gap between x buckets.
  let maxGap = 0;
  let splitX = -1;
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      splitX = (xs[i] + xs[i - 1]) / 2;
    }
  }

  // Only reorder when there is a clear wide column gap.
  if (maxGap <= 150 || splitX < 0) return lines;

  const isSectionHeading = (text: string): boolean => {
    const t = text.trim().toLowerCase().replace(/[:\-]+$/, '');
    const k = headingKey(t);
    return SECTION_KEYWORDS.some((rule) => rule.patterns.some((p) => p.test(t) || p.test(k)));
  };

  const laterPages = lines.filter((l) => l.page > 1);
  // page1Lines are already in y-desc order (inherited from the sort in parseResumeFromLines).
  const leftLines = page1Lines.filter((l) => l.x0 < splitX);
  const rightLines = page1Lines.filter((l) => l.x0 >= splitX);

  // Find the index of the first section heading in each column.
  const leftHeadingIdx = leftLines.findIndex((l) => isSectionHeading(l.text));
  const rightHeadingIdx = rightLines.findIndex((l) => isSectionHeading(l.text));

  // If neither column has a recognised section heading, skip reordering.
  if (leftHeadingIdx < 0 && rightHeadingIdx < 0) return lines;

  // Split each column into a "header zone" (above first heading) and "content zone".
  const leftHeader = leftHeadingIdx >= 0 ? leftLines.slice(0, leftHeadingIdx) : leftLines;
  const leftContent = leftHeadingIdx >= 0 ? leftLines.slice(leftHeadingIdx) : [];
  const rightHeader = rightHeadingIdx >= 0 ? rightLines.slice(0, rightHeadingIdx) : rightLines;
  const rightContent = rightHeadingIdx >= 0 ? rightLines.slice(rightHeadingIdx) : [];

  // Merge both header zones and restore y-desc visual order.
  const combinedHeader = [...leftHeader, ...rightHeader].sort((a, b) => b.y0 - a.y0);

  // Final order: shared header → left sections (Experience/Projects) → right sections (Skills/Education).
  return [...combinedHeader, ...leftContent, ...rightContent, ...laterPages];
}

export function parseResumeFromLines(linesInput: ExtractedLine[], opts: ParseOptions = {}): ParseResumePdfResult {
  const warnings: string[] = [];
  const sortedRaw = linesInput
    .map((l) => ({ ...l, text: cleanLineText(l.text) }))
    .filter((l) => l.text.length > 0)
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(a.y0 - b.y0) > 2) return b.y0 - a.y0;
      return a.x0 - b.x0;
    });
  const lines = splitMergedSectionHeadings(mergeFragmentedLines(
    reorderColumnsIfNeeded(sortedRaw),
  ));

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

  const rawEducation = blocks
    .filter((b) => b.section === 'education')
    .map((b, idx) => parseEducationBlock(b, idx, warnings))
    .filter((v): v is EducationItem => Boolean(v));

  // Merge consecutive pairs where one block has degree-only (no school, no dates) and
  // the next has school+dates but no degree. This handles 2-column PDFs where the degree
  // line and school/date line fall in separate blocks due to y-gap splitting.
  const mergedEducation = rawEducation.reduce((acc: EducationItem[], item) => {
    const last = acc[acc.length - 1];
    const lastIsDegreeOnly = Boolean(last && last.degree && !last.school && !last.start.year && !last.isCurrent);
    if (lastIsDegreeOnly && !item.degree) {
      // Simple merge: degree-only block followed by school+date block with no degree.
      acc[acc.length - 1] = { ...item, degree: last!.degree };
    } else if (lastIsDegreeOnly && item.degree) {
      // Complex merge: degree-only block followed by school+date+degree block.
      // Use the orphan block's degree for this school, then push a new orphan for the
      // displaced degree (it will be merged with the next school+date block).
      acc[acc.length - 1] = { ...item, degree: last!.degree };
      acc.push({ ...last!, degree: item.degree });
    } else {
      acc.push(item);
    }
    return acc;
  }, []);

  const education = sortRecentFirst(mergedEducation).slice(0, 2);

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
    // Use experience role as title fallback only if it looks like a real job title (not a school/bootcamp name)
    currentTitle: (contact.currentTitle ?? experiences.find((e) => e.isCurrent)?.role ?? experiences.find((e) => TITLE_HINT.test(e.role ?? ''))?.role ?? null)?.replace(/\s*[|/]\s*$/, '').trim() || null,
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
      role: exp.role ? normalizeOutputText(exp.role).replace(/\s*[|/]\s*$/, '').trim() || null : null,
      company: exp.company ? normalizeOutputText(exp.company) : null,
      description: exp.description.map((d) => normalizeOutputText(d)).filter(Boolean),
    })),
    education: data.education.map((edu) => ({
      ...edu,
      degree: edu.degree ? normalizeOutputText(edu.degree) : null,
      school: edu.school ? normalizeOutputText(edu.school) : null,
      location: edu.location ? normalizeOutputText(edu.location) : null,
    })),
    skills: unique(data.skills.map((s) => normalizeOutputText(s)).filter(Boolean)).slice(0, 8),
  };

  return {
    data: normalizedData,
    warnings: unique(warnings),
    ...(opts.debug ? { debug: { lines, sections, blocks } } : {}),
  };
}

export async function parseResumePdf(buffer: Buffer, opts: ParseOptions = {}): Promise<ParseResumePdfResult> {
  const lines = await extractLayoutAwareLines(buffer);
  const result = parseResumeFromLines(lines, opts);
  if (opts.useLlm) {
    result.warnings.push('LLM block labeling is not configured in this environment; used deterministic rule-based labeling.');
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

  data.bio = '';
  data.name = parsed.name ?? data.name;
  data.title = parsed.currentTitle ?? data.title;
  data.contact.phone = parsed.phone ?? '';
  data.contact.location = parsed.country ?? '';
  data.contact.linkedin = parsed.linkedin ?? '';
  data.contact.website = parsed.website ?? '';
  data.skills = parsed.skills.slice(0, 8);
  data.workExperience = parsed.experiences.map((exp, idx) => ({
    id: `exp-${idx + 1}`,
    company: exp.company ?? '',
    role: exp.role ?? '',
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
    degree: edu.degree ?? '',
    school: edu.school ?? '',
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
