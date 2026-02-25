import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const sourcePath = path.resolve(process.cwd(), process.env.DB_FILE ?? 'data/db.json');
  if (!fs.existsSync(sourcePath)) {
    console.log(`No JSON source found at ${sourcePath}. Nothing to migrate.`);
    return;
  }

  const prismaModule = await new Function('m', 'return import(m)')('@prisma/client').catch(() => {
    throw new Error('Prisma client not available. Run `npm install` and `npm run prisma:generate`.');
  });
  const PrismaClient = (prismaModule as any).PrismaClient;
  const prisma = new PrismaClient();

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const state = JSON.parse(raw) as {
    users: Array<{ id: string; email: string; passwordHash: string; createdAt: string }>;
    profiles: Array<{ userId: string; fullName: string; headline: string; summary: string; contactEmail: string; phone: string; location: string; linkedin: string; website: string; updatedAt: string }>;
    resumes: Array<{ id: string; userId: string; title: string; source: 'manual' | 'upload' | 'linkedin'; filePath: string; fileName: string; extractedText: string; parsed: unknown; createdAt: string; updatedAt: string }>;
    versions: Array<{ id: string; resumeId: string; versionName: string; isBase: boolean; isAI: boolean; matchScore: number | null; jobTitle: string; jobCompany: string; jobDescription: string; jobLink: string; data: unknown; aiChanges: unknown[]; createdAt: string; updatedAt: string }>;
  };

  let usersInserted = 0;
  let profilesInserted = 0;
  let resumesInserted = 0;
  let versionsInserted = 0;
  let filesInserted = 0;

  for (const u of state.users ?? []) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash: u.passwordHash, createdAt: new Date(u.createdAt) },
      create: { id: u.id, email: u.email, passwordHash: u.passwordHash, createdAt: new Date(u.createdAt) },
    });
    usersInserted += 1;
  }

  for (const p of state.profiles ?? []) {
    await prisma.profile.upsert({
      where: { userId: p.userId },
      update: {
        name: p.fullName,
        headline: p.headline,
        summary: p.summary,
        detailsJson: {
          contactEmail: p.contactEmail,
          phone: p.phone,
          location: p.location,
          linkedin: p.linkedin,
          website: p.website,
        },
        updatedAt: new Date(p.updatedAt),
      },
      create: {
        id: `prf_${p.userId}`,
        userId: p.userId,
        name: p.fullName,
        headline: p.headline,
        summary: p.summary,
        detailsJson: {
          contactEmail: p.contactEmail,
          phone: p.phone,
          location: p.location,
          linkedin: p.linkedin,
          website: p.website,
        },
        updatedAt: new Date(p.updatedAt),
      },
    });
    profilesInserted += 1;
  }

  for (const r of state.resumes ?? []) {
    await prisma.resume.upsert({
      where: { id: r.id },
      update: {
        userId: r.userId,
        title: r.title,
        metaJson: { source: r.source, parsed: r.parsed ?? null },
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      },
      create: {
        id: r.id,
        userId: r.userId,
        title: r.title,
        metaJson: { source: r.source, parsed: r.parsed ?? null },
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      },
    });
    resumesInserted += 1;

    if (r.filePath || r.fileName || r.extractedText) {
      await prisma.uploadedFile.upsert({
        where: { id: `upl_${r.id}` },
        update: {
          userId: r.userId,
          resumeId: r.id,
          originalName: r.fileName || 'resume.pdf',
          mimeType: 'application/pdf',
          size: 0,
          storagePath: r.filePath || '',
          extractedText: r.extractedText || null,
          createdAt: new Date(r.createdAt),
        },
        create: {
          id: `upl_${r.id}`,
          userId: r.userId,
          resumeId: r.id,
          originalName: r.fileName || 'resume.pdf',
          mimeType: 'application/pdf',
          size: 0,
          storagePath: r.filePath || '',
          extractedText: r.extractedText || null,
          createdAt: new Date(r.createdAt),
        },
      });
      filesInserted += 1;
    }
  }

  const grouped = new Map<string, typeof state.versions>();
  for (const v of state.versions ?? []) {
    const list = grouped.get(v.resumeId) ?? [];
    list.push(v);
    grouped.set(v.resumeId, list);
  }

  for (const [resumeId, versions] of grouped.entries()) {
    versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let versionNumber = 1;
    for (const v of versions) {
      await prisma.resumeVersion.upsert({
        where: { id: v.id },
        update: {
          resumeId,
          versionNumber,
          contentJson: {
            versionName: v.versionName,
            isBase: v.isBase,
            isAI: v.isAI,
            matchScore: v.matchScore,
            jobTitle: v.jobTitle,
            jobCompany: v.jobCompany,
            jobDescription: v.jobDescription,
            jobLink: v.jobLink,
            data: v.data,
            aiChanges: v.aiChanges,
          },
          createdAt: new Date(v.createdAt),
          updatedAt: new Date(v.updatedAt),
        },
        create: {
          id: v.id,
          resumeId,
          versionNumber,
          contentJson: {
            versionName: v.versionName,
            isBase: v.isBase,
            isAI: v.isAI,
            matchScore: v.matchScore,
            jobTitle: v.jobTitle,
            jobCompany: v.jobCompany,
            jobDescription: v.jobDescription,
            jobLink: v.jobLink,
            data: v.data,
            aiChanges: v.aiChanges,
          },
          createdAt: new Date(v.createdAt),
          updatedAt: new Date(v.updatedAt),
        },
      });
      versionsInserted += 1;
      versionNumber += 1;
    }
  }

  await prisma.$disconnect();
  console.log('JSON -> Postgres migration completed');
  console.log({ usersInserted, profilesInserted, resumesInserted, versionsInserted, filesInserted });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
