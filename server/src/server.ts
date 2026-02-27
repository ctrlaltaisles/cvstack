import "dotenv/config";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { AuthedRequest, GUEST_USER_ID, getUserIdFromAuthHeader, hashPassword, makeId, requireAuth, signShareToken, signToken, verifyPassword, verifyShareToken } from './auth';
import { defaultResumeData } from './defaults';
import { createVersionRecord, initDb, patchVersionRecord, readDb, withDb, type ProfileRecord, type ResumeRecord, type UserRecord, type VersionRecord } from './db';
import type { ResumeData, ResumeVersionDTO } from './types';
import { inferResumeSummaryFromDebug, parseResumePdf, toResumeDataFromParsedResume } from './resumeParse/parseResumePdf';
import { extractTextFromPdfBuffer, parseResumeText, toResumeData as toResumeDataFromLegacyParser } from './parser';
import { TailorResumeError, curateResumeWithAI, tailorResumeWithAI, type SeniorityLevel } from './ai/tailorResume';
import { deleteStoredResumePdf, getResumePdfAccess, getStorageDiagnostics, storeResumePdf } from './storage/pdfStorage';

dotenv.config();
const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const UPLOAD_RETENTION_DAYS = Number(process.env.UPLOAD_RETENTION_DAYS ?? 7);
const UPLOAD_CLEANUP_INTERVAL_MS = Number(process.env.UPLOAD_CLEANUP_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
// Temporarily hard-disable cleanup scheduler to prevent Prisma transaction conflicts in production.
const ENABLE_UPLOAD_CLEANUP = false;
const MIN_OPTIMIZE_BYTES = 200 * 1024;
const SUPABASE_URL = String(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim();
const SUPABASE_AUTH_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_ANON_KEY
  ?? process.env.VITE_SUPABASE_ANON_KEY
  ?? '',
).trim();
let supabaseAuthClient: ReturnType<typeof createClient> | null = null;

function getSupabaseAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_AUTH_KEY) return null;
  if (supabaseAuthClient) return supabaseAuthClient;
  supabaseAuthClient = createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseAuthClient;
}

type CompressionResult = {
  buffer: Buffer;
  method: 'none' | 'qpdf' | 'ghostscript';
};

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info', 'X-CVStack-Guest-Id'],
  optionsSuccessStatus: 200,
}));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/storage/health', (_req, res) => {
  res.json({
    ok: true,
    storage: getStorageDiagnostics(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/ai/tailor-resume', async (req, res) => {
  const requestId = makeId('air');
  const jdText = String(req.body?.jdText ?? '').trim();
  const baseResumeText = String(req.body?.baseResumeText ?? '').trim();
  const targetTitle = String(req.body?.targetTitle ?? '').trim() || undefined;
  const seniorityRaw = String(req.body?.seniority ?? '').trim().toLowerCase();
  const allowedSeniorities: SeniorityLevel[] = ['intern', 'junior', 'mid', 'senior'];
  const seniority = (allowedSeniorities.includes(seniorityRaw as SeniorityLevel) ? seniorityRaw : undefined) as SeniorityLevel | undefined;

  if (!jdText || !baseResumeText) {
    res.status(400).json({ error: 'jdText and baseResumeText are required', requestId });
    return;
  }

  try {
    const result = await tailorResumeWithAI({ jdText, baseResumeText, targetTitle, seniority }, requestId);
    res.json(result);
  } catch (error) {
    if (error instanceof TailorResumeError) {
      console.warn(`[ai-tailor][${requestId}] failed status=${error.statusCode} jdLen=${jdText.length} baseLen=${baseResumeText.length}`);
      res.status(error.statusCode).json({ error: error.message, requestId });
      return;
    }
    console.warn(`[ai-tailor][${requestId}] failed status=500 jdLen=${jdText.length} baseLen=${baseResumeText.length}`);
    res.status(500).json({ error: 'Unexpected AI tailoring error', requestId });
  }
});

app.post('/api/ai/curate-resume', async (req, res) => {
  const requestId = makeId('aic');
  const resumeData = req.body?.resumeData as ResumeData | undefined;
  const targetRole = String(req.body?.targetRole ?? '').trim() || undefined;
  const jdText = String(req.body?.jdText ?? '').trim() || undefined;
  const jobCompany = String(req.body?.jobCompany ?? '').trim() || undefined;
  const jobLink = String(req.body?.jobLink ?? '').trim() || undefined;

  if (!resumeData || typeof resumeData !== 'object') {
    res.status(400).json({ error: 'resumeData is required', requestId });
    return;
  }

  try {
    const result = await curateResumeWithAI({ resumeData, targetRole, jdText, jobCompany, jobLink }, requestId);
    res.json(result);
  } catch (error) {
    if (error instanceof TailorResumeError) {
      console.warn(`[ai-curate][${requestId}] failed status=${error.statusCode}`);
      res.status(error.statusCode).json({ error: error.message, requestId });
      return;
    }
    console.warn(`[ai-curate][${requestId}] failed status=500`);
    res.status(500).json({ error: 'Unexpected AI curation error', requestId });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const fullName = String(req.body?.fullName ?? '').trim();

  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'Email and password (min 8 chars) are required' });
    return;
  }

  const state = await readDb();
  if (state.users.some((u) => u.email === email)) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const userId = makeId('usr');
  const now = new Date().toISOString();
  const user: UserRecord = { id: userId, email, passwordHash: hashPassword(password), createdAt: now };
  const profile = makeProfileRecord(userId, now, { fullName, contactEmail: email });

  await withDb(async (db) => {
    db.users.push(user);
    db.profiles.push(profile);
  });

  res.status(201).json({ token: signToken(userId), user: { id: userId, email, fullName } });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const state = await readDb();

  const user = state.users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: 'Invalid email/password' });
    return;
  }

  const profile = state.profiles.find((p) => p.userId === user.id);
  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, fullName: profile?.fullName ?? '' } });
});

app.post('/api/auth/supabase', async (req, res) => {
  const accessToken = String(req.body?.accessToken ?? '').trim();
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken is required' });
    return;
  }

  const supabase = getSupabaseAuthClient();
  if (!supabase) {
    res.status(500).json({
      error: 'Supabase auth is not configured on server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).',
    });
    return;
  }

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data?.user?.email) {
    res.status(401).json({ error: 'Invalid Supabase access token' });
    return;
  }

  const email = data.user.email.trim().toLowerCase();
  const now = new Date().toISOString();
  const state = await readDb();
  let user = state.users.find((u) => u.email === email) ?? null;

  if (!user) {
    const userId = makeId('usr');
    user = { id: userId, email, passwordHash: 'supabase', createdAt: now };
    await withDb(async (db) => {
      db.users.push(user as UserRecord);
      db.profiles.push(makeProfileRecord(userId, now, { contactEmail: email }));
    });
  }

  const latestState = await readDb();
  const profile = latestState.profiles.find((p) => p.userId === user!.id);
  res.json({ token: signToken(user.id), user: { id: user.id, email: user.email, fullName: profile?.fullName ?? '' } });
});

app.get('/api/auth/me', requireAuth, async (req: AuthedRequest, res) => {
  const state = await readDb();
  const user = state.users.find((u) => u.id === req.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const profile = state.profiles.find((p) => p.userId === user.id);
  res.json({ user: { id: user.id, email: user.email, fullName: profile?.fullName ?? '' } });
});

app.get('/api/profile', requireAuth, async (req: AuthedRequest, res) => {
  const state = await readDb();
  const profile = state.profiles.find((p) => p.userId === req.userId) ?? null;
  res.json({ profile });
});

app.patch('/api/profile', requireAuth, async (req: AuthedRequest, res) => {
  const now = new Date().toISOString();
  await withDb(async (db) => {
    const profile = db.profiles.find((p) => p.userId === req.userId);
    if (!profile) return;
    profile.fullName = String(req.body?.fullName ?? profile.fullName ?? '');
    profile.headline = String(req.body?.headline ?? profile.headline ?? '');
    profile.summary = String(req.body?.summary ?? profile.summary ?? '');
    profile.contactEmail = String(req.body?.contactEmail ?? profile.contactEmail ?? '');
    profile.phone = String(req.body?.phone ?? profile.phone ?? '');
    profile.location = String(req.body?.location ?? profile.location ?? '');
    profile.linkedin = String(req.body?.linkedin ?? profile.linkedin ?? '');
    profile.website = String(req.body?.website ?? profile.website ?? '');
    profile.updatedAt = now;
  });
  res.json({ ok: true });
});

function resolveRequestUserId(req: express.Request) {
  const authedUserId = getUserIdFromAuthHeader(req);
  if (authedUserId) return authedUserId;

  const rawGuestId = String(req.header('x-cvstack-guest-id') ?? '').trim();
  if (!rawGuestId) return GUEST_USER_ID;
  const safeGuestId = rawGuestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return safeGuestId ? `guest_${safeGuestId}` : GUEST_USER_ID;
}

function makeProfileRecord(
  userId: string,
  updatedAt: string,
  overrides: Partial<Omit<ProfileRecord, 'userId' | 'updatedAt'>> = {},
): ProfileRecord {
  return {
    userId,
    fullName: '',
    headline: '',
    summary: '',
    contactEmail: '',
    phone: '',
    location: '',
    linkedin: '',
    website: '',
    ...overrides,
    updatedAt,
  };
}

function sanitizeUploadFileName(rawValue: unknown) {
  return String(rawValue ?? 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getPdfBufferOrRespond(req: express.Request, res: express.Response): Buffer | null {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'Expected PDF binary body with content-type application/pdf' });
    return null;
  }
  return req.body;
}

async function tryCompressPdfWithCommand(params: {
  command: string;
  args: string[];
  appendInputOutput?: boolean;
  inputBuffer: Buffer;
}): Promise<Buffer | null> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cvstack-pdf-opt-'));
  const inputPath = path.join(tempDir, 'in.pdf');
  const outputPath = path.join(tempDir, 'out.pdf');

  try {
    await fs.promises.writeFile(inputPath, params.inputBuffer);
    const commandArgs = params.appendInputOutput === false
      ? params.args.map((arg) => arg.replace('{input}', inputPath).replace('{output}', outputPath))
      : [...params.args, inputPath, outputPath];
    await execFileAsync(params.command, commandArgs, {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!fs.existsSync(outputPath)) {
      return null;
    }
    const outputBuffer = await fs.promises.readFile(outputPath);
    return outputBuffer.length > 0 ? outputBuffer : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function optimizePdfBufferForStorage(inputBuffer: Buffer): Promise<CompressionResult> {
  if (inputBuffer.length < MIN_OPTIMIZE_BYTES) {
    return { buffer: inputBuffer, method: 'none' };
  }

  const candidates: CompressionResult[] = [{ buffer: inputBuffer, method: 'none' }];

  const qpdfBuffer = await tryCompressPdfWithCommand({
    command: 'qpdf',
    args: ['--stream-data=compress', '--object-streams=generate'],
    inputBuffer,
  });
  if (qpdfBuffer) {
    candidates.push({ buffer: qpdfBuffer, method: 'qpdf' });
  }

  const gsBuffer = await tryCompressPdfWithCommand({
    command: 'gs',
    args: ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-sOutputFile={output}', '{input}'],
    appendInputOutput: false,
    inputBuffer,
  });
  if (gsBuffer) {
    candidates.push({ buffer: gsBuffer, method: 'ghostscript' });
  }

  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.buffer.length < best.buffer.length) {
      best = candidate;
    }
  }
  return best;
}

async function persistUploadedPdf(originalName: string, originalBuffer: Buffer): Promise<{ storedBytes: number; method: CompressionResult['method']; storagePath: string; provider: 'supabase' | 'local'; bucket?: string; key?: string }> {
  const optimized = await optimizePdfBufferForStorage(originalBuffer);
  const stored = await storeResumePdf(optimized.buffer, originalName);
  return {
    storedBytes: optimized.buffer.length,
    method: optimized.method,
    storagePath: stored.storagePath,
    provider: stored.provider,
    bucket: stored.bucket,
    key: stored.key,
  };
}

async function cleanupExpiredUploadedPdfs() {
  if (!Number.isFinite(UPLOAD_RETENTION_DAYS) || UPLOAD_RETENTION_DAYS <= 0) {
    return;
  }
  const cutoffMs = Date.now() - (UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const toDeletePaths = new Set<string>();
  let expiredUploadCount = 0;

  await withDb(async (db) => {
    for (const resume of db.resumes) {
      if (!resume.filePath) continue;
      if (!path.isAbsolute(resume.filePath)) continue;
      let fileAgeMs = Number.NaN;
      try {
        const stat = fs.statSync(resume.filePath);
        fileAgeMs = stat.mtimeMs;
      } catch {
        // Missing files should be cleared from DB references.
      }
      const referenceTs = Number.isFinite(fileAgeMs) ? fileAgeMs : Date.parse(resume.updatedAt || resume.createdAt);
      if (Number.isFinite(referenceTs) && referenceTs >= cutoffMs) continue;
      toDeletePaths.add(resume.filePath);
      resume.filePath = '';
      resume.fileName = '';
      if (resume.source === 'upload') {
        resume.source = 'manual';
      }
      expiredUploadCount += 1;
    }
  });

  for (const filePath of toDeletePaths) {
    await fs.promises.unlink(filePath).catch(() => {});
  }

  if (expiredUploadCount > 0) {
    console.log(`[uploads] cleaned expired files: ${expiredUploadCount} (retention=${UPLOAD_RETENTION_DAYS}d)`);
  }
}

function startUploadCleanupScheduler() {
  if (!ENABLE_UPLOAD_CLEANUP) {
    console.log('[uploads] cleanup scheduler disabled (set ENABLE_UPLOAD_CLEANUP=1 to enable)');
    return;
  }

  void cleanupExpiredUploadedPdfs().catch((error) => {
    console.warn('[uploads] cleanup run failed', error);
  });
  if (!Number.isFinite(UPLOAD_CLEANUP_INTERVAL_MS) || UPLOAD_CLEANUP_INTERVAL_MS <= 0) {
    return;
  }
  const timer = setInterval(() => {
    void cleanupExpiredUploadedPdfs().catch((error) => {
      console.warn('[uploads] cleanup run failed', error);
    });
  }, UPLOAD_CLEANUP_INTERVAL_MS);
  timer.unref();
}

async function parseUploadOrRespond(buffer: Buffer, res: express.Response, fileName: string) {
  console.log(`[parser] starting parse file="${fileName}" bytes=${buffer.length}`);
  try {
    const parsed = await parseUploadedResumeBuffer(buffer);
    const expCount = Array.isArray((parsed.parsedData as any)?.experiences) ? (parsed.parsedData as any).experiences.length : 0;
    const eduCount = Array.isArray((parsed.parsedData as any)?.education) ? (parsed.parsedData as any).education.length : 0;
    const skillCount = Array.isArray((parsed.parsedData as any)?.skills) ? (parsed.parsedData as any).skills.length : 0;
    console.log(`[parser] parse ok file="${fileName}" extractedChars=${parsed.extractedText.length} warnings=${parsed.warnings.length} experiences=${expCount} education=${eduCount} skills=${skillCount}`);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parser error';
    console.warn(`[parser] parse failed file="${fileName}" detail="${message}"`);
    // Keep upload flow resilient in production: if deterministic structured parser
    // fails, try legacy text extraction + heuristic mapping before falling back to blank.
    try {
      const extracted = await extractTextFromPdfBuffer(buffer);
      const extractedText = String(extracted.text ?? '').trim();
      if (extractedText) {
        const parsedLegacy = parseResumeText(extractedText);
        const data = toResumeDataFromLegacyParser(parsedLegacy);
        const fallbackParsedData = {
          name: parsedLegacy.name || null,
          phone: parsedLegacy.phone || null,
          email: parsedLegacy.email || null,
          linkedin: null,
          website: null,
          country: null,
          currentTitle: data.title || null,
          experiences: (data.workExperience ?? []).map((exp) => ({
            start: { month: exp.startDate?.month ?? null, year: exp.startDate?.year ?? null },
            end: { month: exp.endDate?.month ?? null, year: exp.endDate?.year ?? null },
            isCurrent: Boolean(exp.endDate?.present),
            role: exp.role || null,
            company: exp.company || null,
            description: exp.bullets ?? [],
          })),
          education: (data.education ?? []).map((edu) => ({
            degree: edu.degree || null,
            school: edu.school || null,
            location: edu.location || null,
            start: { month: edu.startDate?.month ?? null, year: edu.startDate?.year ?? null },
            end: { month: edu.endDate?.month ?? null, year: edu.endDate?.year ?? null },
            isCurrent: Boolean(edu.endDate?.present),
          })),
          skills: data.skills ?? [],
        };

        return {
          parsedData: fallbackParsedData,
          warnings: [
            'Primary structured extraction failed; recovered data using compatibility parser.',
            `Parser detail: ${message}`,
            `Fallback extractor: ${extracted.method}`,
          ],
          extractedText: extractedText.slice(0, 5000),
          data,
        };
      }
    } catch {
      // continue to blank fallback
    }

    const blankParsedData = {
      name: null,
      phone: null,
      email: null,
      linkedin: null,
      website: null,
      country: null,
      currentTitle: null,
      experiences: [],
      education: [],
      skills: [],
    };

    return {
      parsedData: blankParsedData,
      warnings: [
        'Structured extraction failed for this PDF; opened editor with a blank master resume.',
        `Parser detail: ${message}`,
      ],
      extractedText: '',
      data: defaultResumeData(),
    };
  }
}

function findOwnedResume(state: { resumes: ResumeRecord[] }, userId: string, resumeId: string) {
  return state.resumes.find((r) => r.id === resumeId && r.userId === userId) ?? null;
}

function sendResumeNotFound(res: express.Response) {
  res.status(404).json({ error: 'Resume not found' });
}

function touchResumeUpdatedAt(db: { resumes: ResumeRecord[] }, resumeId: string, now: string) {
  const parent = db.resumes.find((r) => r.id === resumeId);
  if (parent) parent.updatedAt = now;
}

async function createResumeWithBaseVersion(params: {
  userId: string;
  title: string;
  source: 'manual' | 'upload' | 'linkedin';
  filePath?: string;
  fileName?: string;
  extractedText?: string;
  parsed?: unknown;
  data: ResumeData;
}) {
  const now = new Date().toISOString();
  const resumeId = makeId('res');
  const versionId = makeId('ver');

  const resume: ResumeRecord = {
    id: resumeId,
    userId: params.userId,
    title: params.title,
    source: params.source,
    filePath: params.filePath ?? '',
    fileName: params.fileName ?? '',
    extractedText: params.extractedText ?? '',
    parsed: (params.parsed as any) ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const version: VersionRecord = {
    id: versionId,
    resumeId,
    versionName: 'Master Resume',
    isBase: true,
    isAI: false,
    matchScore: null,
    jobTitle: '',
    jobCompany: '',
    jobDescription: '',
    jobLink: '',
    lastCurationInputHash: '',
    data: params.data,
    aiChanges: [],
    createdAt: now,
    updatedAt: now,
  };

  await withDb(async (db) => {
    // Guest and unauthenticated flows still need a backing user row because
    // Resume/UploadedFile tables enforce user foreign keys.
    if (!db.users.some((u) => u.id === params.userId)) {
      const guestEmail = `${params.userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'guest'}@guest.cvstack.local`;
      db.users.push({
        id: params.userId,
        email: guestEmail,
        passwordHash: 'guest',
        createdAt: now,
      });
      db.profiles.push(makeProfileRecord(params.userId, now, { fullName: 'Guest User' }));
    }
    db.resumes.push(resume);
    db.versions.push(version);
  });

  return { resumeId, versionId };
}

async function parseUploadedResumeBuffer(buffer: Buffer) {
  const parsedPayload = await parseResumePdf(buffer, { debug: true });
  const parsedData = parsedPayload.data;
  const warnings = [...parsedPayload.warnings];

  const structuredExtractedText = [
    parsedData.name,
    parsedData.currentTitle,
    ...(parsedData.experiences ?? []).flatMap((exp) => [exp.role, exp.company, ...exp.description]),
    ...(parsedData.education ?? []).flatMap((edu) => [edu.degree, edu.school]),
    ...(parsedData.skills ?? []),
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const debugExtractedText = (parsedPayload.debug?.lines ?? [])
    .map((line) => line.text)
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const extractedText = (structuredExtractedText || debugExtractedText).slice(0, 5000);

  const data = toResumeDataFromParsedResume(parsedData);
  const inferredSummary = inferResumeSummaryFromDebug(parsedPayload.debug);
  if (inferredSummary) {
    data.bio = inferredSummary.slice(0, 1200);
  }

  // Don't hard-fail upload when structured parsing confidence is low.
  // Let users proceed into manual editing with a warning instead.
  if (!parsedData.name && parsedData.experiences.length === 0 && parsedData.education.length === 0 && parsedData.skills.length === 0) {
    warnings.push('Low-confidence extraction: no structured fields were detected. You can still edit manually.');
    if (!extractedText) {
      warnings.push('Could not extract readable text from this PDF. If this is a scanned file, try OCR first.');
    }
  }

  return {
    parsedData,
    warnings,
    extractedText,
    data,
  };
}

app.post('/api/resumes', async (req, res) => {
  const title = String(req.body?.title ?? 'Master Resume').trim() || 'Master Resume';
  const source = (req.body?.source === 'linkedin' ? 'linkedin' : 'manual') as 'manual' | 'linkedin';
  const email = String(req.body?.email ?? '').trim();
  const data = (req.body?.data as ResumeData | undefined) ?? defaultResumeData(email);

  const created = await createResumeWithBaseVersion({ userId: resolveRequestUserId(req), title, source, data });
  res.status(201).json(created);
});

app.post('/api/resumes/parse', express.raw({ type: 'application/pdf', limit: '15mb' }), async (req, res) => {
  const debug = String(req.query.debug ?? '') === '1';
  const useLlm = String(req.query.llm ?? '') === '1';
  const buffer = getPdfBufferOrRespond(req, res);
  if (!buffer) {
    return;
  }

  const parsed = await parseResumePdf(buffer, { debug, useLlm });
  res.json(parsed);
});

app.post('/api/resumes/upload', express.raw({ type: 'application/pdf', limit: '15mb' }), async (req, res) => {
  const fileName = sanitizeUploadFileName(req.query.filename);
  const title = String(req.query.title ?? 'Imported Resume').trim() || 'Imported Resume';
  const buffer = getPdfBufferOrRespond(req, res);
  if (!buffer) {
    return;
  }

  const parsed = await parseUploadOrRespond(buffer, res, fileName);
  if (!parsed) {
    return;
  }
  const storedFile = await persistUploadedPdf(fileName, buffer);
  if (storedFile.method !== 'none') {
    console.log(`[uploads] optimized ${fileName} via ${storedFile.method} (${buffer.length} -> ${storedFile.storedBytes} bytes)`);
  }

  const created = await createResumeWithBaseVersion({
    userId: resolveRequestUserId(req),
    title,
    source: 'upload',
    filePath: storedFile.storagePath,
    fileName,
    extractedText: parsed.extractedText,
    parsed: parsed.parsedData,
    data: parsed.data,
  });

  res.status(201).json({
    ...created,
    parsed: parsed.parsedData,
    warnings: parsed.warnings,
    extractedTextPreview: parsed.extractedText.slice(0, 1200),
    storage: {
      provider: storedFile.provider,
      bucket: storedFile.bucket ?? null,
      path: storedFile.storagePath,
      key: storedFile.key ?? null,
    },
  });
});

app.get('/api/resumes', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const state = await readDb();
  const resumes = state.resumes
    .filter((r) => r.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => ({ id: r.id, title: r.title, source: r.source, file_name: r.fileName, created_at: r.createdAt, updated_at: r.updatedAt }));
  res.json({ resumes });
});

app.get('/api/resumes/:resumeId', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }
  res.json({ resume });
});

app.get('/api/resumes/:resumeId/pdf', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }
  const pdfAccess = await getResumePdfAccess(resume.filePath, resume.fileName || 'resume.pdf');
  if (!pdfAccess) {
    res.status(404).json({ error: 'Uploaded PDF not found' });
    return;
  }
  if (pdfAccess.kind === 'remote') {
    res.redirect(pdfAccess.signedUrl);
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${resume.fileName || 'resume.pdf'}"`);
  res.sendFile(pdfAccess.filePath);
});

app.post('/api/resumes/:resumeId/upload', express.raw({ type: 'application/pdf', limit: '15mb' }), async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const fileName = sanitizeUploadFileName(req.query.filename);
  const buffer = getPdfBufferOrRespond(req, res);
  if (!buffer) {
    return;
  }

  const state = await readDb();
  const existingResume = findOwnedResume(state, userId, resumeId);
  if (!existingResume) {
    sendResumeNotFound(res);
    return;
  }

  const parsed = await parseUploadOrRespond(buffer, res, fileName);
  if (!parsed) {
    return;
  }

  const storedFile = await persistUploadedPdf(fileName, buffer);
  if (storedFile.method !== 'none') {
    console.log(`[uploads] optimized ${fileName} via ${storedFile.method} (${buffer.length} -> ${storedFile.storedBytes} bytes)`);
  }

  const now = new Date().toISOString();
  let updatedBaseVersion: VersionRecord | null = null;
  let previousPath = '';
  await withDb(async (db) => {
    const resume = db.resumes.find((r) => r.id === resumeId && r.userId === userId);
    if (!resume) return;
    previousPath = resume.filePath;

    resume.source = 'upload';
    resume.filePath = storedFile.storagePath;
    resume.fileName = fileName;
    resume.extractedText = parsed.extractedText;
    resume.parsed = parsed.parsedData as any;
    resume.updatedAt = now;

    const baseVersion = db.versions.find((v) => v.resumeId === resumeId && v.isBase);
    if (baseVersion) {
      baseVersion.data = parsed.data;
      baseVersion.aiChanges = [];
      baseVersion.lastCurationInputHash = '';
      baseVersion.updatedAt = now;
      updatedBaseVersion = baseVersion;
    }

  });

  if (previousPath && previousPath !== storedFile.storagePath) {
    await deleteStoredResumePdf(previousPath);
  }

  if (!updatedBaseVersion) {
    res.status(404).json({ error: 'Base version not found' });
    return;
  }
  const baseVersionToReturn = updatedBaseVersion as VersionRecord;

  res.json({
    resumeId,
    versionId: baseVersionToReturn.id,
    version: versionToDto(baseVersionToReturn),
    parsed: parsed.parsedData,
    warnings: parsed.warnings,
    extractedTextPreview: parsed.extractedText.slice(0, 1200),
    storage: {
      provider: storedFile.provider,
      bucket: storedFile.bucket ?? null,
      path: storedFile.storagePath,
      key: storedFile.key ?? null,
    },
    resume: {
      id: resumeId,
      source: 'upload',
      file_name: fileName,
      updated_at: now,
    },
  });
});

app.patch('/api/resumes/:resumeId', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const title = String(req.body?.title ?? '').trim();
  if (!title) {
    res.status(400).json({ error: 'title is required' });
    return;
  }

  let changed = false;
  await withDb(async (db) => {
    const resume = db.resumes.find((r) => r.id === resumeId && r.userId === userId);
    if (!resume) return;
    resume.title = title;
    resume.updatedAt = new Date().toISOString();
    changed = true;
  });

  if (!changed) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }

  res.json({ ok: true });
});

function versionToDto(v: VersionRecord): ResumeVersionDTO {
  return {
    id: v.id,
    name: v.versionName,
    isBase: v.isBase,
    isAI: v.isAI,
    matchScore: v.matchScore ?? undefined,
    jobTitle: v.jobTitle || undefined,
    jobCompany: v.jobCompany || undefined,
    jobDescription: v.jobDescription || undefined,
    jobLink: v.jobLink || undefined,
    lastCurationInputHash: v.lastCurationInputHash || undefined,
    data: v.data,
    aiChanges: v.aiChanges as any,
  };
}

app.get('/api/resumes/:resumeId/versions', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }

  const versions = state.versions
    .filter((v) => v.resumeId === resumeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(versionToDto);

  res.json({ versions });
});

app.post('/api/resumes/:resumeId/share', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const requestedVersionId = String(req.body?.versionId ?? '').trim();
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }

  const version = requestedVersionId
    ? state.versions.find((v) => v.id === requestedVersionId && v.resumeId === resumeId)
    : state.versions.find((v) => v.resumeId === resumeId && v.isBase);

  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  const token = signShareToken({ resumeId, versionId: version.id });
  res.json({ token, resumeId, versionId: version.id });
});

app.get('/api/public/resume/:token', async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  const decoded = verifyShareToken(token);
  if (!decoded) {
    res.status(404).json({ error: 'Invalid or expired share link' });
    return;
  }

  const state = await readDb();
  const resume = state.resumes.find((r) => r.id === decoded.resumeId);
  const version = state.versions.find((v) => v.id === decoded.versionId && v.resumeId === decoded.resumeId);
  if (!resume || !version) {
    res.status(404).json({ error: 'Shared resume not found' });
    return;
  }

  res.json({
    resume: {
      id: resume.id,
      title: resume.title,
    },
    version: versionToDto(version),
  });
});

app.post('/api/resumes/:resumeId/versions', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }

  const input = req.body as Partial<ResumeVersionDTO>;
  const now = new Date().toISOString();
  const version: VersionRecord = {
    id: makeId('ver'),
    resumeId,
    versionName: input.name ?? 'New Version',
    isBase: Boolean(input.isBase),
    isAI: Boolean(input.isAI),
    matchScore: input.matchScore ?? null,
    jobTitle: input.jobTitle ?? '',
    jobCompany: input.jobCompany ?? '',
    jobDescription: input.jobDescription ?? '',
    jobLink: input.jobLink ?? '',
    lastCurationInputHash: input.lastCurationInputHash ?? '',
    data: (input.data as ResumeData) ?? defaultResumeData(),
    aiChanges: input.aiChanges ?? [],
    createdAt: now,
    updatedAt: now,
  };

  const created = await createVersionRecord({
    id: version.id,
    resumeId,
    content: {
      versionName: version.versionName,
      isBase: version.isBase,
      isAI: version.isAI,
      matchScore: version.matchScore,
      jobTitle: version.jobTitle,
      jobCompany: version.jobCompany,
      jobDescription: version.jobDescription,
      jobLink: version.jobLink,
      lastCurationInputHash: version.lastCurationInputHash,
      data: version.data,
      aiChanges: version.aiChanges,
    },
    createdAt: now,
    updatedAt: now,
  });

  res.status(201).json({ version: versionToDto(created) });
});

app.patch('/api/resumes/:resumeId/versions/:versionId', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const versionId = String(req.params.versionId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }

  const input = req.body as Partial<ResumeVersionDTO>;
  const now = new Date().toISOString();
  const existing = state.versions.find((v) => v.id === versionId && v.resumeId === resumeId);
  if (!existing) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }
  const updated = await patchVersionRecord({
    versionId,
    resumeId,
    content: {
      versionName: input.name ?? existing.versionName,
      isBase: existing.isBase,
      isAI: input.isAI ?? existing.isAI,
      matchScore: input.matchScore ?? existing.matchScore,
      jobTitle: input.jobTitle ?? existing.jobTitle,
      jobCompany: input.jobCompany ?? existing.jobCompany,
      jobDescription: input.jobDescription ?? existing.jobDescription,
      jobLink: input.jobLink ?? existing.jobLink,
      lastCurationInputHash: input.lastCurationInputHash ?? existing.lastCurationInputHash,
      data: (input.data as ResumeData) ?? existing.data,
      aiChanges: input.aiChanges ?? existing.aiChanges,
    },
    updatedAt: now,
  });

  if (!updated) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  res.json({ version: versionToDto(updated) });
});

app.delete('/api/resumes/:resumeId/versions/:versionId', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const versionId = String(req.params.versionId);
  const state = await readDb();
  const resume = findOwnedResume(state, userId, resumeId);
  if (!resume) {
    sendResumeNotFound(res);
    return;
  }

  let removed = false;
  const now = new Date().toISOString();
  await withDb(async (db) => {
    const version = db.versions.find((v) => v.id === versionId && v.resumeId === resumeId);
    if (!version || version.isBase) return;
    db.versions = db.versions.filter((v) => !(v.id === versionId && v.resumeId === resumeId));
    touchResumeUpdatedAt(db, resumeId, now);
    removed = true;
  });

  if (!removed) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  res.json({ ok: true });
});

app.post('/api/dev/seed', async (req, res) => {
  if (process.env.ENABLE_DEV_SEED !== 'true') {
    res.status(403).json({ error: 'Dev seed disabled' });
    return;
  }

  const email = String(req.body?.email ?? 'demo@cvstack.dev').trim().toLowerCase();
  const password = String(req.body?.password ?? 'demo12345');

  const state = await readDb();
  if (state.users.some((u) => u.email === email)) {
    res.json({ ok: true, note: 'User already exists' });
    return;
  }

  const userId = makeId('usr');
  const now = new Date().toISOString();
  const user: UserRecord = { id: userId, email, passwordHash: hashPassword(password), createdAt: now };
  const profile = makeProfileRecord(userId, now, { fullName: 'Demo User', contactEmail: email });

  const baseData = defaultResumeData(email);
  baseData.name = 'Demo User';
  baseData.title = 'Product Designer';
  baseData.bio = 'Demo profile imported for quick testing.';
  baseData.skills = ['Figma', 'React', 'UX Research'];

  const created = await createResumeWithBaseVersion({
    userId,
    title: 'Demo Resume',
    source: 'manual',
    data: baseData,
  });

  await withDb(async (db) => {
    db.users.push(user);
    db.profiles.push(profile);
  });

  res.json({ ok: true, credentials: { email, password }, created });
});

app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = Number(error?.statusCode ?? error?.status ?? 500);
  const requestId = makeId('err');
  const detail = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  console.error(`[api-error][${requestId}] ${req.method} ${req.originalUrl} status=${status} detail="${detail}"`);
  res.status(Number.isFinite(status) && status >= 400 ? status : 500).json({
    error: status >= 500 ? 'Internal server error' : detail,
    detail,
    requestId,
  });
});

async function bootstrap() {
  await initDb();
  startUploadCleanupScheduler();
  app.listen(PORT, () => {
    console.log(`CVStack API listening on http://localhost:${PORT}`);
  });
}

void bootstrap().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[bootstrap] failed: ${detail}`);
  process.exit(1);
});
