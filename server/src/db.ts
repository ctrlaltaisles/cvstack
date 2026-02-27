import type { ParsedResume, ResumeData } from './types';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface ProfileRecord {
  userId: string;
  fullName: string;
  headline: string;
  summary: string;
  contactEmail: string;
  phone: string;
  location: string;
  linkedin: string;
  website: string;
  updatedAt: string;
}

export interface ResumeRecord {
  id: string;
  userId: string;
  title: string;
  source: 'manual' | 'upload' | 'linkedin';
  filePath: string;
  fileName: string;
  extractedText: string;
  parsed: ParsedResume | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: string;
  resumeId: string;
  versionName: string;
  isBase: boolean;
  isAI: boolean;
  matchScore: number | null;
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  jobLink: string;
  lastCurationInputHash: string;
  data: ResumeData;
  aiChanges: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface DbState {
  users: UserRecord[];
  profiles: ProfileRecord[];
  resumes: ResumeRecord[];
  versions: VersionRecord[];
}

let prismaSingleton: any = null;
let dbMutationQueue: Promise<unknown> = Promise.resolve();

async function getPrisma() {
  if (prismaSingleton) return prismaSingleton;

  const prismaModule = await new Function('m', 'return import(m)')('@prisma/client').catch(() => {
    throw new Error('Prisma client not available. Run `npm install` in /server and `npm run prisma:generate`.');
  });

  const PrismaClientCtor = (prismaModule as any).PrismaClient;
  prismaSingleton = new PrismaClientCtor();
  return prismaSingleton;
}

function parseResumeMeta(meta: any) {
  const source = (meta?.source ?? 'manual') as 'manual' | 'upload' | 'linkedin';
  const parsed = (meta?.parsed ?? null) as ParsedResume | null;
  return { source, parsed };
}

function versionFromContent(resumeId: string, id: string, createdAt: Date, updatedAt: Date, content: any): VersionRecord {
  return {
    id,
    resumeId,
    versionName: String(content?.versionName ?? content?.name ?? 'Base Resume'),
    isBase: Boolean(content?.isBase),
    isAI: Boolean(content?.isAI),
    matchScore: typeof content?.matchScore === 'number' ? content.matchScore : null,
    jobTitle: String(content?.jobTitle ?? ''),
    jobCompany: String(content?.jobCompany ?? ''),
    jobDescription: String(content?.jobDescription ?? ''),
    jobLink: String(content?.jobLink ?? ''),
    lastCurationInputHash: String(content?.lastCurationInputHash ?? ''),
    data: (content?.data ?? {}) as ResumeData,
    aiChanges: (content?.aiChanges ?? []) as unknown[],
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export async function initDb() {
  const prisma = await getPrisma();
  await prisma.$queryRawUnsafe('SELECT 1');
}

export async function readDb(): Promise<DbState> {
  const prisma = await getPrisma();

  const [users, profiles, resumes, versions, uploads] = await Promise.all([
    prisma.user.findMany(),
    prisma.profile.findMany(),
    prisma.resume.findMany(),
    prisma.resumeVersion.findMany(),
    prisma.uploadedFile.findMany({ orderBy: { createdAt: 'desc' } }),
  ]);

  const latestUploadByResumeId = new Map<string, any>();
  for (const upload of uploads) {
    if (upload.resumeId && !latestUploadByResumeId.has(upload.resumeId)) {
      latestUploadByResumeId.set(upload.resumeId, upload);
    }
  }

  return {
    users: users.map((u: any) => ({
      id: u.id,
      email: u.email,
      passwordHash: u.passwordHash,
      createdAt: new Date(u.createdAt).toISOString(),
    })),
    profiles: profiles.map((p: any) => ({
      userId: p.userId,
      fullName: p.name ?? '',
      headline: p.headline ?? '',
      summary: p.summary ?? '',
      contactEmail: String(p.detailsJson?.contactEmail ?? ''),
      phone: String(p.detailsJson?.phone ?? ''),
      location: String(p.detailsJson?.location ?? ''),
      linkedin: String(p.detailsJson?.linkedin ?? ''),
      website: String(p.detailsJson?.website ?? ''),
      updatedAt: new Date(p.updatedAt).toISOString(),
    })),
    resumes: resumes.map((r: any) => {
      const upload = latestUploadByResumeId.get(r.id);
      const { source, parsed } = parseResumeMeta(r.metaJson);
      return {
        id: r.id,
        userId: r.userId,
        title: r.title,
        source,
        filePath: upload?.storagePath ?? '',
        fileName: upload?.originalName ?? '',
        extractedText: upload?.extractedText ?? '',
        parsed,
        createdAt: new Date(r.createdAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString(),
      } as ResumeRecord;
    }),
    versions: versions.map((v: any) => versionFromContent(v.resumeId, v.id, v.createdAt, v.updatedAt, v.contentJson)),
  };
}

export async function writeDb(state: DbState): Promise<void> {
  const prisma = await getPrisma();

  await prisma.$transaction(async (tx: any) => {
    await tx.uploadedFile.deleteMany();
    await tx.resumeVersion.deleteMany();
    await tx.profile.deleteMany();
    await tx.resume.deleteMany();
    await tx.user.deleteMany();

    if (state.users.length > 0) {
      await tx.user.createMany({
        data: state.users.map((u) => ({
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          createdAt: new Date(u.createdAt),
        })),
      });
    }

    for (const profile of state.profiles) {
      await tx.profile.create({
        data: {
          id: `prf_${profile.userId}`,
          userId: profile.userId,
          name: profile.fullName,
          headline: profile.headline,
          summary: profile.summary,
          detailsJson: {
            contactEmail: profile.contactEmail,
            phone: profile.phone,
            location: profile.location,
            linkedin: profile.linkedin,
            website: profile.website,
          },
          updatedAt: new Date(profile.updatedAt),
        },
      });
    }

    if (state.resumes.length > 0) {
      await tx.resume.createMany({
        data: state.resumes.map((r) => ({
          id: r.id,
          userId: r.userId,
          title: r.title,
          metaJson: {
            source: r.source,
            parsed: r.parsed,
          },
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        })),
      });
    }

    for (const resume of state.resumes) {
      if (!resume.filePath && !resume.fileName) continue;
      await tx.uploadedFile.create({
        data: {
          id: `upl_${resume.id}`,
          userId: resume.userId,
          resumeId: resume.id,
          originalName: resume.fileName || 'resume.pdf',
          mimeType: 'application/pdf',
          size: 0,
          storagePath: resume.filePath || '',
          extractedText: resume.extractedText || null,
          createdAt: new Date(resume.createdAt),
        },
      });
    }

    const groupedByResume = new Map<string, VersionRecord[]>();
    for (const version of state.versions) {
      const list = groupedByResume.get(version.resumeId) ?? [];
      list.push(version);
      groupedByResume.set(version.resumeId, list);
    }

    for (const [resumeId, list] of groupedByResume) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let versionNumber = 1;
      for (const version of list) {
        await tx.resumeVersion.create({
          data: {
            id: version.id,
            resumeId,
            versionNumber,
            contentJson: {
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
            createdAt: new Date(version.createdAt),
            updatedAt: new Date(version.updatedAt),
          },
        });
        versionNumber += 1;
      }
    }
  });
}

export async function withDb<T>(fn: (state: DbState) => Promise<T> | T): Promise<T> {
  const runMutation = async (): Promise<T> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const state = await readDb();
        const result = await fn(state);
        await writeDb(state);
        return result;
      } catch (error) {
        lastError = error;
        const code = String((error as { code?: string } | undefined)?.code ?? '');
        const message = String((error as { message?: string } | undefined)?.message ?? '');
        const retryable = code === 'P2028' || /Transaction API error|Transaction not found/i.test(message);
        if (!retryable || attempt >= 3) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 75 * attempt));
      }
    }
    throw lastError;
  };

  const queued = dbMutationQueue.then(runMutation, runMutation) as Promise<T>;
  dbMutationQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function mapVersionContent(content: any) {
  return {
    versionName: String(content?.versionName ?? content?.name ?? 'Base Resume'),
    isBase: Boolean(content?.isBase),
    isAI: Boolean(content?.isAI),
    matchScore: typeof content?.matchScore === 'number' ? content.matchScore : null,
    jobTitle: String(content?.jobTitle ?? ''),
    jobCompany: String(content?.jobCompany ?? ''),
    jobDescription: String(content?.jobDescription ?? ''),
    jobLink: String(content?.jobLink ?? ''),
    lastCurationInputHash: String(content?.lastCurationInputHash ?? ''),
    data: (content?.data ?? {}) as ResumeData,
    aiChanges: (content?.aiChanges ?? []) as unknown[],
  };
}

export async function createVersionRecord(params: {
  id: string;
  resumeId: string;
  content: any;
  createdAt: string;
  updatedAt: string;
}): Promise<VersionRecord> {
  const prisma = await getPrisma();
  const normalized = mapVersionContent(params.content);
  const createdAt = new Date(params.createdAt);
  const updatedAt = new Date(params.updatedAt);

  const created = await prisma.$transaction(async (tx: any) => {
    const latest = await tx.resumeVersion.aggregate({
      where: { resumeId: params.resumeId },
      _max: { versionNumber: true },
    });
    const nextVersionNumber = Number(latest?._max?.versionNumber ?? 0) + 1;

    const row = await tx.resumeVersion.create({
      data: {
        id: params.id,
        resumeId: params.resumeId,
        versionNumber: nextVersionNumber,
        contentJson: normalized,
        createdAt,
        updatedAt,
      },
    });

    await tx.resume.update({
      where: { id: params.resumeId },
      data: { updatedAt },
    });

    return row;
  });

  return versionFromContent(created.resumeId, created.id, created.createdAt, created.updatedAt, created.contentJson);
}

export async function patchVersionRecord(params: {
  versionId: string;
  resumeId: string;
  content: any;
  updatedAt: string;
}): Promise<VersionRecord | null> {
  const prisma = await getPrisma();
  const updatedAt = new Date(params.updatedAt);
  const normalized = mapVersionContent(params.content);

  const updated = await prisma.$transaction(async (tx: any) => {
    const existing = await tx.resumeVersion.findFirst({
      where: { id: params.versionId, resumeId: params.resumeId },
    });
    if (!existing) return null;

    const row = await tx.resumeVersion.update({
      where: { id: params.versionId },
      data: {
        contentJson: normalized,
        updatedAt,
      },
    });

    await tx.resume.update({
      where: { id: params.resumeId },
      data: { updatedAt },
    });

    return row;
  });

  if (!updated) return null;
  return versionFromContent(updated.resumeId, updated.id, updated.createdAt, updated.updatedAt, updated.contentJson);
}
