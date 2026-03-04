import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { jsPDF } from 'jspdf';
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import {
  Plus, Sparkles, Check, X, Settings, LogOut, ChevronDown, ChevronRight,
  Copy, GripVertical, FileText, Share2, Trash2, Menu, Minus,
  Paperclip, ExternalLink, AlertCircle, Info, Mic, Square, LoaderCircle,
} from 'lucide-react';
import { clearAuthStorage, createResumeShareLink, createVersion, curateResume, deleteVersion, getResume, getResumePdfBlob, listResumes, listVersions, replaceResumePdf, userStore, updateVersion } from '../../lib/api';
import type { AIChange, BaseResumeModel, Certification, ContactInfo, DateValue, EducationEntry, JDVariantModel, ResumeData, ResumeVersion, WorkExperience } from '../../lib/types';
import { useAuthGate } from '../components/AuthGate';
import { useIsMobile } from '../components/ui/use-mobile';
import cvLogo from '../assets/branding/cv-logo.svg';

// ─── Types ─────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PRODUCT_DESIGNER_TITLE = 'Product Designer';
const PRODUCT_DESIGNER_PATTERN = /\bproduct\s+designer\b/i;
const ROLE_LEVEL_PREFIX_PATTERN = /^((lead|senior|sr\.?|junior|jr\.?|founding|principal|staff|head|chief|vp|director|associate)\s+)+/i;
const MIN_JD_CURATION_LENGTH = 40;
const PROJECT_NOTES_PROMPT_HIDE_WORD_THRESHOLD = 100;
const PROJECT_NOTES_BASE_SOURCE_LABEL = 'Master Resume';

// ─── Utilities ─────────────────────────────────────────────────────────────────

const NOW = new Date();
const CURRENT_MONTH_YEAR = { month: NOW.getMonth() + 1, year: NOW.getFullYear() };
function compactText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
function normalizeProductDesignerTitle(value: string): string {
  const clean = compactText(value);
  if (!clean) return '';
  return PRODUCT_DESIGNER_PATTERN.test(clean) ? PRODUCT_DESIGNER_TITLE : clean;
}
function composeRoleCompanyTitle(roleName: string, companyName: string): string {
  const role = compactText(roleName);
  const company = compactText(companyName);
  if (role && company) return `${role} @ ${company}`;
  return role;
}
function normalizeRoleFamilyTitle(value: string): string {
  const clean = compactText(value);
  if (!clean) return PRODUCT_DESIGNER_TITLE;
  const withoutLevel = clean.replace(ROLE_LEVEL_PREFIX_PATTERN, '').trim() || clean;
  return normalizeProductDesignerTitle(withoutLevel) || withoutLevel;
}
function formatSidebarRoleLabel(roleFamily: string, count: number): string {
  return roleFamily;
}
function hasMeaningfulJobDescription(value?: string): boolean {
  return (value ?? '').trim().length >= MIN_JD_CURATION_LENGTH;
}
function normalizeClipboardLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
function normalizePastedText(value: string): string {
  return normalizeClipboardLineEndings(value)
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function stripLeadingListMarker(value: string): string {
  return value.replace(/^\s*(?:(?:[•◦▪‣◉●○◆◇■□►▸▹▫-]|\d+[.)])\s*)+/u, '').trimStart();
}
function scorePastedText(value: string): number {
  const bulletMatches = value.match(/(^|\n)\s*[•◦▪‣◉●○◆◇■□►▸▹▫-]\s+/g)?.length ?? 0;
  const numberedMatches = value.match(/(^|\n)\s*\d+[.)]\s+/g)?.length ?? 0;
  const newlineCount = value.match(/\n/g)?.length ?? 0;
  return bulletMatches * 8 + numberedMatches * 5 + newlineCount * 2 + value.length * 0.001;
}
function pickBestClipboardText(options: string[]): string {
  const normalized = options
    .map(normalizePastedText)
    .filter(Boolean);
  if (normalized.length === 0) return '';
  return normalized.reduce((best, current) => (
    scorePastedText(current) > scorePastedText(best) ? current : best
  ));
}
function serializeClipboardNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'ul') {
    return Array.from(element.children)
      .filter((child) => child.tagName.toLowerCase() === 'li')
      .map((child) => {
        const content = stripLeadingListMarker(serializeClipboardNode(child).trim());
        return content ? `• ${content}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (tag === 'ol') {
    return Array.from(element.children)
      .filter((child) => child.tagName.toLowerCase() === 'li')
      .map((child, index) => {
        const content = stripLeadingListMarker(serializeClipboardNode(child).trim());
        return content ? `${index + 1}. ${content}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (tag === 'li' || element.getAttribute('role') === 'listitem') {
    return `${stripLeadingListMarker(Array.from(element.childNodes).map(serializeClipboardNode).join('').trim())}\n`;
  }
  const childrenText = Array.from(element.childNodes).map(serializeClipboardNode).join('');
  if (['p', 'div', 'section', 'article', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
    return `${childrenText}\n`;
  }
  return childrenText;
}
function parseHtmlClipboardText(value: string): string {
  if (!value.trim()) return '';
  const doc = new DOMParser().parseFromString(value, 'text/html');
  const serialized = Array.from(doc.body.childNodes).map(serializeClipboardNode).join('');
  return normalizePastedText(serialized);
}
function insertTextAtCursor(
  target: HTMLTextAreaElement,
  text: string,
  update: (value: string) => void,
) {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const nextValue = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
  update(nextValue);
  requestAnimationFrame(() => {
    const nextCursor = start + text.length;
    target.selectionStart = nextCursor;
    target.selectionEnd = nextCursor;
  });
}
function handleStructuredPaste(
  event: React.ClipboardEvent<HTMLTextAreaElement>,
  update: (value: string) => void,
) {
  const html = event.clipboardData.getData('text/html');
  const plain = event.clipboardData.getData('text/plain');
  const parsed = html ? parseHtmlClipboardText(html) : '';
  const text = pickBestClipboardText([parsed, plain]);
  if (!text) return;
  event.preventDefault();
  insertTextAtCursor(event.currentTarget, text, update);
}
function getHeaderTitleForVersion(version: Pick<ResumeVersion, 'isAI' | 'jobTitle' | 'jobCompany' | 'data'>): string {
  if (version.isAI) {
    const aiHeader = composeRoleCompanyTitle(version.jobTitle ?? '', version.jobCompany ?? '');
    if (aiHeader) return aiHeader;
  }
  return normalizeProductDesignerTitle(version.data.title) || PRODUCT_DESIGNER_TITLE;
}
function applyHeaderTitleToData(version: Pick<ResumeVersion, 'isAI' | 'jobTitle' | 'jobCompany' | 'data'>, data: ResumeData): ResumeData {
  const normalizedData = normalizeResumeDataShape(data);
  const title = getHeaderTitleForVersion({ ...version, data });
  if (normalizedData.title === title) return normalizedData;
  return { ...normalizedData, title };
}
function applyHeaderTitleToVersion(version: ResumeVersion): ResumeVersion {
  const nextData = applyHeaderTitleToData(version, version.data);
  if (nextData === version.data) return version;
  return { ...version, data: nextData };
}
function calcDurationFromDates(start: DateValue, end: DateValue): string {
  const endD = end.present ? NOW : new Date(end.year, end.month - 1);
  const startD = new Date(start.year, start.month - 1);
  const total = (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth());
  if (total <= 0) return '';
  const yrs = Math.floor(total / 12); const mos = total % 12;
  const out: string[] = [];
  if (yrs > 0) out.push(`${yrs} yr${yrs !== 1 ? 's' : ''}`);
  if (mos > 0) out.push(`${mos} mo${mos !== 1 ? 's' : ''}`);
  return out.join(' ');
}
function formatDateRange(s: DateValue, e: DateValue) { return `${MONTHS[s.month - 1]} ${s.year} – ${e.present ? 'Present' : `${MONTHS[e.month - 1]} ${e.year}`}`; }
function formatMonthYear(m: number, y: number) { return `${MONTHS[m - 1]} ${y}`; }
function monthKey(v: { month: number; year: number }) { return v.year * 12 + (v.month - 1); }
function isInRange(v: { month: number; year: number }, minDate?: { month: number; year: number }, maxDate?: { month: number; year: number }) {
  const key = monthKey(v);
  if (minDate && key < monthKey(minDate)) return false;
  if (maxDate && key > monthKey(maxDate)) return false;
  return true;
}
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};
type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}
function appendDictatedText(existing: string, dictated: string): string {
  const clean = dictated.trim();
  if (!clean) return existing;
  if (!existing.trim()) return clean;
  const needsSpacing = /[.!?]$/.test(existing.trim()) ? '\n\n' : ' ';
  return `${existing.trim()}${needsSpacing}${clean}`;
}
function appendUniqueDictatedText(existing: string, dictated: string): string {
  const clean = dictated.trim();
  if (!clean) return existing;
  const existingNormalized = existing.trim().replace(/\s+/g, ' ').toLowerCase();
  const cleanNormalized = clean.replace(/\s+/g, ' ').toLowerCase();
  if (existingNormalized.endsWith(cleanNormalized)) return existing;
  return appendDictatedText(existing, clean);
}
function countWords(value: string): number {
  const clean = value.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}
type ProjectNotesSection = {
  source: string;
  content: string;
};
function normalizeProjectNotesSourceLabel(value: string): string {
  const clean = compactText(value);
  return clean || PROJECT_NOTES_BASE_SOURCE_LABEL;
}
function parseProjectNotesSections(value: string): ProjectNotesSection[] {
  const normalized = normalizeClipboardLineEndings(value).trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const headingIndices: number[] = [];
  const headingPattern = /^From\s+(.+?)\s*$/;

  lines.forEach((line, index) => {
    if (headingPattern.test(line.trim())) headingIndices.push(index);
  });

  const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const isStructured = headingIndices.length >= 2 && firstNonEmptyLineIndex === headingIndices[0];
  if (!isStructured) {
    return [{ source: PROJECT_NOTES_BASE_SOURCE_LABEL, content: normalized }];
  }

  const sections: ProjectNotesSection[] = [];
  for (let i = 0; i < headingIndices.length; i += 1) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : lines.length;
    const heading = lines[start].trim();
    const match = heading.match(headingPattern);
    if (!match) continue;
    const source = normalizeProjectNotesSourceLabel(match[1]);
    const content = lines.slice(start + 1, end).join('\n').trim();
    if (!content) continue;
    sections.push({ source, content });
  }
  if (sections.length === 0) {
    return [{ source: PROJECT_NOTES_BASE_SOURCE_LABEL, content: normalized }];
  }
  return sections;
}
function serializeProjectNotesSections(sections: ProjectNotesSection[]): string {
  const cleanSections = sections
    .map((section) => ({
      source: normalizeProjectNotesSourceLabel(section.source),
      content: normalizeClipboardLineEndings(section.content).trim(),
    }))
    .filter((section) => section.content.length > 0);

  if (cleanSections.length === 0) return '';
  if (cleanSections.length === 1 && cleanSections[0].source === PROJECT_NOTES_BASE_SOURCE_LABEL) {
    return cleanSections[0].content;
  }
  return cleanSections
    .map((section) => `From ${section.source}\n${section.content}`)
    .join('\n\n');
}
const BASE_PROJECT_NOTES_PROMPTS = [
  'What were the 2-3 biggest projects you owned in this role?',
  'What tools, stack, or systems did you personally use?',
  'What outcomes changed (time saved, revenue, cost, quality, speed)?',
] as const;
const VARIANT_PROJECT_NOTES_PROMPTS = [
  'What in this role best matches the target JD priorities?',
  'What ownership or scope can we make more explicit for this variant?',
  'Which impact points should we emphasize for this specific company?',
] as const;
function normalizeWorkExperienceEntry(exp: WorkExperience): WorkExperience {
  return {
    ...exp,
    bullets: Array.isArray(exp.bullets) ? exp.bullets : [],
    projectNotes: typeof exp.projectNotes === 'string' ? exp.projectNotes : '',
  };
}
function normalizeResumeDataShape(data: ResumeData): ResumeData {
  return {
    ...data,
    workExperience: (data.workExperience ?? []).map(normalizeWorkExperienceEntry),
  };
}
function buildTextResume(data: ResumeData): string {
  const lines: string[] = [data.name, data.title, [data.contact.email, data.contact.phone, data.contact.location].filter(Boolean).join(' | '), '', 'ABOUT', data.bio, '', 'WORK EXPERIENCE'];
  (data.workExperience ?? []).forEach(exp => { lines.push('', `${exp.role} at ${exp.company}`, formatDateRange(exp.startDate, exp.endDate)); exp.bullets.forEach(b => lines.push(`• ${b}`)); });
  lines.push('', 'EDUCATION');
  (data.education ?? []).forEach(edu => { lines.push('', `${edu.degree} — ${edu.school}`); if (edu.location) lines.push(edu.location); });
  lines.push('', 'SKILLS', (data.skills ?? []).join(', '));
  return lines.join('\n');
}
function sanitizeFileName(input: string): string {
  const cleaned = input.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_');
  return cleaned || 'resume';
}
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function heading(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, size: 18, bold: false, color: 'A0A0A0' })],
    spacing: { before: 280, after: 140 },
  });
}
function bodyText(text: string, opts?: { bold?: boolean; color?: string; after?: number }) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, bold: opts?.bold, color: opts?.color ?? '222222' })],
    spacing: { after: opts?.after ?? 80 },
  });
}
function buildWordDocument(data: ResumeData): Document {
  const children: (Paragraph | Table)[] = [];
  children.push(
    new Paragraph({ children: [new TextRun({ text: data.name || 'Name', size: 36, bold: false, color: '1A1A1A' })], spacing: { after: 80 } }),
    new Paragraph({ children: [new TextRun({ text: data.title || '', size: 24, color: '666666' })], spacing: { after: 180 } }),
  );
  const contacts = [data.contact.email, data.contact.phone, data.contact.location, data.contact.website, data.contact.linkedin].filter(Boolean).join('  •  ');
  if (contacts) children.push(new Paragraph({ children: [new TextRun({ text: contacts, size: 20, color: '666666' })], spacing: { after: 220 } }));
  if (data.bio.trim()) {
    children.push(heading('ABOUT'));
    children.push(new Paragraph({ children: [new TextRun({ text: data.bio.trim(), size: 20, color: '2B2B2B' })], spacing: { after: 120 } }));
  }
  if (data.workExperience.length > 0) {
    children.push(heading('WORK EXPERIENCE'));
    data.workExperience.forEach((exp) => {
      const duration = calcDurationFromDates(exp.startDate, exp.endDate);
      const left = [
        new Paragraph({ children: [new TextRun({ text: formatDateRange(exp.startDate, exp.endDate), size: 20, color: '9B9B9B' })], spacing: { after: duration ? 40 : 120 } }),
      ];
      if (duration) left.push(new Paragraph({ children: [new TextRun({ text: duration, size: 18, color: 'C4C4C4' })], spacing: { after: 120 } }));
      const right: Paragraph[] = [
        bodyText(exp.role || '', { bold: true, color: '1A1A1A', after: 40 }),
        bodyText(exp.company || '', { color: '666666', after: 100 }),
      ];
      exp.bullets.filter((b) => b.trim()).forEach((bullet) => {
        right.push(new Paragraph({
          children: [new TextRun({ text: bullet.trim(), size: 20, color: '2B2B2B' })],
          bullet: { level: 0 },
          spacing: { after: 60 },
        }));
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
        rows: [new TableRow({
          children: [
            new TableCell({ width: { size: 23, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, children: left }),
            new TableCell({ width: { size: 77, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, children: right }),
          ],
        })],
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    });
  }
  if (data.education.length > 0) {
    children.push(heading('EDUCATION'));
    data.education.forEach((edu) => {
      const duration = calcDurationFromDates(edu.startDate, edu.endDate);
      const left = [
        new Paragraph({ children: [new TextRun({ text: formatDateRange(edu.startDate, edu.endDate), size: 20, color: '9B9B9B' })], spacing: { after: duration ? 40 : 120 } }),
      ];
      if (duration) left.push(new Paragraph({ children: [new TextRun({ text: duration, size: 18, color: 'C4C4C4' })], spacing: { after: 120 } }));
      const right: Paragraph[] = [
        bodyText(edu.degree || '', { bold: true, color: '1A1A1A', after: 40 }),
        bodyText(edu.school || '', { color: '666666', after: 40 }),
      ];
      if (edu.location?.trim()) right.push(bodyText(edu.location.trim(), { color: '9B9B9B', after: 80 }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } },
        rows: [new TableRow({
          children: [
            new TableCell({ width: { size: 23, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, children: left }),
            new TableCell({ width: { size: 77, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } }, children: right }),
          ],
        })],
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
    });
  }
  if (data.skills.length > 0) {
    children.push(heading('SKILLS'));
    children.push(new Paragraph({
      children: [new TextRun({ text: data.skills.join(' • '), size: 20, color: '2B2B2B' })],
      spacing: { after: 120 },
      alignment: AlignmentType.LEFT,
    }));
  }
  return new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: 720,
            right: 720,
            bottom: 720,
            left: 720,
          },
        },
      },
      children,
    }],
  });
}
function buildPdfDocument(data: ResumeData): jsPDF {
  const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const pageH = 297;
  const marginLeft = 22;
  const marginRight = 22;
  const marginY = 14;
  const leftColW = 38;
  const gutter = 10;
  const contentX = marginLeft + leftColW + gutter;
  // Extra right-side safety buffer to prevent any clipping at page edges.
  const contentW = pageW - marginRight - contentX - 4;
  const fullWidth = pageW - marginLeft - marginRight - 4;
  const maxContentH = pageH - (marginY * 2);
  let y = marginY;

  const PT_TO_MM = 0.3528;
  const BODY_SIZE = 10;
  const LINE_HEIGHT = 1.3; // 130% line-height for exported body text
  const lineStep = (fontSize: number) => fontSize * PT_TO_MM * LINE_HEIGHT;
  const fontList = pdf.getFontList();
  const availableFonts = Object.keys(fontList).map((f) => f.toLowerCase());
  const preferredFont = availableFonts.includes('inter')
    ? 'Inter'
    : availableFonts.includes('calibri')
      ? 'Calibri'
      : 'helvetica';
  const applyFont = (style: 'normal' | 'bold') => {
    pdf.setFont(preferredFont, style);
  };
  const wrap = (text: string, maxW: number, size: number, style: 'normal' | 'bold' = 'normal') => {
    applyFont(style);
    pdf.setFontSize(size);
    return pdf.splitTextToSize(text || '', maxW, { fontSize: size }) as string[];
  };
  const textHeight = (lines: string[], size: number, gap = 1.2) => (lineStep(size) * Math.max(1, lines.length)) + gap;

  const ensureSpace = (needed = 8) => {
    if (y + needed <= pageH - marginY) return;
    pdf.addPage();
    y = marginY;
  };
  const writeParagraph = (text: string, opts?: { x?: number; size?: number; color?: [number, number, number]; bold?: boolean; maxW?: number; gap?: number }) => {
    const x = opts?.x ?? marginLeft;
    const size = opts?.size ?? BODY_SIZE;
    const color = opts?.color ?? [34, 34, 34];
    const maxW = opts?.maxW ?? fullWidth;
    const style = opts?.bold ? 'bold' : 'normal';
    const split = wrap(text, maxW, size, style);
    const step = lineStep(size);
    ensureSpace(textHeight(split, size, opts?.gap ?? 1.2));
    applyFont(style);
    pdf.setFontSize(size);
    pdf.setTextColor(color[0], color[1], color[2]);
    pdf.text(split.length ? split : [''], x, y);
    y += (step * Math.max(1, split.length)) + (opts?.gap ?? 1.2);
  };
  const drawParagraphAt = (
    startY: number,
    text: string,
    opts?: { x?: number; size?: number; color?: [number, number, number]; bold?: boolean; maxW?: number; gap?: number },
  ) => {
    const x = opts?.x ?? marginLeft;
    const size = opts?.size ?? 10;
    const color = opts?.color ?? [34, 34, 34];
    const maxW = opts?.maxW ?? fullWidth;
    const style = opts?.bold ? 'bold' : 'normal';
    const split = wrap(text, maxW, size, style);
    const step = lineStep(size);
    applyFont(style);
    pdf.setFontSize(size);
    pdf.setTextColor(color[0], color[1], color[2]);
    pdf.text(split.length ? split : [''], x, startY);
    return startY + (step * Math.max(1, split.length)) + (opts?.gap ?? 1.2);
  };
  const section = (label: string) => {
    y += 3.2;
    ensureSpace(12);
    pdf.setDrawColor(239, 239, 239);
    pdf.line(marginLeft, y, pageW - marginRight, y);
    y += 5.6;
    writeParagraph(label, { x: marginLeft, size: 8.8, color: [160, 160, 160], maxW: fullWidth, gap: 3.2 });
  };
  const row = (leftText: string[], rightText: string[], rightBullets: string[]) => {
    const leftHeights = leftText.map((t, idx) => {
      const size = idx === 0 ? BODY_SIZE : 8;
      return textHeight(wrap(t, leftColW, size, 'normal'), size, 0.8);
    });
    const rightHeights = [
      ...rightText.map((t, idx) => {
        const size = idx === 0 ? 11.8 : BODY_SIZE;
        const style = idx === 0 ? 'bold' : 'normal';
        return textHeight(wrap(t, contentW, size, style), size, 0.8);
      }),
      ...rightBullets.map((b) => textHeight(wrap(`• ${b}`, contentW, BODY_SIZE, 'normal'), BODY_SIZE, 0.8)),
    ];
    const rowHeight = Math.max(
      leftHeights.reduce((a, b) => a + b, 0),
      rightHeights.reduce((a, b) => a + b, 0),
    ) + 3.4;

    // Normal case: keep each row together to avoid orphaned date lines / awkward blank pages.
    if (rowHeight <= maxContentH) {
      ensureSpace(rowHeight);
      const rowStart = y;
      let leftY = rowStart;
      let rightY = rowStart;
      leftText.forEach((t, idx) => {
      leftY = drawParagraphAt(leftY, t, { x: marginLeft, size: idx === 0 ? BODY_SIZE : 8, color: idx === 0 ? [155, 155, 155] : [196, 196, 196], maxW: leftColW, gap: 1.1 });
      });
      rightText.forEach((t, idx) => {
        rightY = drawParagraphAt(rightY, t, { x: contentX, size: idx === 0 ? 11.8 : BODY_SIZE, bold: idx === 0, color: idx === 0 ? [26, 26, 26] : [102, 102, 102], maxW: contentW, gap: idx === 1 ? 3 : 1.1 });
      });
      rightBullets.forEach((b) => {
        rightY = drawParagraphAt(rightY, `• ${b}`, { x: contentX, size: BODY_SIZE, color: [43, 43, 43], maxW: contentW, gap: 1.1 });
      });
      y = Math.max(leftY, rightY) + 6;
      return;
    }

    // Fallback for extra-long entries: allow paginated flow (prevents clipping).
    ensureSpace(12);
    leftText.forEach((t, idx) => {
      writeParagraph(t, { x: marginLeft, size: idx === 0 ? BODY_SIZE : 8, color: idx === 0 ? [155, 155, 155] : [196, 196, 196], maxW: leftColW, gap: 1.1 });
    });
    rightText.forEach((t, idx) => {
      writeParagraph(t, { x: contentX, size: idx === 0 ? 11.8 : BODY_SIZE, bold: idx === 0, color: idx === 0 ? [26, 26, 26] : [102, 102, 102], maxW: contentW, gap: idx === 1 ? 3 : 1.1 });
    });
    rightBullets.forEach((b) => {
      writeParagraph(`• ${b}`, { x: contentX, size: BODY_SIZE, color: [43, 43, 43], maxW: contentW, gap: 1.1 });
    });
    y += 5;
  };

  writeParagraph(data.name || 'Name', { x: marginLeft, size: 20, bold: true, color: [26, 26, 26], maxW: fullWidth, gap: 1 });
  writeParagraph(data.title || '', { x: marginLeft, size: 12.5, color: [102, 102, 102], maxW: fullWidth, gap: 2.3 });
  const contact = [data.contact.email, data.contact.phone, data.contact.location, data.contact.website, data.contact.linkedin].filter(Boolean).join('  •  ');
  if (contact) writeParagraph(contact, { x: marginLeft, size: BODY_SIZE, color: [102, 102, 102], maxW: fullWidth, gap: 2.4 });

  if (data.bio.trim()) {
    section('ABOUT');
    writeParagraph(data.bio.trim(), { x: marginLeft, size: BODY_SIZE, color: [43, 43, 43], maxW: fullWidth, gap: 2.2 });
  }
  if (data.workExperience.length > 0) {
    section('WORK EXPERIENCE');
    data.workExperience.forEach((exp) => {
      const duration = calcDurationFromDates(exp.startDate, exp.endDate);
      row(
        [formatDateRange(exp.startDate, exp.endDate), ...(duration ? [duration] : [])],
        [exp.role || '', exp.company || ''],
        exp.bullets.filter((b) => b.trim()),
      );
    });
  }
  if (data.education.length > 0) {
    section('EDUCATION');
    data.education.forEach((edu) => {
      const duration = calcDurationFromDates(edu.startDate, edu.endDate);
      row(
        [formatDateRange(edu.startDate, edu.endDate), ...(duration ? [duration] : [])],
        [edu.degree || '', edu.school || '', ...(edu.location?.trim() ? [edu.location.trim()] : [])],
        [],
      );
    });
  }
  if (data.skills.length > 0) {
    section('SKILLS');
    writeParagraph(data.skills.join(' • '), { x: marginLeft, size: BODY_SIZE, color: [43, 43, 43], maxW: fullWidth, gap: 2 });
  }
  return pdf;
}

// ─── Local Model Helpers ───────────────────────────────────────────────────────

const EMPTY_CONTACT: ContactInfo = { email: '', phone: '', location: '', website: '', linkedin: '' };
const EMPTY_DATA: ResumeData = {
  name: '',
  title: '',
  contact: EMPTY_CONTACT,
  bio: '',
  workExperience: [],
  education: [],
  certifications: [],
  skills: [],
};
const INITIAL_VERSIONS: ResumeVersion[] = [
  { id: 'base', name: 'Master Resume', isAI: false, isBase: true, data: EMPTY_DATA, aiChanges: [] },
];
type LocalWorkspaceStore = { baseResume: BaseResumeModel | null; jdVariants: JDVariantModel[] };

function cloneResumeData(data: ResumeData): ResumeData {
  return normalizeResumeDataShape(JSON.parse(JSON.stringify(data)) as ResumeData);
}
function createVariantDataFromBase(data: ResumeData, title: string): ResumeData {
  const cloned = cloneResumeData(data);
  return {
    ...cloned,
    title,
    workExperience: cloned.workExperience.map((exp) => ({
      ...exp,
      projectNotes: '',
    })),
  };
}
function storageKeyForResume(resumeId?: string): string {
  return `cvstack_workspace_variants_${resumeId || 'local'}`;
}
function loadLocalWorkspaceStore(key: string): LocalWorkspaceStore {
  const raw = localStorage.getItem(key);
  if (!raw) return { baseResume: null, jdVariants: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalWorkspaceStore>;
    return {
      baseResume: parsed.baseResume ?? null,
      jdVariants: Array.isArray(parsed.jdVariants) ? parsed.jdVariants : [],
    };
  } catch {
    return { baseResume: null, jdVariants: [] };
  }
}
function saveLocalWorkspaceStore(key: string, store: LocalWorkspaceStore) {
  localStorage.setItem(key, JSON.stringify(store));
}
function buildVariantContent(baseContent: string): string {
  return baseContent;
}
function createJDVariantFromBase(baseVersion: ResumeVersion, roleName: string, company: string, jd: string, link: string, baseResume: BaseResumeModel): { version: ResumeVersion; jdVariant: JDVariantModel } {
  const ts = Date.now();
  const title = composeRoleCompanyTitle(roleName, company) || PRODUCT_DESIGNER_TITLE;
  const jdVariantId = `jdv-${ts}`;
  const variantContent = buildVariantContent(baseResume.content);
  const variantData = createVariantDataFromBase(baseVersion.data, title);
  const version: ResumeVersion = {
    id: `ai-v-${ts}`,
    name: title,
    isAI: true,
    jobTitle: roleName,
    jobCompany: company || 'Company',
    jobDescription: jd,
    jobLink: link,
    baseResumeId: baseResume.id,
    jdVariantId,
    variantContent,
    data: variantData,
    aiChanges: [],
  };
  const jdVariant: JDVariantModel = {
    id: jdVariantId,
    baseResumeId: baseResume.id,
    title,
    jdText: jd,
    variantContent,
    createdAt: new Date(ts).toISOString(),
  };
  return { version, jdVariant };
}
function applyChange(change: AIChange, d: ResumeData): ResumeData {
  if (change.field === 'bio') return { ...d, bio: change.suggested };
  if (change.field === 'bullet' && change.expId && change.bulletIdx !== undefined) {
    return {
      ...d,
      workExperience: d.workExperience.map((exp) => {
        if (exp.id !== change.expId) return exp;
        const bullets = [...exp.bullets];
        const idx = change.bulletIdx!;
        const next = change.suggested.trim();
        if (!next) {
          if (idx >= 0 && idx < bullets.length) bullets.splice(idx, 1);
          return { ...exp, bullets };
        }
        if (idx >= bullets.length) bullets.splice(idx, 0, next);
        else bullets[idx] = next;
        return { ...exp, bullets };
      }),
    };
  }
  return d;
}
function buildPendingAIChangesFromCuration(
  version: ResumeVersion,
  result: Awaited<ReturnType<typeof curateResume>>,
  seed = Date.now(),
  options: { includePreviouslyAccepted?: boolean } = {},
): AIChange[] {
  const nextChanges: AIChange[] = [];
  let hasBioSuggestion = false;

  for (const [idx, suggestion] of result.suggestions.entries()) {
    if (suggestion.field === 'bio') {
      if (suggestion.suggested.trim() === version.data.bio.trim()) continue;
      hasBioSuggestion = true;
      nextChanges.push({
        id: `c-ai-bio-${seed}-${idx}`,
        field: 'bio',
        original: version.data.bio,
        suggested: suggestion.suggested.trim(),
        status: 'pending',
      });
      continue;
    }

    if (!suggestion.expId || suggestion.bulletIdx === undefined) continue;
    const exp = version.data.workExperience.find((item) => item.id === suggestion.expId);
    if (!exp) continue;
    const bullet = exp.bullets[suggestion.bulletIdx];
    const suggested = suggestion.suggested.trim();
    const currentBulletText = bullet ?? '';
    if (bullet === undefined && !suggested) continue;
    if (bullet !== undefined && suggested === bullet.trim()) continue;
    if (!options.includePreviouslyAccepted && isAcceptedAiBulletUnchanged(version, suggestion.expId, suggestion.bulletIdx, currentBulletText)) continue;
    nextChanges.push({
      id: `c-ai-bullet-${seed}-${idx}`,
      field: 'bullet',
      expId: suggestion.expId,
      bulletIdx: suggestion.bulletIdx,
      original: bullet ?? '',
      suggested,
      status: 'pending',
    });
  }

  if (!hasBioSuggestion && !version.data.bio.trim()) {
    const lines: string[] = [];
    if ((result.jdFocusAreas ?? []).length > 0) {
      lines.push('Target focus areas from JD:');
      result.jdFocusAreas.slice(0, 3).forEach((focus) => lines.push(`- ${focus}`));
      lines.push('');
    }
    if ((result.aboutPointers ?? []).length > 0) {
      lines.push('About section pointers:');
      result.aboutPointers.slice(0, 4).forEach((pointer) => lines.push(`- ${pointer}`));
    }
    if (lines.length > 0) {
      nextChanges.push({
        id: `c-ai-bio-guidance-${seed}`,
        field: 'bio',
        original: version.data.bio,
        suggested: lines.join('\n'),
        status: 'pending',
      });
    }
  }

  return nextChanges;
}
function getCurationFallbackReason(result: Awaited<ReturnType<typeof curateResume>>): string | null {
  if (result.meta?.providerStatus !== 'fallback') return null;
  const baseReason = result.meta.fallbackReason?.trim() || result.redFlags?.[0]?.trim() || 'AI curation is currently unavailable.';
  if (/timed out|abort/i.test(baseReason)) return 'AI curation timed out. Please try again in a moment.';
  if (/api[_\s-]?key|unauthorized|forbidden|auth/i.test(baseReason)) return 'AI curation is not configured correctly. Please verify your OpenAI API key.';
  return `AI curation fallback: ${baseReason}`;
}
function getCurationNoChangeMessage(result: Awaited<ReturnType<typeof curateResume>>): string {
  if ((result.questions ?? []).length > 0) {
    return 'No direct changes yet. Add metrics, scope, and tools to unlock stronger curation.';
  }
  return 'No new changes suggested. Try a fuller JD or a more specific target role.';
}
function applyAllChanges(data: ResumeData, changes: AIChange[]): ResumeData {
  return changes.reduce((acc, change) => applyChange(change, acc), data);
}

function isAcceptedAiBulletUnchanged(version: ResumeVersion, expId: string, bulletIdx: number, bulletText: string): boolean {
  const normalized = bulletText.trim();
  return (version.aiChanges ?? []).some((change) => (
    change.field === 'bullet'
    && change.expId === expId
    && change.bulletIdx === bulletIdx
    && change.status === 'accepted'
    && change.suggested.trim() === normalized
  ));
}

function hasCuratableBullets(version: ResumeVersion): boolean {
  for (const exp of version.data.workExperience ?? []) {
    for (const [idx, bullet] of exp.bullets.entries()) {
      const text = bullet.trim();
      if (!text) continue;
      if (!isAcceptedAiBulletUnchanged(version, exp.id, idx, text)) return true;
    }
  }
  return false;
}

function buildCurationInputHash(version: ResumeVersion): string {
  const normalize = (value?: string) => (value ?? '').trim().replace(/\s+/g, ' ');
  const hashSource = {
    role: normalize(version.jobTitle || version.data.title),
    company: normalize(version.jobCompany),
    jd: normalize(version.jobDescription),
    link: normalize(version.jobLink),
    bio: normalize(version.data.bio),
    workExperience: (version.data.workExperience ?? []).map((exp) => ({
      id: exp.id,
      role: normalize(exp.role),
      company: normalize(exp.company),
      bullets: (exp.bullets ?? []).map((bullet) => normalize(bullet)),
      projectNotes: normalize(exp.projectNotes),
    })),
    skills: (version.data.skills ?? []).map((skill) => normalize(skill)),
  };
  return JSON.stringify(hashSource);
}

function hasNewCurationContext(version: ResumeVersion): boolean {
  return version.lastCurationInputHash !== buildCurationInputHash(version);
}

function markVersionCurated(version: ResumeVersion): ResumeVersion {
  return { ...version, lastCurationInputHash: buildCurationInputHash(version) };
}

function mergeAIChangesWithoutRepeats(existing: AIChange[], incoming: AIChange[]): AIChange[] {
  const seen = new Set(existing.map((change) => `${change.field}|${change.expId ?? ''}|${change.bulletIdx ?? ''}|${change.original.trim()}|${change.suggested.trim()}`));
  const merged = [...existing];
  for (const change of incoming) {
    const key = `${change.field}|${change.expId ?? ''}|${change.bulletIdx ?? ''}|${change.original.trim()}|${change.suggested.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(change);
  }
  return merged;
}

function normalizeRoleKey(exp: WorkExperience): string {
  return `${exp.role.trim().toLowerCase()}::${exp.company.trim().toLowerCase()}`;
}

function splitProjectNotesIntoSegments(value: string): string[] {
  return normalizeClipboardLineEndings(value)
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeProjectNotesSegment(value: string): string {
  return compactText(value).toLowerCase();
}

function mergeProjectNotesPreservingStructure(baseNotes: string, variantNotes: string): string {
  const baseSegments = splitProjectNotesIntoSegments(baseNotes);
  const variantSegments = splitProjectNotesIntoSegments(variantNotes);
  if (variantSegments.length === 0) return baseSegments.join('\n\n');
  if (baseSegments.length === 0) return variantSegments.join('\n\n');

  const seen = new Set(baseSegments.map(normalizeProjectNotesSegment));
  const additions = variantSegments.filter((segment) => {
    const key = normalizeProjectNotesSegment(segment);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (additions.length === 0) return baseSegments.join('\n\n');
  return [...baseSegments, ...additions].join('\n\n');
}

function mergeVariantProjectNotesIntoBase(baseData: ResumeData, variantData: ResumeData, sourceLabel: string): { data: ResumeData; changed: boolean } {
  if (!baseData.workExperience.length || !variantData.workExperience.length) return { data: baseData, changed: false };

  const variantById = new Map(variantData.workExperience.map((exp) => [exp.id, exp]));
  const variantByRoleKey = new Map(variantData.workExperience.map((exp) => [normalizeRoleKey(exp), exp]));
  let changed = false;

  const mergedWorkExperience = baseData.workExperience.map((baseExp) => {
    const variantExp = variantById.get(baseExp.id) ?? variantByRoleKey.get(normalizeRoleKey(baseExp));
    if (!variantExp) return baseExp;

    const currentNotes = (baseExp.projectNotes ?? '').trim();
    const currentSections = parseProjectNotesSections(currentNotes);
    const variantNotes = (variantExp.projectNotes ?? '').trim();
    const variantSections = parseProjectNotesSections(variantNotes);
    const incomingSource = normalizeProjectNotesSourceLabel(sourceLabel);
    const sourceMatchedSection = variantSections.find((section) => normalizeProjectNotesSourceLabel(section.source).toLowerCase() === incomingSource.toLowerCase());
    const incomingContent = sourceMatchedSection
      ? sourceMatchedSection.content
      : variantSections.map((section) => section.content.trim()).filter(Boolean).join('\n\n');
    if (!incomingContent) return baseExp;

    const sectionIndex = currentSections.findIndex((section) => normalizeProjectNotesSourceLabel(section.source).toLowerCase() === incomingSource.toLowerCase());
    let nextSections = [...currentSections];

    if (sectionIndex >= 0) {
      const mergedContent = mergeProjectNotesPreservingStructure(nextSections[sectionIndex].content, incomingContent);
      if (mergedContent !== nextSections[sectionIndex].content) {
        nextSections[sectionIndex] = { ...nextSections[sectionIndex], content: mergedContent };
      }
    } else if (nextSections.length === 0) {
      nextSections = [{ source: incomingSource, content: incomingContent }];
    } else {
      nextSections = [...nextSections, { source: incomingSource, content: incomingContent }];
    }

    const mergedNotes = serializeProjectNotesSections(nextSections);
    if (mergedNotes === currentNotes) return baseExp;
    changed = true;
    return { ...baseExp, projectNotes: mergedNotes };
  });

  if (!changed) return { data: baseData, changed: false };
  return { data: { ...baseData, workExperience: mergedWorkExperience }, changed: true };
}

function mergeProjectNotesAcrossSources(primaryNotes: string, secondaryNotes: string): string {
  const primarySections = parseProjectNotesSections(primaryNotes);
  const secondarySections = parseProjectNotesSections(secondaryNotes);
  if (secondarySections.length === 0) return serializeProjectNotesSections(primarySections);
  if (primarySections.length === 0) return serializeProjectNotesSections(secondarySections);

  const merged = [...primarySections];
  for (const section of secondarySections) {
    const source = normalizeProjectNotesSourceLabel(section.source);
    const index = merged.findIndex((item) => normalizeProjectNotesSourceLabel(item.source).toLowerCase() === source.toLowerCase());
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        content: mergeProjectNotesPreservingStructure(merged[index].content, section.content),
      };
    } else {
      merged.push({ source, content: section.content.trim() });
    }
  }
  return serializeProjectNotesSections(merged);
}

function parseProjectNotesSectionsForCurationScope(value: string): ProjectNotesSection[] {
  const parsedSections = parseProjectNotesSections(value);
  if (parsedSections.length !== 1 || normalizeProjectNotesSourceLabel(parsedSections[0].source) !== PROJECT_NOTES_BASE_SOURCE_LABEL) {
    return parsedSections;
  }

  const normalized = normalizeClipboardLineEndings(value).trim();
  if (!normalized) return parsedSections;

  const lines = normalized.split('\n');
  const headingPattern = /^From\s+(.+?)\s*$/;
  const headingIndices: number[] = [];
  lines.forEach((line, index) => {
    if (headingPattern.test(line.trim())) headingIndices.push(index);
  });
  const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const isStructured = headingIndices.length >= 1 && firstNonEmptyLineIndex === headingIndices[0];
  if (!isStructured) return parsedSections;

  const sections: ProjectNotesSection[] = [];
  for (let i = 0; i < headingIndices.length; i += 1) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : lines.length;
    const heading = lines[start].trim();
    const match = heading.match(headingPattern);
    if (!match) continue;
    const source = normalizeProjectNotesSourceLabel(match[1]);
    const content = lines.slice(start + 1, end).join('\n').trim();
    if (!content) continue;
    sections.push({ source, content });
  }
  return sections.length > 0 ? sections : parsedSections;
}

function buildAllowedProjectNotesSourcesForCuration(version: ResumeVersion): Set<string> {
  const allowed = new Set<string>([PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase()]);
  const candidateSources = [
    composeRoleCompanyTitle(version.jobTitle ?? '', version.jobCompany ?? ''),
    version.name ?? '',
  ];
  candidateSources.forEach((source) => {
    const normalized = compactText(source).toLowerCase();
    if (normalized) allowed.add(normalized);
  });
  return allowed;
}

function scopeBaseProjectNotesForCuration(baseNotes: string, allowedSources: Set<string>): string {
  const sections = parseProjectNotesSectionsForCurationScope(baseNotes);
  if (sections.length === 0) return '';
  const filteredSections = sections.filter((section) => allowedSources.has(normalizeProjectNotesSourceLabel(section.source).toLowerCase()));
  return serializeProjectNotesSections(filteredSections);
}

function buildResumeDataForCuration(version: ResumeVersion, baseVersion: ResumeVersion): ResumeData {
  if (version.id === baseVersion.id) return version.data;
  const allowedSources = buildAllowedProjectNotesSourcesForCuration(version);
  const baseById = new Map(baseVersion.data.workExperience.map((exp) => [exp.id, exp]));
  const baseByRoleKey = new Map(baseVersion.data.workExperience.map((exp) => [normalizeRoleKey(exp), exp]));

  const mergedWorkExperience = (version.data.workExperience ?? []).map((exp) => {
    const baseExp = baseById.get(exp.id) ?? baseByRoleKey.get(normalizeRoleKey(exp));
    if (!baseExp) return exp;
    const scopedBaseNotes = scopeBaseProjectNotesForCuration(baseExp.projectNotes ?? '', allowedSources);
    const mergedNotes = mergeProjectNotesAcrossSources(exp.projectNotes ?? '', scopedBaseNotes);
    if (mergedNotes === (exp.projectNotes ?? '')) return exp;
    return { ...exp, projectNotes: mergedNotes };
  });

  return {
    ...version.data,
    workExperience: mergedWorkExperience,
  };
}

// ─── Toast ──────────────────────────────────────────────────────────────────────

function Toast({ message, visible, tone = 'success' }: { message: string; visible: boolean; tone?: 'success' | 'info' | 'error' }) {
  const toneStyles = tone === 'error'
    ? {
      text: 'text-[#6E1E20]',
      border: 'border-[#F2C7CC]',
      iconColor: 'text-[#D6454E]',
      bg: 'bg-[#FFF4F5]/95',
      Icon: AlertCircle,
    }
    : tone === 'info'
      ? {
        text: 'text-[#1F3D66]',
        border: 'border-[#CFE2F7]',
        iconColor: 'text-[#3B82F6]',
        bg: 'bg-[#F4FAFF]/95',
        Icon: Info,
      }
      : {
        text: 'text-[#2A5139]',
        border: 'border-[#CCEAD8]',
        iconColor: 'text-[#2FB46E]',
        bg: 'bg-white/90',
        Icon: Check,
      };

  return (
    <div className={`fixed bottom-28 left-1/2 -translate-x-1/2 z-[100] transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
      <div className={`${toneStyles.bg} backdrop-blur-md border ${toneStyles.border} ${toneStyles.text} px-4 py-2.5 rounded-[12px] shadow-[0_8px_22px_rgba(0,0,0,0.08)] whitespace-nowrap flex items-center gap-2`} style={{ fontSize: 13 }}>
        <toneStyles.Icon size={13} strokeWidth={1.8} className={toneStyles.iconColor} />{message}
      </div>
    </div>
  );
}

// ─── InlineText ─────────────────────────────────────────────────────────────────

function InlineText({ value, onChange, className = '', placeholder = 'Click to edit', onFocusChange, disabled = false }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; onFocusChange?: (f: boolean) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  const save = () => { setEditing(false); onFocusChange?.(false); if (local !== value) onChange(local); };
  return (
    <div className={className}>
      {editing
        ? <input ref={ref} value={local} onChange={e => setLocal(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setLocal(value); setEditing(false); onFocusChange?.(false); } }} className="w-full bg-[#F5F5F5] border-0 border-b border-[#D0D0D0] outline-none px-1 py-0.5" style={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit', lineHeight: 'inherit', fontWeight: 'inherit' }} />
        : <span onClick={() => { if (!disabled) { setEditing(true); onFocusChange?.(true); } }} className={`${disabled ? '' : 'cursor-text hover:bg-[#F5F5F5]'} rounded-[4px] px-1 -mx-1 transition-colors inline-block w-full`}>{local || <span className="text-[#D0D0D0]">{placeholder}</span>}</span>}
    </div>
  );
}

// ─── InlineArea ─────────────────────────────────────────────────────────────────

function InlineArea({ value, onChange, className = '', placeholder = 'Click to edit', disabled = false }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.style.height = 'auto'; ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [editing]);
  const save = () => { setEditing(false); if (local !== value) onChange(local); };
  return (
    <div className={className}>
      {editing
        ? <textarea ref={ref} value={local} onChange={e => { setLocal(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} onBlur={save} onKeyDown={e => { if (e.key === 'Escape') { setLocal(value); setEditing(false); } }} className="w-full bg-[#F5F5F5] outline-none resize-none overflow-hidden px-2 py-1.5 leading-relaxed rounded-[8px]" style={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit' }} />
        : <p onClick={() => { if (!disabled) setEditing(true); }} className={`${disabled ? '' : 'cursor-text hover:bg-[#F5F5F5]'} rounded-[8px] px-2 -mx-2 py-1.5 -my-1.5 transition-colors leading-relaxed whitespace-pre-wrap break-words`}>{local || <span className="text-[#D0D0D0]">{placeholder}</span>}</p>}
    </div>
  );
}

// ─── BulletInlineArea ─────────────────────────────────────────────────────────

function BulletInlineArea({ value, onChange, onDeleteOnEmpty, onFocusChange, onEnterNewBullet, autoEdit, onAutoEditConsumed, disabled = false }: { value: string; onChange: (v: string) => void; onDeleteOnEmpty?: () => void; onFocusChange?: (f: boolean) => void; onEnterNewBullet?: () => void; autoEdit?: boolean; onAutoEditConsumed?: () => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { const el = ref.current; el.focus(); el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; const l = el.value.length; el.setSelectionRange(l, l); } }, [editing]);
  useEffect(() => {
    if (autoEdit) {
      setEditing(true);
      onFocusChange?.(true);
      onAutoEditConsumed?.();
    }
  }, [autoEdit, onAutoEditConsumed, onFocusChange]);
  const resize = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
  const save = () => { setEditing(false); onFocusChange?.(false); if (local !== value) onChange(local); };
  if (editing) return <textarea ref={ref} value={local} rows={1} onChange={e => { setLocal(e.target.value); resize(e.target); }} onBlur={save} onKeyDown={e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (local !== value) onChange(local);
      setEditing(false);
      onFocusChange?.(false);
      onEnterNewBullet?.();
      return;
    }
    if (e.key === 'Escape') { setLocal(value); setEditing(false); onFocusChange?.(false); }
    if (e.key === 'Backspace' && local === '' && onDeleteOnEmpty) { e.preventDefault(); onDeleteOnEmpty(); }
  }} className="w-full bg-transparent outline-none resize-none overflow-hidden text-sm text-[#2B2B2B] leading-relaxed" style={{ fontFamily: 'inherit', minHeight: '1.5em' }} />;
  return <span onClick={() => { if (!disabled) { setEditing(true); onFocusChange?.(true); } }} className={`${disabled ? '' : 'cursor-text'} inline-block w-full text-sm text-[#2B2B2B] leading-relaxed whitespace-pre-wrap break-words min-h-[1.5em]`}>{local || <span className="text-[#D0D0D0] not-italic">Add bullet text…</span>}</span>;
}

// ─── ContactInlineField ─────────────────────────────────────────────────────────

function ContactInlineField({ value, onChange, placeholder, disabled = false }: { value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocal(value); }, [value]); useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const save = () => { setEditing(false); if (local !== value) onChange(local); };
  if (editing) return <input ref={ref} value={local} onChange={e => setLocal(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setLocal(value); setEditing(false); } }} placeholder={placeholder} className="outline-none border-b border-[#D0D0D0] bg-[#F5F5F5] text-sm text-[#6B6B6B] px-0.5" style={{ width: `${Math.max(local.length, placeholder.length) * 7.5 + 8}px`, minWidth: 60 }} />;
  if (!value) return <span onClick={() => { if (!disabled) setEditing(true); }} className={`${disabled ? '' : 'cursor-text'} text-sm text-[#D0D0D0] hover:text-[#CBCBCB] italic`}>{placeholder}</span>;
  return <span onClick={() => { if (!disabled) setEditing(true); }} className={`${disabled ? '' : 'cursor-text hover:bg-[#F5F5F5]'} text-sm text-[#6B6B6B] rounded-[3px] px-0.5 transition-colors`}>{value}</span>;
}

// ─── SkillPill + SkillsEditor ────────────────────────────────────────────────

function SkillPill({ skill, onDelete }: { skill: string; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  return <div className="flex items-center gap-1 px-4 py-1.5 bg-[#F5F5F5] rounded-full text-sm text-[#2B2B2B]" onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>{skill}<button onClick={onDelete} className={`ml-0.5 text-[#AAAAAA] hover:text-[#444] transition-all ${hov ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}><X size={11} strokeWidth={1.8} /></button></div>;
}
function SkillsEditor({ skills, onUpdate, disabled = false }: { skills: string[]; onUpdate: (s: string[]) => void; disabled?: boolean }) {
  const [adding, setAdding] = useState(false); const [input, setInput] = useState(''); const ref = useRef<HTMLInputElement>(null);
  const maxSkills = 8;
  useEffect(() => { if (adding) ref.current?.focus(); }, [adding]);
  const submit = () => {
    const t = input.trim();
    if (t && skills.length < maxSkills && !skills.some((s) => s.toLowerCase() === t.toLowerCase())) {
      onUpdate([...skills, t].slice(0, maxSkills));
    }
    setInput('');
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {skills.map((s, i) => <SkillPill key={i} skill={s} onDelete={() => onUpdate(skills.filter((_, j) => j !== i))} />)}
      {adding && skills.length < maxSkills
        ? <input ref={ref} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Backspace' && input === '') setAdding(false); if (e.key === 'Escape') { setInput(''); setAdding(false); } }} onBlur={submit} placeholder="Type a skill…" className="px-4 py-1.5 bg-[#F0F0F0] rounded-full text-sm text-[#2B2B2B] outline-none min-w-[120px]" />
        : <button onClick={() => { if (!disabled) setAdding(true); }} disabled={disabled || skills.length >= maxSkills} className="px-4 py-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B] rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{skills.length >= maxSkills ? 'Max 8 skills' : '+ Add Skill'}</button>}
    </div>
  );
}

// ─── MonthGridPicker ─────────────────────────────────────────────────────────

function MonthGridPicker({
  year,
  month,
  onSelect,
  minDate,
  maxDate,
}: {
  year: number;
  month: number;
  onSelect: (m: number, y: number) => void;
  minDate?: { month: number; year: number };
  maxDate?: { month: number; year: number };
}) {
  const [dy, setDy] = useState(year);
  useEffect(() => { setDy(year); }, [year]);
  const canGoPrev = isInRange({ month, year: dy - 1 }, minDate, maxDate);
  const canGoNext = isInRange({ month, year: dy + 1 }, minDate, maxDate);
  const goPrevYear = () => {
    if (!canGoPrev) return;
    const nextYear = dy - 1;
    setDy(nextYear);
    onSelect(month, nextYear);
  };
  const goNextYear = () => {
    if (!canGoNext) return;
    const nextYear = dy + 1;
    setDy(nextYear);
    onSelect(month, nextYear);
  };
  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-3">
        <button
          onClick={e => { e.stopPropagation(); goPrevYear(); }}
          disabled={!canGoPrev}
          className={`w-6 h-6 flex items-center justify-center rounded-[4px] transition-colors select-none ${canGoPrev ? 'text-[#9B9B9B] hover:text-[#1A1A1A] hover:bg-[#F0F0F0]' : 'text-[#D8D8D8] cursor-not-allowed'}`}
          style={{ fontSize: 16 }}
        >
          ‹
        </button>
        <p className="text-sm text-[#1A1A1A] select-none">{dy}</p>
        <button
          onClick={e => { e.stopPropagation(); goNextYear(); }}
          disabled={!canGoNext}
          className={`w-6 h-6 flex items-center justify-center rounded-[4px] transition-colors select-none ${canGoNext ? 'text-[#9B9B9B] hover:text-[#1A1A1A] hover:bg-[#F0F0F0]' : 'text-[#D8D8D8] cursor-not-allowed'}`}
          style={{ fontSize: 16 }}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {MONTHS.map((m, i) => {
          const isSelected = i + 1 === month;
          const disabled = !isInRange({ month: i + 1, year: dy }, minDate, maxDate);
          return (
            <button
              key={m}
              onClick={e => { e.stopPropagation(); if (!disabled) onSelect(i + 1, dy); }}
              disabled={disabled}
              className={`py-2 text-xs rounded-[6px] transition-colors ${isSelected ? 'bg-[#1A1A1A] text-white' : disabled ? 'text-[#D0D0D0] cursor-not-allowed' : 'text-[#2B2B2B] hover:bg-[#F0F0F0]'}`}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── DateRangeEditor & MonthYearEditor ──────────────────────────────────────

function DateRangeEditor({ startDate, endDate, onChangeStart, onChangeEnd }: { startDate: DateValue; endDate: DateValue; onChangeStart: (v: DateValue) => void; onChangeEnd: (v: DateValue) => void; onClose: () => void }) {
  const startMaxByEnd = endDate.present ? undefined : { month: endDate.month, year: endDate.year };
  const startMax = startMaxByEnd && monthKey(startMaxByEnd) < monthKey(CURRENT_MONTH_YEAR) ? startMaxByEnd : CURRENT_MONTH_YEAR;
  const endMin = { month: startDate.month, year: startDate.year };
  const endMax = CURRENT_MONTH_YEAR;
  const handleStartChange = (m: number, y: number) => {
    const nextStart = { ...startDate, month: m, year: y };
    onChangeStart(nextStart);
    if (!endDate.present && monthKey(nextStart) > monthKey(endDate)) {
      onChangeEnd({ ...endDate, month: m, year: y });
    }
  };
  const handleEndChange = (m: number, y: number) => {
    const nextEnd = { ...endDate, month: m, year: y };
    onChangeEnd(nextEnd);
    if (monthKey(nextEnd) < monthKey(startDate)) {
      onChangeStart({ ...startDate, month: m, year: y });
    }
  };
  const togglePresent = () => {
    if (endDate.present) {
      const fallbackRaw = monthKey(endDate) < monthKey(startDate)
        ? { month: startDate.month, year: startDate.year }
        : { month: endDate.month, year: endDate.year };
      const fallback = monthKey(fallbackRaw) > monthKey(CURRENT_MONTH_YEAR) ? CURRENT_MONTH_YEAR : fallbackRaw;
      onChangeEnd({ ...endDate, present: false, ...fallback });
      return;
    }
    onChangeEnd({ ...endDate, present: true });
  };
  return (
    <div className="absolute left-0 top-full mt-2 w-[220px] bg-white border border-[#E5E5E5] rounded-[12px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-4 z-[60] animate-[fadeInDown_150ms_ease-out]">
      <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA] mb-3">Start</p>
      <MonthGridPicker year={startDate.year} month={startDate.month} maxDate={startMax} onSelect={handleStartChange} />
      <div className="mt-4 pt-4 border-t border-[#F0F0F0]">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA]">End</p>
          <button onClick={e => { e.stopPropagation(); togglePresent(); }} className="flex items-center gap-2">
            <div className={`relative w-8 h-4 rounded-full transition-colors ${endDate.present ? 'bg-[#1A1A1A]' : 'bg-[#DDDDDD]'}`}><div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${endDate.present ? 'translate-x-4' : 'translate-x-0'}`} /></div>
            <span className="text-xs text-[#6B6B6B]">Present</span>
          </button>
        </div>
        {!endDate.present && <MonthGridPicker year={endDate.year} month={endDate.month} minDate={endMin} maxDate={endMax} onSelect={handleEndChange} />}
      </div>
    </div>
  );
}
function MonthYearEditor({ month, year, onChange, onClose }: { month: number; year: number; onChange: (m: number, y: number) => void; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-full mt-2 w-[200px] bg-white border border-[#E5E5E5] rounded-[12px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-4 z-[60] animate-[fadeInDown_150ms_ease-out]">
      <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA] mb-3">Date Issued</p>
      <MonthGridPicker year={year} month={month} maxDate={CURRENT_MONTH_YEAR} onSelect={(m, y) => onChange(m, y)} />
    </div>
  );
}

// ─── BulletRow ───────────────────────────────────────────────────────────────

function BulletRow({ bullet, isDragging, isHighlighted, onGripDragStart, onGripDragEnd, onChange, onDelete, onDuplicate, onEnterNewBullet, autoEdit, onAutoEditConsumed, isReviewLocked = false }: { bullet: string; isDragging: boolean; isHighlighted: boolean; onGripDragStart: (e: React.DragEvent) => void; onGripDragEnd: () => void; onChange: (v: string) => void; onDelete: () => void; onDuplicate: () => void; onEnterNewBullet: () => void; autoEdit?: boolean; onAutoEditConsumed?: () => void; isReviewLocked?: boolean }) {
  const [rowHov, setRowHov] = useState(false); const [active, setActive] = useState(false);
  return (
    <div className={`relative flex items-start gap-3 rounded-[6px] -mx-2 px-2 py-0.5 transition-colors duration-300 ${isDragging ? 'opacity-30' : ''} ${active || isHighlighted ? 'bg-[#F5F5F5]' : ''}`} onMouseEnter={() => setRowHov(true)} onMouseLeave={() => setRowHov(false)}>
      {!isReviewLocked && <div draggable onDragStart={onGripDragStart} onDragEnd={onGripDragEnd} className={`absolute -left-4 top-[3px] shrink-0 cursor-grab active:cursor-grabbing text-[#D4D4D4] hover:text-[#9B9B9B] transition-opacity ${rowHov ? 'opacity-100' : 'opacity-0'}`}><GripVertical size={13} strokeWidth={1.8} /></div>}
      <span className="text-[#CBCBCB] shrink-0 mt-px select-none text-sm">–</span>
      <div className="flex-1 min-w-0 md:pr-10"><BulletInlineArea disabled={isReviewLocked} value={bullet} onChange={onChange} onDeleteOnEmpty={onDelete} onFocusChange={f => setActive(f)} onEnterNewBullet={onEnterNewBullet} autoEdit={autoEdit} onAutoEditConsumed={onAutoEditConsumed} /></div>
      {!isReviewLocked && (
        <div className={`hidden md:flex absolute right-1 top-1 items-center gap-0.5 transition-opacity ${rowHov || active || isHighlighted ? 'opacity-100' : 'opacity-0'}`}>
          <button onClick={onDuplicate} aria-label="Duplicate bullet" title="Duplicate bullet" className="p-0.5 rounded text-[#CBCBCB] hover:text-[#6B6B6B] transition-colors">
            <Copy size={13} />
          </button>
          <button onClick={onDelete} aria-label="Delete bullet" title="Delete bullet" className="p-0.5 rounded text-[#CBCBCB] hover:text-red-500 transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ExperienceBlock ─────────────────────────────────────────────────────────

function ProjectNotesEditor({ value, onChange, disabled = false, autoExpand = false, onAutoExpandConsumed, promptMode = 'base' }: { value: string; onChange: (v: string) => void; disabled?: boolean; autoExpand?: boolean; onAutoExpandConsumed?: () => void; promptMode?: 'base' | 'variant' }) {
  const [expanded, setExpanded] = useState(Boolean(value.trim()));
  const [expandedSourceKeys, setExpandedSourceKeys] = useState<Set<string>>(new Set());
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [dictationError, setDictationError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const valueRef = useRef(value);
  const supportsDictation = !disabled && Boolean(getSpeechRecognitionCtor());

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!autoExpand) return;
    setExpanded(true);
    onAutoExpandConsumed?.();
  }, [autoExpand, onAutoExpandConsumed]);
  const prompts = promptMode === 'variant' ? VARIANT_PROJECT_NOTES_PROMPTS : BASE_PROJECT_NOTES_PROMPTS;
  const sections = parseProjectNotesSections(value);
  const hasMultipleSources = sections.length > 1;
  const sectionKeys = sections.map((section, index) => `${index}:${normalizeProjectNotesSourceLabel(section.source)}`);
  const sectionsSignature = sectionKeys.join('||');
  const hasReachedPromptThreshold = countWords(value) >= PROJECT_NOTES_PROMPT_HIDE_WORD_THRESHOLD;

  useEffect(() => {
    if (!hasMultipleSources) {
      setExpandedSourceKeys(new Set());
      return;
    }
    setExpandedSourceKeys((prev) => {
      const next = new Set<string>();
      sectionKeys.forEach((key, index) => {
        if (prev.has(key) || index === 0) next.add(key);
      });
      return next;
    });
  }, [hasMultipleSources, sectionsSignature]);

  const stopDictation = useCallback(() => {
    if (interimTranscript.trim()) {
      const nextValue = appendUniqueDictatedText(valueRef.current, interimTranscript);
      valueRef.current = nextValue;
      onChange(nextValue);
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsRecording(false);
    setInterimTranscript('');
  }, [interimTranscript, onChange]);

  const startDictation = useCallback(() => {
    const RecognitionCtor = getSpeechRecognitionCtor();
    if (!RecognitionCtor || disabled) {
      setDictationError('Voice dictation is not supported in this browser.');
      return;
    }
    setDictationError(null);
    setInterimTranscript('');

    const recognition = new RecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => setIsRecording(true);
    recognition.onend = () => {
      setIsRecording(false);
      setInterimTranscript('');
      recognitionRef.current = null;
    };
    recognition.onerror = (event) => {
      const err = event.error ?? 'unknown_error';
      if (err !== 'aborted' && err !== 'no-speech') {
        setDictationError('Microphone access was blocked or interrupted. Please try again.');
      }
      setIsRecording(false);
      setInterimTranscript('');
      recognitionRef.current = null;
    };
    recognition.onresult = (event) => {
      let finalChunk = '';
      let interimChunk = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0]?.transcript ?? '';
        if (!transcript.trim()) continue;
        if (event.results[i].isFinal) finalChunk += ` ${transcript}`;
        else interimChunk += ` ${transcript}`;
      }

      if (finalChunk.trim()) {
        const nextValue = appendUniqueDictatedText(valueRef.current, finalChunk);
        valueRef.current = nextValue;
        onChange(nextValue);
      }
      setInterimTranscript(interimChunk.trim());
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setDictationError('Microphone is already in use. Please stop other recordings and try again.');
      recognitionRef.current = null;
      setIsRecording(false);
    }
  }, [disabled, onChange]);

  return (
    <div className="mt-6 rounded-[12px] bg-[#F8F8F8]">
      <div className={`w-full pr-4 rounded-[12px] transition-colors flex items-center justify-between text-left ${expanded ? 'h-12 pt-1.5 pl-5 hover:bg-transparent md:h-11 md:pt-1' : 'h-12 pl-4 hover:bg-[#F1F1F1] md:h-10'}`}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left"
        >
          <span className="text-[#6B6B6B] text-sm">Projects & Tasks</span>
        </button>
        <div className="flex items-center gap-2">
          {!disabled && (
            <div className="relative group/dictate">
              <button
                type="button"
                onClick={isRecording ? stopDictation : startDictation}
                disabled={!supportsDictation}
                aria-label={isRecording ? 'Stop dictation' : 'Start dictation'}
                className={`relative w-6 h-6 flex items-center justify-center rounded-[6px] transition-colors ${supportsDictation ? 'text-[#8D8D8D] hover:text-[#4D4D4D] hover:bg-[#F0F0F0]' : 'text-[#C6C6C6] cursor-not-allowed'}`}
              >
                {!isRecording && <Mic size={15} />}
                {isRecording && (
                  <>
                    <span className="flex items-end gap-[2px] h-4 group-hover/dictate:opacity-0 transition-opacity">
                      {Array.from({ length: 5 }).map((_, idx) => (
                        <motion.span
                          key={`dictate-wave-${idx}`}
                          className="w-[2px] rounded-full bg-[#595959]"
                          style={{ transformOrigin: 'bottom', height: 12 }}
                          animate={{ scaleY: [0.35, 1, 0.5] }}
                          transition={{ duration: 0.7, ease: 'easeInOut', repeat: Infinity, delay: idx * 0.06 }}
                        />
                      ))}
                    </span>
                    <Square size={12} className="absolute opacity-0 group-hover/dictate:opacity-100 transition-opacity text-[#4D4D4D]" />
                  </>
                )}
              </button>
              <div className="absolute right-0 top-[calc(100%+8px)] px-2 py-1 rounded-[8px] bg-[#121212] text-white text-xs whitespace-nowrap opacity-0 pointer-events-none group-hover/dictate:opacity-100 transition-opacity z-20">
                {isRecording ? 'Stop recording' : 'Dictate'}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-6 h-6 flex items-center justify-center text-[#7C7C7C] hover:text-[#5F5F5F] rounded-[6px] hover:bg-[#F0F0F0] transition-colors"
            aria-label={expanded ? 'Collapse projects and tasks' : 'Expand projects and tasks'}
          >
            {expanded ? <ChevronDown size={16} className="text-[#7C7C7C]" /> : <ChevronRight size={16} className="text-[#7C7C7C]" />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-4 animate-[fadeInDown_150ms_ease-out]">
          {!hasMultipleSources && (
            <InlineArea
              disabled={disabled}
              value={value}
              onChange={(nextValue) => onChange(nextValue)}
              placeholder="Word-dump what you did. AI will convert this into recruiter-ready bullets."
              className="ml-1 text-[13px] text-[#767676]"
            />
          )}
          {hasMultipleSources && (
            <div className="mt-1 ml-1 mr-1 border-t border-[#ECECEC]">
              {sections.map((section, index) => {
                const key = sectionKeys[index];
                const isOpen = expandedSourceKeys.has(key);
                return (
                  <div key={key} className="border-b border-[#ECECEC] py-3">
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedSourceKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                      className="w-full flex items-center justify-between text-left"
                    >
                      <span className="text-sm text-[#6F6F6F]">From {section.source}</span>
                      <span className="text-[#9A9A9A]">{isOpen ? <Minus size={16} /> : <Plus size={16} />}</span>
                    </button>
                    {isOpen && (
                      <InlineArea
                        disabled={disabled}
                        value={section.content}
                        onChange={(content) => {
                          const nextSections = sections.map((item, itemIndex) => (
                            itemIndex === index ? { ...item, content } : item
                          ));
                          onChange(serializeProjectNotesSections(nextSections));
                        }}
                        placeholder="Add source-specific context"
                        className="mt-2 text-[13px] text-[#767676]"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!disabled && isRecording && interimTranscript && (
            <p className="mt-2 ml-1 text-[11px] text-[#7A7A7A] italic">
              Listening: "{interimTranscript}"
            </p>
          )}
          {!disabled && !supportsDictation && (
            <p className="mt-2 ml-1 text-[11px] text-[#9A9A9A]">
              Dictation works best in Chrome and Edge.
            </p>
          )}
          {!disabled && dictationError && (
            <p className="mt-2 ml-1 text-[11px] text-[#A6454A]">{dictationError}</p>
          )}
          {!disabled && !hasMultipleSources && !hasReachedPromptThreshold && (
            <div className="flex flex-wrap gap-2 mt-3">
              {prompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => onChange(value.trim() ? `${value.trim()}\n\n${prompt}` : prompt)}
                  className="text-xs px-2.5 py-1.5 rounded-full border border-[#E5E5E6] text-[#6E6E6E] hover:bg-white transition-colors"
                >
                  + {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExperienceBlock({ exp, onUpdateExp, onDeleteExp, onDragStartExperience, onDragEndExperience, isDraggingExperience, pendingBulletChanges, showOriginal, onAcceptPending, onRejectPending, onToggleShowOriginal, onShowToast, autoExpandProjectNotes = false, onAutoExpandProjectNotesConsumed, isReviewLocked = false, notesPromptMode = 'base' }: { exp: WorkExperience; onUpdateExp: (e: WorkExperience) => void; onDeleteExp: () => void; onDragStartExperience: (e: React.DragEvent) => void; onDragEndExperience: () => void; isDraggingExperience: boolean; pendingBulletChanges: Map<number, AIChange>; showOriginal: boolean; onAcceptPending: () => void; onRejectPending: () => void; onToggleShowOriginal: () => void; onShowToast: (msg: string) => void; autoExpandProjectNotes?: boolean; onAutoExpandProjectNotesConsumed?: () => void; isReviewLocked?: boolean; notesPromptMode?: 'base' | 'variant' }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null); const [dragTarget, setDragTarget] = useState<number | null>(null); const [showCopyTip, setShowCopyTip] = useState(false); const [editingDate, setEditingDate] = useState(false); const [autoEditBulletIdx, setAutoEditBulletIdx] = useState<number | null>(null); const dateColRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const updateBullets = (bullets: string[]) => onUpdateExp({ ...exp, bullets });
  const insertBulletAfter = (idx: number) => {
    const next = [...exp.bullets];
    next.splice(idx + 1, 0, '');
    updateBullets(next);
    setAutoEditBulletIdx(idx + 1);
  };
  const handleDrop = (toIdx: number) => { if (dragFrom === null || dragFrom === toIdx) { setDragFrom(null); setDragTarget(null); return; } const next = [...exp.bullets]; const [moved] = next.splice(dragFrom, 1); next.splice(toIdx, 0, moved); updateBullets(next); setDragFrom(null); setDragTarget(null); };
  const duration = calcDurationFromDates(exp.startDate, exp.endDate);
  const hasPending = pendingBulletChanges.size > 0;
  const pendingAdditions = [...pendingBulletChanges.entries()]
    .filter(([idx, change]) => idx >= exp.bullets.length && change.suggested.trim())
    .sort((a, b) => a[0] - b[0]);
  return (
    <div className={`flex flex-col gap-3 md:flex-row md:gap-10 group/exp transition-all duration-300 ${isDraggingExperience ? 'opacity-35' : 'opacity-100'}`}>
      <div className="w-full md:w-44 md:shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        {!isReviewLocked && <button
          draggable
          onDragStart={onDragStartExperience}
          onDragEnd={onDragEndExperience}
          className="absolute -left-5 top-0 opacity-0 group-hover/exp:opacity-100 text-[#CBCBCB] hover:text-[#6B6B6B] transition-all p-0.5 cursor-grab active:cursor-grabbing"
        >
          <GripVertical size={12} strokeWidth={1.8} />
        </button>}
        <div onClick={() => { if (!isReviewLocked) setEditingDate(!editingDate); }} className={`${isReviewLocked ? '' : 'cursor-pointer'}`}><p className="text-xs text-[#9B9B9B] leading-snug hover:text-[#6B6B6B] transition-colors md:whitespace-nowrap">{formatDateRange(exp.startDate, exp.endDate)}</p>{duration && <p className="mt-1" style={{ fontSize: 11, color: '#C4C4C4' }}>{duration}</p>}</div>
        {editingDate && <DateRangeEditor startDate={exp.startDate} endDate={exp.endDate} onChangeStart={v => onUpdateExp({ ...exp, startDate: v })} onChangeEnd={v => onUpdateExp({ ...exp, endDate: v })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 group/role mb-0.5">
          <div className="flex-1 min-w-0"><InlineText disabled={isReviewLocked} value={exp.role} onChange={v => onUpdateExp({ ...exp, role: v })} className="text-sm text-[#1A1A1A]" /></div>
          <div className="hidden md:flex relative shrink-0 mt-0.5 items-center gap-1">
            {!isReviewLocked && <button onClick={() => { const text = [`${exp.role} at ${exp.company}`, formatDateRange(exp.startDate, exp.endDate), '', ...exp.bullets.map(b => `• ${b}`)].join('\n'); navigator.clipboard.writeText(text).catch(() => {}); onShowToast('Copied to clipboard'); }} onMouseEnter={() => setShowCopyTip(true)} onMouseLeave={() => setShowCopyTip(false)} className="opacity-0 group-hover/role:opacity-100 text-[#CBCBCB] hover:text-[#6B6B6B] transition-all p-0.5"><Copy size={12} strokeWidth={1.8} /></button>}
            {showCopyTip && <div className="absolute right-0 top-6 bg-[#1A1A1A] text-white rounded-[6px] px-2 py-1 whitespace-nowrap pointer-events-none z-50" style={{ fontSize: 11 }}>Copy role</div>}
          </div>
        </div>
        <div className="mb-4"><InlineText disabled={isReviewLocked} value={exp.company} onChange={v => onUpdateExp({ ...exp, company: v })} className="text-sm text-[#6B6B6B]" /></div>
        <ul className="space-y-0.5">
          {exp.bullets.map((bullet, idx) => {
            const pendingChange = pendingBulletChanges.get(idx);
            return (
              <li key={idx} className={`border-t-2 transition-colors ${dragTarget === idx && dragFrom !== null && dragFrom !== idx ? 'border-[#BFBFBF]' : 'border-transparent'}`} onDragOver={e => { e.preventDefault(); if (dragFrom !== null && dragFrom !== idx) setDragTarget(idx); }} onDrop={() => handleDrop(idx)} onDragLeave={() => setDragTarget(null)}>
                {pendingChange ? (
                  <div className="flex items-start gap-3 rounded-[6px] -mx-2 px-2 py-1.5 bg-[#F7F7F7]">
                    <span className="text-[#CBCBCB] shrink-0 mt-px select-none text-sm">–</span>
                    <p className="text-sm text-[#2B2B2B] leading-relaxed">{showOriginal ? pendingChange.original || '(new bullet)' : pendingChange.suggested || '(remove this bullet)'}</p>
                  </div>
                ) : (
                  <BulletRow bullet={bullet} isDragging={dragFrom === idx} isHighlighted={false} onGripDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragFrom(idx); }} onGripDragEnd={() => { setDragFrom(null); setDragTarget(null); }} onChange={v => { const n = [...exp.bullets]; n[idx] = v; updateBullets(n); }} onDelete={() => updateBullets(exp.bullets.filter((_, i) => i !== idx))} onDuplicate={() => { const n = [...exp.bullets]; n.splice(idx + 1, 0, bullet); updateBullets(n); }} onEnterNewBullet={() => insertBulletAfter(idx)} autoEdit={autoEditBulletIdx === idx} onAutoEditConsumed={() => setAutoEditBulletIdx(null)} isReviewLocked={isReviewLocked} />
                )}
              </li>
            );
          })}
          {pendingAdditions.map(([idx, change]) => (
            <li key={`pending-add-${idx}`} className="border-t-2 border-transparent">
              <div className="flex items-start gap-3 rounded-[6px] -mx-2 px-2 py-1.5 bg-[#F2FAF5]">
                <span className="text-[#9DC5A8] shrink-0 mt-px select-none text-sm">+</span>
                <p className="text-sm text-[#2B2B2B] leading-relaxed">{showOriginal ? '(new bullet)' : change.suggested}</p>
              </div>
            </li>
          ))}
        </ul>
        {hasPending && (
          <div className="flex gap-2 mt-4">
            <button onClick={onAcceptPending} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1A1A1A] text-white rounded-[7px] hover:bg-black" style={{ fontSize: 12 }}><Check size={11} /> Accept</button>
            <button onClick={onRejectPending} className="px-3 py-1.5 border border-[#E0E0E0] text-[#6B6B6B] rounded-[7px] hover:bg-[#F5F5F5]" style={{ fontSize: 12 }}>Reject</button>
            <button onClick={onToggleShowOriginal} className="px-3 py-1.5 border border-[#E0E0E0] text-[#6B6B6B] rounded-[7px] hover:bg-[#F5F5F5]" style={{ fontSize: 12 }}>{showOriginal ? 'Show Changed' : 'Show Original'}</button>
          </div>
        )}
        {!isReviewLocked && <button onClick={() => updateBullets([...exp.bullets, ''])} className="mt-3 mb-1 text-xs text-[#CBCBCB] hover:text-[#9B9B9B] transition-colors">+ Add bullet</button>}
        <ProjectNotesEditor
          disabled={isReviewLocked}
          value={exp.projectNotes ?? ''}
          onChange={(projectNotes) => onUpdateExp({ ...exp, projectNotes })}
          autoExpand={autoExpandProjectNotes}
          onAutoExpandConsumed={onAutoExpandProjectNotesConsumed}
          promptMode={notesPromptMode}
        />
        {!isReviewLocked && <button onClick={onDeleteExp} className="block mt-2 text-xs text-[#CBCBCB] hover:text-red-400 transition-colors opacity-0 group-hover/exp:opacity-100">Remove</button>}
      </div>
    </div>
  );
}

// ─── EducationBlock ──────────────────────────────────────────────────────────

function EducationBlock({ edu, onUpdateEdu, onDeleteEdu }: { edu: EducationEntry; onUpdateEdu: (e: EducationEntry) => void; onDeleteEdu: () => void }) {
  const [editingDate, setEditingDate] = useState(false); const dateColRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const duration = calcDurationFromDates(edu.startDate, edu.endDate);
  return (
    <div className="flex flex-col gap-3 md:flex-row md:gap-10 group/edu">
      <div className="w-full md:w-44 md:shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        <div onClick={() => setEditingDate(!editingDate)} className="cursor-pointer"><p className="text-xs text-[#9B9B9B] leading-snug hover:text-[#6B6B6B] transition-colors md:whitespace-nowrap">{formatDateRange(edu.startDate, edu.endDate)}</p>{duration && <p className="mt-1" style={{ fontSize: 11, color: '#C4C4C4' }}>{duration}</p>}</div>
        {editingDate && <DateRangeEditor startDate={edu.startDate} endDate={edu.endDate} onChangeStart={v => onUpdateEdu({ ...edu, startDate: v })} onChangeEnd={v => onUpdateEdu({ ...edu, endDate: v })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <InlineText value={edu.degree} onChange={v => onUpdateEdu({ ...edu, degree: v })} className="text-sm text-[#1A1A1A] mb-0.5" />
        <InlineText value={edu.school} onChange={v => onUpdateEdu({ ...edu, school: v })} className="text-sm text-[#6B6B6B]" />
        <InlineText value={edu.location} onChange={v => onUpdateEdu({ ...edu, location: v })} className="text-xs text-[#9B9B9B] mt-0.5" placeholder="Location" />
        <button onClick={onDeleteEdu} className="mt-2 text-xs text-[#CBCBCB] hover:text-red-400 transition-colors opacity-0 group-hover/edu:opacity-100">Remove</button>
      </div>
    </div>
  );
}

// ─── CertificationBlock ──────────────────────────────────────────────────────

function CertificationBlock({ cert, onUpdateCert, onDeleteCert }: { cert: Certification; onUpdateCert: (c: Certification) => void; onDeleteCert: () => void }) {
  const [editingDate, setEditingDate] = useState(false); const [showModal, setShowModal] = useState(false); const dateColRef = useRef<HTMLDivElement>(null); const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; onUpdateCert({ ...cert, fileUrl: URL.createObjectURL(file), fileName: file.name, fileType: file.type }); };
  return (
    <div className="flex gap-10 group/cert">
      <div className="w-44 shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        <div onClick={() => setEditingDate(!editingDate)} className="cursor-pointer"><p className="text-xs text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors whitespace-nowrap">{formatMonthYear(cert.issuedMonth, cert.issuedYear)}</p></div>
        {editingDate && <MonthYearEditor month={cert.issuedMonth} year={cert.issuedYear} onChange={(m, y) => onUpdateCert({ ...cert, issuedMonth: m, issuedYear: y })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <InlineText value={cert.name} onChange={v => onUpdateCert({ ...cert, name: v })} className="text-sm text-[#1A1A1A] mb-0.5" />
        <InlineText value={cert.organization} onChange={v => onUpdateCert({ ...cert, organization: v })} className="text-sm text-[#6B6B6B]" />
        <InlineText value={cert.credentialId} onChange={v => onUpdateCert({ ...cert, credentialId: v })} className="text-xs text-[#9B9B9B] mt-1" placeholder="Credential ID" />
        {cert.fileUrl ? (
          <div className="mt-3 flex items-center gap-3"><div onClick={() => setShowModal(true)} className="w-12 h-12 rounded-[8px] overflow-hidden bg-[#F5F5F5] border border-[#EBEBEB] flex items-center justify-center cursor-pointer hover:border-[#CBCBCB] shrink-0">{cert.fileType?.startsWith('image/') ? <img src={cert.fileUrl} alt={cert.fileName} className="w-full h-full object-cover" /> : <FileText size={20} className="text-[#9B9B9B]" />}</div><div className="min-w-0"><p className="text-xs text-[#6B6B6B] truncate max-w-[140px]">{cert.fileName}</p><button onClick={() => onUpdateCert({ ...cert, fileUrl: undefined, fileName: undefined, fileType: undefined })} className="text-[11px] text-[#CBCBCB] hover:text-red-400 mt-0.5">Remove</button></div></div>
        ) : <button onClick={() => fileRef.current?.click()} className="mt-2 text-xs text-[#CBCBCB] hover:text-[#9B9B9B]">+ Attach certificate</button>}
        <input ref={fileRef} type="file" accept=".pdf,image/*" onChange={handleFile} className="hidden" />
        <button onClick={onDeleteCert} className="block mt-2 text-xs text-[#CBCBCB] hover:text-red-400 opacity-0 group-hover/cert:opacity-100">Remove entry</button>
      </div>
      {showModal && cert.fileUrl && <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-8" onClick={() => setShowModal(false)}><div className="bg-white rounded-[16px] shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}><div className="flex items-center justify-between px-6 py-4 border-b border-[#F0F0F0]"><p className="text-sm truncate">{cert.fileName}</p><button onClick={() => setShowModal(false)}><X size={16} /></button></div><div className="flex-1 overflow-auto p-6 flex items-center justify-center">{cert.fileType?.startsWith('image/') ? <img src={cert.fileUrl} alt={cert.fileName} className="max-w-full max-h-full object-contain" /> : <iframe src={cert.fileUrl} className="w-full h-96 border-0" />}</div></div></div>}
    </div>
  );
}

// ─── SuggestionCard ──────────────────────────────────────────────────────────

// ─── ResumeView ──────────────────────────────────────────────────────────────

function ResumeView({ version, onUpdateData, onAcceptChange, onRejectChange, onShowToast, headerTitle, isReviewLocked = false }: { version: ResumeVersion; onUpdateData: (d: ResumeData) => void; onAcceptChange: (id: string) => void; onRejectChange: (id: string) => void; onShowToast: (msg: string) => void; headerTitle: string; isReviewLocked?: boolean }) {
  const { data, aiChanges } = version;
  const update = (p: Partial<ResumeData>) => onUpdateData({ ...data, ...p });
  const [dragExpFrom, setDragExpFrom] = useState<number | null>(null);
  const [dragExpTarget, setDragExpTarget] = useState<number | null>(null);
  const [autoExpandProjectNotesExpId, setAutoExpandProjectNotesExpId] = useState<string | null>(null);
  const pendingChanges = (aiChanges ?? []).filter(c => c.status === 'pending');
  const [showOriginalGroups, setShowOriginalGroups] = useState<Set<string>>(new Set());
  const bioChanges = pendingChanges.filter((c) => c.field === 'bio');
  const bioChange = bioChanges[0];
  const pendingByExp = React.useMemo(() => {
    const map = new Map<string, AIChange[]>();
    pendingChanges
      .filter((c) => c.field === 'bullet' && c.expId)
      .forEach((change) => {
        const key = change.expId!;
        const list = map.get(key) ?? [];
        list.push(change);
        map.set(key, list);
      });
    return map;
  }, [pendingChanges]);
  const hasAbout = data.bio.trim().length > 0;
  const hasWorkExperience = (data.workExperience ?? []).length > 0;
  const hasEducation = (data.education ?? []).length > 0;
  const hasCertifications = (data.certifications ?? []).length > 0;
  const hasSkills = (data.skills ?? []).length > 0;
  const toggleOriginal = (groupKey: string) => {
    setShowOriginalGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };
  const acceptChanges = (changes: AIChange[]) => {
    changes.forEach((change) => onAcceptChange(change.id));
  };
  const rejectChanges = (changes: AIChange[]) => {
    changes.forEach((change) => onRejectChange(change.id));
  };
  const contactItems: Array<{ key: keyof ContactInfo; placeholder: string }> = [{ key: 'email', placeholder: 'email@email.com' }, { key: 'phone', placeholder: '+1 234 567 890' }, { key: 'location', placeholder: 'City, Country' }, { key: 'website', placeholder: 'website.com' }, { key: 'linkedin', placeholder: 'linkedin.com/in/…' }];

  return (
    <div className="relative">
      <div className="print-main-content text-[13px] leading-[1.55]">
        {/* Header */}
        <div className="mb-5">
          <div className="flex-1 min-w-0 space-y-1 pt-1">
            <InlineText disabled={isReviewLocked} value={data.name} onChange={v => update({ name: v })} className="text-[#1A1A1A] text-[22px]" />
            <p className="text-base text-[#6B6B6B] px-1 -mx-1">{headerTitle}</p>
          </div>
        </div>
        {/* Contact */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 mb-10">
          {contactItems.flatMap((item, idx) => [idx > 0 ? <span key={`d-${item.key}`} className="text-[#D8D8D8] text-sm">•</span> : null, <ContactInlineField disabled={isReviewLocked} key={item.key} value={data.contact[item.key]} onChange={v => update({ contact: { ...data.contact, [item.key]: v } })} placeholder={item.placeholder} />])}
        </div>
        {/* About */}
        <div className="resume-section mb-7" data-empty={!hasAbout}>
          <div className="h-px bg-[#EFEFEF] mb-7" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-4">About</p>
          {bioChange ? (
            <>
              <div className="rounded-[8px] bg-[#F7F7F7] px-2 py-1.5">
                <p className="text-sm text-[#2B2B2B] leading-relaxed whitespace-pre-wrap">{showOriginalGroups.has('bio') ? bioChange.original : bioChange.suggested}</p>
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={() => onAcceptChange(bioChange.id)} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1A1A1A] text-white rounded-[7px] hover:bg-black" style={{ fontSize: 12 }}><Check size={11} /> Accept</button>
                <button onClick={() => onRejectChange(bioChange.id)} className="px-3 py-1.5 border border-[#E0E0E0] text-[#6B6B6B] rounded-[7px] hover:bg-[#F5F5F5]" style={{ fontSize: 12 }}>Reject</button>
                <button onClick={() => toggleOriginal('bio')} className="px-3 py-1.5 border border-[#E0E0E0] text-[#6B6B6B] rounded-[7px] hover:bg-[#F5F5F5]" style={{ fontSize: 12 }}>{showOriginalGroups.has('bio') ? 'Show Changed' : 'Show Original'}</button>
              </div>
            </>
          ) : (
            <InlineArea disabled={isReviewLocked} value={data.bio} onChange={v => update({ bio: v })} className="text-sm text-[#2B2B2B]" />
          )}
        </div>
        {/* Work Experience */}
        <div className="resume-section mb-7" data-empty={!hasWorkExperience}>
          <div className="h-px bg-[#EFEFEF] mb-7" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Work Experience</p>
          <div className="space-y-6">
            {(data.workExperience ?? []).map((exp, idx) => (
              <div
                key={exp.id}
                className={`border-t-2 transition-colors ${dragExpTarget === idx && dragExpFrom !== null && dragExpFrom !== idx ? 'border-[#BFBFBF]' : 'border-transparent'}`}
                onDragOver={(e) => {
                  if (isReviewLocked || dragExpFrom === null) return;
                  e.preventDefault();
                  if (dragExpFrom !== idx) setDragExpTarget(idx);
                }}
                onDrop={() => {
                  if (isReviewLocked || dragExpFrom === null || dragExpFrom === idx) {
                    setDragExpFrom(null);
                    setDragExpTarget(null);
                    return;
                  }
                  const next = [...data.workExperience];
                  const [moved] = next.splice(dragExpFrom, 1);
                  next.splice(idx, 0, moved);
                  update({ workExperience: next });
                  setDragExpFrom(null);
                  setDragExpTarget(null);
                }}
                onDragLeave={() => {
                  if (dragExpFrom !== null) setDragExpTarget(null);
                }}
              >
                {(() => {
                  const expChanges = [...(pendingByExp.get(exp.id) ?? [])].sort((a, b) => (a.bulletIdx ?? 0) - (b.bulletIdx ?? 0));
                  const pendingBulletChanges = new Map<number, AIChange>();
                  expChanges.forEach((change) => {
                    if (change.bulletIdx !== undefined) pendingBulletChanges.set(change.bulletIdx, change);
                  });
                  const groupKey = `exp-${exp.id}`;
                  return (
                <ExperienceBlock
                  exp={exp}
                  onUpdateExp={u => update({ workExperience: data.workExperience.map(e => e.id === exp.id ? u : e) })}
                  onDeleteExp={() => update({ workExperience: data.workExperience.filter(e => e.id !== exp.id) })}
                  onDragStartExperience={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragExpFrom(idx);
                  }}
                  onDragEndExperience={() => {
                    setDragExpFrom(null);
                    setDragExpTarget(null);
                  }}
                  isDraggingExperience={dragExpFrom === idx}
                  isReviewLocked={isReviewLocked}
                  pendingBulletChanges={pendingBulletChanges}
                  showOriginal={showOriginalGroups.has(groupKey)}
                  onAcceptPending={() => acceptChanges(expChanges)}
                  onRejectPending={() => rejectChanges(expChanges)}
                  onToggleShowOriginal={() => toggleOriginal(groupKey)}
                  onShowToast={onShowToast}
                  autoExpandProjectNotes={autoExpandProjectNotesExpId === exp.id}
                  onAutoExpandProjectNotesConsumed={() => setAutoExpandProjectNotesExpId((current) => (current === exp.id ? null : current))}
                  notesPromptMode={version.isBase ? 'base' : 'variant'}
                />
                  );
                })()}
              </div>
            ))}
          </div>
          {!isReviewLocked && <button onClick={() => {
            const id = `exp-${Date.now()}`;
            setAutoExpandProjectNotesExpId(id);
            update({ workExperience: [...data.workExperience, { id, company: 'Company Name', role: 'Your Role', startDate: { month: 1, year: 2023, present: false }, endDate: { month: 1, year: 2026, present: true }, bullets: ['Describe your impact here'], projectNotes: '' }] });
          }} className="mt-7 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} strokeWidth={1.8} /> Add Experience</button>}
        </div>
        {/* Education */}
        <div className={`resume-section mb-7 ${isReviewLocked ? 'pointer-events-none' : ''}`} data-empty={!hasEducation}>
          <div className="h-px bg-[#EFEFEF] mb-7" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Education</p>
          <div className="space-y-5">{(data.education ?? []).map(edu => <EducationBlock key={edu.id} edu={edu} onUpdateEdu={u => update({ education: data.education.map(e => e.id === edu.id ? u : e) })} onDeleteEdu={() => update({ education: data.education.filter(e => e.id !== edu.id) })} />)}</div>
          {!isReviewLocked && <button onClick={() => update({ education: [...data.education, { id: `edu-${Date.now()}`, school: 'School Name', degree: 'Degree', location: '', startDate: { month: 9, year: 2020, present: false }, endDate: { month: 5, year: 2024, present: false } }] })} className="mt-6 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} strokeWidth={1.8} /> Add Education</button>}
        </div>
        {/* Certifications */}
        <div className={`resume-section mb-7 ${isReviewLocked ? 'pointer-events-none' : ''}`} data-empty={!hasCertifications}>
          <div className="h-px bg-[#EFEFEF] mb-7" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Certifications</p>
          <div className="space-y-6">{(data.certifications ?? []).map(cert => <CertificationBlock key={cert.id} cert={cert} onUpdateCert={u => update({ certifications: data.certifications.map(c => c.id === cert.id ? u : c) })} onDeleteCert={() => update({ certifications: data.certifications.filter(c => c.id !== cert.id) })} />)}</div>
          {!isReviewLocked && <button onClick={() => update({ certifications: [...data.certifications, { id: `cert-${Date.now()}`, name: 'Certificate Name', organization: 'Issuing Organization', issuedMonth: 1, issuedYear: 2024, credentialId: '' }] })} className="mt-6 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} strokeWidth={1.8} /> Add Certification</button>}
        </div>
        {/* Skills */}
        <div className={`resume-section ${isReviewLocked ? 'pointer-events-none' : ''}`} data-empty={!hasSkills}>
          <div className="h-px bg-[#EFEFEF] mb-7" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-5">Skills</p>
          <SkillsEditor disabled={isReviewLocked} skills={data.skills ?? []} onUpdate={s => update({ skills: s })} />
        </div>
      </div>

    </div>
  );
}

// ─── FloatingToolbar — Granola/Awwwards style capsule ────────────────────────

function FloatingToolbar({ isBaseResume, hasJD, canCurate, curateHint, pendingCount, isCurating, jdPanelOpen, hasUploadedResumePdf, canManageBaseResumePdf, onAcceptAll, onRejectAll, onOpenResumeModal, onJDClick, onCurate, onExportPDF, onExportWord, onShareLink }: { isBaseResume: boolean; hasJD: boolean; canCurate: boolean; curateHint?: string; pendingCount: number; isCurating: boolean; jdPanelOpen: boolean; hasUploadedResumePdf: boolean; canManageBaseResumePdf: boolean; onAcceptAll: () => void; onRejectAll: () => void; onOpenResumeModal: () => void; onJDClick: () => void; onCurate: () => void; onExportPDF: () => void; onExportWord: () => void; onShareLink: () => void }) {
  const CURATING_LOADING_MESSAGES = [
    'I swear we’re doing something…',
    'Not just copy-pasting, promise.',
    'Turning chaos into clarity…',
    'Your resume is leveling up…',
    'Making you look expensive.',
    'Swapping generic for strategic…',
    'Removing fluff. Keeping fire.',
    'This is where the magic happens…',
    'Making recruiters pause.',
    'Your resume is adapting…',
    'Stop rewriting. Start stacking.',
    'Working smarter, not longer.',
    'Almost ready to impress.',
    'Brewing something strong…',
    'Upgrading from “okay” to “oh.”',
    'Building your unfair advantage…',
    'Crafting your next opportunity…',
    'Turning experience into leverage…',
    'Sharpening your edge…',
    'Done soon. Worth the wait.',
    'Reading between the lines…',
    'Thinking like a recruiter…',
    'Matching patterns…',
    'Connecting the dots…',
    'Spotting transferable skills…',
    'Translating experience into impact…',
    'Reframing your strengths…',
    'Prioritizing what matters most…',
    'Aligning signal with intent…',
    'Making your experience work harder…',
    'Curating your resume…',
    'Aligning with job description…',
    'Analyzing role requirements…',
    'Optimizing experience highlights…',
    'Mapping skills to priorities…',
    'Refining bullet points…',
    'Adjusting impact statements…',
    'Strengthening keyword alignment…',
    'Enhancing clarity and structure…',
    'Rebalancing your experience…',
    'Elevating your achievements…',
    'Tailoring tone and positioning…',
    'Structuring for recruiter scan…',
    'Calibrating relevance…',
    'Updating role emphasis…',
    'Fine-tuning your narrative…',
    'Optimizing for ATS systems…',
    'Rewriting for stronger impact…',
    'Enhancing measurable results…',
    'Finalizing tailored version…',
  ] as const;
  const [showExport, setShowExport] = useState(false);
  const [curatingMessage, setCuratingMessage] = useState<string>(CURATING_LOADING_MESSAGES[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setShowExport(false); } };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  useEffect(() => {
    if (pendingCount > 0 || isCurating) setShowExport(false);
  }, [pendingCount, isCurating]);
  useEffect(() => {
    if (!isCurating) {
      setCuratingMessage(CURATING_LOADING_MESSAGES[0]);
      return;
    }

    const pickRandomMessage = (prev?: string) => {
      if (CURATING_LOADING_MESSAGES.length === 1) return CURATING_LOADING_MESSAGES[0];
      let next = CURATING_LOADING_MESSAGES[Math.floor(Math.random() * CURATING_LOADING_MESSAGES.length)];
      while (next === prev) {
        next = CURATING_LOADING_MESSAGES[Math.floor(Math.random() * CURATING_LOADING_MESSAGES.length)];
      }
      return next;
    };

    setCuratingMessage((prev) => pickRandomMessage(prev));
    const interval = window.setInterval(() => {
      setCuratingMessage((prev) => pickRandomMessage(prev));
    }, 8000);
    return () => window.clearInterval(interval);
  }, [isCurating]);

  const segBase = 'relative z-10 flex items-center justify-center gap-2 h-[34px] px-5 rounded-full text-sm whitespace-nowrap transition-all duration-250';
  const segActive = 'bg-white text-[#2B2B2B] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_4px_rgba(0,0,0,0.08)]';
  const segIdle = 'text-[#2F2F2F] hover:bg-white hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_4px_rgba(0,0,0,0.08)]';
  const segAction = 'text-[#2F2F2F] hover:bg-white/65 active:bg-white/75';
  const toolbarMode = jdPanelOpen ? 'jd_only' : isCurating ? 'curating' : pendingCount > 0 ? 'review' : 'default';

  return (
    <div ref={ref} className="relative flex flex-col items-center">
      {toolbarMode === 'curating' && (
        <>
          <div className="pointer-events-none absolute -bottom-4 h-10 w-[86%] rounded-full blur-2xl opacity-70 bg-[linear-gradient(110deg,#7FE6DA,#9FAEFF,#F09BE7,#7FE6DA)] bg-[length:260%_260%] animate-[toolbarGlow_2.2s_linear_infinite]" />
          <div className="pointer-events-none absolute -bottom-1 h-5 w-[72%] rounded-full blur-lg opacity-65 bg-[linear-gradient(110deg,#86F0E2,#B6C4FF,#F4ACEB,#86F0E2)] bg-[length:240%_240%] animate-[toolbarGlow_2.2s_linear_infinite]" />
        </>
      )}

      {/* Share dropdown — appears above toolbar */}
      {showExport && (
        <div className="absolute bottom-[calc(100%+8px)] right-0 w-56 bg-[#F8F8F8] border border-[#E2E2E2] rounded-[16px] shadow-[0_10px_28px_rgba(0,0,0,0.12)] p-2 z-50 animate-[fadeInDown_150ms_ease-out]">
          <button onClick={() => { onExportPDF(); setShowExport(false); }} className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] rounded-[10px] hover:bg-[#E7E7E7] transition-colors">Share as PDF</button>
          <button onClick={() => { onExportWord(); setShowExport(false); }} className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] rounded-[10px] hover:bg-[#E7E7E7] transition-colors">Share as Word Doc</button>
          <button onClick={() => { onShareLink(); setShowExport(false); }} className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] rounded-[10px] hover:bg-[#E7E7E7] transition-colors">Copy Share Link</button>
        </div>
      )}

      {/* ── Main capsule ── */}
      <motion.div
        layout
        key={toolbarMode}
        transition={{ type: 'spring', stiffness: 260, damping: 28, mass: 0.8 }}
        className="inline-flex items-center rounded-full border border-[#DADADA] bg-[#F8F8F8] px-1.5 py-1 shadow-[0_14px_34px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.6)] transition-[width,transform,box-shadow,background-color] duration-300"
        style={{ height: 44 }}
      >
        {toolbarMode === 'jd_only' ? (
          <button onClick={onJDClick} className={`${segBase} ${segActive} min-w-[108px]`}>
            <Paperclip size={14} className={hasJD ? 'text-[#1A1A1A]' : 'text-[#9B9B9B]'} />
            <span>View Job</span>
            {hasJD && <span className="w-1.5 h-1.5 rounded-full bg-[#1A1A1A] ml-0.5" />}
          </button>
        ) : toolbarMode === 'curating' ? (
          <div className={`relative flex items-center justify-center min-w-[300px] ${segBase} text-[#5E5E5E]`}>
            <div className="relative flex items-center gap-2 text-[#5E5E5E]">
              <Sparkles size={15} />
              <span className="text-sm loading-shimmer-text">
                {curatingMessage}
              </span>
            </div>
          </div>
        ) : toolbarMode === 'review' ? (
          <>
            <button
              disabled
              className={`${segBase} text-[#AFAFAF] cursor-not-allowed`}
            >
              <Sparkles size={14} className="text-[#B7B7B7]" />
              <span>Curate</span>
            </button>
            <div className="w-px bg-white/55 my-2.5 shrink-0" />
            <div className={`${segBase} text-[#2F2F2F]`}>{pendingCount} Suggestion{pendingCount !== 1 ? 's' : ''}</div>
            <button onClick={onAcceptAll} className={`${segBase} ${segAction}`}><span>Accept all</span></button>
            <button onClick={onRejectAll} className={`${segBase} text-[#979797] hover:bg-white/65 active:bg-white/75 hover:text-[#787878]`}><span>Reject all</span></button>
          </>
        ) : (
          <>
            {isBaseResume ? (
              <>
                <button onClick={onOpenResumeModal} disabled={!canManageBaseResumePdf} className={`${segBase} ${canManageBaseResumePdf ? segIdle : 'text-[#AFAFAF] cursor-not-allowed'}`}>
                  {hasUploadedResumePdf && <Paperclip size={14} className="text-[#1A1A1A]" />}
                  <span>{hasUploadedResumePdf ? 'View Resume' : '+ Add Resume'}</span>
                </button>
                <div className="w-px bg-white/55 my-2.5 shrink-0" />
                <button onClick={onCurate} className={`${segBase} ${segIdle}`}>
                  <Sparkles size={14} className="text-[#1A1A1A]" />
                  <span>Curate</span>
                </button>
              </>
            ) : (
              <>
                <button onClick={onJDClick} className={`${segBase} ${segIdle} ${hasJD ? '' : 'opacity-60'}`}>
                  <Paperclip size={14} className={hasJD ? 'text-[#1A1A1A]' : 'text-[#9B9B9B]'} />
                  <span>View Job</span>
                  {hasJD && <span className="w-1.5 h-1.5 rounded-full bg-[#1A1A1A] ml-0.5" />}
                </button>
                <div className="w-px bg-white/55 my-2.5 shrink-0" />
                <button
                  onClick={onCurate}
                  disabled={!canCurate}
                  title={!canCurate ? (curateHint ?? 'Add more job description details to curate.') : undefined}
                  className={`${segBase} ${canCurate ? segIdle : 'text-[#AFAFAF] cursor-not-allowed'}`}
                >
                  <Sparkles size={14} className="text-[#1A1A1A]" />
                  <span>Curate</span>
                </button>
              </>
            )}
            <div className="w-px bg-white/55 my-2.5 shrink-0" />
            <button onClick={() => { setShowExport(p => !p); }} className={`${segBase} ${showExport ? segActive : segIdle}`}>
              <Share2 size={14} className="text-[#9B9B9B]" />
              <span>Share</span>
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}

// ─── JDSidePanel — right overlay panel ───────────────────────────────────────

function JDSidePanel({
  version,
  tldr,
  isTldrLoading,
  onClose,
  onSave,
}: {
  version: ResumeVersion;
  tldr?: { roleAsks: string; candidateNeeds: string; keyFocusAreas: string[] };
  isTldrLoading: boolean;
  onClose: () => void;
  onSave: (jdText: string, jobLink: string) => void;
}) {
  const TLDR_LOADING_MESSAGES = [
    'Analyzing role context from the JD…',
    'Reading role details from the JD…',
    'Analyzing job description details…',
    'Mapping hiring priorities…',
    'Understanding team structure…',
    'Extracting key responsibilities…',
    'Identifying required competencies…',
    'Studying role language and intent…',
    'Reviewing hiring signals…',
    'Assessing role expectations…',
    'Identifying success metrics…',
    'Breaking down role requirements…',
    'Evaluating strategic alignment…',
    'Parsing core responsibilities…',
    'Reviewing organizational signals…',
    'Analyzing hiring intent…',
    'Scanning for priority keywords…',
    'Identifying decision-maker focus…',
    'Understanding business direction…',
    'Contextualizing role impact…',
    'Thinking like a hiring manager…',
    'Reverse-engineering expectations…',
    'Connecting responsibilities to outcomes…',
    'Identifying what really matters…',
    'Prioritizing signals over noise…',
    'Extracting hidden requirements…',
    'Aligning role to business goals…',
    'Interpreting strategic intent…',
    'Reading between the lines…',
    'Highlighting core evaluation criteria…',
    'Still analyzing… (we’re not slacking.)',
    'Digging through the details…',
    'Doing the homework for you…',
    'Connecting the dots…',
    'Looking for what they really want…',
    'Making sense of the fine print…',
    'Decoding corporate language…',
    'Turning buzzwords into clarity…',
    'Scanning beyond the surface…',
    'Checking what’s signal vs fluff…',
    'Taking this seriously…',
    'Making sure we don’t miss anything…',
    'Gathering JD context before conclusions…',
    'Almost done analyzing…',
    'The TLDR is brewing…',
    'Putting the puzzle together…',
    'Verifying what matters most…',
    'Reading it twice so you don’t have to…',
    'Building a sharper summary…',
    'Preparing your strategic TLDR…',
  ] as const;
  const [isEditing, setIsEditing] = useState(false);
  const [jdDraft, setJdDraft] = useState(version.jobDescription ?? '');
  const [linkDraft, setLinkDraft] = useState(version.jobLink ?? '');
  const [tldrLoadingMessage, setTldrLoadingMessage] = useState<string>(TLDR_LOADING_MESSAGES[0]);
  useEffect(() => {
    setJdDraft(version.jobDescription ?? '');
    setLinkDraft(version.jobLink ?? '');
    setIsEditing(false);
  }, [version.id, version.jobDescription, version.jobLink]);
  useEffect(() => {
    if (!isTldrLoading) {
      setTldrLoadingMessage(TLDR_LOADING_MESSAGES[0]);
      return;
    }
    const pickRandomMessage = (prev?: string) => {
      if (TLDR_LOADING_MESSAGES.length === 1) return TLDR_LOADING_MESSAGES[0];
      let next = TLDR_LOADING_MESSAGES[Math.floor(Math.random() * TLDR_LOADING_MESSAGES.length)];
      while (next === prev) {
        next = TLDR_LOADING_MESSAGES[Math.floor(Math.random() * TLDR_LOADING_MESSAGES.length)];
      }
      return next;
    };
    setTldrLoadingMessage((prev) => pickRandomMessage(prev));
    const interval = window.setInterval(() => {
      setTldrLoadingMessage((prev) => pickRandomMessage(prev));
    }, 8000);
    return () => window.clearInterval(interval);
  }, [isTldrLoading]);

  return (
    <motion.aside
      initial={{ x: 42, opacity: 0, filter: 'blur(4px)' }}
      animate={{ x: 0, opacity: 1, filter: 'blur(0px)' }}
      exit={{ x: 30, opacity: 0, filter: 'blur(4px)' }}
      transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute right-0 top-0 bottom-0 w-[440px] bg-white border-l border-[#F0F0F0] shadow-[-4px_0_24px_rgba(0,0,0,0.06)] flex flex-col z-10 print-hide"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#F0F0F0] flex items-center justify-between shrink-0">
        <div>
          <p className="text-sm text-[#1A1A1A]" style={{ fontWeight: 500 }}>Job Description</p>
          {version.jobCompany && <p className="text-xs text-[#9B9B9B] mt-0.5">{version.name}</p>}
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] hover:text-[#2B2B2B] transition-colors"><X size={15} /></button>
      </div>
      {/* Content */}
      {version.jobDescription ? (
        <>
          {isEditing ? (
            <div className="flex-1 min-h-0 px-6 py-5 flex flex-col">
              <div className="rounded-[10px] bg-[#F7F7F7] border border-[#ECECEC] px-4 py-3 mb-5 shrink-0">
                <p className="text-xs uppercase tracking-widest text-[#9B9B9B] mb-2">TL;DR</p>
                {isTldrLoading ? (
                  <p className="text-sm loading-shimmer-text">
                    {tldrLoadingMessage}
                  </p>
                ) : (
                  <div className="space-y-2.5 text-sm text-[#3B3B3B] leading-relaxed">
                    <p>{tldr?.roleAsks || 'No JD summary available yet.'}</p>
                    <p>{tldr?.candidateNeeds || 'Open the JD panel with a full job description for AI summary.'}</p>
                    {tldr?.keyFocusAreas && tldr.keyFocusAreas.length > 0 && (
                      <div className="mt-6">
                        <p className="text-xs uppercase tracking-widest text-[#9B9B9B] mb-1.5">Key Focus Areas</p>
                        <ul className="space-y-1">
                          {tldr.keyFocusAreas.slice(0, 3).map((focus, idx) => (
                            <li key={`${focus}-${idx}`}>• {focus}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                <textarea
                  value={jdDraft}
                  onChange={(e) => setJdDraft(e.target.value)}
                  onPaste={(event) => handleStructuredPaste(event, setJdDraft)}
                  className="flex-1 min-h-0 w-full text-sm text-[#4B4B4B] leading-[1.75] whitespace-pre-wrap bg-[#FAFAFA] border border-[#ECECEC] rounded-[8px] px-3 py-2.5 outline-none resize-none overflow-y-auto"
                />
              </div>

              <div className="pt-3 shrink-0">
                <label className="block text-[11px] uppercase tracking-widest text-[#9B9B9B] mb-1.5">Job Link</label>
                <input
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  placeholder="https://..."
                  className="w-full text-sm text-[#4B4B4B] bg-[#FAFAFA] border border-[#ECECEC] rounded-[8px] px-3 py-2 outline-none"
                />
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-[10px] bg-[#F7F7F7] border border-[#ECECEC] px-4 py-3 mb-5">
                <p className="text-xs uppercase tracking-widest text-[#9B9B9B] mb-2">TL;DR</p>
                {isTldrLoading ? (
                  <p className="text-sm loading-shimmer-text">
                    {tldrLoadingMessage}
                  </p>
                ) : (
                  <div className="space-y-2.5 text-sm text-[#3B3B3B] leading-relaxed">
                    <p>{tldr?.roleAsks || 'No JD summary available yet.'}</p>
                    <p>{tldr?.candidateNeeds || 'Open the JD panel with a full job description for AI summary.'}</p>
                    {tldr?.keyFocusAreas && tldr.keyFocusAreas.length > 0 && (
                      <div className="mt-6">
                        <p className="text-xs uppercase tracking-widest text-[#9B9B9B] mb-1.5">Key Focus Areas</p>
                        <ul className="space-y-1">
                          {tldr.keyFocusAreas.slice(0, 3).map((focus, idx) => (
                            <li key={`${focus}-${idx}`}>• {focus}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="py-1">
                <p className="text-sm text-[#4B4B4B] leading-[1.75] whitespace-pre-wrap px-4">{version.jobDescription}</p>
              </div>
            </div>
          )}
          <div className="px-6 py-4 border-t border-[#F0F0F0] flex gap-2 shrink-0">
            {(version.jobLink || linkDraft) && !isEditing && (
              <a href={version.jobLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E8] rounded-[8px] text-xs text-[#6B6B6B] hover:bg-[#F5F5F5] transition-colors">
                <ExternalLink size={12} /> View posting
              </a>
            )}
            <button
              onClick={() => {
                if (isEditing) {
                  onSave(jdDraft, linkDraft);
                  setIsEditing(false);
                  return;
                }
                setIsEditing(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E8] rounded-[8px] text-xs text-[#6B6B6B] hover:bg-[#F5F5F5] transition-colors"
            >
              <FileText size={12} /> {isEditing ? 'Save' : 'Edit'}
            </button>
            {isEditing && (
              <button
                onClick={() => {
                  setJdDraft(version.jobDescription ?? '');
                  setLinkDraft(version.jobLink ?? '');
                  setIsEditing(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E8] rounded-[8px] text-xs text-[#6B6B6B] hover:bg-[#F5F5F5] transition-colors"
              >
                <X size={12} /> Cancel
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-12 h-12 bg-[#F7F7F8] rounded-full flex items-center justify-center mb-4"><Paperclip size={20} className="text-[#D4D4D4]" /></div>
          <p className="text-sm text-[#9B9B9B]">No job description attached</p>
          <p className="text-xs text-[#CBCBCB] mt-1.5 max-w-[200px] leading-relaxed">Create a new tailored version with "+ Add new" to attach a JD</p>
        </div>
      )}
    </motion.aside>
  );
}

// ─── CreateResumeModal ───────────────────────────────────────────────────────

function CreateResumeModal({ onGenerate, onClose, isGenerating }: { onGenerate: (role: string, company: string, jd: string, link: string) => void; onClose: () => void; isGenerating: boolean }) {
  const [roleName, setRoleName] = useState(''); const [company, setCompany] = useState(''); const [jobDesc, setJobDesc] = useState(''); const [jobLink, setJobLink] = useState('');
  const fCls = "w-full px-4 py-2.5 bg-[#F7F7F8] rounded-[10px] border border-[#EFEFEF] text-sm outline-none focus:border-[#CBCBCB] placeholder:text-[#D4D4D4] transition-colors text-[#1A1A1A]";
  const canSubmit = roleName.trim().length > 0 && !isGenerating;
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isGenerating) onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [isGenerating, onClose]);
  return (
    <div className="fixed inset-0 bg-black/20 z-[200] flex items-center justify-center p-6 backdrop-blur-[2px] animate-[fadeIn_150ms_ease-out]" onClick={() => { if (!isGenerating) onClose(); }}>
      <div className="bg-white rounded-[16px] shadow-[0_24px_80px_rgba(0,0,0,0.14)] w-full max-w-[600px] animate-[fadeInScale_200ms_ease-out]" onClick={e => e.stopPropagation()}>
        <div className="px-8 py-6 border-b border-[#F0F0F0] flex items-center justify-between">
          <div><h2 className="text-base text-[#1A1A1A]" style={{ fontWeight: 500 }}>Create Resume for New Role</h2><p className="text-xs text-[#9B9B9B] mt-0.5">AI will tailor your resume to match this position</p></div>
          <button onClick={onClose} disabled={isGenerating} className="w-8 h-8 flex items-center justify-center rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"><X size={16} /></button>
        </div>
        <div className="px-8 py-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Role Name</label><input value={roleName} onChange={e => setRoleName(e.target.value)} placeholder="e.g. Product Designer" className={fCls} autoFocus disabled={isGenerating} /></div>
            <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Company <span className="text-[#CBCBCB]">(optional)</span></label><input value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Stripe" className={fCls} disabled={isGenerating} /></div>
          </div>
          <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Job Description</label><textarea value={jobDesc} onChange={e => setJobDesc(e.target.value)} onPaste={(event) => handleStructuredPaste(event, setJobDesc)} placeholder="Paste the full job description here — the more detail, the better the tailoring." rows={7} className={`${fCls} resize-none leading-relaxed`} disabled={isGenerating} /></div>
          <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Job Link <span className="text-[#CBCBCB]">(optional)</span></label><input value={jobLink} onChange={e => setJobLink(e.target.value)} placeholder="https://…" className={fCls} disabled={isGenerating} /></div>
          {isGenerating && (
            <p className="text-xs text-[#6B6B6B]">Generating your tailored resume. This can take a moment.</p>
          )}
        </div>
        <div className="px-8 py-5 border-t border-[#F0F0F0] flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={isGenerating} className="px-4 py-2.5 border border-[#E8E8E8] rounded-[10px] text-sm text-[#6B6B6B] hover:bg-[#F5F5F5] disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
          <button onClick={() => { if (roleName.trim() && !isGenerating) onGenerate(roleName, company, jobDesc, jobLink); }} disabled={!canSubmit} className="px-4 py-2.5 bg-[#1A1A1A] text-white rounded-[10px] text-sm hover:bg-black disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[152px]">
            <Sparkles size={13} className={isGenerating ? 'animate-pulse' : ''} /> {isGenerating ? 'Generating...' : 'Generate Resume'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BaseResumeFileModal({
  fileName,
  pdfUrl,
  hasUploadedPdf,
  isLoading,
  isUploading,
  onClose,
  onReplace,
}: {
  fileName: string;
  pdfUrl: string;
  hasUploadedPdf: boolean;
  isLoading: boolean;
  isUploading: boolean;
  onClose: () => void;
  onReplace: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const isEmptyState = !hasUploadedPdf;
  return (
    <div className="fixed inset-0 bg-black/20 z-[220] flex items-center justify-center p-6 backdrop-blur-[2px] animate-[fadeIn_150ms_ease-out]" onClick={onClose}>
      <div className={`bg-white rounded-[16px] shadow-[0_24px_80px_rgba(0,0,0,0.14)] w-full overflow-hidden animate-[fadeInScale_200ms_ease-out] flex flex-col ${isEmptyState ? 'max-w-[620px]' : 'max-w-[920px] max-h-[92vh]'}`} onClick={(e) => e.stopPropagation()}>
        <div className="px-8 py-6 border-b border-[#F0F0F0] flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base text-[#1A1A1A]" style={{ fontWeight: 500 }}>
              {isEmptyState ? 'Upload Resume' : 'Resume Preview'}
            </h3>
            <p className="text-xs text-[#9B9B9B] mt-0.5 truncate max-w-[620px]">
              {isEmptyState ? 'Start building your master resume' : (fileName || 'resume.pdf')}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] transition-colors"><X size={16} /></button>
        </div>

        {isEmptyState ? (
          <div className="px-8 py-8 flex items-center justify-center min-h-[220px]">
            <div className="text-center max-w-[360px]">
              <p className="text-sm text-[#8B8B8B]">No resume uploaded yet.</p>
            </div>
          </div>
        ) : (
          <div className="px-8 py-6 flex-1 min-h-0 flex flex-col">
            {isLoading ? (
              <div className="flex-1 min-h-[56vh] w-full rounded-[12px] border border-[#ECECEC] bg-[#FAFAFA] flex items-center justify-center text-sm text-[#8B8B8B]">Loading PDF preview...</div>
            ) : pdfUrl ? (
              <iframe title="Uploaded resume preview" src={pdfUrl} className="block flex-1 min-h-[56vh] w-full rounded-[12px] border border-[#ECECEC] bg-white" />
            ) : (
              <div className="flex-1 min-h-[56vh] w-full rounded-[12px] border border-[#ECECEC] bg-[#FAFAFA] flex items-center justify-center text-sm text-[#8B8B8B]">
                Unable to preview this PDF.
              </div>
            )}
          </div>
        )}
        <div className="px-8 py-5 border-t border-[#F0F0F0] flex items-center justify-end gap-3 shrink-0">
          {isEmptyState ? (
            <button onClick={() => fileRef.current?.click()} disabled={isUploading} className="px-4 py-2.5 bg-[#1A1A1A] text-white rounded-[10px] text-sm transition-colors hover:bg-[#2A2A2A] disabled:opacity-60">
              {isUploading ? 'Uploading...' : 'Upload'}
            </button>
          ) : (
            <div className="relative group/replace">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={isUploading}
                title="Replacing the PDF will reset your Master Resume content."
                className="px-4 py-2.5 border border-[#DCDCDC] bg-white text-[#2B2B2B] rounded-[10px] text-sm transition-colors hover:bg-[#F8F8F8] disabled:opacity-60"
              >
                {isUploading ? 'Uploading...' : 'Replace Resume'}
              </button>
              <div className="pointer-events-none absolute right-0 bottom-[calc(100%+8px)] whitespace-nowrap rounded-[8px] bg-[#1A1A1A] px-3 py-2 text-xs text-white opacity-0 transition-opacity duration-150 group-hover/replace:opacity-100">
                Replacing the PDF will reset your Master Resume content.
              </div>
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onReplace(file);
            event.currentTarget.value = '';
          }}
        />
      </div>
    </div>
  );
}


// ─── Workspace ──────────────────────────────────────────────────────────────────

export default function Workspace() {
  const navigate = useNavigate();
  const { requireAuth } = useAuthGate();
  const [searchParams] = useSearchParams();
  const [resumeId, setResumeId] = useState<string>(searchParams.get('resumeId') ?? '');
  const [versions, setVersions] = useState<ResumeVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showBaseFileModal, setShowBaseFileModal] = useState(false);
  const [basePdfUrl, setBasePdfUrl] = useState('');
  const [basePdfLoading, setBasePdfLoading] = useState(false);
  const [basePdfRefreshKey, setBasePdfRefreshKey] = useState(0);
  const [isReplacingBasePdf, setIsReplacingBasePdf] = useState(false);
  const [showJDPanel, setShowJDPanel] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isCurating, setIsCurating] = useState(false);
  const [isGeneratingVersion, setIsGeneratingVersion] = useState(false);
  const [isTldrLoading, setIsTldrLoading] = useState(false);
  const [deletingVariantId, setDeletingVariantId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ visible: boolean; message: string; tone: 'success' | 'info' | 'error' }>({ visible: false, message: '', tone: 'success' });
  const [baseResumeModel, setBaseResumeModel] = useState<BaseResumeModel | null>(null);
  const [jdVariants, setJDVariants] = useState<JDVariantModel[]>([]);
  const [resumeMeta, setResumeMeta] = useState<{ id: string; title: string; source: string; file_name?: string; created_at: string; updated_at: string } | null>(null);
  const [jdTldrByVersion, setJdTldrByVersion] = useState<Record<string, { roleAsks: string; candidateNeeds: string; keyFocusAreas: string[] }>>({});
  const avatarRef = useRef<HTMLDivElement>(null);
  const currentUser = userStore.get();
  const activeVersionRef = useRef<ResumeVersion | null>(null);
  const generateVersionLockRef = useRef(false);
  const autoSavedSigRef = useRef<Record<string, string>>({});
  const initialExpanded = INITIAL_VERSIONS
    .filter((v) => v.isAI)
    .map((v) => normalizeRoleFamilyTitle(v.jobTitle || v.name).toLowerCase());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(initialExpanded));
  const localStoreKey = storageKeyForResume(resumeId);
  const isMobile = useIsMobile();

  const handleSidebarVersionSelect = useCallback((versionId: string) => {
    setSelectedVersionId(versionId);
    if (isMobile) setIsMobileSidebarOpen(false);
  }, [isMobile]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setShowAvatarMenu(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (!isMobile) setIsMobileSidebarOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return undefined;
    document.body.style.overflow = isMobileSidebarOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, isMobileSidebarOpen]);

  const showToast = (msg: string, tone: 'success' | 'info' | 'error' = 'success') => {
    if (tone === 'error') {
      console.error(`[Workspace toast] ${msg}`);
    }
    setToast({ visible: true, message: msg, tone });
    setTimeout(() => setToast({ visible: false, message: '', tone: 'success' }), 2500);
  };
  const syncLocalStore = useCallback((nextBase: BaseResumeModel | null, nextJDVariants: JDVariantModel[]) => {
    setBaseResumeModel(nextBase);
    setJDVariants(nextJDVariants);
    saveLocalWorkspaceStore(localStoreKey, { baseResume: nextBase, jdVariants: nextJDVariants });
  }, [localStoreKey]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        let targetResumeId = resumeId;
        let loadedResumeMeta: { id: string; title: string; source: string; file_name?: string; created_at: string; updated_at: string } | null = null;
        let response: Awaited<ReturnType<typeof listVersions>>;

        if (targetResumeId) {
          const [resumeResponse, versionsResponse] = await Promise.all([
            getResume(targetResumeId).catch(() => null),
            listVersions(targetResumeId),
          ]);
          response = versionsResponse;
          if (resumeResponse?.resume) {
            loadedResumeMeta = {
              id: resumeResponse.resume.id,
              title: resumeResponse.resume.title,
              source: resumeResponse.resume.source,
              file_name: resumeResponse.resume.fileName,
              created_at: resumeResponse.resume.createdAt,
              updated_at: resumeResponse.resume.updatedAt,
            };
          }
        } else {
          const resumeListResponse = await listResumes();
          targetResumeId = resumeListResponse.resumes[0]?.id;
          if (!targetResumeId) {
            navigate('/start', { replace: true });
            return;
          }
          loadedResumeMeta = resumeListResponse.resumes.find((resume) => resume.id === targetResumeId) ?? null;
          response = await listVersions(targetResumeId);
        }

        if (!targetResumeId) {
          navigate('/start', { replace: true });
          return;
        }
        if (!resumeId) setResumeId(targetResumeId);
        setResumeMeta(loadedResumeMeta);
        const loadedVersions = response.versions as ResumeVersion[];
        if (!mounted) return;
        const localStore = loadLocalWorkspaceStore(storageKeyForResume(targetResumeId));
        const nextVersions = (loadedVersions.length === 0 ? INITIAL_VERSIONS : loadedVersions)
          .map((version) => ({ ...version, data: normalizeResumeDataShape(version.data) }))
          .map(applyHeaderTitleToVersion);
        const rootBaseVersion = nextVersions.find((v) => v.isBase) ?? nextVersions[0];
        const baseResumeId = localStore.baseResume?.id ?? rootBaseVersion.baseResumeId ?? `base-${targetResumeId}`;
        const nextBaseResume: BaseResumeModel = {
          id: baseResumeId,
          content: buildTextResume(rootBaseVersion.data),
          updatedAt: new Date().toISOString(),
        };
        const hydrated = nextVersions.map((version) => {
          const contentSnapshot = buildTextResume(version.data);
          if (version.id === rootBaseVersion.id) {
            return { ...version, isBase: true, baseResumeId, variantContent: contentSnapshot };
          }
          if (!version.isAI) return version;
          const linkedVariant = version.jdVariantId ? localStore.jdVariants.find((item) => item.id === version.jdVariantId) : null;
          return {
            ...version,
            baseResumeId: version.baseResumeId ?? baseResumeId,
            variantContent: linkedVariant?.variantContent ?? version.variantContent ?? contentSnapshot,
          };
        });
        setVersions(hydrated);
        setSelectedVersionId((hydrated.find((v) => v.isBase)?.id ?? hydrated[0].id));
        setBaseResumeModel(nextBaseResume);
        setJDVariants(localStore.jdVariants);
        saveLocalWorkspaceStore(storageKeyForResume(targetResumeId), { baseResume: nextBaseResume, jdVariants: localStore.jdVariants });
        const normalizedTitleVersions = loadedVersions.length === 0
          ? []
          : hydrated.filter((version) => {
            const original = loadedVersions.find((loadedVersion) => loadedVersion.id === version.id);
            return Boolean(original && original.data.title !== version.data.title);
          });
        if (normalizedTitleVersions.length > 0) {
          void Promise.all(normalizedTitleVersions.map((version) => updateVersion(targetResumeId, version.id, version).catch(() => null)));
        }
      } catch (err) {
        if (!mounted) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load resume workspace');
      } finally {
        if (mounted) setIsLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [navigate, resumeId, syncLocalStore]);

  useEffect(() => {
    activeVersionRef.current = (versions.find(v => v.id === selectedVersionId) || versions[0] || null);
  }, [versions, selectedVersionId]);

  const activeVersion = versions.find(v => v.id === selectedVersionId) || versions[0];
  const baseVersion = versions.find(v => v.isBase) ?? versions[0];
  const effectiveResumeId = resumeId || resumeMeta?.id || '';
  const hasUploadedResumePdf = Boolean(resumeMeta?.source === 'upload' && resumeMeta.file_name);
  const canManageBaseResumePdf = Boolean(effectiveResumeId);
  const sidebarGroups = versions.filter((v) => v.isAI).reduce((acc, v) => {
    const roleFamily = normalizeRoleFamilyTitle(v.jobTitle || v.name);
    const key = roleFamily.toLowerCase();
    const existing = acc.find((group) => group.key === key);
    if (existing) {
      existing.items.push(v);
      return acc;
    }
    acc.push({ key, roleFamily, items: [v] });
    return acc;
  }, [] as { key: string; roleFamily: string; items: ResumeVersion[] }[]);

  const persistVersion = async (nextVersion: ResumeVersion) => {
    if (!resumeId) return;
    await updateVersion(resumeId, nextVersion.id, nextVersion);
  };

  const autosaveSerialize = (version: ResumeVersion) => JSON.stringify({
    name: version.name,
    isAI: version.isAI,
    isBase: version.isBase,
    matchScore: version.matchScore,
    jobTitle: version.jobTitle,
    jobCompany: version.jobCompany,
    jobDescription: version.jobDescription,
    jobLink: version.jobLink,
    baseResumeId: version.baseResumeId,
    jdVariantId: version.jdVariantId,
    variantContent: version.variantContent,
    lastCurationInputHash: version.lastCurationInputHash,
    data: version.data,
    aiChanges: version.aiChanges,
  });

  useEffect(() => {
    if (isLoading || loadError) return;
    if (!activeVersion || !baseVersion) {
      navigate('/start', { replace: true });
    }
  }, [activeVersion, baseVersion, isLoading, loadError, navigate]);

  useEffect(() => {
    if (!resumeId) return;
    const interval = window.setInterval(() => {
      const version = activeVersionRef.current;
      if (!version) return;
      const sig = autosaveSerialize(version);
      const prevSig = autoSavedSigRef.current[version.id];
      if (prevSig === undefined) {
        autoSavedSigRef.current[version.id] = sig;
        return;
      }
      if (sig === prevSig) return;
      void persistVersion(version)
        .then(() => {
          autoSavedSigRef.current[version.id] = sig;
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(interval);
  }, [resumeId]);

  const updateVersionData = (data: ResumeData) => {
    if (!activeVersion || !baseVersion) return;
    const normalizedData = applyHeaderTitleToData(activeVersion, data);
    const contentSnapshot = buildTextResume(normalizedData);
    const nextVersion: ResumeVersion = { ...activeVersion, data: normalizedData, variantContent: contentSnapshot };
    setVersions((prev) => prev.map((v) => (v.id === selectedVersionId ? nextVersion : v)));
    void persistVersion(nextVersion).catch(() => {});

    if (nextVersion.id !== baseVersion.id) {
      const variantSourceLabel = composeRoleCompanyTitle(nextVersion.jobTitle ?? '', nextVersion.jobCompany ?? '') || nextVersion.name || 'Variant';
      const mergedBase = mergeVariantProjectNotesIntoBase(baseVersion.data, normalizedData, variantSourceLabel);
      if (mergedBase.changed) {
        const nextBaseVersion: ResumeVersion = {
          ...baseVersion,
          data: mergedBase.data,
          variantContent: buildTextResume(mergedBase.data),
        };
        setVersions((prev) => prev.map((v) => (v.id === baseVersion.id ? nextBaseVersion : v)));
        void persistVersion(nextBaseVersion).catch(() => {});
      }
    }

    if (nextVersion.id === baseVersion.id) {
      const nextBaseResume: BaseResumeModel = {
        id: nextVersion.baseResumeId ?? baseResumeModel?.id ?? `base-${resumeId || 'local'}`,
        content: contentSnapshot,
        updatedAt: new Date().toISOString(),
      };
      syncLocalStore(nextBaseResume, jdVariants);
      return;
    }

    if (nextVersion.jdVariantId) {
      const nowIso = new Date().toISOString();
      const nextJDVariants = jdVariants.some((item) => item.id === nextVersion.jdVariantId)
        ? jdVariants.map((item) => item.id === nextVersion.jdVariantId ? { ...item, variantContent: contentSnapshot } : item)
        : [
          ...jdVariants,
          {
            id: nextVersion.jdVariantId,
            baseResumeId: nextVersion.baseResumeId ?? baseResumeModel?.id ?? `base-${resumeId || 'local'}`,
            title: nextVersion.name,
            jdText: nextVersion.jobDescription ?? '',
            variantContent: contentSnapshot,
            createdAt: nowIso,
          },
        ];
      syncLocalStore(baseResumeModel, nextJDVariants);
    }
  };
  const handleAcceptChange = (id: string) => setVersions(prev => prev.map(v => { if (v.id !== selectedVersionId) return v; const c = v.aiChanges.find(c => c.id === id); if (!c) return v; return { ...v, data: applyChange(c, v.data), aiChanges: v.aiChanges.map(ch => ch.id === id ? { ...ch, status: 'accepted' as const } : ch) }; }));
  const handleRejectChange = (id: string) => setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: v.aiChanges.map(c => c.id === id ? { ...c, status: 'rejected' as const } : c) } : v));
  const handleAcceptAll = () => setVersions(prev => prev.map(v => { if (v.id !== selectedVersionId) return v; let data = v.data; v.aiChanges.filter(c => c.status === 'pending').forEach(c => { data = applyChange(c, data); }); return { ...v, data, aiChanges: v.aiChanges.map(c => ({ ...c, status: 'accepted' as const })) }; }));
  const handleRejectAll = () => setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: v.aiChanges.map(c => ({ ...c, status: 'rejected' as const })) } : v));

  const handleGenerateVersion = (roleName: string, company: string, jd: string, link: string) => {
    if (generateVersionLockRef.current || isGeneratingVersion) return;
    requireAuth(async () => {
      if (generateVersionLockRef.current) return;
      if (!baseVersion) return;
      generateVersionLockRef.current = true;
      setIsGeneratingVersion(true);
      const baseSnapshot = buildTextResume(baseVersion.data);
      const nowIso = new Date().toISOString();
      const nextBaseResume: BaseResumeModel = {
        id: baseResumeModel?.id ?? baseVersion.baseResumeId ?? `base-${resumeId || 'local'}`,
        content: baseSnapshot,
        updatedAt: nowIso,
      };
      const { version: nv, jdVariant } = createJDVariantFromBase(baseVersion, roleName || 'New Role', company, jd, link, nextBaseResume);
      try {
        let nextVersion = nv;
        if (resumeId) {
          const created = await createVersion(resumeId, nv);
          const createdVersion = created.version as ResumeVersion;
          nextVersion = applyHeaderTitleToVersion({
            ...nv,
            ...createdVersion,
            data: normalizeResumeDataShape((createdVersion.data as ResumeData) ?? nv.data),
            aiChanges: (createdVersion.aiChanges as AIChange[]) ?? nv.aiChanges,
            jdVariantId: createdVersion.jdVariantId ?? nv.jdVariantId,
            variantContent: createdVersion.variantContent ?? nv.variantContent,
            baseResumeId: createdVersion.baseResumeId ?? nv.baseResumeId,
          });
        }
        setShowModal(false);
        const nextGroupKey = normalizeRoleFamilyTitle(nextVersion.jobTitle || nextVersion.name).toLowerCase();
        setExpandedGroups((prev) => new Set([...prev, nextGroupKey]));
        setVersions((prev) => [...prev, nextVersion]);
        setSelectedVersionId(nextVersion.id);
        setIsCurating(true);

        let finalVersion = nextVersion;
        try {
          const includePreviouslyAccepted = hasNewCurationContext(nextVersion);
          if (!includePreviouslyAccepted && !hasCuratableBullets(nextVersion)) {
            showToast('All accepted AI bullets are unchanged, so curation was skipped.', 'info');
          } else {
            const curation = await curateResume({
              resumeData: buildResumeDataForCuration(nextVersion, baseVersion),
              targetRole: nextVersion.jobTitle || nextVersion.data.title,
              jdText: nextVersion.jobDescription,
              jobCompany: nextVersion.jobCompany,
              jobLink: nextVersion.jobLink,
            });
            const fallbackReason = getCurationFallbackReason(curation);
            if (fallbackReason) {
              showToast(fallbackReason, 'info');
              if (!hasMeaningfulJobDescription(nextVersion.jobDescription)) {
                setShowJDPanel(true);
              }
            } else {
              const changes = buildPendingAIChangesFromCuration(nextVersion, curation, Date.now(), { includePreviouslyAccepted });
              if (changes.length > 0) {
                const curatedData = applyAllChanges(nextVersion.data, changes);
                finalVersion = {
                  ...nextVersion,
                  data: curatedData,
                  variantContent: buildTextResume(curatedData),
                  aiChanges: [],
                };
              } else {
                finalVersion = markVersionCurated(nextVersion);
                showToast(getCurationNoChangeMessage(curation), 'info');
              }
              if (changes.length > 0) {
                finalVersion = markVersionCurated(finalVersion);
              }
            }
          }
        } catch {
          showToast('AI curation failed. Please try again.', 'error');
        } finally {
          setIsCurating(false);
        }

        if (resumeId) {
          await updateVersion(resumeId, finalVersion.id, finalVersion);
        }
        const nextJDVariants = [...jdVariants.filter((item) => item.id !== jdVariant.id), { ...jdVariant, variantContent: finalVersion.variantContent ?? buildTextResume(finalVersion.data) }];
        setVersions((prev) => prev.map((v) => (v.id === finalVersion.id ? finalVersion : v)));
        syncLocalStore(nextBaseResume, nextJDVariants);
        showToast(`Resume created for ${finalVersion.name}`);
      } catch {
        setIsCurating(false);
        showToast('Failed to save generated version');
      } finally {
        setIsGeneratingVersion(false);
        generateVersionLockRef.current = false;
      }
    });
  };

  const handleCurate = () => {
    requireAuth(async () => {
      const versionId = selectedVersionId;
      const snapshot = activeVersion;
      if (!snapshot) return;
      if (!snapshot.isBase && !hasMeaningfulJobDescription(snapshot.jobDescription)) {
        setShowJDPanel(true);
        showToast('Add the full JD before curating so AI can make targeted changes.', 'info');
        return;
      }
      setIsCurating(true);
      try {
        const includePreviouslyAccepted = hasNewCurationContext(snapshot);
        if (!includePreviouslyAccepted && !hasCuratableBullets(snapshot)) {
          showToast('All accepted AI bullets are unchanged, so curation was skipped.', 'info');
          return;
        }
        const result = await curateResume({
          resumeData: buildResumeDataForCuration(snapshot, baseVersion),
          targetRole: snapshot.jobTitle || snapshot.data.title,
          jdText: snapshot.jobDescription,
          jobCompany: snapshot.jobCompany,
          jobLink: snapshot.jobLink,
        });
        const fallbackReason = getCurationFallbackReason(result);
        if (fallbackReason) {
          showToast(fallbackReason, 'info');
          if (!hasMeaningfulJobDescription(snapshot.jobDescription)) {
            setShowJDPanel(true);
          }
          return;
        }
        const curatedSnapshot = markVersionCurated(snapshot);
        const nextChanges = buildPendingAIChangesFromCuration(snapshot, result, Date.now(), { includePreviouslyAccepted });
        if (nextChanges.length === 0) {
          setVersions((prev) => prev.map((v) => (
            v.id === versionId
              ? { ...v, lastCurationInputHash: curatedSnapshot.lastCurationInputHash }
              : v
          )));
        }
        if (nextChanges.length === 0) {
          showToast(getCurationNoChangeMessage(result), 'info');
          return;
        }
        setVersions((prev) => prev.map((v) => (
          v.id === versionId
            ? {
              ...v,
              aiChanges: mergeAIChangesWithoutRepeats(v.aiChanges ?? [], nextChanges),
              lastCurationInputHash: curatedSnapshot.lastCurationInputHash,
            }
            : v
        )));
        showToast(`${nextChanges.length} curation suggestion${nextChanges.length === 1 ? '' : 's'} ready to review.`);
      } catch (_error) {
        showToast('AI curation failed. Please try again.', 'error');
      } finally {
        setIsCurating(false);
      }
    });
  };

  const handleDeleteVariant = (versionId: string) => {
    if (deletingVariantId) return;
    const target = versions.find((v) => v.id === versionId);
    if (!target || target.isBase) return;
    const confirmed = window.confirm(`Delete ${target.name}? This cannot be undone.`);
    if (!confirmed) return;
    setDeletingVariantId(versionId);
    const fallbackSelectedId = baseVersion?.id ?? versions[0]?.id ?? '';
    const nextJDVariants = target.jdVariantId ? jdVariants.filter((item) => item.id !== target.jdVariantId) : jdVariants;
    if (resumeId) {
      void deleteVersion(resumeId, versionId)
        .then(() => {
          setVersions((prev) => prev.filter((v) => v.id !== versionId));
          if (selectedVersionId === versionId) setSelectedVersionId(fallbackSelectedId);
          syncLocalStore(baseResumeModel, nextJDVariants);
          showToast('Variant deleted');
        })
        .catch((error) => {
          showToast(error instanceof Error ? error.message : 'Failed to delete variant');
        })
        .finally(() => {
          setDeletingVariantId((current) => (current === versionId ? null : current));
        });
      return;
    }
    setVersions((prev) => prev.filter((v) => v.id !== versionId));
    if (selectedVersionId === versionId) setSelectedVersionId(fallbackSelectedId);
    syncLocalStore(baseResumeModel, nextJDVariants);
    showToast('Variant deleted');
    setDeletingVariantId((current) => (current === versionId ? null : current));
  };
  useEffect(() => {
    if (!showBaseFileModal || !effectiveResumeId) return;
    if (!hasUploadedResumePdf) {
      setBasePdfUrl('');
      setBasePdfLoading(false);
      return;
    }
    let revokedUrl: string | null = null;
    setBasePdfLoading(true);
    void getResumePdfBlob(effectiveResumeId)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revokedUrl = url;
        setBasePdfUrl(url);
      })
      .catch(() => {
        setBasePdfUrl('');
        showToast('Unable to load uploaded PDF preview');
      })
      .finally(() => {
        setBasePdfLoading(false);
      });

    return () => {
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [showBaseFileModal, effectiveResumeId, basePdfRefreshKey, hasUploadedResumePdf]);

  const handleReplaceBasePdf = async (file: File) => {
    if (!effectiveResumeId) return;
    if (file.type !== 'application/pdf') {
      showToast('Please upload a PDF file');
      return;
    }
    setIsReplacingBasePdf(true);
    try {
      const response = await replaceResumePdf(effectiveResumeId, file, resumeMeta?.title || 'Uploaded Resume');
      const incomingVersion = applyHeaderTitleToVersion({
        ...(response.version as ResumeVersion),
        data: normalizeResumeDataShape((response.version as ResumeVersion).data),
      });
      setVersions((prev) => prev.map((version) => (
        version.id === incomingVersion.id
          ? {
            ...version,
            ...incomingVersion,
            isBase: true,
            aiChanges: [],
            variantContent: buildTextResume(incomingVersion.data),
          }
          : version
      )));

      const refreshedBase = {
        id: baseResumeModel?.id ?? incomingVersion.baseResumeId ?? `base-${effectiveResumeId}`,
        content: buildTextResume(incomingVersion.data),
        updatedAt: new Date().toISOString(),
      };
      syncLocalStore(refreshedBase, jdVariants);
      setResumeMeta((prev) => prev ? { ...prev, source: response.resume.source, file_name: response.resume.file_name, updated_at: response.resume.updated_at } : prev);
      setSelectedVersionId(incomingVersion.id);
      setBasePdfRefreshKey((prev) => prev + 1);
      setShowBaseFileModal(false);
      showToast('Master resume replaced from uploaded PDF');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to replace uploaded PDF');
    } finally {
      setIsReplacingBasePdf(false);
    }
  };

  const handleSaveJDDetails = (jdText: string, jobLink: string) => {
    if (!activeVersion) return;
    const trimmedJd = jdText.trim();
    const trimmedLink = jobLink.trim();
    const nextVersion: ResumeVersion = {
      ...activeVersion,
      jobDescription: trimmedJd,
      jobLink: trimmedLink,
    };
    setVersions((prev) => prev.map((v) => (v.id === activeVersion.id ? nextVersion : v)));
    void persistVersion(nextVersion).catch(() => {});
    if (nextVersion.jdVariantId) {
      const nextVariants = jdVariants.map((item) => item.id === nextVersion.jdVariantId ? { ...item, jdText: trimmedJd } : item);
      syncLocalStore(baseResumeModel, nextVariants);
    }
    showToast('Job description updated');
  };
  useEffect(() => {
    if (!showJDPanel || !activeVersion?.id || !activeVersion.jobDescription?.trim() || !baseVersion) return;
    if (jdTldrByVersion[activeVersion.id]) return;
    let cancelled = false;
    setIsTldrLoading(true);
    void curateResume({
      resumeData: buildResumeDataForCuration(activeVersion, baseVersion),
      targetRole: activeVersion.jobTitle || activeVersion.data.title,
      jdText: activeVersion.jobDescription,
      jobCompany: activeVersion.jobCompany,
      jobLink: activeVersion.jobLink,
    })
      .then((result) => {
        if (cancelled) return;
        const keyFocusAreas = (result.jdTldr?.keyFocusAreas?.length ? result.jdTldr.keyFocusAreas : result.jdFocusAreas ?? []).slice(0, 3);
        setJdTldrByVersion((prev) => ({
          ...prev,
          [activeVersion.id]: {
            roleAsks: result.jdTldr?.roleAsks || 'Role asks: deliver against responsibilities and ownership outlined in the JD.',
            candidateNeeds: result.jdTldr?.candidateNeeds || 'Candidate needs: clear execution quality, collaboration, and role-relevant outcomes.',
            keyFocusAreas,
          },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setJdTldrByVersion((prev) => ({
          ...prev,
          [activeVersion.id]: {
            roleAsks: 'Role asks: execute core responsibilities defined in the JD with strong quality and ownership.',
            candidateNeeds: 'Candidate needs: show relevant outcomes, communication, and cross-functional execution.',
            keyFocusAreas: [],
          },
        }));
      })
      .finally(() => {
        if (!cancelled) setIsTldrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showJDPanel, activeVersion?.id, activeVersion?.jobDescription, activeVersion?.jobTitle, jdTldrByVersion, baseVersion]);
  const pendingSuggestionCount = activeVersion?.aiChanges.filter(c => c.status === 'pending').length ?? 0;
  const hasMeaningfulJD = hasMeaningfulJobDescription(activeVersion?.jobDescription);
  const canCurateActiveVersion = activeVersion?.isBase ? true : hasMeaningfulJD;
  const activeHeaderTitle = activeVersion ? getHeaderTitleForVersion(activeVersion) : PRODUCT_DESIGNER_TITLE;
  const handleExportPdf = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportData = applyHeaderTitleToData(activeVersion, activeVersion.data);
      const pdf = buildPdfDocument(exportData);
      pdf.save(`${sanitizeFileName(activeVersion.name)}.pdf`);
      showToast('PDF downloaded');
    } catch (error) {
      console.error('PDF export failed', error);
      showToast('Failed to export PDF');
    } finally {
      setIsExporting(false);
    }
  };
  const handleExportWord = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportData = applyHeaderTitleToData(activeVersion, activeVersion.data);
      const doc = buildWordDocument(exportData);
      const blob = await Packer.toBlob(doc);
      downloadBlob(blob, `${sanitizeFileName(activeVersion.name)}.docx`);
      showToast('Word document downloaded');
    } catch (error) {
      console.error('Word export failed', error);
      showToast('Failed to export Word document');
    } finally {
      setIsExporting(false);
    }
  };
  const handleShareLink = async () => {
    if (!resumeId || !activeVersion?.id) {
      showToast('Unable to create share link');
      return;
    }
    try {
      const response = await createResumeShareLink(resumeId, activeVersion.id);
      const shareUrl = `${window.location.origin}/shared/${response.token}`;
      await navigator.clipboard.writeText(shareUrl);
      showToast('Share link copied');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to create share link');
    }
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#6B6B6B]">Loading workspace...</div>;
  }

  if (loadError) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#D14343]">{loadError}</div>;
  }

  if (!activeVersion || !baseVersion) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#6B6B6B]">Redirecting…</div>;
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-screen flex bg-white overflow-hidden workspace-shell"
    >
      {isMobile && isMobileSidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setIsMobileSidebarOpen(false)}
          className="absolute inset-0 z-40 bg-black/30 print-hide"
        />
      )}

      {/* ── Sidebar ── */}
      <div
        className={`w-[220px] shrink-0 border-r border-[#EAEAEA] bg-[#F5F5F5] flex flex-col print-hide transition-transform duration-200 ease-out md:relative md:translate-x-0 md:shadow-none ${isMobile ? 'fixed inset-y-0 left-0 z-50 shadow-[0_12px_30px_rgba(0,0,0,0.2)]' : ''} ${isMobile && !isMobileSidebarOpen ? '-translate-x-full' : 'translate-x-0'}`}
      >
        <div className="px-6 py-5 border-b border-[#ECECEC] bg-[#F5F5F5]">
          <img src={cvLogo} alt="CV Stack" className="w-6 h-6 object-contain" />
        </div>
        <div className="flex-1 overflow-y-auto py-3">
          <div className={`group/base w-[calc(100%-16px)] mx-2 px-4 py-2 rounded-[10px] mb-1 transition-colors flex items-center gap-2 ${selectedVersionId === baseVersion.id ? 'bg-[#E9E9E9]' : 'hover:bg-[#ECECEC]'}`}>
            <button onClick={() => handleSidebarVersionSelect(baseVersion.id)} className={`flex-1 text-left text-sm ${selectedVersionId === baseVersion.id ? 'text-[#111]' : 'text-[#6B6B6B]'}`}>Master Resume</button>
          </div>
          {sidebarGroups.map(group => {
            const isOpen = expandedGroups.has(group.key);
            const groupLabel = formatSidebarRoleLabel(group.roleFamily, group.items.length);
            return (
              <div key={group.key} className="mb-1">
                <button onClick={() => setExpandedGroups(prev => { const n = new Set(prev); n.has(group.key) ? n.delete(group.key) : n.add(group.key); return n; })} className="w-[calc(100%-16px)] mx-2 text-left px-4 py-2 flex items-center gap-2 rounded-[10px] hover:bg-[#ECECEC] group">
                  <ChevronRight size={13} strokeWidth={1.8} className={`text-[#AAAAAA] group-hover:text-[#6B6B6B] transition-all duration-200 shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                  <span className="text-[13px] text-[#2B2B2B] truncate" style={{ fontWeight: 500 }}>{groupLabel}</span>
                </button>
                {isOpen && (
                  <div className="mt-0.5 mb-1 animate-[fadeIn_150ms_ease-out]">
                    {group.items.map(v => {
                      const isDeleting = deletingVariantId === v.id;
                      return (
                      <div key={v.id} className={`group/item w-[calc(100%-16px)] mx-2 pl-4 pr-2 py-1.5 rounded-[10px] mb-0.5 transition-colors flex items-center gap-1 ${selectedVersionId === v.id ? 'bg-[#E9E9E9]' : 'hover:bg-[#ECECEC]'}`}>
                        <span className="w-[21px] shrink-0" />
                        <button onClick={() => handleSidebarVersionSelect(v.id)} className={`flex-1 text-left text-[13px] truncate ${selectedVersionId === v.id ? 'text-[#111] font-medium' : 'text-[#7F7F7F]'}`}>
                          {v.jobCompany}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteVariant(v.id);
                          }}
                          disabled={isDeleting}
                          className={`${isDeleting ? 'opacity-100 text-[#9C9C9C] cursor-wait' : 'opacity-0 group-hover/item:opacity-100 text-[#B5B5B5] hover:text-[#7A7A7A]'} transition-opacity p-1 rounded`}
                          aria-label={isDeleting ? `Deleting ${v.name}` : `Delete ${v.name}`}
                          title={isDeleting ? 'Deleting variant...' : 'Delete variant'}
                        >
                          {isDeleting ? <LoaderCircle size={12} strokeWidth={1.8} className="animate-spin" /> : <Trash2 size={12} strokeWidth={1.8} />}
                        </button>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={() => requireAuth(() => setShowModal(true))} className="w-[calc(100%-16px)] mx-2 text-left px-4 py-2 rounded-[10px] text-[13px] text-[#9B9B9B] hover:bg-[#ECECEC] hover:text-[#6B6B6B] flex items-center gap-2 mt-2"><Plus size={13} strokeWidth={1.8} /> Add new</button>
        </div>
      </div>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Top bar */}
        <div className="h-14 px-4 md:px-6 flex items-center justify-between shrink-0 print-hide relative bg-white">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <button
                type="button"
                onClick={() => setIsMobileSidebarOpen((open) => !open)}
                className="md:hidden inline-flex h-8 w-8 items-center justify-center rounded-md text-[#6B6B6B] hover:bg-[#F2F2F2] hover:text-[#2B2B2B] transition-colors"
                aria-label="Toggle sidebar"
              >
                <Menu size={18} />
              </button>
              <span className="text-[#CBCBCB]">Resumes</span><span className="text-[#E0E0E0]">/</span>
              <span className="text-[#1A1A1A] truncate">{activeVersion.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative" ref={avatarRef}>
                <button onClick={() => setShowAvatarMenu(p => !p)} className="flex items-center gap-1 group">
                  <div className="w-8 h-8 rounded-full bg-[#2B2B2B] text-white flex items-center justify-center group-hover:bg-black select-none" style={{ fontSize: 12 }}>
                    {(currentUser?.fullName || currentUser?.email || 'Guest').slice(0, 2).toUpperCase()}
                  </div>
                  <ChevronDown size={13} className="text-[#CBCBCB]" />
                </button>
                {showAvatarMenu && (
                  <div className="absolute right-0 top-11 w-48 bg-[#F3F3F3] border border-[#E2E2E2] rounded-[16px] shadow-[0_10px_28px_rgba(0,0,0,0.12)] p-2 z-50 animate-[fadeInDown_150ms_ease-out]">
                    <button className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] rounded-[10px] hover:bg-[#E7E7E7] transition-colors flex items-center gap-2.5">
                      <Settings size={14} className="text-[#A0A0A0]" /> Settings
                    </button>
                    <button onClick={() => { clearAuthStorage(); navigate('/start'); }} className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] rounded-[10px] hover:bg-[#E7E7E7] transition-colors flex items-center gap-2.5">
                      <LogOut size={14} className="text-[#A0A0A0]" /> Log Out
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="absolute bottom-0 left-6 right-6 h-px bg-[#EFEFEF]" />
          </div>

        {/* Content + JD overlay + floating toolbar */}
        <div className="flex-1 relative overflow-hidden">

          {/* Scrollable resume content */}
          <div className="absolute inset-0 overflow-y-auto bg-white" id="print-resume-root">
            <div className="max-w-[960px] mx-auto py-14 px-12 pb-32 print-page resume-print-root">
              <motion.div
                key={activeVersion.id}
                initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 0.24, ease: 'easeOut' }}
              >
              <ResumeView isReviewLocked={pendingSuggestionCount > 0} version={activeVersion} headerTitle={activeHeaderTitle} onUpdateData={updateVersionData} onAcceptChange={handleAcceptChange} onRejectChange={handleRejectChange} onShowToast={showToast} />
              </motion.div>
              <p className="text-center mt-12 print-hide" style={{ fontSize: 12, color: '#D4D4D4' }}>Click dates to edit · Click any text to edit · Drag bullets to reorder</p>
            </div>
          </div>

          {/* JD Side Panel — slides in from right */}
          <AnimatePresence>
            {showJDPanel && (
              <>
                <motion.div
                  key="jd-panel-backdrop"
                  className="absolute inset-0 z-[9] pointer-events-none"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                />
                <JDSidePanel
                  version={activeVersion}
                  tldr={jdTldrByVersion[activeVersion.id]}
                  isTldrLoading={isTldrLoading}
                  onClose={() => setShowJDPanel(false)}
                  onSave={handleSaveJDDetails}
                />
              </>
            )}
          </AnimatePresence>

          <div
            className={`absolute inset-0 z-30 transition-opacity duration-500 ${isCurating ? 'opacity-100 pointer-events-auto cursor-default' : 'opacity-0 pointer-events-none'}`}
          >
            <div className="absolute inset-0 bg-white/24 backdrop-blur-[4px]" />
            <div className="absolute inset-0 opacity-90 bg-[radial-gradient(130%_100%_at_10%_10%,rgba(127,230,218,0.26)_0%,rgba(127,230,218,0)_55%),radial-gradient(120%_110%_at_90%_12%,rgba(159,174,255,0.24)_0%,rgba(159,174,255,0)_52%),radial-gradient(115%_100%_at_52%_92%,rgba(240,155,231,0.22)_0%,rgba(240,155,231,0)_52%)] bg-[length:170%_170%,170%_170%,170%_170%] animate-[curationBackdropDrift_8s_ease-in-out_infinite]" />
          </div>

          {/* ── Floating toolbar — centered at bottom, above scroll ── */}
          <div className="absolute bottom-8 inset-x-0 flex justify-center z-40 pointer-events-none print-hide">
            <div className="pointer-events-auto">
              <FloatingToolbar
                isBaseResume={selectedVersionId === baseVersion.id}
                hasJD={!!(activeVersion.jobDescription)}
                canCurate={canCurateActiveVersion}
                curateHint="Add at least a short JD (40+ characters) to unlock targeted curation."
                pendingCount={pendingSuggestionCount}
                isCurating={isCurating}
                jdPanelOpen={showJDPanel}
                hasUploadedResumePdf={hasUploadedResumePdf}
                canManageBaseResumePdf={canManageBaseResumePdf}
                onAcceptAll={handleAcceptAll}
                onRejectAll={handleRejectAll}
                onOpenResumeModal={() => setShowBaseFileModal(true)}
                onJDClick={() => setShowJDPanel(p => !p)}
                onCurate={handleCurate}
                onExportPDF={handleExportPdf}
                onExportWord={handleExportWord}
                onShareLink={() => { void handleShareLink(); }}
              />
            </div>
          </div>
        </div>
      </div>

      {showModal && <CreateResumeModal onGenerate={handleGenerateVersion} onClose={() => setShowModal(false)} isGenerating={isGeneratingVersion} />}
      {showBaseFileModal && (
        <BaseResumeFileModal
          fileName={resumeMeta?.file_name || 'resume.pdf'}
          pdfUrl={basePdfUrl}
          hasUploadedPdf={hasUploadedResumePdf}
          isLoading={basePdfLoading}
          isUploading={isReplacingBasePdf}
          onClose={() => setShowBaseFileModal(false)}
          onReplace={(file) => { void handleReplaceBasePdf(file); }}
        />
      )}
      <Toast message={toast.message} visible={toast.visible} tone={toast.tone} />
    </motion.div>
  );
}
