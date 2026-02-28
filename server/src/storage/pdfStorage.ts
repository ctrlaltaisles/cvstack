import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type StoredPdf = {
  storagePath: string;
  provider: 'supabase' | 'local';
  bucket?: string;
  key?: string;
};

type PdfAccess =
  | { kind: 'local'; filePath: string }
  | { kind: 'remote'; signedUrl: string };

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const SUPABASE_BUCKET = (process.env.SUPABASE_BUCKET ?? process.env.SUPABASE_STORAGE_BUCKET ?? 'resumes').trim() || 'resumes';
const uploadsDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');

let supabaseClient: ReturnType<typeof createClient> | null = null;

function isSupabaseStorageConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseClient() {
  if (!isSupabaseStorageConfigured()) return null;
  if (supabaseClient) return supabaseClient;
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return supabaseClient;
}

function buildSupabaseUri(bucket: string, key: string) {
  return `supabase://${bucket}/${key}`;
}

function parseSupabaseUri(storagePath: string): { bucket: string; key: string } | null {
  if (!storagePath.startsWith('supabase://')) return null;
  const withoutScheme = storagePath.slice('supabase://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex <= 0) return null;
  const bucket = withoutScheme.slice(0, slashIndex).trim();
  const key = withoutScheme.slice(slashIndex + 1).trim();
  if (!bucket || !key) return null;
  return { bucket, key };
}

function getLegacyBucketCandidates() {
  const ordered = [SUPABASE_BUCKET, 'uploads', 'resumes'];
  const uniq = new Set<string>();
  for (const bucket of ordered) {
    const trimmed = String(bucket || '').trim();
    if (trimmed) uniq.add(trimmed);
  }
  return Array.from(uniq);
}

function getFileExtension(name: string) {
  const ext = name.split('.').pop()?.trim().toLowerCase();
  if (!ext || !/^[a-z0-9]+$/.test(ext)) return 'pdf';
  return ext;
}

export async function storeResumePdf(fileBuffer: Buffer, originalName: string): Promise<StoredPdf> {
  const supabase = getSupabaseClient();
  if (supabase) {
    const key = `resumes/${Date.now()}-${crypto.randomUUID()}.${getFileExtension(originalName)}`;
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(key, fileBuffer, { contentType: 'application/pdf', upsert: false });
    if (!error) {
      return {
        storagePath: buildSupabaseUri(SUPABASE_BUCKET, key),
        provider: 'supabase',
        bucket: SUPABASE_BUCKET,
        key,
      };
    }
    // Keep resume import resilient when remote storage rejects a file.
    // Fallback to local storage rather than failing the upload flow.
    console.warn(`[uploads] Supabase upload failed (${error.message}); falling back to local storage.`);
  }

  fs.mkdirSync(uploadsDir, { recursive: true });
  const safeName = String(originalName || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = path.join(uploadsDir, `${Date.now()}_${safeName}`);
  fs.writeFileSync(localPath, fileBuffer);
  return { storagePath: localPath, provider: 'local' };
}

export async function getResumePdfAccess(storagePath: string, downloadName: string): Promise<PdfAccess | null> {
  if (!storagePath) return null;

  const supabase = getSupabaseClient();
  const supabaseUri = parseSupabaseUri(storagePath);
  if (supabase && supabaseUri) {
    const { data, error } = await supabase.storage
      .from(supabaseUri.bucket)
      .createSignedUrl(supabaseUri.key, 60 * 5, { download: downloadName || 'resume.pdf' });
    if (error || !data?.signedUrl) {
      return null;
    }
    return { kind: 'remote', signedUrl: data.signedUrl };
  }

  // Legacy storage format: plain object key without supabase://bucket prefix.
  if (supabase && !path.isAbsolute(storagePath)) {
    for (const bucket of getLegacyBucketCandidates()) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, 60 * 5, { download: downloadName || 'resume.pdf' });
      if (!error && data?.signedUrl) {
        return { kind: 'remote', signedUrl: data.signedUrl };
      }
    }
    return null;
  }

  if (!fs.existsSync(storagePath)) return null;
  return { kind: 'local', filePath: path.resolve(storagePath) };
}

export async function deleteStoredResumePdf(storagePath: string) {
  if (!storagePath) return;

  const supabase = getSupabaseClient();
  const supabaseUri = parseSupabaseUri(storagePath);
  if (supabase && supabaseUri) {
    await supabase.storage.from(supabaseUri.bucket).remove([supabaseUri.key]);
    return;
  }
  if (supabase && !path.isAbsolute(storagePath)) {
    // Legacy storage format fallback.
    for (const bucket of getLegacyBucketCandidates()) {
      await supabase.storage.from(bucket).remove([storagePath]);
    }
    return;
  }

  if (fs.existsSync(storagePath)) {
    fs.unlink(storagePath, () => {});
  }
}

export function getStorageDiagnostics() {
  return {
    provider: isSupabaseStorageConfigured() ? 'supabase' : 'local',
    bucket: SUPABASE_BUCKET,
    configured: isSupabaseStorageConfigured(),
  };
}
