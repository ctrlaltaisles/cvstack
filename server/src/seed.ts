import { defaultResumeData } from './defaults';
import { hashPassword, makeId } from './auth';
import { readDb, withDb, type ProfileRecord, type UserRecord, type ResumeRecord, type VersionRecord } from './db';

async function run() {
  const email = process.env.SEED_EMAIL ?? 'demo@cvstack.dev';
  const password = process.env.SEED_PASSWORD ?? 'demo12345';
  const now = new Date().toISOString();

  const state = await readDb();
  if (state.users.some((u) => u.email === email)) {
    console.log('Seed skipped: user already exists', email);
    return;
  }

  const userId = makeId('usr');
  const resumeId = makeId('res');
  const versionId = makeId('ver');

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

  const data = defaultResumeData(email);
  data.name = 'Demo User';
  data.title = 'Product Designer';
  data.bio = 'Demo user seeded via script.';

  const resume: ResumeRecord = {
    id: resumeId,
    userId,
    title: 'Demo Resume',
    source: 'manual',
    filePath: '',
    fileName: '',
    extractedText: '',
    parsed: null,
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
    shareSlug: '',
    data,
    aiChanges: [],
    createdAt: now,
    updatedAt: now,
  };

  await withDb(async (db) => {
    db.users.push(user);
    db.profiles.push(profile);
    db.resumes.push(resume);
    db.versions.push(version);
  });

  console.log('Seed complete:', { email, password });
}

void run();
