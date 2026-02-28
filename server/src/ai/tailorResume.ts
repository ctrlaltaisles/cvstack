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
const CURATE_MAX_TOKENS = Number(process.env.OPENAI_CURATE_MAX_TOKENS ?? 2600);
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
  { id: 'program_artifacts', label: 'program artifacts and controls', pattern: /\b(workflow spec|checklist|tracker|template|journey visualization|plan of record|approval flows?)\b/i, modes: ['pm', 'ops', 'strategy', 'product'] },
  { id: 'discovery_interviews', label: 'discovery interviews', pattern: /\b(discovery interviews?|interview(ed|ing) .*managers?|friction points?)\b/i, modes: ['pm', 'product', 'designer', 'analyst'] },
  { id: 'theme_synthesis', label: 'insight/theme synthesis', pattern: /\b(synthesi[sz](ed|ing) (themes|inputs|findings)|identified themes?)\b/i, modes: ['pm', 'product', 'designer', 'analyst', 'strategy'] },
  { id: 'decision_frameworks', label: 'decision framework/template design', pattern: /\b(feedback template|structured feedback|reduc(ed|ing) subjective bias|decision[- ]making clarity)\b/i, modes: ['pm', 'product', 'designer', 'ops', 'strategy'] },
  { id: 'journey_mapping', label: 'journey mapping', pattern: /\b(journey|touchpoints?|90-day milestone|experience journey|drop-off risks?)\b/i, modes: ['pm', 'product', 'designer', 'ops'] },
  { id: 'experimentation', label: 'pilot/experimentation', pattern: /\b(pilot|tested|post-launch|experiment|validation)\b/i, modes: ['pm', 'product', 'designer', 'analyst', 'ops'] },
  { id: 'analytics_interpretation', label: 'analytics interpretation', pattern: /\b(heatmap|analytics|conversion points?|time-on-page|engagement)\b/i, modes: ['pm', 'product', 'designer', 'analyst'] },
  { id: 'scenario_modeling', label: 'scenario modeling', pattern: /\b(headcount planning|hiring velocity|growth trajectories?|scenario|cost implications?)\b/i, modes: ['pm', 'product', 'analyst', 'strategy', 'ops'] },
  { id: 'cadence_reporting', label: 'executive reporting cadence', pattern: /\b(recurring reports?|monthly reviews?|headcount dashboards?|cost visibility|time-to-hire|offer acceptance)\b/i, modes: ['pm', 'analyst', 'ops', 'strategy'] },
  { id: 'delivery_execution', label: 'delivery execution and schedule control', pattern: /\b(launch(ed)? in half|50% of (the )?planned timeline|behind schedule|deliverables?|timeline|schedule)\b/i, modes: ['pm', 'ops', 'strategy', 'product'] },
  { id: 'sla_negotiation', label: 'SLA/risk mitigation', pattern: /\b(sla|provisioning delays?|escalated the issue|service level|turnaround times?)\b/i, modes: ['pm', 'ops', 'strategy'] },
  { id: 'dashboard_visibility', label: 'tracking dashboard/operational visibility', pattern: /\b(tracking dashboard|monitor turnaround|visibility dashboard|operational visibility)\b/i, modes: ['pm', 'analyst', 'ops', 'strategy'] },
  { id: 'commercial_optimization', label: 'commercial optimization and renewal controls', pattern: /\b(vendor cost optimization|microsoft|aws|renewal|usage audits?|benchmark|23%|recurring costs?)\b/i, modes: ['pm', 'ops', 'strategy', 'bizdev'] },
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

const PROJECT_NOTES_BASE_SOURCE_LABEL = 'Master Resume';
const PROJECT_NOTES_SOURCE_HEADING = /^From\s+(.+?)\s*$/i;

interface CapabilityInventoryItem {
  expId: string;
  capabilityId?: string;
  capability: string;
  source?: string;
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
  capabilityId?: string;
  source?: string;
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

interface MechanismRequirement {
  capabilityId: string;
  label: string;
  source: string;
  pattern: RegExp;
  priority: number;
}

interface DepthDiagnostics {
  score: number;
  avgSimilarity: number;
  meaningfulChanges: number;
  capabilityCoverage: number;
  mechanismCoverage: number;
  variantMechanismCoverage: number;
  criticalCoverage: number;
  missingMechanisms: string[];
  deepEnough: boolean;
  notes: string[];
}

const MODE_SIGNAL_CATALOG: Record<TargetRoleMode, Array<{ signal: string; capabilityIds: string[]; jdHints: string[] }>> = {
  pm: [
    { signal: 'Requirements and scope definition', capabilityIds: ['requirements_modeling', 'workflow_architecture'], jdHints: ['requirements', 'scope', 'handover', 'execution'] },
    { signal: 'Cross-functional delivery coordination', capabilityIds: ['cross_functional_facilitation', 'journey_mapping', 'delivery_execution'], jdHints: ['cross-functional', 'stakeholder', 'customer', 'coordination'] },
    { signal: 'Program artifacts and governance controls', capabilityIds: ['program_artifacts', 'cadence_reporting'], jdHints: ['artifacts', 'plan of record', 'timelines', 'scope', 'report'] },
    { signal: 'Schedule and dependency management', capabilityIds: ['workflow_architecture', 'scenario_modeling'], jdHints: ['schedule', 'timeline', 'dependencies', 'on-time'] },
    { signal: 'Risk, issue, and SLA management', capabilityIds: ['sla_negotiation', 'dashboard_visibility', 'program_artifacts'], jdHints: ['risk', 'issue', 'complaint', 'sla', 'mitigation'] },
    { signal: 'Reporting and governance', capabilityIds: ['dashboard_visibility', 'analytics_interpretation', 'scenario_modeling', 'cadence_reporting'], jdHints: ['reporting', 'status', 'financial', 'progress', 'closing'] },
    { signal: 'Commercial and contract control', capabilityIds: ['commercial_optimization', 'scenario_modeling'], jdHints: ['commercial', 'contract', 'renewal', 'cost', 'financial'] },
    { signal: 'Continuous improvement and lessons learned', capabilityIds: ['experimentation', 'integration_hypothesis', 'theme_synthesis'], jdHints: ['lessons learnt', 'improve', 'process discipline', 'quality'] },
  ],
  product: [
    { signal: 'Problem discovery and synthesis', capabilityIds: ['discovery_interviews', 'theme_synthesis', 'decision_frameworks'], jdHints: ['discovery', 'insights', 'problem', 'users'] },
    { signal: 'Requirements and flow design', capabilityIds: ['requirements_modeling', 'workflow_architecture', 'journey_mapping'], jdHints: ['requirements', 'flows', 'spec', 'scope'] },
    { signal: 'Experimentation and iteration', capabilityIds: ['experimentation', 'analytics_interpretation'], jdHints: ['experiment', 'adoption', 'conversion', 'engagement'] },
    { signal: 'Cross-functional prioritization', capabilityIds: ['cross_functional_facilitation', 'scenario_modeling'], jdHints: ['prioritization', 'tradeoff', 'alignment', 'roadmap'] },
  ],
  designer: [
    { signal: 'Journey and flow mapping', capabilityIds: ['journey_mapping', 'workflow_architecture'], jdHints: ['journey', 'flow', 'experience'] },
    { signal: 'Feedback-led iteration', capabilityIds: ['discovery_interviews', 'theme_synthesis', 'experimentation'], jdHints: ['feedback', 'testing', 'iteration'] },
    { signal: 'Usability and clarity improvements', capabilityIds: ['decision_frameworks', 'analytics_interpretation'], jdHints: ['usability', 'clarity', 'engagement'] },
  ],
  dev: [
    { signal: 'Implementation planning and dependencies', capabilityIds: ['requirements_modeling', 'workflow_architecture'], jdHints: ['requirements', 'implementation', 'dependencies'] },
    { signal: 'Reliability and issue resolution', capabilityIds: ['sla_negotiation', 'dashboard_visibility'], jdHints: ['reliability', 'issue', 'monitoring', 'quality'] },
    { signal: 'Cross-functional delivery', capabilityIds: ['cross_functional_facilitation', 'scenario_modeling'], jdHints: ['cross-functional', 'delivery', 'schedule'] },
  ],
  analyst: [
    { signal: 'Metric definition and reporting cadence', capabilityIds: ['dashboard_visibility', 'scenario_modeling', 'analytics_interpretation'], jdHints: ['kpi', 'reporting', 'dashboard', 'analysis'] },
    { signal: 'Insight synthesis', capabilityIds: ['theme_synthesis', 'discovery_interviews'], jdHints: ['insight', 'findings', 'recommendation'] },
    { signal: 'Decision support models', capabilityIds: ['scenario_modeling', 'integration_hypothesis'], jdHints: ['model', 'scenario', 'decision'] },
  ],
  ops: [
    { signal: 'Process standardization', capabilityIds: ['workflow_architecture', 'journey_mapping', 'decision_frameworks'], jdHints: ['process', 'sop', 'standardize'] },
    { signal: 'Operational visibility', capabilityIds: ['dashboard_visibility', 'analytics_interpretation'], jdHints: ['visibility', 'monitor', 'dashboard'] },
    { signal: 'Issue resolution and controls', capabilityIds: ['sla_negotiation', 'cross_functional_facilitation'], jdHints: ['issue', 'risk', 'escalation'] },
  ],
  strategy: [
    { signal: 'Scenario planning and business cases', capabilityIds: ['scenario_modeling', 'integration_hypothesis'], jdHints: ['scenario', 'roi', 'business case', 'tradeoff'] },
    { signal: 'Executive synthesis and recommendations', capabilityIds: ['theme_synthesis', 'analytics_interpretation'], jdHints: ['executive', 'recommendation', 'insight'] },
    { signal: 'Cross-functional alignment', capabilityIds: ['cross_functional_facilitation', 'requirements_modeling'], jdHints: ['alignment', 'stakeholder', 'prioritization'] },
  ],
  bizdev: [
    { signal: 'Partnership and stakeholder management', capabilityIds: ['cross_functional_facilitation', 'decision_frameworks'], jdHints: ['partnership', 'stakeholder', 'negotiation'] },
    { signal: 'Pipeline and conversion optimization', capabilityIds: ['analytics_interpretation', 'experimentation'], jdHints: ['pipeline', 'conversion', 'engagement'] },
    { signal: 'Commercial planning support', capabilityIds: ['scenario_modeling', 'integration_hypothesis'], jdHints: ['commercial', 'growth', 'planning'] },
  ],
};

function normalizeProjectNotesSourceLabel(value: string): string {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  return clean || PROJECT_NOTES_BASE_SOURCE_LABEL;
}

function parseProjectNotesSections(value: string): Array<{ source: string; content: string }> {
  const normalized = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const headingIndices: number[] = [];
  lines.forEach((line, index) => {
    if (PROJECT_NOTES_SOURCE_HEADING.test(line.trim())) headingIndices.push(index);
  });

  const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const isStructured = headingIndices.length >= 2 && firstNonEmptyLineIndex === headingIndices[0];
  if (!isStructured) {
    return [{ source: PROJECT_NOTES_BASE_SOURCE_LABEL, content: normalized }];
  }

  const sections: Array<{ source: string; content: string }> = [];
  for (let i = 0; i < headingIndices.length; i += 1) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : lines.length;
    const heading = lines[start].trim();
    const match = heading.match(PROJECT_NOTES_SOURCE_HEADING);
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

function inferCapabilityRuleFromText(text: string, mode: TargetRoleMode): CapabilityMarkerRule | undefined {
  const normalized = String(text ?? '').toLowerCase();
  return CAPABILITY_MARKER_RULES.find((rule) => {
    if (!rule.modes.includes(mode)) return false;
    if (rule.pattern.test(normalized)) return true;
    const idProbe = rule.id.replace(/_/g, ' ');
    const labelProbe = rule.label.toLowerCase().split('/')[0]?.trim();
    return normalized.includes(idProbe) || (labelProbe ? normalized.includes(labelProbe) : false);
  });
}

function findEvidenceQuotes(content: string, pattern: RegExp): string[] {
  const metricScore = (sentence: string): number => {
    const percentMatches = sentence.match(/\b\d{1,3}\s?%/g)?.length ?? 0;
    const numericMatches = sentence.match(/\b\d+(?:\.\d+)?\b/g)?.length ?? 0;
    return (percentMatches * 3) + numericMatches;
  };
  const sentenceHits = splitSentences(content)
    .filter((sentence) => pattern.test(sentence))
    .sort((a, b) => metricScore(b) - metricScore(a))
    .slice(0, 2);
  if (sentenceHits.length > 0) return sentenceHits.map((sentence) => sentence.slice(0, 280));
  const fallback = String(content ?? '').trim();
  return fallback ? [fallback.slice(0, 280)] : [];
}

function buildDeterministicCapabilityExtraction(resumeData: ResumeData, mode: TargetRoleMode): CapabilityExtractionOutput {
  const capabilities: CapabilityInventoryItem[] = [];
  const dedupe = new Set<string>();

  for (const exp of resumeData.workExperience ?? []) {
    const sections = parseProjectNotesSections(exp.projectNotes ?? '');
    for (const section of sections) {
      const markers = extractCapabilityMarkers(section.content, mode);
      for (const marker of markers) {
        const key = `${exp.id}::${marker.id}::${normalizeProjectNotesSourceLabel(section.source)}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        capabilities.push({
          expId: exp.id,
          capabilityId: marker.id,
          capability: marker.label,
          source: normalizeProjectNotesSourceLabel(section.source),
          evidenceQuotes: findEvidenceQuotes(section.content, marker.pattern).slice(0, 2),
        });
      }
    }

    if (sections.length === 0) {
      const sourceText = `${(exp.bullets ?? []).join(' ')}`.trim();
      const markers = extractCapabilityMarkers(sourceText, mode);
      for (const marker of markers) {
        const key = `${exp.id}::${marker.id}::bullets`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        capabilities.push({
          expId: exp.id,
          capabilityId: marker.id,
          capability: marker.label,
          source: 'Legacy Bullets',
          evidenceQuotes: (exp.bullets ?? []).filter((bullet) => marker.pattern.test(bullet)).slice(0, 2),
        });
      }
    }
  }

  const capabilitySummary = uniqueStrings(capabilities.map((item) => item.capability)).slice(0, 24);
  return {
    capabilities: capabilities.slice(0, 80),
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
      const source = normalizeProjectNotesSourceLabel(String(item.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL));
      const explicitId = String(item.capabilityId ?? '').trim();
      const inferred = explicitId || inferCapabilityRuleFromText(`${capability} ${asStringArray(item.evidenceQuotes).join(' ')}`, mode)?.id || '';
      return {
        expId,
        capabilityId: inferred || undefined,
        capability,
        source,
        evidenceQuotes: asStringArray(item.evidenceQuotes).slice(0, 2),
      } as CapabilityInventoryItem;
    })
    .filter((row): row is CapabilityInventoryItem => Boolean(row));

  const capabilitySummary = uniqueStrings([
    ...asStringArray(raw.capabilitySummary),
    ...capabilities.map((item) => item.capability),
  ]).slice(0, 24);

  return {
    capabilities: capabilities.length > 0 ? capabilities.slice(0, 80) : fallback.capabilities,
    capabilitySummary: capabilitySummary.length > 0 ? capabilitySummary : fallback.capabilitySummary,
    missingInfoQuestions: asStringArray(raw.missingInfoQuestions).slice(0, 5),
  };
}

function buildDeterministicRoleMapping(
  capabilities: CapabilityExtractionOutput,
  jdKeywords: string[],
  targetRoleMode: TargetRoleMode,
  jdText = '',
): RoleMappingOutput {
  const catalog = MODE_SIGNAL_CATALOG[targetRoleMode] ?? MODE_SIGNAL_CATALOG.product;
  const jdBlob = `${jdText} ${jdKeywords.join(' ')}`.toLowerCase();

  const supportedSignalsRaw: Array<RoleMappingSignal & { priority: number }> = [];
  for (const signal of catalog) {
    const matched = capabilities.capabilities.filter((item) => item.capabilityId && signal.capabilityIds.includes(item.capabilityId));
    if (matched.length === 0) continue;
    const jdMatched = signal.jdHints.some((hint) => jdBlob.includes(hint.toLowerCase()));
    const fromVariant = matched.some((item) => normalizeProjectNotesSourceLabel(item.source ?? '').toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase());
    const priority = (jdMatched ? 2 : 0) + (fromVariant ? 1 : 0);
    supportedSignalsRaw.push({
      signal: signal.signal,
      mappedCapabilities: uniqueStrings(matched.map((item) => item.capability)).slice(0, 5),
      evidenceQuotes: uniqueStrings(matched.flatMap((item) => item.evidenceQuotes)).slice(0, 2),
      priority,
    });
  }

  const supportedSignals = supportedSignalsRaw
    .sort((a, b) => b.priority - a.priority || b.mappedCapabilities.length - a.mappedCapabilities.length)
    .slice(0, 10)
    .map((item) => ({
      signal: item.signal,
      mappedCapabilities: item.mappedCapabilities,
      evidenceQuotes: item.evidenceQuotes,
    }));

  const supportedText = `${supportedSignals.map((item) => item.signal).join(' ')} ${supportedSignals.flatMap((item) => item.mappedCapabilities).join(' ')}`.toLowerCase();
  const unsupportedSignals = jdKeywords.filter((keyword) => !supportedText.includes(keyword.toLowerCase())).slice(0, 10);
  const jdFocusAreas = uniqueStrings([
    ...jdKeywords.slice(0, 3),
    ...supportedSignals.slice(0, 2).map((item) => item.signal),
  ]).slice(0, 3);

  return {
    supportedSignals,
    unsupportedSignals,
    jdFocusAreas,
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
        mappedCapabilities: asStringArray(item.mappedCapabilities).slice(0, 5),
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
    unsupportedSignals: uniqueStrings(asStringArray(raw.unsupportedSignals)).slice(0, 10),
    jdFocusAreas: uniqueStrings(asStringArray(raw.jdFocusAreas)).slice(0, 3).length > 0
      ? uniqueStrings(asStringArray(raw.jdFocusAreas)).slice(0, 3)
      : fallback.jdFocusAreas,
    targetRoleMode: mode,
  };
}

function extractPercentages(texts: string[]): string[] {
  const hits = new Set<string>();
  for (const text of texts) {
    const matches = String(text ?? '').match(/\b\d{1,3}\s?%/g) ?? [];
    for (const match of matches) hits.add(match.replace(/\s+/g, ''));
  }
  return [...hits];
}

function evidenceHasPattern(texts: string[], pattern: RegExp): boolean {
  return texts.some((text) => pattern.test(String(text ?? '')));
}

function claimForCapability(item: CapabilityInventoryItem, mode: TargetRoleMode): { claim: string; mechanism: string; impact: string } {
  const programTone = mode === 'pm';
  const evidencePercents = extractPercentages(item.evidenceQuotes);
  switch (item.capabilityId) {
    case 'requirements_modeling':
      return {
        claim: programTone
          ? 'Translated business needs into workflow specifications with explicit state transitions to align cross-functional handoffs.'
          : 'Translated business needs into a lightweight workflow spec with explicit state transitions to align cross-functional handoffs.',
        mechanism: 'workflow spec + state transitions',
        impact: 'reduced manual duplication and improved execution clarity',
      };
    case 'workflow_architecture':
      return {
        claim: programTone
          ? 'Formalized end-to-end workflow handoffs, identified bottlenecks, and redesigned execution paths to improve delivery visibility.'
          : 'Mapped end-to-end workflow handoffs, identified bottlenecks, and redesigned process flow to improve execution visibility.',
        mechanism: 'workflow mapping + bottleneck analysis',
        impact: 'clearer handoffs and faster operational flow',
      };
    case 'cross_functional_facilitation':
      return {
        claim: programTone
          ? 'Led cross-functional execution forums across HR, Engineering, IT, and business stakeholders to align ownership and delivery decisions.'
          : 'Facilitated working sessions across HR, Engineering, IT, and business stakeholders to align ownership and delivery decisions.',
        mechanism: 'cross-functional facilitation',
        impact: 'faster alignment and fewer execution gaps',
      };
    case 'program_artifacts':
      return {
        claim: 'Established formal execution artifacts including workflow specs, standardized templates, and checklists to reduce ambiguity and maintain control points.',
        mechanism: 'program artifacts + governance controls',
        impact: 'more consistent execution and lower process-risk leakage',
      };
    case 'discovery_interviews':
      return {
        claim: programTone
          ? 'Ran discovery interviews with hiring managers to surface execution friction and convert qualitative pain points into action items.'
          : 'Ran discovery interviews with hiring managers to surface friction points and convert qualitative pain points into action items.',
        mechanism: 'discovery interviews',
        impact: 'better decision quality in evaluation workflows',
      };
    case 'theme_synthesis':
      return {
        claim: 'Synthesized recurring stakeholder themes to prioritize interventions and clarify decision pathways.',
        mechanism: 'theme synthesis',
        impact: 'higher-signal prioritization',
      };
    case 'decision_frameworks':
      return {
        claim: 'Designed structured feedback templates to reduce subjective bias and improve clarity in decision-making.',
        mechanism: 'structured decision framework',
        impact: 'more consistent evaluation outcomes',
      };
    case 'journey_mapping':
      return {
        claim: 'Mapped onboarding journey touchpoints from offer acceptance through 90-day milestones to identify drop-off risks.',
        mechanism: 'journey mapping',
        impact: 'improved onboarding continuity',
      };
    case 'experimentation':
      return {
        claim: 'Facilitated pilot rollouts of standardized onboarding experiences and iterated checkpoints using feedback.',
        mechanism: 'pilot experimentation',
        impact: 'stronger process adoption',
      };
    case 'analytics_interpretation':
      if (evidencePercents.length >= 2) {
        return {
          claim: 'Reviewed engagement and heatmap analytics to reposition careers-page content and strengthen conversion signals.',
          mechanism: 'heatmap + engagement analysis',
          impact: `improved page performance, including ${evidencePercents[0]} higher viewership and ${evidencePercents[1]} longer engagement`,
        };
      }
      return {
        claim: 'Reviewed engagement and heatmap analytics to reposition careers-page content and strengthen conversion signals.',
        mechanism: 'heatmap + engagement analysis',
        impact: 'improved page performance and inbound quality',
      };
    case 'scenario_modeling':
      return {
        claim: programTone
          ? 'Built scenario-based capacity models in Excel to test hiring-velocity assumptions across conservative and aggressive growth trajectories.'
          : 'Modeled hiring-velocity scenarios and growth trajectories in Excel to inform headcount and cost planning trade-offs.',
        mechanism: 'scenario modeling',
        impact: 'clearer leadership decisions on cost exposure, resource constraints, and timeline trade-offs',
      };
    case 'cadence_reporting':
      return {
        claim: 'Developed recurring executive reporting dashboards using Excel and HRIS exports for headcount, cost, and time-to-hire visibility.',
        mechanism: 'reporting cadence + dashboard instrumentation',
        impact: 'stronger operating-review governance and data-driven planning',
      };
    case 'delivery_execution':
      if (evidenceHasPattern(item.evidenceQuotes, /\b(half the expected timeline|50%\s+of\s+(the\s+)?planned timeline)\b/i) || evidencePercents.length >= 1) {
        return {
          claim: 'Program-managed careers-page redesign deliverables across marketing, design, and external developers under compressed timelines.',
          mechanism: 'schedule control + deliverable orchestration',
          impact: `accelerated launch execution to ${evidencePercents[0] ?? 'half the planned timeline'} while maintaining conversion objectives`,
        };
      }
      return {
        claim: 'Program-managed cross-functional deliverables against schedule constraints, recovering delayed workstreams and accelerating launch readiness.',
        mechanism: 'schedule control + deliverable orchestration',
        impact: 'improved on-time execution confidence under scaling pressure',
      };
    case 'sla_negotiation':
      return {
        claim: 'Identified recurring provisioning bottlenecks, escalated SLA gaps, and drove revised IT service commitments to protect onboarding readiness.',
        mechanism: 'SLA redesign',
        impact: 'faster turnaround and stronger cross-functional accountability',
      };
    case 'dashboard_visibility':
      return {
        claim: 'Implemented turnaround tracking dashboards to provide shared operational visibility for stakeholders and issue-resolution cadence.',
        mechanism: 'dashboard instrumentation',
        impact: 'better progress tracking and issue response',
      };
    case 'commercial_optimization':
      if (evidencePercents.length >= 1) {
        return {
          claim: 'Drove vendor optimization planning for Microsoft and AWS renewals through usage audits, benchmark research, and cost-comparison analysis.',
          mechanism: 'commercial modeling + renewal controls',
          impact: `contributed to a ${evidencePercents[0]} reduction in recurring spend and lower contract-risk exposure`,
        };
      }
      return {
        claim: 'Drove vendor optimization planning for Microsoft and AWS renewals through usage audits, benchmark research, and cost-comparison analysis.',
        mechanism: 'commercial modeling + renewal controls',
        impact: 'reduced recurring spend and lowered renewal risk exposure',
      };
    case 'integration_hypothesis':
      return {
        claim: 'Contributed to exploratory integration planning between HR reporting and product analytics to link hiring investment to team velocity.',
        mechanism: 'cross-domain analytics integration',
        impact: 'stronger strategy hypotheses for scaling',
      };
    default:
      return {
        claim: `Applied ${item.capability} to improve cross-functional execution quality.`,
        mechanism: item.capability,
        impact: 'better delivery consistency',
      };
  }
}

function buildDeterministicRoleTransformation(
  capabilities: CapabilityExtractionOutput,
  targetRoleMode: TargetRoleMode,
): RoleTransformationOutput {
  const priorityByCapability: Record<string, number> = {
    requirements_modeling: 9,
    workflow_architecture: 8,
    cross_functional_facilitation: 8,
    program_artifacts: 8,
    scenario_modeling: 8,
    cadence_reporting: 7,
    sla_negotiation: 7,
    dashboard_visibility: 7,
    delivery_execution: 7,
    commercial_optimization: 7,
    discovery_interviews: 6,
    decision_frameworks: 6,
    analytics_interpretation: 6,
    journey_mapping: 6,
    experimentation: 5,
    theme_synthesis: 5,
    integration_hypothesis: 4,
  };

  const orderedCapabilities = [...capabilities.capabilities].sort((a, b) => {
    const aSource = normalizeProjectNotesSourceLabel(a.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL).toLowerCase();
    const bSource = normalizeProjectNotesSourceLabel(b.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL).toLowerCase();
    const aVariant = aSource !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    const bVariant = bSource !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    if (aVariant !== bVariant) return bVariant - aVariant;
    const aPriority = priorityByCapability[a.capabilityId ?? ''] ?? 1;
    const bPriority = priorityByCapability[b.capabilityId ?? ''] ?? 1;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return (b.evidenceQuotes?.[0]?.length ?? 0) - (a.evidenceQuotes?.[0]?.length ?? 0);
  });

  const transformedClaims: RoleTransformationClaim[] = orderedCapabilities.slice(0, 30).map((item) => {
    const reframed = claimForCapability(item, targetRoleMode);
    return {
      expId: item.expId,
      capabilityId: item.capabilityId,
      source: item.source,
      claim: reframed.claim,
      mechanism: reframed.mechanism,
      impactSignal: reframed.impact,
      evidenceQuotes: item.evidenceQuotes.slice(0, 2),
    };
  });

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
        capabilityId: String(item.capabilityId ?? '').trim() || undefined,
        source: normalizeProjectNotesSourceLabel(String(item.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL)),
        claim,
        mechanism: String(item.mechanism ?? '').trim(),
        impactSignal: String(item.impactSignal ?? '').trim(),
        evidenceQuotes: asStringArray(item.evidenceQuotes).slice(0, 2),
      } as RoleTransformationClaim;
    })
    .filter((row): row is RoleTransformationClaim => Boolean(row));

  return {
    transformedClaims: transformedClaims.length > 0 ? transformedClaims.slice(0, 28) : fallback.transformedClaims,
    droppedClaims: uniqueStrings(asStringArray(raw.droppedClaims)).slice(0, 10),
    warnings: uniqueStrings(asStringArray(raw.warnings)).slice(0, 10),
  };
}

function mergeCapabilityExtractionOutputs(
  base: CapabilityExtractionOutput,
  overlay: CapabilityExtractionOutput,
): CapabilityExtractionOutput {
  const mergedMap = new Map<string, CapabilityInventoryItem>();
  const upsert = (item: CapabilityInventoryItem) => {
    const key = [
      item.expId,
      item.capabilityId ?? item.capability.toLowerCase(),
      normalizeProjectNotesSourceLabel(item.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL).toLowerCase(),
    ].join('::');
    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        ...item,
        source: normalizeProjectNotesSourceLabel(item.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL),
        evidenceQuotes: uniqueStrings(item.evidenceQuotes).slice(0, 2),
      });
      return;
    }
    const existing = mergedMap.get(key)!;
    mergedMap.set(key, {
      ...existing,
      capabilityId: existing.capabilityId || item.capabilityId,
      evidenceQuotes: uniqueStrings([...existing.evidenceQuotes, ...item.evidenceQuotes]).slice(0, 2),
    });
  };

  base.capabilities.forEach(upsert);
  overlay.capabilities.forEach(upsert);

  return {
    capabilities: [...mergedMap.values()].slice(0, 90),
    capabilitySummary: uniqueStrings([...base.capabilitySummary, ...overlay.capabilitySummary]).slice(0, 24),
    missingInfoQuestions: uniqueStrings([...base.missingInfoQuestions, ...overlay.missingInfoQuestions]).slice(0, 5),
  };
}

function mergeRoleMappingOutputs(base: RoleMappingOutput, overlay: RoleMappingOutput): RoleMappingOutput {
  const map = new Map<string, RoleMappingSignal>();
  for (const signal of [...base.supportedSignals, ...overlay.supportedSignals]) {
    const key = signal.signal.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        signal: signal.signal,
        mappedCapabilities: uniqueStrings(signal.mappedCapabilities).slice(0, 5),
        evidenceQuotes: uniqueStrings(signal.evidenceQuotes).slice(0, 2),
      });
      continue;
    }
    map.set(key, {
      signal: existing.signal,
      mappedCapabilities: uniqueStrings([...existing.mappedCapabilities, ...signal.mappedCapabilities]).slice(0, 5),
      evidenceQuotes: uniqueStrings([...existing.evidenceQuotes, ...signal.evidenceQuotes]).slice(0, 2),
    });
  }

  return {
    supportedSignals: [...map.values()].slice(0, 12),
    unsupportedSignals: uniqueStrings([...base.unsupportedSignals, ...overlay.unsupportedSignals]).slice(0, 10),
    jdFocusAreas: uniqueStrings([...base.jdFocusAreas, ...overlay.jdFocusAreas]).slice(0, 3),
    targetRoleMode: overlay.targetRoleMode || base.targetRoleMode,
  };
}

function mergeRoleTransformationOutputs(
  base: RoleTransformationOutput,
  overlay: RoleTransformationOutput,
): RoleTransformationOutput {
  const map = new Map<string, RoleTransformationClaim>();
  const upsert = (claim: RoleTransformationClaim) => {
    const key = `${claim.expId}::${claim.capabilityId ?? claim.mechanism.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        ...claim,
        evidenceQuotes: uniqueStrings(claim.evidenceQuotes).slice(0, 2),
      });
      return;
    }
    const existing = map.get(key)!;
    map.set(key, {
      ...existing,
      claim: existing.claim || claim.claim,
      mechanism: existing.mechanism || claim.mechanism,
      impactSignal: existing.impactSignal || claim.impactSignal,
      evidenceQuotes: uniqueStrings([...existing.evidenceQuotes, ...claim.evidenceQuotes]).slice(0, 2),
    });
  };

  base.transformedClaims.forEach(upsert);
  overlay.transformedClaims.forEach(upsert);

  return {
    transformedClaims: [...map.values()].slice(0, 28),
    droppedClaims: uniqueStrings([...base.droppedClaims, ...overlay.droppedClaims]).slice(0, 10),
    warnings: uniqueStrings([...base.warnings, ...overlay.warnings]).slice(0, 10),
  };
}

function buildMechanismRequirements(capabilities: CapabilityExtractionOutput, mode: TargetRoleMode): MechanismRequirement[] {
  const dedupe = new Map<string, MechanismRequirement>();
  for (const item of capabilities.capabilities) {
    const rule = item.capabilityId
      ? CAPABILITY_MARKER_RULES.find((candidate) => candidate.id === item.capabilityId)
      : inferCapabilityRuleFromText(item.capability, mode);
    if (!rule) continue;
    const source = normalizeProjectNotesSourceLabel(item.source ?? PROJECT_NOTES_BASE_SOURCE_LABEL);
    const fromVariant = source.toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase();
    const priority = (fromVariant ? 3 : 1)
      + ([
        'requirements_modeling',
        'workflow_architecture',
        'program_artifacts',
        'discovery_interviews',
        'analytics_interpretation',
        'scenario_modeling',
        'cadence_reporting',
        'delivery_execution',
        'sla_negotiation',
        'dashboard_visibility',
        'commercial_optimization',
      ].includes(rule.id) ? 1 : 0);
    const key = `${rule.id}::${source.toLowerCase()}`;
    if (!dedupe.has(key) || (dedupe.get(key)?.priority ?? 0) < priority) {
      dedupe.set(key, {
        capabilityId: rule.id,
        label: rule.label,
        source,
        pattern: rule.pattern,
        priority,
      });
    }
  }
  return [...dedupe.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 10);
}

function evaluateDepthDiagnostics(
  resumeData: ResumeData,
  output: CurateResumeOutput,
  targetRoleMode: TargetRoleMode,
  mechanismRequirements: MechanismRequirement[],
): DepthDiagnostics {
  const beforeBullets = resumeData.workExperience.flatMap((exp) => exp.bullets.map((bullet) => bullet.trim()).filter(Boolean));
  const afterBullets = output.improved.experience.flatMap((exp) => exp.bullets.map((bullet) => bullet.trim()).filter(Boolean));
  const max = Math.max(beforeBullets.length, afterBullets.length);
  const sims: number[] = [];
  let meaningfulChanges = 0;
  for (let i = 0; i < max; i += 1) {
    const before = beforeBullets[i] ?? '';
    const after = afterBullets[i] ?? '';
    if (!after) continue;
    if (!before) {
      meaningfulChanges += 1;
      continue;
    }
    const sim = lexicalSimilarity(before, after);
    sims.push(sim);
    if (sim < 0.8) meaningfulChanges += 1;
  }
  const avgSimilarity = sims.length > 0 ? Number((sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(2)) : 1;

  const capabilityCoverageEval = evaluateCapabilityElevationCoverage(resumeData, output.improved, targetRoleMode);
  const capabilityCoverage = capabilityCoverageEval.coverageRatio;

  const afterText = afterBullets.join(' ');
  const mechanismHits = mechanismRequirements.filter((item) => item.pattern.test(afterText));
  const mechanismCoverage = mechanismRequirements.length > 0 ? mechanismHits.length / mechanismRequirements.length : 1;
  const variantRequirements = mechanismRequirements.filter((item) => item.source.toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase());
  const variantHits = variantRequirements.filter((item) => item.pattern.test(afterText));
  const variantMechanismCoverage = variantRequirements.length > 0 ? variantHits.length / variantRequirements.length : 1;

  const score = Number((
    (meaningfulChanges * 0.2)
    + ((1 - avgSimilarity) * 0.25)
    + (capabilityCoverage * 0.3)
    + (mechanismCoverage * 0.15)
    + (variantMechanismCoverage * 0.1)
  ).toFixed(3));

  const missingMechanisms = mechanismRequirements
    .filter((item) => !item.pattern.test(afterText))
    .map((item) => `${item.label} (${item.source})`)
    .slice(0, 8);

  const criticalPmCapabilities = [
    'requirements_modeling',
    'program_artifacts',
    'delivery_execution',
    'scenario_modeling',
    'cadence_reporting',
    'sla_negotiation',
    'commercial_optimization',
  ];
  const requiredCapabilitySet = new Set(mechanismRequirements.map((item) => item.capabilityId));
  const criticalRequired = criticalPmCapabilities.filter((id) => requiredCapabilitySet.has(id));
  const criticalMatched = criticalRequired.filter((id) => mechanismRequirements.some((item) => item.capabilityId === id && item.pattern.test(afterText)));
  const criticalCoverage = criticalRequired.length > 0 ? criticalMatched.length / criticalRequired.length : 1;

  const deepEnough = meaningfulChanges >= 4
    && avgSimilarity <= 0.74
    && capabilityCoverage >= 0.3
    && mechanismCoverage >= 0.55
    && variantMechanismCoverage >= 0.45
    && (targetRoleMode !== 'pm' || criticalCoverage >= 0.6);

  const notes: string[] = [
    `meaningfulChanges=${meaningfulChanges}`,
    `avgSimilarity=${avgSimilarity}`,
    `capabilityCoverage=${Math.round(capabilityCoverage * 100)}%`,
    `mechanismCoverage=${Math.round(mechanismCoverage * 100)}%`,
    `variantMechanismCoverage=${Math.round(variantMechanismCoverage * 100)}%`,
    ...(targetRoleMode === 'pm' ? [`criticalCoverage=${Math.round(criticalCoverage * 100)}%`] : []),
  ];

  return {
    score,
    avgSimilarity,
    meaningfulChanges,
    capabilityCoverage,
    mechanismCoverage,
    variantMechanismCoverage,
    criticalCoverage,
    missingMechanisms,
    deepEnough,
    notes,
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
      // Keep richer context so merged Master + Variant notes are not silently dropped.
      projectNotes: clamp(exp.projectNotes ?? '', 9000),
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
  const outputRoleMode = inferTargetRoleMode(targetRole);
  const maxBulletsPerExperience = outputRoleMode === 'pm' ? 9 : 7;

  const improvedExperience: ElevateExperience[] = expRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const expId = String(row.expId ?? '').trim();
      if (!expId) return null;
      const original = resumeData.workExperience.find((exp) => exp.id === expId);
      if (!original) return null;
      const bullets = asStringArray(row.bullets).slice(0, maxBulletsPerExperience);
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

function buildDepthRescueBulletsForExp(
  baseExp: ResumeData['workExperience'][number],
  claims: RoleTransformationClaim[],
  maxBullets = 7,
): string[] {
  const priorityByCapability: Record<string, number> = {
    requirements_modeling: 10,
    program_artifacts: 10,
    workflow_architecture: 9,
    delivery_execution: 9,
    cross_functional_facilitation: 8,
    scenario_modeling: 8,
    cadence_reporting: 8,
    dashboard_visibility: 8,
    sla_negotiation: 8,
    commercial_optimization: 8,
    analytics_interpretation: 7,
    discovery_interviews: 7,
    decision_frameworks: 7,
    journey_mapping: 7,
    experimentation: 6,
    theme_synthesis: 6,
    integration_hypothesis: 5,
  };

  // Keep strongest claim per capability to avoid repetitive bullets.
  const bestByCapability = new Map<string, RoleTransformationClaim>();
  for (const claim of claims) {
    const key = claim.capabilityId ?? claim.claim.toLowerCase();
    const existing = bestByCapability.get(key);
    if (!existing) {
      bestByCapability.set(key, claim);
      continue;
    }
    const claimVariant = normalizeProjectNotesSourceLabel(claim.source ?? '').toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    const existingVariant = normalizeProjectNotesSourceLabel(existing.source ?? '').toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    if (claimVariant > existingVariant) {
      bestByCapability.set(key, claim);
      continue;
    }
    const claimEvidenceLen = claim.evidenceQuotes.join(' ').length;
    const existingEvidenceLen = existing.evidenceQuotes.join(' ').length;
    if (claimEvidenceLen > existingEvidenceLen) bestByCapability.set(key, claim);
  }

  const orderedClaims = [...bestByCapability.values()].sort((a, b) => {
    const aPriority = priorityByCapability[a.capabilityId ?? ''] ?? 1;
    const bPriority = priorityByCapability[b.capabilityId ?? ''] ?? 1;
    if (aPriority !== bPriority) return bPriority - aPriority;
    const aVariant = normalizeProjectNotesSourceLabel(a.source ?? '').toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    const bVariant = normalizeProjectNotesSourceLabel(b.source ?? '').toLowerCase() !== PROJECT_NOTES_BASE_SOURCE_LABEL.toLowerCase() ? 1 : 0;
    if (aVariant !== bVariant) return bVariant - aVariant;
    return b.claim.length - a.claim.length;
  });

  const groupForCapability = (capabilityId?: string): string => {
    switch (capabilityId) {
      case 'requirements_modeling':
      case 'workflow_architecture':
      case 'program_artifacts':
        return 'workflow';
      case 'delivery_execution':
      case 'cross_functional_facilitation':
        return 'delivery';
      case 'scenario_modeling':
        return 'planning';
      case 'cadence_reporting':
        return 'reporting';
      case 'sla_negotiation':
      case 'dashboard_visibility':
        return 'risk';
      case 'commercial_optimization':
        return 'commercial';
      case 'analytics_interpretation':
      case 'discovery_interviews':
      case 'decision_frameworks':
      case 'journey_mapping':
      case 'theme_synthesis':
      case 'experimentation':
        return 'insight';
      default:
        return 'other';
    }
  };

  const selectedClaims: RoleTransformationClaim[] = [];
  const selectedKeys = new Set<string>();
  const hardCoverageOrder = ['workflow', 'delivery', 'planning', 'reporting', 'risk', 'commercial', 'insight'];
  for (const group of hardCoverageOrder) {
    const candidate = orderedClaims.find((claim) => groupForCapability(claim.capabilityId) === group);
    if (!candidate) continue;
    const key = candidate.capabilityId ?? candidate.claim.toLowerCase();
    if (selectedKeys.has(key)) continue;
    selectedClaims.push(candidate);
    selectedKeys.add(key);
    if (selectedClaims.length >= maxBullets) break;
  }

  const softGroupLimits: Record<string, number> = {
    workflow: 2,
    delivery: 2,
    planning: 2,
    reporting: 1,
    risk: 2,
    commercial: 1,
    insight: 2,
    other: 1,
  };
  const groupCounts = selectedClaims.reduce<Record<string, number>>((acc, claim) => {
    const group = groupForCapability(claim.capabilityId);
    acc[group] = (acc[group] ?? 0) + 1;
    return acc;
  }, {});

  for (const claim of orderedClaims) {
    if (selectedClaims.length >= maxBullets) break;
    const key = claim.capabilityId ?? claim.claim.toLowerCase();
    if (selectedKeys.has(key)) continue;
    const group = groupForCapability(claim.capabilityId);
    const limit = softGroupLimits[group] ?? 1;
    if ((groupCounts[group] ?? 0) >= limit) continue;
    selectedClaims.push(claim);
    selectedKeys.add(key);
    groupCounts[group] = (groupCounts[group] ?? 0) + 1;
  }

  for (const claim of orderedClaims) {
    if (selectedClaims.length >= maxBullets) break;
    const key = claim.capabilityId ?? claim.claim.toLowerCase();
    if (selectedKeys.has(key)) continue;
    selectedClaims.push(claim);
    selectedKeys.add(key);
  }

  const claimBullets = selectedClaims
    .map((claim) => {
      const base = claim.claim.trim().replace(/\.$/, '');
      const impact = claim.impactSignal.trim().replace(/\.$/, '');
      const sentence = impact ? `${base}, ${impact}.` : `${base}.`;
      return sentence.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);

  const uniqueClaimBullets = uniqueStrings(claimBullets).slice(0, maxBullets);
  if (uniqueClaimBullets.length >= 4) return uniqueClaimBullets;

  const fallbacks = (baseExp.bullets ?? [])
    .map((bullet) => bullet.trim())
    .filter(Boolean)
    .slice(0, maxBullets - uniqueClaimBullets.length);
  return uniqueStrings([...uniqueClaimBullets, ...fallbacks]).slice(0, maxBullets);
}

function applyDepthRescueFromClaims(
  output: CurateResumeOutput,
  resumeData: ResumeData,
  roleTransformation: RoleTransformationOutput,
  maxBulletsPerExperience: number,
): CurateResumeOutput {
  const byExp = new Map<string, RoleTransformationClaim[]>();
  for (const claim of roleTransformation.transformedClaims) {
    const list = byExp.get(claim.expId) ?? [];
    list.push(claim);
    byExp.set(claim.expId, list);
  }

  const rescuedExperience = output.improved.experience.map((exp) => {
    const sourceExp = resumeData.workExperience.find((item) => item.id === exp.expId);
    if (!sourceExp) return exp;
    const claims = byExp.get(exp.expId) ?? [];
    if (claims.length === 0) return exp;
    const bullets = buildDepthRescueBulletsForExp(sourceExp, claims, maxBulletsPerExperience);
    if (bullets.length === 0) return exp;
    return { ...exp, bullets };
  });

  return {
    ...output,
    improved: {
      ...output.improved,
      experience: rescuedExperience,
    },
    redFlags: uniqueStrings([
      ...output.redFlags,
      'Depth rescue applied from transformed capability claims.',
    ]),
  };
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
          capabilities: [{ expId: 'string', capabilityId: 'string', capability: 'string', source: 'string', evidenceQuotes: 'string[] max 2' }],
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
      const modelLayer1 = sanitizeCapabilityExtractionOutput(parsed, compactResumeData, targetRoleMode);
      layer1 = mergeCapabilityExtractionOutputs(layer1, modelLayer1);
    } catch (error) {
      console.warn(`[ai-curate][${requestId}] layer1 fallback reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
    }

    let layer2 = buildDeterministicRoleMapping(layer1, jdKeywords, targetRoleMode, jdText);
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
        const modelLayer2 = sanitizeRoleMappingOutput(parsed, layer2);
        layer2 = mergeRoleMappingOutputs(layer2, modelLayer2);
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
            capabilityId: 'string',
            source: 'string',
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
      const modelLayer3 = sanitizeRoleTransformationOutput(parsed, layer3, compactResumeData);
      const filteredModelLayer3: RoleTransformationOutput = {
        transformedClaims: modelLayer3.transformedClaims.filter((claim) => {
          if (!claim.capabilityId) return false;
          return !layer3.transformedClaims.some((base) => base.expId === claim.expId && base.capabilityId === claim.capabilityId);
        }),
        droppedClaims: modelLayer3.droppedClaims,
        warnings: modelLayer3.warnings,
      };
      layer3 = mergeRoleTransformationOutputs(layer3, filteredModelLayer3);
    } catch (error) {
      console.warn(`[ai-curate][${requestId}] layer3 fallback reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
    }

    const mechanismRequirements = buildMechanismRequirements(layer1, layer2.targetRoleMode);
    const finalPayload = {
      task: hasJD ? 'layer_4_final_writing_jd_aligned' : 'layer_4_final_writing_base_resume',
      targetRole,
      targetRoleMode: layer2.targetRoleMode,
      jdText,
      jdFocusAreas: layer2.jdFocusAreas,
      supportedSignals: layer2.supportedSignals,
      unsupportedSignals: layer2.unsupportedSignals,
      transformedClaims: layer3.transformedClaims,
      mustIncludeMechanisms: mechanismRequirements.map((item) => ({
        capabilityId: item.capabilityId,
        label: item.label,
        source: item.source,
        priority: item.priority,
      })),
      resumeData: compactResumeData,
      rules: [
        'Use only source-backed claims from resumeData and transformedClaims.',
        'Do not invent responsibilities, tools, metrics, systems, or outcomes.',
        'Do not copy JD text line-by-line or mirror JD order.',
        'Keep 6-9 bullets for program/project management roles with dense evidence; otherwise keep 5-7 bullets.',
        'If metrics are missing, ask concise questions instead of inventing values.',
        'Depth requirement: preserve mechanism nouns from evidence (e.g., workflow spec, state transitions, discovery interviews, heatmap analytics, scenario modeling, SLA, dashboard) when present.',
        'Each bullet should include mechanism + action + impact signal, not only generic process language.',
        'If variant project-note sources exist, preserve at least 2 mechanism signals from those variant sources in final bullets.',
        'For pm mode, prioritize explicit execution framing: program artifacts, dependency/schedule control, risk or SLA mitigation, reporting cadence, and commercial controls when supported by evidence.',
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
        roleLensOutput: {
          bullets: [{ expId: 'string', bullet: 'string', evidenceQuotes: 'string[] max 2' }],
          missingInfoQuestions: 'string[] max 5',
        },
      },
    };

    let bestOutput: CurateResumeOutput | null = null;
    let bestDepth: DepthDiagnostics | null = null;
    let currentFinalPayload: Record<string, unknown> = finalPayload;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let parsed: unknown;
      try {
        ({ parsed } = await runCurateModelParsed(
          client,
          FINAL_WRITING_SYSTEM_PROMPT,
          JSON.stringify(currentFinalPayload),
          curateSignal,
        ));
      } catch (error) {
        console.warn(`[ai-curate][${requestId}] layer4 attempt=${attempt + 1} reason="${String((error as { message?: string }).message ?? 'unknown error')}"`);
        if (attempt === 2) break;
        currentFinalPayload = {
          ...finalPayload,
          depthRetry: {
            attempt: attempt + 1,
            reason: 'format_or_generation_failure',
            instruction: 'Return exactly one valid JSON object matching output_schema. No markdown.',
          },
        };
        continue;
      }

      const candidate = sanitizeElevateOutput(parsed, input.resumeData, targetRole, jdKeywords);
      if (candidate.suggestions.length === 0) {
        candidate.suggestions = deriveSuggestionsFromImproved(input.resumeData, candidate.improved, candidate.changes);
      }
      const candidateDepth = evaluateDepthDiagnostics(
        input.resumeData,
        candidate,
        layer2.targetRoleMode,
        mechanismRequirements,
      );

      if (!bestDepth || candidateDepth.score > bestDepth.score) {
        bestDepth = candidateDepth;
        bestOutput = candidate;
      }

      if (candidateDepth.deepEnough) break;

      currentFinalPayload = {
        ...finalPayload,
        depthRetry: {
          attempt: attempt + 1,
          depthDiagnostics: candidateDepth,
          missingMechanisms: candidateDepth.missingMechanisms,
          previousImproved: candidate.improved.experience,
          instruction: 'Increase transformation depth: preserve mechanism nouns, reduce generic wording, and integrate missing mechanisms without inventing facts.',
        },
      };
    }

    if (!bestOutput) {
      return buildFallbackCurateOutput(input, 'AI response formatting issue in final writing step. Please retry curation.');
    }

    let output = bestOutput;
    let depthDiagnostics = bestDepth ?? evaluateDepthDiagnostics(
      input.resumeData,
      output,
      layer2.targetRoleMode,
      mechanismRequirements,
    );
    const maxBulletsPerExperience = layer2.targetRoleMode === 'pm' ? 9 : 7;
    if (!depthDiagnostics.deepEnough && layer3.transformedClaims.length > 0) {
      output = applyDepthRescueFromClaims(output, input.resumeData, layer3, maxBulletsPerExperience);
      depthDiagnostics = evaluateDepthDiagnostics(
        input.resumeData,
        output,
        layer2.targetRoleMode,
        mechanismRequirements,
      );
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
      `Mechanisms targeted: ${mechanismRequirements.map((item) => item.label).slice(0, 6).join(', ') || 'none'}.`,
      `Depth diagnostics: ${depthDiagnostics.notes.join(', ')}.`,
    ]).slice(0, 10);

    output.redFlags = uniqueStrings([
      ...output.redFlags,
      ...layer3.warnings,
      ...(hasJD && layer2.unsupportedSignals.length > 0
        ? [`Excluded unsupported JD signals: ${layer2.unsupportedSignals.slice(0, 5).join(', ')}`]
        : []),
      ...(!depthDiagnostics.deepEnough
        ? [`Depth gap remains after retries; missing mechanisms: ${depthDiagnostics.missingMechanisms.slice(0, 5).join('; ') || 'none'}.`]
        : []),
    ]).slice(0, 8);

    output.quality = evaluateCurateQuality(input, output);
    if (output.quality && depthDiagnostics.deepEnough) {
      output.quality = {
        ...output.quality,
        passed: true,
        notes: `${output.quality.notes} Depth gate passed with score ${depthDiagnostics.score}.`,
      };
    }

    const meaningfulSuggestions = output.suggestions.filter((s) => s.suggested.trim()).length;
    const hasChangePayload = meaningfulSuggestions > 0 || output.changes.length > 0;

    if (output.quality && !output.quality.passed && !depthDiagnostics.deepEnough) {
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
