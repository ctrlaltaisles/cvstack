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

export type TargetRoleMode = 'pm' | 'product' | 'designer' | 'dev' | 'analyst' | 'ops' | 'strategy' | 'bizdev';

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
  positioningSummary?: string;
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
const CURATE_TIMEOUT_DISABLED = String(process.env.OPENAI_CURATE_DISABLE_TIMEOUT ?? 'true').trim().toLowerCase() === 'true' || CURATE_TIMEOUT_MS <= 0;
const CURATE_MAX_TOKENS = Number(process.env.OPENAI_CURATE_MAX_TOKENS ?? 1800);
const CAPABILITY_EXTRACTION_SYSTEM_PROMPT = [
  'You extract capability evidence from resume content.',
  'Use ONLY resume bullets and project notes.',
  'Do not use JD for this step.',
  'Do not rewrite into polished bullets.',
  'Return valid JSON only.',
].join(' ');
const ROLE_MAPPING_SYSTEM_PROMPT = [
  'You map extracted capabilities to JD signals.',
  'Identify supported vs unsupported JD signals.',
  'Do not rewrite resume bullets.',
  'Do not copy JD text line-by-line.',
  'Return valid JSON only.',
].join(' ');
const ROLE_TRANSFORMATION_SYSTEM_PROMPT = [
  'You transform capabilities into role-lens claims.',
  'Use only supported signals and evidence-backed capabilities.',
  'No final bullet writing in this step.',
  'Return valid JSON only.',
].join(' ');
const FINAL_WRITING_SYSTEM_PROMPT = [
  'You write final resume output from transformed claims and source evidence.',
  'Source of truth is resume bullets/projectNotes and transformed claims.',
  'JD is prioritization only. No JD copying.',
  'No fabricated tools/metrics/systems/outcomes.',
  'If metrics are missing, ask concise questions.',
  'Return valid JSON only.',
].join(' ');
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'was', 'were', 'this', 'these', 'those',
]);

const TARGET_ROLE_MODE_HINTS: Array<{ mode: TargetRoleMode; hints: string[] }> = [
  {
    mode: 'designer',
    hints: ['product designer', 'ux designer', 'ui designer', 'experience designer', 'design lead', 'lead designer', 'design manager', 'interaction designer'],
  },
  {
    mode: 'product',
    hints: ['product manager', 'product management', 'pm ', 'group product manager', 'senior product manager', 'director of product'],
  },
  {
    mode: 'pm',
    hints: ['project manager', 'program manager', 'delivery manager', 'scrum master', 'pmo', 'implementation manager'],
  },
  {
    mode: 'dev',
    hints: ['software engineer', 'software developer', 'frontend developer', 'front-end developer', 'full stack', 'backend developer', 'web developer', 'engineer'],
  },
  {
    mode: 'analyst',
    hints: ['data analyst', 'analytics', 'business analyst', 'insights analyst', 'reporting analyst', 'bi analyst'],
  },
  {
    mode: 'ops',
    hints: ['operations', 'ops manager', 'operational excellence', 'process improvement', 'supply chain', 'service delivery'],
  },
  {
    mode: 'strategy',
    hints: ['strategy', 'bizops', 'business operations', 'chief of staff', 'strategic planning', 'corporate strategy'],
  },
  {
    mode: 'bizdev',
    hints: ['business development', 'partnerships', 'alliances', 'account executive', 'sales development', 'growth partnerships'],
  },
];

interface CapabilityMarkerRule {
  id: string;
  label: string;
  pattern: RegExp;
  modes: TargetRoleMode[];
}

const CAPABILITY_MARKER_RULES: CapabilityMarkerRule[] = [
  { id: 'requirements_modeling', label: 'requirements/spec modeling', pattern: /\b(requirements?|workflow spec|specification|state transitions?)\b/i, modes: ['pm', 'product', 'dev', 'ops'] },
  { id: 'workflow_architecture', label: 'workflow architecture', pattern: /\b(end-to-end workflow|handoff|bottleneck|tracking logic|process map)\b/i, modes: ['pm', 'product', 'ops'] },
  { id: 'cross_functional_facilitation', label: 'cross-functional facilitation', pattern: /\b(working session|facilitated|cross-functional|stakeholder alignment|coordinat(ed|ing) with)\b/i, modes: ['pm', 'product', 'ops', 'strategy', 'bizdev'] },
  { id: 'discovery_interviews', label: 'discovery interviews', pattern: /\b(discovery interviews?|interview(ed|ing) .*managers?|friction points?)\b/i, modes: ['pm', 'product', 'designer', 'analyst'] },
  { id: 'theme_synthesis', label: 'insight/theme synthesis', pattern: /\b(synthesi[sz](ed|ing) (themes|inputs|findings)|identified themes?)\b/i, modes: ['pm', 'product', 'designer', 'analyst', 'strategy'] },
  { id: 'decision_frameworks', label: 'decision framework/template design', pattern: /\b(feedback template|structured feedback|reduc(ed|ing) subjective bias|decision[- ]making clarity)\b/i, modes: ['pm', 'product', 'designer', 'ops', 'strategy'] },
  { id: 'journey_mapping', label: 'journey mapping', pattern: /\b(journey|touchpoints?|90-day milestone|experience journey|drop-off risks?)\b/i, modes: ['pm', 'product', 'designer', 'ops'] },
  { id: 'experimentation', label: 'pilot/experimentation', pattern: /\b(pilot|tested|post-launch|experiment|validation)\b/i, modes: ['pm', 'product', 'designer', 'analyst', 'ops'] },
  { id: 'analytics_interpretation', label: 'analytics interpretation', pattern: /\b(heatmap|analytics|conversion points?|time-on-page|engagement)\b/i, modes: ['pm', 'product', 'designer', 'analyst'] },
  { id: 'scenario_modeling', label: 'scenario modeling', pattern: /\b(headcount planning|hiring velocity|growth trajectories?|scenario|cost implications?)\b/i, modes: ['pm', 'product', 'analyst', 'strategy', 'ops'] },
  { id: 'sla_negotiation', label: 'SLA/risk mitigation', pattern: /\b(sla|provisioning delays?|escalated the issue|service level|turnaround times?)\b/i, modes: ['pm', 'ops', 'strategy'] },
  { id: 'dashboard_visibility', label: 'tracking dashboard/operational visibility', pattern: /\b(tracking dashboard|monitor turnaround|visibility dashboard|operational visibility)\b/i, modes: ['pm', 'analyst', 'ops', 'strategy'] },
  { id: 'integration_hypothesis', label: 'cross-domain integration hypothesis', pattern: /\b(integrat(e|ing).*(analytics|reporting)|correlat(e|ing).*(investment|velocity)|exploratory initiative)\b/i, modes: ['pm', 'product', 'analyst', 'strategy'] },
];

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

export function inferTargetRoleMode(targetRole: string): TargetRoleMode {
  const text = String(targetRole ?? '').toLowerCase();
  for (const entry of TARGET_ROLE_MODE_HINTS) {
    if (entry.hints.some((hint) => text.includes(hint))) return entry.mode;
  }
  return 'product';
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

function extractProjectNoteSignals(projectNotes: string, limit = 12): string[] {
  const raw = String(projectNotes ?? '').trim();
  if (!raw) return [];
  const clauses = raw
    .replace(/[•\u2022]/g, '\n')
    .replace(/^\s*-\s+/gm, '')
    .split(/\n|[.;]|,\s+and\s+|,\s+but\s+|,\s+where\s+|,\s+which\s+/i)
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

  const signals: string[] = [];
  for (const clause of clauses) {
    const compact = clause.replace(/^[-–—]\s*/, '').trim();
    if (!compact) continue;
    const words = compact.split(/\s+/);
    if (words.length < 2) continue;

    const significant = tokenize(compact).filter((t) => t.length >= 3);
    if (significant.length < 2) continue;

    const normalized = significant.slice(0, 8).join(' ');
    if (!signals.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      signals.push(normalized);
    }
    if (signals.length >= limit) break;
  }
  return signals;
}

function wordCount(text: string): number {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/[\n.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
}

function extractCapabilityMarkers(text: string, mode: TargetRoleMode): CapabilityMarkerRule[] {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  return CAPABILITY_MARKER_RULES.filter((rule) => rule.modes.includes(mode) && rule.pattern.test(source));
}

function buildProjectNotesSignalMap(resumeData: ResumeData): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const exp of resumeData.workExperience ?? []) {
    const signals = extractProjectNoteSignals(exp.projectNotes ?? '', 12);
    if (signals.length > 0) map.set(exp.id, signals);
  }
  return map;
}

function containsSignal(text: string, signal: string): boolean {
  const textTokens = new Set(tokenize(text).filter((token) => token.length >= 3));
  const signalTokens = tokenize(signal).filter((token) => token.length >= 3);
  if (signalTokens.length === 0) return false;
  const overlap = signalTokens.filter((token) => textTokens.has(token)).length;
  return overlap >= Math.max(2, Math.ceil(signalTokens.length * 0.65));
}

function evaluateProjectNotesCoverage(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
): {
  hasSignals: boolean;
  coverageRatio: number;
  newSignalRatio: number;
  missingByExp: Array<{ expId: string; role: string; company: string; missingSignals: string[] }>;
} {
  const signalMap = buildProjectNotesSignalMap(resumeData);
  if (signalMap.size === 0) {
    return { hasSignals: false, coverageRatio: 1, newSignalRatio: 1, missingByExp: [] };
  }

  let totalSignals = 0;
  let coveredSignals = 0;
  let newlySurfacedSignals = 0;
  let baselineSignals = 0;
  const missingByExp: Array<{ expId: string; role: string; company: string; missingSignals: string[] }> = [];

  for (const [expId, signals] of signalMap.entries()) {
    const originalExp = resumeData.workExperience.find((item) => item.id === expId);
    const improvedExp = improved.experience.find((item) => item.expId === expId);
    const originalText = `${originalExp?.bullets.join(' ') ?? ''}`.trim();
    const improvedText = `${improvedExp?.bullets.join(' ') ?? ''}`.trim();
    const missingSignals: string[] = [];

    for (const signal of signals) {
      totalSignals += 1;
      const presentInOriginal = containsSignal(originalText, signal);
      const presentInImproved = containsSignal(improvedText, signal);

      if (presentInImproved) coveredSignals += 1;
      if (!presentInOriginal) {
        baselineSignals += 1;
        if (presentInImproved) newlySurfacedSignals += 1;
      }
      if (!presentInImproved) missingSignals.push(signal);
    }

    if (missingSignals.length > 0 && originalExp) {
      missingByExp.push({
        expId,
        role: originalExp.role,
        company: originalExp.company,
        missingSignals: missingSignals.slice(0, 6),
      });
    }
  }

  return {
    hasSignals: totalSignals > 0,
    coverageRatio: totalSignals > 0 ? coveredSignals / totalSignals : 1,
    newSignalRatio: baselineSignals > 0 ? newlySurfacedSignals / baselineSignals : 1,
    missingByExp,
  };
}

type StrategicTheme =
  | 'ownership'
  | 'system_design'
  | 'risk_mitigation'
  | 'commercial_influence'
  | 'cross_functional_leadership';

const STRATEGIC_THEME_RULES: Array<{ theme: StrategicTheme; pattern: RegExp }> = [
  { theme: 'ownership', pattern: /\b(owned|ownership|took over|drove|led|orchestrated|architected|accountable|initiated)\b/i },
  { theme: 'system_design', pattern: /\b(framework|system|model|pipeline|workflow|governance|architecture|operationali[sz]ed|standardi[sz]ed|lifecycle)\b/i },
  { theme: 'risk_mitigation', pattern: /\b(risk|bottleneck|mitigat|compliance|policy|renewal tracking|audit|grey area|fallback|escalation)\b/i },
  { theme: 'commercial_influence', pattern: /\b(cost|budget|savings|commercial|vendor|procurement|roi|efficiency|run rate|headcount planning)\b/i },
  { theme: 'cross_functional_leadership', pattern: /\b(cross-functional|stakeholder|bridge|engineering|product|finance|operations|leadership|alignment|decision-making)\b/i },
];

function extractStrategicThemes(text: string): Set<StrategicTheme> {
  const out = new Set<StrategicTheme>();
  for (const rule of STRATEGIC_THEME_RULES) {
    if (rule.pattern.test(String(text ?? ''))) out.add(rule.theme);
  }
  return out;
}

function evaluateStrategicThemeCoverage(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
): {
  hasThemes: boolean;
  coverageRatio: number;
  missingByExp: Array<{ expId: string; role: string; company: string; missingThemes: StrategicTheme[] }>;
} {
  let total = 0;
  let covered = 0;
  const missingByExp: Array<{ expId: string; role: string; company: string; missingThemes: StrategicTheme[] }> = [];

  for (const exp of resumeData.workExperience ?? []) {
    const notesThemes = extractStrategicThemes(exp.projectNotes ?? '');
    if (notesThemes.size === 0) continue;
    const improvedExp = improved.experience.find((item) => item.expId === exp.id);
    const improvedText = improvedExp ? improvedExp.bullets.join(' ') : '';
    const improvedThemes = extractStrategicThemes(improvedText);
    const missingThemes: StrategicTheme[] = [];
    for (const theme of notesThemes) {
      total += 1;
      if (improvedThemes.has(theme)) covered += 1;
      else missingThemes.push(theme);
    }
    if (missingThemes.length > 0) {
      missingByExp.push({
        expId: exp.id,
        role: exp.role,
        company: exp.company,
        missingThemes,
      });
    }
  }

  return {
    hasThemes: total > 0,
    coverageRatio: total > 0 ? covered / total : 1,
    missingByExp,
  };
}

function evaluateNotesDrivenBulletLift(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
): {
  hasEligibleRoles: boolean;
  passedRoles: number;
  totalEligibleRoles: number;
  deficits: Array<{ expId: string; role: string; company: string; requiredNewBullets: number; detectedNewBullets: number }>;
} {
  const deficits: Array<{ expId: string; role: string; company: string; requiredNewBullets: number; detectedNewBullets: number }> = [];
  let totalEligibleRoles = 0;
  let passedRoles = 0;

  for (const exp of resumeData.workExperience ?? []) {
    const notesWords = wordCount(exp.projectNotes ?? '');
    if (notesWords < 100) continue;
    totalEligibleRoles += 1;

    const improvedExp = improved.experience.find((item) => item.expId === exp.id);
    const improvedBullets = (improvedExp?.bullets ?? []).map((b) => b.trim()).filter(Boolean);
    const originalBullets = (exp.bullets ?? []).map((b) => b.trim()).filter(Boolean);

    let newBullets = 0;
    for (const bullet of improvedBullets) {
      if (originalBullets.length === 0) {
        newBullets += 1;
        continue;
      }
      const bestSimilarity = Math.max(...originalBullets.map((original) => lexicalSimilarity(original, bullet)));
      if (bestSimilarity < 0.68) newBullets += 1;
    }

    if (newBullets >= 2) {
      passedRoles += 1;
      continue;
    }
    deficits.push({
      expId: exp.id,
      role: exp.role,
      company: exp.company,
      requiredNewBullets: 2,
      detectedNewBullets: newBullets,
    });
  }

  return {
    hasEligibleRoles: totalEligibleRoles > 0,
    passedRoles,
    totalEligibleRoles,
    deficits,
  };
}

function evaluateCapabilityElevationCoverage(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
  mode: TargetRoleMode,
): {
  hasMarkers: boolean;
  coverageRatio: number;
  missingByExp: Array<{ expId: string; role: string; company: string; missingCapabilities: string[] }>;
} {
  let total = 0;
  let covered = 0;
  const missingByExp: Array<{ expId: string; role: string; company: string; missingCapabilities: string[] }> = [];

  for (const exp of resumeData.workExperience ?? []) {
    const sourceText = `${exp.projectNotes ?? ''} ${(exp.bullets ?? []).join(' ')}`.trim();
    const sourceMarkers = extractCapabilityMarkers(sourceText, mode);
    if (sourceMarkers.length === 0) continue;

    const improvedExp = improved.experience.find((item) => item.expId === exp.id);
    const improvedText = (improvedExp?.bullets ?? []).join(' ');
    const missingCapabilities: string[] = [];

    for (const marker of sourceMarkers) {
      total += 1;
      const coveredInImproved = marker.pattern.test(improvedText);
      if (coveredInImproved) covered += 1;
      else missingCapabilities.push(marker.label);
    }

    if (missingCapabilities.length > 0) {
      missingByExp.push({
        expId: exp.id,
        role: exp.role,
        company: exp.company,
        missingCapabilities: missingCapabilities.slice(0, 6),
      });
    }
  }

  return {
    hasMarkers: total > 0,
    coverageRatio: total > 0 ? covered / total : 1,
    missingByExp,
  };
}

interface CapabilityInventoryItem {
  expId: string;
  capability: string;
  evidenceQuotes: string[];
}

interface CapabilityExtractionOutput {
  capabilities: CapabilityInventoryItem[];
  capabilitySummary: string[];
  missingInfoQuestions: string[];
}

interface RoleMappingSignal {
  signal: string;
  mappedCapabilities: string[];
  evidenceQuotes: string[];
}

interface RoleMappingOutput {
  supportedSignals: RoleMappingSignal[];
  unsupportedSignals: string[];
  jdFocusAreas: string[];
  targetRoleMode: TargetRoleMode;
}

interface RoleTransformationClaim {
  expId: string;
  claim: string;
  mechanism: string;
  impactSignal: string;
  evidenceQuotes: string[];
}

interface RoleTransformationOutput {
  transformedClaims: RoleTransformationClaim[];
  droppedClaims: string[];
  warnings: string[];
}

function buildDeterministicCapabilityExtraction(resumeData: ResumeData, mode: TargetRoleMode): CapabilityExtractionOutput {
  const capabilities: CapabilityInventoryItem[] = [];
  for (const exp of resumeData.workExperience ?? []) {
    const sourceText = `${exp.projectNotes ?? ''} ${(exp.bullets ?? []).join(' ')}`.trim();
    const markers = extractCapabilityMarkers(sourceText, mode);
    const notesSentences = splitSentences(exp.projectNotes ?? '').slice(0, 2);
    const bulletQuotes = (exp.bullets ?? []).map((b) => b.trim()).filter(Boolean).slice(0, 2);
    const evidenceBase = uniqueStrings([...notesSentences, ...bulletQuotes]).slice(0, 2);
    for (const marker of markers) {
      capabilities.push({
        expId: exp.id,
        capability: marker.label,
        evidenceQuotes: evidenceBase,
      });
    }
  }

  const capabilitySummary = uniqueStrings(capabilities.map((item) => item.capability)).slice(0, 20);
  return {
    capabilities: capabilities.slice(0, 60),
    capabilitySummary,
    missingInfoQuestions: [],
  };
}

function sanitizeCapabilityExtractionOutput(payload: unknown, resumeData: ResumeData, mode: TargetRoleMode): CapabilityExtractionOutput {
  const fallback = buildDeterministicCapabilityExtraction(resumeData, mode);
  if (!payload || typeof payload !== 'object') return fallback;
  const raw = payload as Record<string, unknown>;
  const validExpIds = new Set((resumeData.workExperience ?? []).map((exp) => exp.id));
  const capabilityRows = Array.isArray(raw.capabilities) ? raw.capabilities : [];

  const capabilities = capabilityRows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, unknown>;
      const expId = String(item.expId ?? '').trim();
      const capability = String(item.capability ?? '').trim();
      if (!expId || !capability || !validExpIds.has(expId)) return null;
      return {
        expId,
        capability,
        evidenceQuotes: asStringArray(item.evidenceQuotes).slice(0, 2),
      } as CapabilityInventoryItem;
    })
    .filter((row): row is CapabilityInventoryItem => Boolean(row));

  const capabilitySummary = uniqueStrings([
    ...asStringArray(raw.capabilitySummary),
    ...capabilities.map((item) => item.capability),
  ]).slice(0, 20);

  return {
    capabilities: capabilities.length > 0 ? capabilities.slice(0, 60) : fallback.capabilities,
    capabilitySummary: capabilitySummary.length > 0 ? capabilitySummary : fallback.capabilitySummary,
    missingInfoQuestions: asStringArray(raw.missingInfoQuestions).slice(0, 5),
  };
}

function buildDeterministicRoleMapping(
  capabilities: CapabilityExtractionOutput,
  jdKeywords: string[],
  targetRoleMode: TargetRoleMode,
): RoleMappingOutput {
  const supportedSignals: RoleMappingSignal[] = capabilities.capabilitySummary.slice(0, 8).map((capability) => {
    const mapped = capabilities.capabilities.filter((item) => item.capability.toLowerCase() === capability.toLowerCase()).slice(0, 2);
    return {
      signal: capability,
      mappedCapabilities: [capability],
      evidenceQuotes: uniqueStrings(mapped.flatMap((item) => item.evidenceQuotes)).slice(0, 2),
    };
  });

  const supportedText = supportedSignals.map((item) => item.signal.toLowerCase()).join(' ');
  const unsupportedSignals = jdKeywords.filter((keyword) => !supportedText.includes(keyword.toLowerCase())).slice(0, 8);
  return {
    supportedSignals,
    unsupportedSignals,
    jdFocusAreas: jdKeywords.slice(0, 3),
    targetRoleMode,
  };
}

function sanitizeRoleMappingOutput(
  payload: unknown,
  fallback: RoleMappingOutput,
): RoleMappingOutput {
  if (!payload || typeof payload !== 'object') return fallback;
  const raw = payload as Record<string, unknown>;
  const supportedRows = Array.isArray(raw.supportedSignals) ? raw.supportedSignals : [];
  const supportedSignals = supportedRows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, unknown>;
      const signal = String(item.signal ?? '').trim();
      if (!signal) return null;
      return {
        signal,
        mappedCapabilities: asStringArray(item.mappedCapabilities).slice(0, 4),
        evidenceQuotes: asStringArray(item.evidenceQuotes).slice(0, 2),
      } as RoleMappingSignal;
    })
    .filter((row): row is RoleMappingSignal => Boolean(row));

  const modeRaw = String(raw.targetRoleMode ?? fallback.targetRoleMode).trim().toLowerCase();
  const mode: TargetRoleMode = (['pm', 'product', 'designer', 'dev', 'analyst', 'ops', 'strategy', 'bizdev'].includes(modeRaw)
    ? modeRaw
    : fallback.targetRoleMode) as TargetRoleMode;

  return {
    supportedSignals: supportedSignals.length > 0 ? supportedSignals.slice(0, 12) : fallback.supportedSignals,
    unsupportedSignals: uniqueStrings(asStringArray(raw.unsupportedSignals)).slice(0, 8),
    jdFocusAreas: uniqueStrings(asStringArray(raw.jdFocusAreas)).slice(0, 3),
    targetRoleMode: mode,
  };
}

function buildDeterministicRoleTransformation(
  capabilities: CapabilityExtractionOutput,
  _targetRoleMode: TargetRoleMode,
): RoleTransformationOutput {
  const transformedClaims: RoleTransformationClaim[] = capabilities.capabilities.slice(0, 16).map((item) => ({
    expId: item.expId,
    claim: `Applied ${item.capability} in cross-functional delivery contexts.`,
    mechanism: item.capability,
    impactSignal: 'execution clarity',
    evidenceQuotes: item.evidenceQuotes.slice(0, 2),
  }));

  return {
    transformedClaims,
    droppedClaims: [],
    warnings: transformedClaims.length === 0 ? ['No transformed claims detected from capability inventory.'] : [],
  };
}

function sanitizeRoleTransformationOutput(payload: unknown, fallback: RoleTransformationOutput, resumeData: ResumeData): RoleTransformationOutput {
  if (!payload || typeof payload !== 'object') return fallback;
  const raw = payload as Record<string, unknown>;
  const validExpIds = new Set((resumeData.workExperience ?? []).map((exp) => exp.id));
  const rows = Array.isArray(raw.transformedClaims) ? raw.transformedClaims : [];
  const transformedClaims = rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const item = row as Record<string, unknown>;
      const expId = String(item.expId ?? '').trim();
      const claim = String(item.claim ?? '').trim();
      if (!expId || !claim || !validExpIds.has(expId)) return null;
      return {
        expId,
        claim,
        mechanism: String(item.mechanism ?? '').trim(),
        impactSignal: String(item.impactSignal ?? '').trim(),
        evidenceQuotes: asStringArray(item.evidenceQuotes).slice(0, 2),
      } as RoleTransformationClaim;
    })
    .filter((row): row is RoleTransformationClaim => Boolean(row));

  return {
    transformedClaims: transformedClaims.length > 0 ? transformedClaims.slice(0, 24) : fallback.transformedClaims,
    droppedClaims: uniqueStrings(asStringArray(raw.droppedClaims)).slice(0, 8),
    warnings: uniqueStrings(asStringArray(raw.warnings)).slice(0, 8),
  };
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
      projectNotes: clamp(exp.projectNotes ?? '', 2400),
    })),
    education: (resumeData.education ?? []).slice(0, 5),
    certifications: (resumeData.certifications ?? []).slice(0, 5),
    skills: (resumeData.skills ?? []).slice(0, 40).map((skill) => clamp(skill, 40)),
  };
}

function buildProjectNotesPrimaryResumeData(resumeData: ResumeData): ResumeData {
  return {
    ...resumeData,
    workExperience: (resumeData.workExperience ?? []).map((exp) => {
      const hasNotes = String(exp.projectNotes ?? '').trim().length > 0;
      if (!hasNotes) return exp;
      // De-anchor the model from legacy bullet taxonomy when richer raw notes exist.
      return { ...exp, bullets: [] };
    }),
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

function sanitizeElevateOutput(
  payload: unknown,
  resumeData: ResumeData,
  targetRole: string,
  jdKeywords: string[],
): CurateResumeOutput {
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
  const companyContextRaw = (raw.companyContext && typeof raw.companyContext === 'object') ? (raw.companyContext as Record<string, unknown>) : null;
  const parsedCompanyContext: CompanyContext | undefined = companyContextRaw
    ? {
      company: truncate(String(companyContextRaw.company ?? ''), 120) || 'Target role',
      focus: truncate(String(companyContextRaw.focus ?? ''), 320),
      stellarProfile: asStringArray(companyContextRaw.stellarProfile).slice(0, 4).map((line) => truncate(line, 220)),
      evidence: asStringArray(companyContextRaw.evidence).slice(0, 4).map((line) => truncate(line, 340)),
    }
    : undefined;
  const output: CurateResumeOutput = {
    changeSummary: asStringArray(raw.changeSummary),
    redFlags: asStringArray(raw.redFlags),
    aboutPointers: asStringArray(raw.aboutPointers),
    jdFocusAreas: asStringArray(raw.jdFocusAreas).slice(0, 3),
    positioningSummary: truncate(String(raw.positioningSummary ?? ''), 320),
    jdTldr: {
      roleAsks: String(((raw.jdTldr as Record<string, unknown> | undefined)?.roleAsks ?? '')).trim(),
      candidateNeeds: String(((raw.jdTldr as Record<string, unknown> | undefined)?.candidateNeeds ?? '')).trim(),
      keyFocusAreas: asStringArray((raw.jdTldr as Record<string, unknown> | undefined)?.keyFocusAreas).slice(0, 3),
    },
    companyContext: parsedCompanyContext,
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

export function detectCategoryMirrorRisk(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
): { risky: boolean; mirrorRatio: number; compared: number } {
  let compared = 0;
  let mirrored = 0;

  for (const exp of improved.experience) {
    const original = resumeData.workExperience.find((item) => item.id === exp.expId);
    if (!original) continue;
    const originalBullets = original.bullets.map((b) => b.trim()).filter(Boolean);
    const improvedBullets = exp.bullets.map((b) => b.trim()).filter(Boolean);
    if (originalBullets.length === 0 || improvedBullets.length === 0) continue;

    const minLen = Math.min(originalBullets.length, improvedBullets.length);
    const lenDelta = Math.abs(originalBullets.length - improvedBullets.length);
    if (lenDelta > 1) continue;

    for (let i = 0; i < minLen; i += 1) {
      const before = originalBullets[i];
      const after = improvedBullets[i];
      if (!before || !after) continue;
      compared += 1;
      const sim = lexicalSimilarity(before, after);
      const beforeSignals = [hasScopeSignal(before), hasOwnershipSignal(before), hasOutcomeSignal(before), hasToolSignal(before), hasMetric(before)].filter(Boolean).length;
      const afterSignals = [hasScopeSignal(after), hasOwnershipSignal(after), hasOutcomeSignal(after), hasToolSignal(after), hasMetric(after)].filter(Boolean).length;
      if (sim >= 0.72 && afterSignals <= beforeSignals + 1) {
        mirrored += 1;
      }
    }
  }

  const mirrorRatio = compared > 0 ? mirrored / compared : 0;
  const risky = compared >= 3 && mirrorRatio >= 0.55;
  return { risky, mirrorRatio: round2(mirrorRatio), compared };
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

function hasPlaceholderPattern(text: string): boolean {
  return /\[[^\]]*(x|tbd|na|n\/a|l)\s*%?[^\]]*]/i.test(text) || /\b(x|tbd)\s*%/i.test(text);
}

function evaluateGroundingViolations(
  resumeData: ResumeData,
  improved: CurateResumeOutput['improved'],
  jdText: string,
): { suspicious: boolean; details: string[] } {
  const details: string[] = [];
  const jdTokens = new Set(tokenize(jdText).filter((t) => t.length >= 4));
  const jdSentences = splitSentences(jdText);
  const skillsText = (resumeData.skills ?? []).join(' ');
  const globalSourceText = [resumeData.bio, skillsText].filter(Boolean).join(' ');

  for (const exp of improved.experience) {
    const original = resumeData.workExperience.find((item) => item.id === exp.expId);
    const sourceText = [
      original?.role ?? '',
      original?.company ?? '',
      original?.projectNotes ?? '',
      ...(original?.bullets ?? []),
      globalSourceText,
    ].join(' ');
    const sourceTokens = new Set(tokenize(sourceText).filter((t) => t.length >= 3));
    const sourceSentences = splitSentences(sourceText);

    for (const bullet of exp.bullets) {
      const b = bullet.trim();
      if (!b) continue;
      if (hasPlaceholderPattern(b)) {
        details.push(`Unsupported placeholder pattern in bullet: "${b.slice(0, 90)}..."`);
        continue;
      }

      const bulletTokens = tokenize(b).filter((t) => t.length >= 3);
      const jdHits = bulletTokens.filter((t) => jdTokens.has(t)).length;
      const sourceHits = bulletTokens.filter((t) => sourceTokens.has(t)).length;
      const maxJdSim = jdSentences.length > 0 ? Math.max(...jdSentences.map((s) => lexicalSimilarity(s, b))) : 0;
      const maxSourceSim = sourceSentences.length > 0 ? Math.max(...sourceSentences.map((s) => lexicalSimilarity(s, b))) : 0;

      const jdLeak = jdHits >= 4 && sourceHits < 3;
      const jdCopy = maxJdSim >= 0.72 && maxSourceSim < 0.45;
      if (jdLeak || jdCopy) {
        details.push(`Likely JD-anchored unsupported bullet: "${b.slice(0, 90)}..."`);
      }
    }
  }

  return { suspicious: details.length > 0, details: details.slice(0, 8) };
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
  const projectNotesCoverage = evaluateProjectNotesCoverage(input.resumeData, output.improved);
  const projectNotesPass = !projectNotesCoverage.hasSignals
    || (projectNotesCoverage.coverageRatio >= 0.65 && projectNotesCoverage.newSignalRatio >= 0.25);
  const strategicThemeCoverage = evaluateStrategicThemeCoverage(input.resumeData, output.improved);
  const strategicThemePass = !strategicThemeCoverage.hasThemes || strategicThemeCoverage.coverageRatio >= 0.6;
  const targetRoleMode = inferTargetRoleMode(input.targetRole ?? input.resumeData.title ?? '');
  const capabilityCoverage = evaluateCapabilityElevationCoverage(input.resumeData, output.improved, targetRoleMode);
  const capabilityPass = !capabilityCoverage.hasMarkers || capabilityCoverage.coverageRatio >= 0.55;
  const mirrorRisk = detectCategoryMirrorRisk(input.resumeData, output.improved);
  const notesDrivenLift = evaluateNotesDrivenBulletLift(input.resumeData, output.improved);
  const notesLiftPass = !notesDrivenLift.hasEligibleRoles || notesDrivenLift.deficits.length === 0;
  const grounding = evaluateGroundingViolations(input.resumeData, output.improved, input.jdText ?? '');

  const passed = !lowValue.lowValue && !hallucination.suspicious && !grounding.suspicious && impactScore >= 0.45 && fillerImproved && projectNotesPass && strategicThemePass && capabilityPass && !mirrorRisk.risky && notesLiftPass;
  const notes = [
    lowValue.notes,
    hallucination.suspicious ? hallucination.details.join(' | ') : 'No fabricated metric pattern detected.',
    fillerImproved ? 'Generic filler reduced or unchanged.' : 'Generic filler increased.',
    projectNotesCoverage.hasSignals
      ? `Project-notes coverage=${Math.round(projectNotesCoverage.coverageRatio * 100)}%, new-signal lift=${Math.round(projectNotesCoverage.newSignalRatio * 100)}%.`
      : 'No project-notes signals detected.',
    strategicThemeCoverage.hasThemes
      ? `Strategic-theme coverage=${Math.round(strategicThemeCoverage.coverageRatio * 100)}%.`
      : 'No strategic themes detected in project notes.',
    capabilityCoverage.hasMarkers
      ? `Capability-elevation coverage=${Math.round(capabilityCoverage.coverageRatio * 100)}% for mode=${targetRoleMode}.`
      : 'No capability markers detected for the active role lens.',
    `Category-mirror risk=${mirrorRisk.risky ? 'high' : 'low'} (ratio=${Math.round(mirrorRisk.mirrorRatio * 100)}%, compared=${mirrorRisk.compared}).`,
    notesDrivenLift.hasEligibleRoles
      ? `Notes-driven new-bullet lift=${notesDrivenLift.passedRoles}/${notesDrivenLift.totalEligibleRoles} eligible roles met >=2 new bullets.`
      : 'No >=100-word project notes roles requiring forced new-bullet lift.',
    grounding.suspicious ? `Grounding violations detected: ${grounding.details.join(' | ')}` : 'No JD-leakage grounding violations detected.',
  ].join(' ');

  return {
    similarityScore: lowValue.similarity,
    impactScore: round2(impactScore),
    atsScore: round2(atsScore),
    passed,
    notes,
  };
}

function buildFallbackCurateOutput(input: CurateResumeInput, reason: string): CurateResumeOutput {
  const role = (input.targetRole || input.resumeData.title || 'this role').trim();
  const hasJD = Boolean((input.jdText ?? '').trim());
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
    positioningSummary: hasJD
      ? `Position for ${role} by showing ownership level, scope, and business outcomes prioritized by the JD.`
      : `Position for ${role} by showing ownership level, scope, tooling depth, and business outcomes from existing experience.`,
    jdTldr: {
      roleAsks: `Role focus for ${role}: execution quality, ownership, and business-relevant outcomes.`,
      candidateNeeds: 'Candidate needs: clear scope, decision-making signal, and measurable impact where available.',
      keyFocusAreas: jdFocusAreas,
    },
    companyContext: undefined,
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

export async function curateResumeWithAI(input: CurateResumeInput, requestId: string): Promise<CurateResumeOutput> {
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
  const targetRoleMode = inferTargetRoleMode(targetRole);
  const jdText = (input.jdText ?? '').trim();
  const hasJD = jdText.length > 0;
  const jdKeywords = extractJDKeywords(input.jdText ?? '', targetRole);
  const projectNotesPrimaryData = buildProjectNotesPrimaryResumeData(input.resumeData);
  const compactResumeData = compactResumeDataForCuration(projectNotesPrimaryData);

  try {
    console.info(`[ai-curate][${requestId}] start roleLen=${targetRole.length} jdLen=${jdText.length} mode=${hasJD ? 'jd' : 'base'}`);

    let layer1 = buildDeterministicCapabilityExtraction(compactResumeData, targetRoleMode);
    try {
      const layer1Payload = {
        task: 'layer_1_capability_extraction',
        targetRoleMode,
        sourceOfTruth: 'resume bullets + workExperience.projectNotes only',
        resumeData: compactResumeData,
        output_schema: {
          capabilities: [{ expId: 'string', capability: 'string', evidenceQuotes: 'string[] max 2' }],
          capabilitySummary: 'string[]',
          missingInfoQuestions: 'string[] max 5',
        },
      };
      const { parsed } = await runCurateModelParsed(
        client,
        CAPABILITY_EXTRACTION_SYSTEM_PROMPT,
        JSON.stringify(layer1Payload),
        curateSignal,
      );
      layer1 = sanitizeCapabilityExtractionOutput(parsed, compactResumeData, targetRoleMode);
    } catch (error) {
      console.warn(`[ai-curate][${requestId}] layer1 fallback reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
    }

    let layer2 = buildDeterministicRoleMapping(layer1, jdKeywords, targetRoleMode);
    if (hasJD) {
      try {
        const layer2Payload = {
          task: 'layer_2_role_mapping',
          targetRole,
          targetRoleMode,
          jdText,
          jdKeywords,
          capabilityInventory: layer1,
          output_schema: {
            supportedSignals: [{ signal: 'string', mappedCapabilities: 'string[]', evidenceQuotes: 'string[] max 2' }],
            unsupportedSignals: 'string[]',
            jdFocusAreas: 'string[] max 3',
            targetRoleMode: 'pm|product|designer|dev|analyst|ops|strategy|bizdev',
          },
        };
        const { parsed } = await runCurateModelParsed(
          client,
          ROLE_MAPPING_SYSTEM_PROMPT,
          JSON.stringify(layer2Payload),
          curateSignal,
        );
        layer2 = sanitizeRoleMappingOutput(parsed, layer2);
      } catch (error) {
        console.warn(`[ai-curate][${requestId}] layer2 fallback reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
      }
    } else {
      layer2 = { ...layer2, unsupportedSignals: [] };
    }

    let layer3 = buildDeterministicRoleTransformation(layer1, layer2.targetRoleMode);
    try {
      const layer3Payload = {
        task: 'layer_3_role_transformation',
        targetRole,
        targetRoleMode: layer2.targetRoleMode,
        supportedSignals: layer2.supportedSignals,
        capabilityInventory: layer1,
        output_schema: {
          transformedClaims: [{
            expId: 'string',
            claim: 'string',
            mechanism: 'string',
            impactSignal: 'string',
            evidenceQuotes: 'string[] max 2',
          }],
          droppedClaims: 'string[]',
          warnings: 'string[]',
        },
      };
      const { parsed } = await runCurateModelParsed(
        client,
        ROLE_TRANSFORMATION_SYSTEM_PROMPT,
        JSON.stringify(layer3Payload),
        curateSignal,
      );
      layer3 = sanitizeRoleTransformationOutput(parsed, layer3, compactResumeData);
    } catch (error) {
      console.warn(`[ai-curate][${requestId}] layer3 fallback reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
    }

    const finalPayload = {
      task: hasJD ? 'layer_4_final_writing_jd_aligned' : 'layer_4_final_writing_base_resume',
      targetRole,
      targetRoleMode: layer2.targetRoleMode,
      jdText,
      jdFocusAreas: layer2.jdFocusAreas,
      supportedSignals: layer2.supportedSignals,
      unsupportedSignals: layer2.unsupportedSignals,
      transformedClaims: layer3.transformedClaims,
      resumeData: compactResumeData,
      rules: [
        'Use only source-backed claims from resumeData and transformedClaims.',
        'Do not invent responsibilities, tools, metrics, systems, or outcomes.',
        'Do not copy JD text line-by-line or mirror JD order.',
        'Keep 5-7 bullets maximum per role.',
        'If metrics are missing, ask concise questions instead of inventing values.',
      ],
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
        questions: 'string[] max 5',
        changeSummary: 'string[]',
        redFlags: 'string[]',
        aboutPointers: 'string[]',
        jdFocusAreas: 'string[] max 3',
        positioningSummary: 'string',
        jdTldr: { roleAsks: 'string', candidateNeeds: 'string', keyFocusAreas: 'string[] max 3' },
        companyContext: {
          company: 'string',
          focus: 'string',
          stellarProfile: 'string[] max 4',
          evidence: 'string[] max 4',
        },
        suggestions: [{ field: 'bio|bullet', expId: 'string', bulletIdx: 'number', suggested: 'string', reason: 'string' }],
      },
    };

    let finalParsed: unknown;
    try {
      ({ parsed: finalParsed } = await runCurateModelParsed(
        client,
        FINAL_WRITING_SYSTEM_PROMPT,
        JSON.stringify(finalPayload),
        curateSignal,
      ));
    } catch (error) {
      console.warn(`[ai-curate][${requestId}] layer4 retry reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
      const rescuePayload = {
        ...finalPayload,
        rescue: true,
        extraInstruction: 'Return exactly one valid JSON object matching output_schema. No markdown.',
      };
      try {
        ({ parsed: finalParsed } = await runCurateModelParsed(
          client,
          FINAL_WRITING_SYSTEM_PROMPT,
          JSON.stringify(rescuePayload),
          curateSignal,
        ));
      } catch (rescueError) {
        console.warn(`[ai-curate][${requestId}] layer4 rescue fallback reason="${String((rescueError as { message?: string }).message ?? 'unknown error')}"`);
        return buildFallbackCurateOutput(input, 'AI response formatting issue in final writing step. Please retry curation.');
      }
    }

    const output = sanitizeElevateOutput(finalParsed, input.resumeData, targetRole, jdKeywords);

    if (output.suggestions.length === 0) {
      output.suggestions = deriveSuggestionsFromImproved(input.resumeData, output.improved, output.changes);
    }

    const unsupportedQuestions = hasJD
      ? layer2.unsupportedSignals.slice(0, 3).map((signal) => `Do you have source evidence for "${signal}" in your past work?`)
      : [];
    output.questions = uniqueStrings([
      ...output.questions,
      ...layer1.missingInfoQuestions,
      ...unsupportedQuestions,
    ]).slice(0, 5);

    if (output.jdFocusAreas.length === 0) {
      output.jdFocusAreas = layer2.jdFocusAreas.slice(0, 3);
    }
    if (output.jdTldr.keyFocusAreas.length === 0) {
      output.jdTldr.keyFocusAreas = output.jdFocusAreas.slice(0, 3);
    }

    output.changeSummary = uniqueStrings([
      ...output.changeSummary,
      `Used staged reasoning: capability extraction -> role mapping -> ${layer2.targetRoleMode} transformation -> final writing.`,
    ]).slice(0, 10);

    output.redFlags = uniqueStrings([
      ...output.redFlags,
      ...layer3.warnings,
      ...(hasJD && layer2.unsupportedSignals.length > 0
        ? [`Excluded unsupported JD signals: ${layer2.unsupportedSignals.slice(0, 5).join(', ')}`]
        : []),
    ]).slice(0, 8);

    output.quality = evaluateCurateQuality(input, output);

    const meaningfulSuggestions = output.suggestions.filter((s) => s.suggested.trim()).length;
    const hasChangePayload = meaningfulSuggestions > 0 || output.changes.length > 0;

    if (output.quality && !output.quality.passed) {
      output.redFlags = [
        ...new Set([
          ...output.redFlags,
          'Quality gate warning: suggestions provided, but more metrics/scope/tooling detail would improve recruiter-grade impact.',
        ]),
      ];
    }

    if (!hasChangePayload) {
      const reason = hasJD
        ? 'Need more details; ask user for metrics, scope, tooling, and ownership signals.'
        : 'Need more details from existing resume content; add concrete ownership, scope, tools, and measurable outcomes to unlock stronger base curation.';
      return buildFallbackCurateOutput(input, reason);
    }

    const finalGrounding = evaluateGroundingViolations(input.resumeData, output.improved, jdText);
    if (finalGrounding.suspicious) {
      return buildFallbackCurateOutput(input, `Grounding guardrail blocked unsupported JD-derived content: ${finalGrounding.details.join(' | ')}`);
    }

    const elapsedMs = Date.now() - started;
    console.info(`[ai-curate][${requestId}] success elapsedMs=${elapsedMs} suggestions=${output.suggestions.length} capabilities=${layer1.capabilitySummary.length} supportedSignals=${layer2.supportedSignals.length}`);
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
