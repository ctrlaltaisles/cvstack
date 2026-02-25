import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { AuthedRequest, GUEST_USER_ID, getUserIdFromAuthHeader, hashPassword, makeId, requireAuth, signToken, verifyPassword } from './auth';
import { defaultResumeData } from './defaults';
import { initDb, readDb, withDb, type ProfileRecord, type ResumeRecord, type UserRecord, type VersionRecord } from './db';
import type { ResumeData, ResumeVersionDTO } from './types';
import { inferResumeSummaryFromDebug, parseResumePdf, toResumeDataFromParsedResume } from './resumeParse/parseResumePdf';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const uploadsDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',').map((v) => v.trim()) || true }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
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
  const profile: ProfileRecord = {
    userId,
    fullName,
    headline: '',
    summary: '',
    contactEmail: email,
    phone: '',
    location: '',
    linkedin: '',
    website: '',
    updatedAt: now,
  };

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
    versionName: 'Base Resume',
    isBase: true,
    isAI: false,
    matchScore: null,
    jobTitle: '',
    jobCompany: '',
    jobDescription: '',
    jobLink: '',
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
      db.profiles.push({
        userId: params.userId,
        fullName: 'Guest User',
        headline: '',
        summary: '',
        contactEmail: '',
        phone: '',
        location: '',
        linkedin: '',
        website: '',
        updatedAt: now,
      });
    }
    db.resumes.push(resume);
    db.versions.push(version);
  });

  return { resumeId, versionId };
}

app.post('/api/resumes', async (req, res) => {
  const title = String(req.body?.title ?? 'Base Resume').trim() || 'Base Resume';
  const source = (req.body?.source === 'linkedin' ? 'linkedin' : 'manual') as 'manual' | 'linkedin';
  const email = String(req.body?.email ?? '').trim();
  const data = (req.body?.data as ResumeData | undefined) ?? defaultResumeData(email);

  const created = await createResumeWithBaseVersion({ userId: resolveRequestUserId(req), title, source, data });
  res.status(201).json(created);
});

app.post('/api/resumes/parse', express.raw({ type: 'application/pdf', limit: '15mb' }), async (req, res) => {
  const debug = String(req.query.debug ?? '') === '1';
  const useLlm = String(req.query.llm ?? '') === '1';
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'Expected PDF binary body with content-type application/pdf' });
    return;
  }

  const parsed = await parseResumePdf(req.body, { debug, useLlm });
  res.json(parsed);
});

app.post('/api/resumes/upload', express.raw({ type: 'application/pdf', limit: '15mb' }), async (req, res) => {
  const fileName = String(req.query.filename ?? 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const title = String(req.query.title ?? 'Imported Resume').trim() || 'Imported Resume';

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'Expected PDF binary body with content-type application/pdf' });
    return;
  }

  const uploadName = `${Date.now()}_${fileName}`;
  const filePath = path.join(uploadsDir, uploadName);
  fs.writeFileSync(filePath, req.body);

  const parsedPayload = await parseResumePdf(req.body, { debug: true });
  const extractedText = [
    parsedPayload.data.name,
    parsedPayload.data.currentTitle,
    ...(parsedPayload.data.experiences ?? []).flatMap((exp) => [exp.role, exp.company, ...exp.description]),
    ...(parsedPayload.data.education ?? []).flatMap((edu) => [edu.degree, edu.school]),
    ...(parsedPayload.data.skills ?? []),
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .slice(0, 5000);

  if (!parsedPayload.data.name && parsedPayload.data.experiences.length === 0 && parsedPayload.data.education.length === 0 && parsedPayload.data.skills.length === 0) {
    res.status(422).json({ error: 'PDF text extraction failed; try a text-based PDF' });
    return;
  }

  const data = toResumeDataFromParsedResume(parsedPayload.data);
  const inferredSummary = inferResumeSummaryFromDebug(parsedPayload.debug);
  if (inferredSummary) {
    data.bio = inferredSummary.slice(0, 1200);
  }

  const created = await createResumeWithBaseVersion({
    userId: resolveRequestUserId(req),
    title,
    source: 'upload',
    filePath,
    fileName,
    extractedText,
    parsed: parsedPayload.data,
    data,
  });

  res.status(201).json({ ...created, parsed: parsedPayload.data, warnings: parsedPayload.warnings, extractedTextPreview: extractedText.slice(0, 1200) });
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
  const resume = state.resumes.find((r) => r.id === resumeId && r.userId === userId);
  if (!resume) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }
  res.json({ resume });
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
    data: v.data,
    aiChanges: v.aiChanges as any,
  };
}

app.get('/api/resumes/:resumeId/versions', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = state.resumes.find((r) => r.id === resumeId && r.userId === userId);
  if (!resume) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }

  const versions = state.versions
    .filter((v) => v.resumeId === resumeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(versionToDto);

  res.json({ versions });
});

app.post('/api/resumes/:resumeId/versions', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const state = await readDb();
  const resume = state.resumes.find((r) => r.id === resumeId && r.userId === userId);
  if (!resume) {
    res.status(404).json({ error: 'Resume not found' });
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
    data: (input.data as ResumeData) ?? defaultResumeData(),
    aiChanges: input.aiChanges ?? [],
    createdAt: now,
    updatedAt: now,
  };

  await withDb(async (db) => {
    db.versions.push(version);
    const parent = db.resumes.find((r) => r.id === resumeId);
    if (parent) parent.updatedAt = now;
  });

  res.status(201).json({ version: versionToDto(version) });
});

app.patch('/api/resumes/:resumeId/versions/:versionId', async (req, res) => {
  const userId = resolveRequestUserId(req);
  const resumeId = String(req.params.resumeId);
  const versionId = String(req.params.versionId);
  const state = await readDb();
  const resume = state.resumes.find((r) => r.id === resumeId && r.userId === userId);
  if (!resume) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }

  let updated: VersionRecord | null = null;
  const input = req.body as Partial<ResumeVersionDTO>;
  const now = new Date().toISOString();

  await withDb(async (db) => {
    const version = db.versions.find((v) => v.id === versionId && v.resumeId === resumeId);
    if (!version) return;

    version.versionName = input.name ?? version.versionName;
    version.isAI = input.isAI ?? version.isAI;
    version.matchScore = input.matchScore ?? version.matchScore;
    version.jobTitle = input.jobTitle ?? version.jobTitle;
    version.jobCompany = input.jobCompany ?? version.jobCompany;
    version.jobDescription = input.jobDescription ?? version.jobDescription;
    version.jobLink = input.jobLink ?? version.jobLink;
    version.data = (input.data as ResumeData) ?? version.data;
    version.aiChanges = input.aiChanges ?? version.aiChanges;
    version.updatedAt = now;

    const parent = db.resumes.find((r) => r.id === resumeId);
    if (parent) parent.updatedAt = now;

    updated = version;
  });

  if (!updated) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  res.json({ version: versionToDto(updated) });
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
  const profile: ProfileRecord = {
    userId,
    fullName: 'Demo User',
    headline: '',
    summary: '',
    contactEmail: email,
    phone: '',
    location: '',
    linkedin: '',
    website: '',
    updatedAt: now,
  };

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

async function bootstrap() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`CVStack API listening on http://localhost:${PORT}`);
  });
}

void bootstrap();
