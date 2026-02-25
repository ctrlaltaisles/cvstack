import OpenAI from 'openai';
import type { ResumeData } from '../types';

export type SeniorityLevel = 'intern' | 'junior' | 'mid' | 'senior' | 'lead';

export interface TailorResumeInput {
  jdText: string;
  baseResumeText: string;
  targetTitle?: string;
  seniority?: SeniorityLevel;
}

export interface TailorResumeOutput {
  variantResumeText: string;
  changeSummary: string[];
  redFlags: string[];
  keywordCoverage: { matched: string[]; missing: string[] };
}

export interface CurateSuggestion {
  field: 'bio' | 'bullet';
  expId?: string;
  bulletIdx?: number;
  suggested: string;
  reason?: string;
}

export interface ElevateExperience {
  expId: string;
  role: string;
  company: string;
  bullets: string[];
}

export interface ElevateChange {
  section: string;
  before: string;
  after: string;
  reason: string;
}

export interface ElevateATS {
  targetRole: string;
  keywordsAdded: Array<{ keyword: string; where: string }>;
  keywordsMissing: string[];
}

export interface ElevateQuality {
  similarityScore: number;
  impactScore: number;
  atsScore: number;
  passed: boolean;
  notes: string;
}

export interface CompanyContext {
  company: string;
  focus: string;
  stellarProfile: string[];
  evidence: string[];
}

export interface CurateResumeOutput {
  changeSummary: string[];
  redFlags: string[];
  aboutPointers: string[];
  jdFocusAreas: string[];
  jdTldr: {
    roleAsks: string;
    candidateNeeds: string;
    keyFocusAreas: string[];
  };
  companyContext?: CompanyContext;
  suggestions: CurateSuggestion[];
  improved: {
    about: string;
    experience: ElevateExperience[];
    skills: string[];
  };
  changes: ElevateChange[];
  ats: ElevateATS;
  questions: string[];
  quality: ElevateQuality;
  meta?: {
    providerStatus: 'ok' | 'fallback';
    fallbackReason?: string;
    model?: string;
  };
}

interface CurateResumeInput {
  resumeData: ResumeData;
  targetRole?: string;
  jdText?: string;
  seniority?: SeniorityLevel;
  jobCompany?: string;
  jobLink?: string;
}

export class TailorResumeError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 60000);
const CURATE_TIMEOUT_MS = Number(process.env.OPENAI_CURATE_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS ?? 120000);
const SECOND_PASS_MIN_REMAINING_MS = Number(process.env.OPENAI_SECOND_PASS_MIN_REMAINING_MS ?? 45000);
const CURATE_SECOND_PASS_ENABLED = String(process.env.OPENAI_CURATE_SECOND_PASS ?? 'false').trim().toLowerCase() === 'true';
const CURATE_TIMEOUT_DISABLED = String(process.env.OPENAI_CURATE_DISABLE_TIMEOUT ?? 'true').trim().toLowerCase() === 'true' || CURATE_TIMEOUT_MS <= 0;
const CURATE_MAX_TOKENS = Number(process.env.OPENAI_CURATE_MAX_TOKENS ?? 1800);
const COMPANY_RESEARCH_TIMEOUT_MS = Number(process.env.COMPANY_RESEARCH_TIMEOUT_MS ?? 4500);
const CURATION_ROLE_CLUSTERS = [
  'Product Manager',
  'Software Developer',
  'Front-End Developer',
  'Product Designer',
  'Business Development',
  'Data Analytics',
];
const CURATION_HARD_RULES = [
  'No fabricated metrics or tools',
  'Do not invent new employers/projects/awards',
  'If data is missing, ask concise questions (max 5)',
  'Reject synonym-only rewrites',
  'Prioritize ownership, scope, outcomes, and business impact',
];
const CURATION_GENERIC_PHRASES_TO_REDUCE = [
  'helped',
  'worked on',
  'responsible for',
  'assisted with',
  'various tasks',
];
const CURATION_SYSTEM_PROMPT = [
  'You are a principal tech recruiter and hiring panel advisor with 12+ years placing candidates into high-bar technology roles.',
  'Specialize in Product Manager, Software Developer, Front-End Developer, Product Designer, Business Development, and Data Analytics hiring.',
  'Your edits must sound sharp, distinct, and impact-first, aligned with what employers screen for in tech hiring loops.',
  'Return valid JSON only.',
  'NON-NEGOTIABLE: if output is mostly synonym swaps without stronger ownership, scope, outcomes, tooling, and decision signal, it fails.',
  'Use impact-first bullets: [Action Verb] + [What] + [How] + [Outcome/Metric] + [Scope] + [Tools].',
  'If no metrics exist in source, do not invent them. Put metric placeholders only under questions.',
  'Keep truthfulness: do not invent employers, products, metrics, awards, credentials, or tools.',
  'Remove fluff and generic verbs. Keep max 5-7 bullets per role.',
  'Each change reason must cite at least one recruiter heuristic: ownership, scope, outcomes, tooling, signal clarity.',
  'Optimize keyword placement across About, Experience, and Skills without keyword stuffing.',
].join(' ');
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'was', 'were', 'this', 'these', 'those',
]);

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; message?: string };
  const name = String(maybe.name ?? '').toLowerCase();
  const message = String(maybe.message ?? '').toLowerCase();
  return name.includes('abort') || message.includes('aborted') || message.includes('timed out');
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function tokenize(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9%$\-\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token));
}

function jaccard(tokensA: string[], tokensB: string[]): number {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const token of a) {
    if (b.has(token)) intersect += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersect / union;
}

export function lexicalSimilarity(before: string, after: string): number {
  return round2(jaccard(tokenize(before), tokenize(after)));
}

function hasMetric(text: string): boolean {
  return /(\d+\s?%|\$\s?\d+|\d+\s?(k|m|b)|\d+\+|\d+\s?(ms|s|sec|secs|seconds|mins|minutes|hrs|hours|days|weeks|months|years))/i.test(text);
}

function hasScopeSignal(text: string): boolean {
  return /\b(across|end-to-end|multi|global|portfolio|org|organization|team|squad|cross-functional|stakeholder|production|users?|customers?|client|enterprise|platform|roadmap|launch)\b/i.test(text);
}

function hasOwnershipSignal(text: string): boolean {
  return /\b(owned|led|drove|spearheaded|architected|designed|implemented|launched|directed|orchestrated|defined|prioritized|mentored)\b/i.test(text);
}

function hasToolSignal(text: string): boolean {
  return /\b(figma|react|typescript|python|sql|aws|gcp|azure|tableau|power bi|jira|notion|excel|ga4|google analytics|mixpanel|amplitude|kibana|snowflake|spark|node|next\.js|docker|kubernetes)\b/i.test(text);
}

function hasOutcomeSignal(text: string): boolean {
  return /\b(increased|improved|reduced|cut|saved|accelerated|grew|boosted|improving|reducing|resulting|enabled|delivered|achieved|decreased)\b/i.test(text);
}

function genericFillerCount(text: string): number {
  const matches = String(text ?? '').match(/\b(helped|worked on|responsible for|assisted with|involved in|participated in|various|multiple tasks)\b/gi);
  return matches?.length ?? 0;
}

function extractNumbers(text: string): string[] {
  const matches = String(text ?? '').match(/(\d+\s?%|\$\s?\d+[\d,.]*|\d+\s?(k|m|b)|\d+\+|\d+)/gi);
  return (matches ?? []).map((m) => m.trim().toLowerCase());
}

export function extractJDKeywords(jdText: string, targetRole?: string): string[] {
  const seed = [
    'product strategy', 'roadmap', 'stakeholder management', 'cross-functional', 'user research', 'design systems', 'accessibility',
    'a/b testing', 'experimentation', 'analytics', 'sql', 'python', 'react', 'typescript', 'frontend', 'backend', 'api', 'scalability',
    'performance', 'ownership', 'leadership', 'communication', 'execution', 'delivery', 'metrics', 'kpi', 'conversion', 'retention',
  ];
  const text = `${jdText || ''} ${targetRole || ''}`.toLowerCase();
  const found = seed.filter((keyword) => text.includes(keyword.toLowerCase()));
  if (found.length > 0) return Array.from(new Set(found)).slice(0, 20);

  const tokens = tokenize(text)
    .filter((token) => token.length >= 4)
    .filter((token) => !/^\d+$/.test(token));
  const freq = new Map<string, number>();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([token]) => token);
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new TailorResumeError('Model returned empty response', 502);
  const deFenced = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const candidates = [trimmed, deFenced];
  const firstBrace = deFenced.indexOf('{');
  const lastBrace = deFenced.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(deFenced.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  throw new TailorResumeError('Model returned non-JSON response', 502);
}

function compactResumeDataForCuration(resumeData: ResumeData): ResumeData {
  const clamp = (value: string, max: number) => String(value ?? '').trim().slice(0, max);
  return {
    ...resumeData,
    name: clamp(resumeData.name, 80),
    title: clamp(resumeData.title, 80),
    bio: clamp(resumeData.bio, 700),
    workExperience: (resumeData.workExperience ?? []).slice(0, 8).map((exp) => ({
      ...exp,
      company: clamp(exp.company, 80),
      role: clamp(exp.role, 80),
      bullets: (exp.bullets ?? []).slice(0, 7).map((bullet) => clamp(bullet, 260)),
    })),
    education: (resumeData.education ?? []).slice(0, 5),
    certifications: (resumeData.certifications ?? []).slice(0, 5),
    skills: (resumeData.skills ?? []).slice(0, 40).map((skill) => clamp(skill, 40)),
  };
}

function truncate(value: string, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (!out.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      out.push(normalized);
    }
  }
  return out;
}

function normalizeCompanyName(company?: string, jobLink?: string): string {
  const explicit = truncate(company ?? '', 120);
  if (explicit) return explicit;
  try {
    const parsed = new URL(String(jobLink ?? '').trim());
    const host = parsed.hostname.replace(/^www\./i, '');
    const firstPart = host.split('.').filter(Boolean)[0] ?? '';
    return firstPart
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  } catch {
    return '';
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'CVStackBot/1.0 (+company-context)' },
      signal: controller.signal,
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToText(input: string): string {
  return String(input ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCompanyFocusSummary(text: string, targetRole: string): string {
  const normalized = text.toLowerCase();
  const focusSignals = [
    ['growth', 'growth and demand generation'],
    ['customer', 'customer value and user-centric execution'],
    ['ai', 'applied AI and intelligent product capabilities'],
    ['platform', 'platform reliability and scalable systems'],
    ['enterprise', 'enterprise-grade delivery and stakeholder alignment'],
    ['design', 'design quality and user experience'],
    ['data', 'data-driven decisions and analytics rigor'],
    ['experiment', 'experimentation and measurable optimization'],
    ['security', 'security and trust standards'],
    ['performance', 'performance, quality, and execution speed'],
  ] as const;

  const matched = uniqueStrings(
    focusSignals
      .filter(([needle]) => normalized.includes(needle))
      .map(([, label]) => label),
  ).slice(0, 3);

  if (matched.length === 0) {
    return targetRole
      ? `${targetRole} at this company is likely evaluated on ownership, execution quality, and measurable outcomes.`
      : 'This company likely evaluates talent on ownership, execution quality, and measurable outcomes.';
  }
  return `Current emphasis appears to be ${matched.join(', ')}.`;
}

function buildStellarProfile(targetRole: string, focus: string): string[] {
  const role = truncate(targetRole || 'this role', 80) || 'this role';
  return [
    `Owns priorities end-to-end in ${role}, not just task execution.`,
    'Translates ambiguity into clear plans with measurable business or user outcomes.',
    'Communicates decisions crisply across product, engineering, design, and commercial stakeholders.',
    `Demonstrates strong tooling fluency and execution aligned to company focus: ${focus}`,
  ].map((line) => truncate(line, 220));
}

async function researchCompanyContext(input: CurateResumeInput): Promise<CompanyContext | undefined> {
  const company = normalizeCompanyName(input.jobCompany, input.jobLink);
  const jdText = truncate(input.jdText ?? '', 5000);
  const targetRole = truncate(input.targetRole ?? input.resumeData.title ?? '', 120);

  const evidence: string[] = [];
  if (jdText) evidence.push(`JD highlights: ${truncate(htmlToText(jdText), 320)}`);

  const jobLink = String(input.jobLink ?? '').trim();
  if (jobLink) {
    const jobPage = await fetchTextWithTimeout(jobLink, COMPANY_RESEARCH_TIMEOUT_MS);
    const jobPageText = truncate(htmlToText(jobPage), 1200);
    if (jobPageText) evidence.push(`Job posting text: ${jobPageText}`);
  }

  if (company) {
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(company)}`;
    const wikiRaw = await fetchTextWithTimeout(wikiUrl, COMPANY_RESEARCH_TIMEOUT_MS);
    if (wikiRaw) {
      try {
        const wiki = JSON.parse(wikiRaw) as { extract?: string };
        const extract = truncate(wiki.extract ?? '', 420);
        if (extract) evidence.push(`Company background: ${extract}`);
      } catch {
        // Ignore parsing errors and continue with available signals.
      }
    }
  }

  const combinedEvidence = uniqueStrings(evidence).slice(0, 4);
  if (!company && combinedEvidence.length === 0) return undefined;

  const focus = buildCompanyFocusSummary(combinedEvidence.join(' '), targetRole);
  return {
    company: company || 'Target company',
    focus,
    stellarProfile: buildStellarProfile(targetRole, focus).slice(0, 4),
    evidence: combinedEvidence.map((line) => truncate(line, 340)),
  };
}

function sanitizeOutput(payload: unknown): TailorResumeOutput {
  if (!payload || typeof payload !== 'object') {
    throw new TailorResumeError('Model output was not valid JSON object', 502);
  }
  const raw = payload as Record<string, unknown>;
  const keywordCoverageRaw = raw.keywordCoverage as Record<string, unknown> | undefined;
  const variantResumeText = String(raw.variantResumeText ?? '').trim();
  if (!variantResumeText) {
    throw new TailorResumeError('Model output missing variantResumeText', 502);
  }
  return {
    variantResumeText,
    changeSummary: asStringArray(raw.changeSummary),
    redFlags: asStringArray(raw.redFlags),
    keywordCoverage: {
      matched: asStringArray(keywordCoverageRaw?.matched),
      missing: asStringArray(keywordCoverageRaw?.missing),
    },
  };
}

export function validateElevateSchema(payload: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload must be an object'] };
  }
  const raw = payload as Record<string, unknown>;
  if (!raw.improved || typeof raw.improved !== 'object') {
    errors.push('Missing improved object');
  } else {
    const improved = raw.improved as Record<string, unknown>;
    if (typeof improved.about !== 'string') errors.push('improved.about must be a string');
    if (!Array.isArray(improved.experience)) errors.push('improved.experience must be an array');
    if (!Array.isArray(improved.skills)) errors.push('improved.skills must be an array');
  }
  if (!Array.isArray(raw.changes)) errors.push('Missing changes array');
  if (!raw.ats || typeof raw.ats !== 'object') {
    errors.push('Missing ats object');
  } else {
    const ats = raw.ats as Record<string, unknown>;
    if (typeof ats.targetRole !== 'string') errors.push('ats.targetRole must be a string');
    if (!Array.isArray(ats.keywordsAdded)) errors.push('ats.keywordsAdded must be an array');
    if (!Array.isArray(ats.keywordsMissing)) errors.push('ats.keywordsMissing must be an array');
  }
  if (!Array.isArray(raw.questions)) errors.push('Missing questions array');
  return { valid: errors.length === 0, errors };
}

function sanitizeElevateOutput(payload: unknown, resumeData: ResumeData, targetRole: string, jdKeywords: string[]): CurateResumeOutput {
  if (!payload || typeof payload !== 'object') {
    throw new TailorResumeError('Model output was not valid JSON object', 502);
  }
  const schemaCheck = validateElevateSchema(payload);
  if (!schemaCheck.valid) {
    throw new TailorResumeError(`Model output schema invalid: ${schemaCheck.errors.join('; ')}`, 502);
  }

  const raw = payload as Record<string, unknown>;
  const improvedRaw = raw.improved as Record<string, unknown>;
  const expRaw = Array.isArray(improvedRaw.experience) ? improvedRaw.experience : [];

  const improvedExperience: ElevateExperience[] = expRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const expId = String(row.expId ?? '').trim();
      if (!expId) return null;
      const original = resumeData.workExperience.find((exp) => exp.id === expId);
      if (!original) return null;
      const bullets = asStringArray(row.bullets).slice(0, 7);
      if (bullets.length === 0) return null;
      return {
        expId,
        role: String(row.role ?? original.role).trim() || original.role,
        company: String(row.company ?? original.company).trim() || original.company,
        bullets,
      } as ElevateExperience;
    })
    .filter((item): item is ElevateExperience => Boolean(item));

  const changesRaw = Array.isArray(raw.changes) ? raw.changes : [];
  const changes: ElevateChange[] = changesRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const section = String(row.section ?? '').trim();
      const before = String(row.before ?? '').trim();
      const after = String(row.after ?? '').trim();
      const reason = String(row.reason ?? '').trim();
      if (!section || !before || !after || !reason) return null;
      return { section, before, after, reason };
    })
    .filter((item): item is ElevateChange => Boolean(item));

  const atsRaw = (raw.ats && typeof raw.ats === 'object') ? (raw.ats as Record<string, unknown>) : {};
  const keywordsAddedRaw = Array.isArray(atsRaw.keywordsAdded) ? atsRaw.keywordsAdded : [];
  const keywordsAdded = keywordsAddedRaw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const keyword = String(row.keyword ?? '').trim();
      const where = String(row.where ?? '').trim();
      if (!keyword || !where) return null;
      return { keyword, where };
    })
    .filter((item): item is { keyword: string; where: string } => Boolean(item));

  const qualityRaw = (raw.quality && typeof raw.quality === 'object') ? (raw.quality as Record<string, unknown>) : {};
  const output: CurateResumeOutput = {
    changeSummary: asStringArray(raw.changeSummary),
    redFlags: asStringArray(raw.redFlags),
    aboutPointers: asStringArray(raw.aboutPointers),
    jdFocusAreas: asStringArray(raw.jdFocusAreas).slice(0, 3),
    jdTldr: {
      roleAsks: String(((raw.jdTldr as Record<string, unknown> | undefined)?.roleAsks ?? '')).trim(),
      candidateNeeds: String(((raw.jdTldr as Record<string, unknown> | undefined)?.candidateNeeds ?? '')).trim(),
      keyFocusAreas: asStringArray((raw.jdTldr as Record<string, unknown> | undefined)?.keyFocusAreas).slice(0, 3),
    },
    suggestions: [],
    improved: {
      about: String(improvedRaw.about ?? '').trim(),
      experience: improvedExperience,
      skills: asStringArray(improvedRaw.skills),
    },
    changes,
    ats: {
      targetRole: String(atsRaw.targetRole ?? targetRole).trim() || targetRole,
      keywordsAdded,
      keywordsMissing: asStringArray(atsRaw.keywordsMissing),
    },
    questions: asStringArray(raw.questions).slice(0, 5),
    quality: {
      similarityScore: round2(Number(qualityRaw.similarityScore ?? 0)),
      impactScore: round2(Number(qualityRaw.impactScore ?? 0)),
      atsScore: round2(Number(qualityRaw.atsScore ?? 0)),
      passed: Boolean(qualityRaw.passed),
      notes: String(qualityRaw.notes ?? '').trim(),
    },
  };

  if (output.ats.keywordsMissing.length === 0 && jdKeywords.length > 0) {
    const added = new Set(output.ats.keywordsAdded.map((item) => item.keyword.toLowerCase()));
    output.ats.keywordsMissing = jdKeywords.filter((keyword) => !added.has(keyword.toLowerCase())).slice(0, 12);
  }

  return output;
}

function deriveSuggestionsFromImproved(resumeData: ResumeData, improved: CurateResumeOutput['improved'], changes: ElevateChange[]): CurateSuggestion[] {
  const suggestions: CurateSuggestion[] = [];
  if (improved.about && improved.about.trim() && improved.about.trim() !== resumeData.bio.trim()) {
    const changeReason = changes.find((item) => item.section.toLowerCase().includes('about'))?.reason;
    suggestions.push({
      field: 'bio',
      suggested: improved.about.trim(),
      reason: changeReason,
    });
  }

  for (const exp of improved.experience) {
    const originalExp = resumeData.workExperience.find((item) => item.id === exp.expId);
    if (!originalExp) continue;
    const maxLen = Math.max(originalExp.bullets.length, exp.bullets.length);
    for (let idx = 0; idx < maxLen; idx += 1) {
      const before = originalExp.bullets[idx]?.trim() ?? '';
      const after = exp.bullets[idx]?.trim() ?? '';
      if (before === after) continue;
      const reason = changes.find((item) => item.before.trim() === before && item.after.trim() === after)?.reason;
      suggestions.push({
        field: 'bullet',
        expId: exp.expId,
        bulletIdx: idx,
        suggested: after,
        reason,
      });
    }
  }

  return suggestions;
}

function mapKeywordsAdded(output: CurateResumeOutput): Array<{ keyword: string; where: string }> {
  if (output.ats.keywordsAdded.length > 0) return output.ats.keywordsAdded;
  const whereBuckets: Array<{ where: string; text: string }> = [
    { where: 'about', text: output.improved.about },
    { where: 'skills', text: output.improved.skills.join(' ') },
    { where: 'experience', text: output.improved.experience.flatMap((exp) => exp.bullets).join(' ') },
  ];
  const added: Array<{ keyword: string; where: string }> = [];
  for (const keyword of output.ats.keywordsMissing) {
    const lowered = keyword.toLowerCase();
    const hit = whereBuckets.find((bucket) => bucket.text.toLowerCase().includes(lowered));
    if (hit) added.push({ keyword, where: hit.where });
  }
  return added;
}

export function detectLowValueRephrase(beforeAfterPairs: Array<{ before: string; after: string }>): { lowValue: boolean; similarity: number; notes: string } {
  if (beforeAfterPairs.length === 0) return { lowValue: true, similarity: 1, notes: 'No changed content detected' };
  const similarities = beforeAfterPairs.map((pair) => lexicalSimilarity(pair.before, pair.after));
  const avgSim = similarities.reduce((sum, score) => sum + score, 0) / similarities.length;
  const enrichedRatio = beforeAfterPairs.filter((pair) => {
    const beforeSignals = [hasScopeSignal(pair.before), hasOwnershipSignal(pair.before), hasOutcomeSignal(pair.before), hasToolSignal(pair.before), hasMetric(pair.before)].filter(Boolean).length;
    const afterSignals = [hasScopeSignal(pair.after), hasOwnershipSignal(pair.after), hasOutcomeSignal(pair.after), hasToolSignal(pair.after), hasMetric(pair.after)].filter(Boolean).length;
    return afterSignals > beforeSignals;
  }).length / beforeAfterPairs.length;

  const lowValue = avgSim >= 0.86 && enrichedRatio < 0.35;
  const notes = lowValue
    ? 'High lexical overlap with insufficient new specificity/scope/outcome signals.'
    : 'Meaningful content gain detected.';
  return { lowValue, similarity: round2(avgSim), notes };
}

export function detectMetricHallucination(beforeAfterPairs: Array<{ before: string; after: string }>): { suspicious: boolean; details: string[] } {
  const details: string[] = [];
  for (const pair of beforeAfterPairs) {
    const beforeNums = new Set(extractNumbers(pair.before));
    const afterNums = extractNumbers(pair.after);
    const introduced = afterNums.filter((num) => !beforeNums.has(num));
    if (introduced.length > 0 && !hasMetric(pair.before) && hasMetric(pair.after)) {
      details.push(`Potential fabricated metric(s): ${introduced.join(', ')}`);
    }
  }
  return { suspicious: details.length > 0, details };
}

export function evaluateCurateQuality(input: { resumeData: ResumeData; targetRole?: string; jdText?: string }, output: CurateResumeOutput): ElevateQuality {
  const beforeAfterPairs: Array<{ before: string; after: string }> = [];
  if (output.improved.about && output.improved.about.trim() !== input.resumeData.bio.trim()) {
    beforeAfterPairs.push({ before: input.resumeData.bio, after: output.improved.about });
  }
  for (const exp of output.improved.experience) {
    const original = input.resumeData.workExperience.find((item) => item.id === exp.expId);
    if (!original) continue;
    for (let idx = 0; idx < Math.min(original.bullets.length, exp.bullets.length); idx += 1) {
      const before = original.bullets[idx] ?? '';
      const after = exp.bullets[idx] ?? '';
      if (before.trim() && after.trim() && before.trim() !== after.trim()) {
        beforeAfterPairs.push({ before, after });
      }
    }
  }

  const lowValue = detectLowValueRephrase(beforeAfterPairs);
  const hallucination = detectMetricHallucination(beforeAfterPairs);

  const gainedSignals = beforeAfterPairs.filter((pair) => {
    const beforeCount = [hasScopeSignal(pair.before), hasOwnershipSignal(pair.before), hasOutcomeSignal(pair.before), hasToolSignal(pair.before), hasMetric(pair.before)].filter(Boolean).length;
    const afterCount = [hasScopeSignal(pair.after), hasOwnershipSignal(pair.after), hasOutcomeSignal(pair.after), hasToolSignal(pair.after), hasMetric(pair.after)].filter(Boolean).length;
    return afterCount > beforeCount;
  }).length;
  const impactScore = beforeAfterPairs.length === 0 ? 0 : gainedSignals / beforeAfterPairs.length;

  const jdKeywords = extractJDKeywords(input.jdText ?? '', input.targetRole ?? input.resumeData.title);
  const keywordsAdded = mapKeywordsAdded(output);
  const atsScore = jdKeywords.length === 0 ? 0.65 : keywordsAdded.length / Math.max(1, jdKeywords.length);

  const beforeText = [input.resumeData.bio, ...input.resumeData.workExperience.flatMap((exp) => exp.bullets)].join(' ');
  const afterText = [output.improved.about, ...output.improved.experience.flatMap((exp) => exp.bullets)].join(' ');
  const fillerImproved = genericFillerCount(afterText) <= genericFillerCount(beforeText);

  const passed = !lowValue.lowValue && !hallucination.suspicious && impactScore >= 0.45 && fillerImproved;
  const notes = [
    lowValue.notes,
    hallucination.suspicious ? hallucination.details.join(' | ') : 'No fabricated metric pattern detected.',
    fillerImproved ? 'Generic filler reduced or unchanged.' : 'Generic filler increased.',
  ].join(' ');

  return {
    similarityScore: lowValue.similarity,
    impactScore: round2(impactScore),
    atsScore: round2(atsScore),
    passed,
    notes,
  };
}

function buildFallbackCurateOutput(input: { resumeData: ResumeData; targetRole?: string; jdText?: string }, reason: string): CurateResumeOutput {
  const role = (input.targetRole || input.resumeData.title || 'this role').trim();
  const jdFocusAreas = extractJDKeywords(input.jdText ?? '', role).slice(0, 3);
  const aboutPointers = [
    `Lead with your role identity and years of relevant experience for ${role}.`,
    'Add one concrete ownership example and one business/user outcome.',
    'Include tools/platforms only if you actually used them.',
    'Replace generic verbs with action + scope + result language.',
  ];

  const missingQuestions = [
    'What measurable outcomes can you share for your top 2 projects (e.g., conversion, time saved, quality)?',
    'What was your scope (users/team/product area/market)?',
    'Which tools or stack did you personally use for each major achievement?',
    'What decisions did you own vs contribute to?',
    'What constraints or trade-offs did you navigate?',
  ].slice(0, 5);

  const improvedExperience: ElevateExperience[] = input.resumeData.workExperience.map((exp) => ({
    expId: exp.id,
    role: exp.role,
    company: exp.company,
    bullets: exp.bullets,
  }));

  const output: CurateResumeOutput = {
    changeSummary: ['Need more details to produce recruiter-grade impact improvements.'],
    redFlags: [reason, 'Need more details; ask user for metrics, scope, tools, and ownership level.'],
    aboutPointers,
    jdFocusAreas,
    jdTldr: {
      roleAsks: `Role focus for ${role}: execution quality, ownership, and business-relevant outcomes.`,
      candidateNeeds: 'Candidate needs: clear scope, decision-making signal, and measurable impact where available.',
      keyFocusAreas: jdFocusAreas,
    },
    suggestions: [],
    improved: {
      about: input.resumeData.bio,
      experience: improvedExperience,
      skills: input.resumeData.skills,
    },
    changes: [],
    ats: {
      targetRole: role,
      keywordsAdded: [],
      keywordsMissing: jdFocusAreas,
    },
    questions: missingQuestions,
    quality: {
      similarityScore: 1,
      impactScore: 0,
      atsScore: jdFocusAreas.length === 0 ? 0.6 : 0.2,
      passed: false,
      notes: 'Need more details; ask user for metrics, scope, tooling, and ownership before applying changes.',
    },
    meta: {
      providerStatus: 'fallback',
      fallbackReason: reason,
      model: DEFAULT_MODEL,
    },
  };

  if (!input.resumeData.bio.trim()) {
    output.suggestions.push({
      field: 'bio',
      suggested: `Draft an About section for ${role} with your ownership scope, strongest domain strengths, and business/user outcomes (without inventing metrics).`,
      reason: 'About section is empty and blocks recruiter signal quality.',
    });
  }
  return output;
}

async function runCurateModel(client: OpenAI, systemPrompt: string, userPrompt: string, signal?: AbortSignal) {
  return client.chat.completions.create(
    {
      model: DEFAULT_MODEL,
      temperature: 0.2,
      max_tokens: CURATE_MAX_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    },
    signal ? { signal } : undefined,
  );
}

async function runCurateModelParsed(
  client: OpenAI,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<{ parsed: unknown; raw: string }> {
  const completion = await runCurateModel(client, systemPrompt, userPrompt, signal);
  const raw = completion.choices[0]?.message?.content ?? '';
  try {
    return { parsed: parseModelJson(raw), raw };
  } catch (error) {
    if (!(error instanceof TailorResumeError) || !/non-JSON|empty response/i.test(error.message)) throw error;
    const retryPrompt = `${userPrompt}\n\nIMPORTANT: Return ONLY one valid JSON object. No markdown, no prose, no code fences.`;
    const retryCompletion = await runCurateModel(client, systemPrompt, retryPrompt, signal);
    const retryRaw = retryCompletion.choices[0]?.message?.content ?? '';
    return { parsed: parseModelJson(retryRaw), raw: retryRaw };
  }
}

export async function tailorResumeWithAI(input: TailorResumeInput, requestId: string): Promise<TailorResumeOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TailorResumeError('OPENAI_API_KEY is not configured', 503);
  }

  const client = new OpenAI({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();

  const systemPrompt = [
    'You are an elite executive headhunter and ATS/interview screener.',
    'Return valid JSON only. No markdown, no preface.',
    'Do not invent roles, companies, dates, projects, metrics, credentials, or tools.',
    'Rewrite for clarity and impact while preserving factual accuracy.',
    'For bullets: use impact + metric only when metric already exists in source; otherwise use neutral outcomes.',
    'Optimize for JD keywords and responsibilities.',
    'Keep structure clean and consistent for a resume document.',
  ].join(' ');

  const userPrompt = JSON.stringify({
    task: 'Tailor base resume text to job description',
    constraints: {
      must_not_invent_experience: true,
      output_format: {
        variantResumeText: 'string',
        changeSummary: 'string[]',
        redFlags: 'string[]',
        keywordCoverage: {
          matched: 'string[]',
          missing: 'string[]',
        },
      },
    },
    input,
  });

  try {
    console.info(`[ai-tailor][${requestId}] start jdLen=${input.jdText.length} baseLen=${input.baseResumeText.length}`);
    const completion = await runCurateModel(client, systemPrompt, userPrompt, controller.signal);
    const content = completion.choices[0]?.message?.content ?? '';
    const parsed = parseModelJson(content);
    const output = sanitizeOutput(parsed);
    const elapsedMs = Date.now() - started;
    console.info(`[ai-tailor][${requestId}] success elapsedMs=${elapsedMs} outputLen=${output.variantResumeText.length}`);
    return output;
  } catch (error) {
    if (error instanceof TailorResumeError) throw error;
    if (isAbortLikeError(error)) {
      throw new TailorResumeError('AI tailoring timed out', 504);
    }
    throw new TailorResumeError('AI tailoring failed', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function curateResumeWithAI(input: { resumeData: ResumeData; targetRole?: string; jdText?: string; seniority?: SeniorityLevel }, requestId: string): Promise<CurateResumeOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TailorResumeError('OPENAI_API_KEY is not configured', 503);
  }

  const client = new OpenAI({ apiKey });
  const controller = new AbortController();
  const timeout = CURATE_TIMEOUT_DISABLED ? null : setTimeout(() => controller.abort(), CURATE_TIMEOUT_MS);
  const curateSignal = CURATE_TIMEOUT_DISABLED ? undefined : controller.signal;
  const started = Date.now();
  const targetRole = (input.targetRole || input.resumeData.title || '').trim();
  const jdKeywords = extractJDKeywords(input.jdText ?? '', targetRole);

  const systemPrompt = CURATION_SYSTEM_PROMPT;
  const compactResumeData = compactResumeDataForCuration(input.resumeData);

  const basePayload = {
    task: 'Recruiter-grade elevate of current resume content using intent-over-rephrase behavior',
    curationPersona: 'Principal Tech Recruiter',
    roleClusters: CURATION_ROLE_CLUSTERS,
    roleTarget: targetRole,
    seniority: input.seniority ?? '',
    jdText: input.jdText ?? '',
    jdKeywords,
    hard_rules: CURATION_HARD_RULES,
    recruiter_rubric: {
      bullet_formula: '[Action Verb] + [What] + [How] + [Outcome/Metric] + [Scope] + [Tools]',
      required_signal_coverage: 'At least 70% of bullets should gain scope, outcome, tools, or ownership signal',
      ranking_priorities: ['business impact', 'ownership level', 'scope complexity', 'tool fluency', 'clear execution signal'],
      generic_phrases_to_reduce: CURATION_GENERIC_PHRASES_TO_REDUCE,
    },
    editing_rules: [
      'You may rewrite, add, or remove bullets when it improves clarity and impact.',
      'Keep each role to 3-7 bullets and prioritize strongest evidence.',
      'For removals, use empty string in improved bullets at that index.',
    ],
    resumeData: compactResumeData,
    output_schema: {
      improved: {
        about: 'string',
        experience: [{ expId: 'string', role: 'string', company: 'string', bullets: 'string[]' }],
        skills: 'string[]',
      },
      changes: [{ section: 'string', before: 'string', after: 'string', reason: 'string' }],
      ats: {
        targetRole: 'string',
        keywordsAdded: [{ keyword: 'string', where: 'about|experience|skills' }],
        keywordsMissing: 'string[]',
      },
      questions: 'string[] max 5, only critical missing info (metrics/tools/scope/ownership)',
      changeSummary: 'string[]',
      redFlags: 'string[]',
      aboutPointers: 'string[]',
      jdFocusAreas: 'string[] max 3',
      jdTldr: { roleAsks: 'string', candidateNeeds: 'string', keyFocusAreas: 'string[] max 3' },
      suggestions: [{ field: 'bio|bullet', expId: 'string when bullet', bulletIdx: 'number when bullet', suggested: 'string', reason: 'string with recruiter heuristic' }],
    },
  };

  try {
    console.info(`[ai-curate][${requestId}] start roleLen=${targetRole.length} jdLen=${(input.jdText ?? '').length}`);

    let { parsed } = await runCurateModelParsed(client, systemPrompt, JSON.stringify(basePayload), curateSignal);
    let output = sanitizeElevateOutput(parsed, input.resumeData, targetRole, jdKeywords);

    if (output.suggestions.length === 0) {
      output.suggestions = deriveSuggestionsFromImproved(input.resumeData, output.improved, output.changes);
    }

    let quality = evaluateCurateQuality(input, output);
    output.quality = quality;

    if (CURATE_SECOND_PASS_ENABLED && (!quality.passed || quality.similarityScore >= 0.86)) {
      const elapsedBeforeSecondPass = Date.now() - started;
      const remainingBudget = CURATE_TIMEOUT_MS - elapsedBeforeSecondPass;
      if (remainingBudget >= SECOND_PASS_MIN_REMAINING_MS) {
        try {
          const secondPassPrompt = JSON.stringify({
            ...basePayload,
            correction: 'Second pass required. Make it sharper and more distinct. Add stronger specificity, scope, outcomes, tooling, and decision ownership signals. Reduce synonym-only edits. No fabricated metrics.',
            firstPassQuality: quality,
          });
          ({ parsed } = await runCurateModelParsed(client, systemPrompt, secondPassPrompt, curateSignal));
          output = sanitizeElevateOutput(parsed, input.resumeData, targetRole, jdKeywords);
          if (output.suggestions.length === 0) {
            output.suggestions = deriveSuggestionsFromImproved(input.resumeData, output.improved, output.changes);
          }
          quality = evaluateCurateQuality(input, output);
          output.quality = quality;
          output.redFlags = [...new Set([...output.redFlags, 'Second pass guardrail applied for low-value rephrase risk.'])];
        } catch (secondPassError) {
          const elapsedSecondPassMs = Date.now() - started;
          console.warn(`[ai-curate][${requestId}] second-pass failed elapsedMs=${elapsedSecondPassMs} reason="${String((secondPassError as { message?: string }).message ?? 'unknown error')}"`);
          output.redFlags = [
            ...new Set([
              ...output.redFlags,
              `Second pass skipped after first-pass completion: ${isAbortLikeError(secondPassError) ? 'timed out' : 'model error'}.`,
            ]),
          ];
        }
      } else {
        output.redFlags = [
          ...new Set([
            ...output.redFlags,
            'Second pass skipped to preserve responsiveness within timeout budget.',
          ]),
        ];
      }
    }

    const meaningfulSuggestions = output.suggestions.filter((s) => s.suggested.trim()).length;
    const hasChangePayload = meaningfulSuggestions > 0 || output.changes.length > 0;

    if (!output.quality.passed) {
      output.redFlags = [
        ...new Set([
          ...output.redFlags,
          'Quality gate warning: suggestions provided, but more metrics/scope/tooling detail would improve recruiter-grade impact.',
        ]),
      ];
    }

    if (!hasChangePayload) {
      return buildFallbackCurateOutput(input, 'Need more details; ask user for metrics, scope, tooling, and ownership signals.');
    }

    const elapsedMs = Date.now() - started;
    console.info(`[ai-curate][${requestId}] success elapsedMs=${elapsedMs} suggestions=${output.suggestions.length} impactScore=${output.quality.impactScore}`);
    output.meta = {
      providerStatus: 'ok',
      model: DEFAULT_MODEL,
    };
    return output;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const reason = error instanceof TailorResumeError
      ? error.message
      : isAbortLikeError(error)
        ? 'AI curation timed out'
        : `AI curation failed: ${String((error as { message?: string }).message ?? 'unknown error')}`;
    console.warn(`[ai-curate][${requestId}] fallback reason="${reason}" elapsedMs=${elapsedMs}`);
    return buildFallbackCurateOutput(input, reason);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
