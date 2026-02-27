import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type StoredPdf = {
  storagePath: string;
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
    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }
    return { storagePath: key };
  }

  fs.mkdirSync(uploadsDir, { recursive: true });
  const safeName = String(originalName || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const localPath = path.join(uploadsDir, `${Date.now()}_${safeName}`);
  fs.writeFileSync(localPath, fileBuffer);
  return { storagePath: localPath };
}

export async function getResumePdfAccess(storagePath: string, downloadName: string): Promise<PdfAccess | null> {
  if (!storagePath) return null;

  const supabase = getSupabaseClient();
  if (supabase && !path.isAbsolute(storagePath)) {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(storagePath, 60 * 5, { download: downloadName || 'resume.pdf' });
    if (error || !data?.signedUrl) {
      return null;
    }
    return { kind: 'remote', signedUrl: data.signedUrl };
  }

  if (!fs.existsSync(storagePath)) return null;
  return { kind: 'local', filePath: path.resolve(storagePath) };
}

export async function deleteStoredResumePdf(storagePath: string) {
  if (!storagePath) return;

  const supabase = getSupabaseClient();
  if (supabase && !path.isAbsolute(storagePath)) {
    await supabase.storage.from(SUPABASE_BUCKET).remove([storagePath]);
    return;
  }

  if (fs.existsSync(storagePath)) {
    fs.unlink(storagePath, () => {});
  }
}
