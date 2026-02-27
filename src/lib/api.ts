function resolveApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (envBase) return envBase;

  // In deployed environments, default to same-origin API routes.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      return '';
    }
  }

  // Local development fallback when frontend and API run separately.
  return 'http://localhost:4000';
}

const API_BASE = resolveApiBase();
const TOKEN_KEY = 'cvstack_token';
const USER_KEY = 'cvstack_user';
const GUEST_KEY = 'cvstack_guest_id';
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';

export interface StoredUser {
  id: string;
  email: string;
  fullName: string;
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export const userStore = {
  get: (): StoredUser | null => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredUser;
    } catch {
      return null;
    }
  },
  set: (user: StoredUser) => localStorage.setItem(USER_KEY, JSON.stringify(user)),
  clear: () => localStorage.removeItem(USER_KEY),
};

export function clearAuthStorage() {
  tokenStore.clear();
  userStore.clear();
}

export type OAuthProvider = 'google' | 'github' | 'linkedin_oidc';

function getSupabaseAuthBase() {
  if (!SUPABASE_URL) return '';
  return `${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;
}

export function beginOAuthSignIn(provider: OAuthProvider) {
  const authBase = getSupabaseAuthBase();
  if (!authBase || !SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase OAuth config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  const redirectTo = `${window.location.origin}/login`;
  const params = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
  });

  window.location.assign(`${authBase}/authorize?${params.toString()}`);
}

function supabaseHeaders() {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase OAuth config. Set VITE_SUPABASE_ANON_KEY.');
  }
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function requestEmailOtp(email: string) {
  const authBase = getSupabaseAuthBase();
  if (!authBase) {
    throw new Error('Missing Supabase OAuth config. Set VITE_SUPABASE_URL.');
  }

  const response = await fetch(`${authBase}/otp`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      email,
      create_user: true,
      email_redirect_to: `${window.location.origin}/login`,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error_description || payload.msg || payload.error || 'Failed to send OTP');
  }
}

export async function verifyEmailOtp(email: string, token: string) {
  const authBase = getSupabaseAuthBase();
  if (!authBase) {
    throw new Error('Missing Supabase OAuth config. Set VITE_SUPABASE_URL.');
  }

  const response = await fetch(`${authBase}/verify`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify({ email, token, type: 'email' }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error_description || payload.msg || payload.error || 'Invalid OTP');
  }

  const payload = await response.json().catch(() => ({}));
  const accessToken = String(payload?.access_token || payload?.session?.access_token || '').trim();
  if (!accessToken) {
    throw new Error('Could not complete sign in after OTP verification.');
  }
  return accessToken;
}

export function loginWithSupabaseAccessToken(accessToken: string) {
  return requestJson<AuthResponse>('/api/auth/supabase', { accessToken });
}

type ReqOpts = RequestInit & { auth?: boolean };

function getGuestId() {
  const existing = localStorage.getItem(GUEST_KEY);
  if (existing) return existing;
  const generated = `gst_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
  localStorage.setItem(GUEST_KEY, generated);
  return generated;
}

function buildRequestHeaders(opts: ReqOpts = {}) {
  const headers = new Headers(opts.headers);
  const token = tokenStore.get();
  if (!token) {
    headers.set('X-CVStack-Guest-Id', getGuestId());
  }
  if (opts.auth) {
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  return headers;
}

async function assertOk(response: Response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
}

async function request<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: buildRequestHeaders(opts),
  });

  await assertOk(response);

  return response.json() as Promise<T>;
}

function requestJson<T>(path: string, payload: unknown, opts: ReqOpts = {}) {
  const headers = new Headers(opts.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return request<T>(path, {
    ...opts,
    method: opts.method ?? 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

export interface AuthResponse {
  token: string;
  user: StoredUser;
}

export interface TailorResumeRequest {
  jdText: string;
  baseResumeText: string;
  targetTitle?: string;
  seniority?: 'intern' | 'junior' | 'mid' | 'senior';
}

export interface TailorResumeResponse {
  variantResumeText: string;
  changeSummary: string[];
  redFlags: string[];
  keywordCoverage: { matched: string[]; missing: string[] };
}

export interface CurateResumeRequest {
  resumeData: unknown;
  targetRole?: string;
  jdText?: string;
  jobCompany?: string;
  jobLink?: string;
}

export interface CurateResumeResponse {
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
  companyContext?: {
    company: string;
    focus: string;
    stellarProfile: string[];
    evidence: string[];
  };
  suggestions: Array<{
    field: 'bio' | 'bullet';
    expId?: string;
    bulletIdx?: number;
    suggested: string;
    reason?: string;
  }>;
  questions?: string[];
  quality?: {
    similarityScore: number;
    impactScore: number;
    atsScore: number;
    passed: boolean;
    notes: string;
  };
  meta?: {
    providerStatus: 'ok' | 'fallback';
    fallbackReason?: string;
    model?: string;
  };
}

export interface SharedResumeResponse {
  resume: { id: string; title: string };
  version: unknown;
}

export function register(email: string, password: string, fullName = '') {
  return requestJson<AuthResponse>('/api/auth/register', { email, password, fullName });
}

export function login(email: string, password: string) {
  return requestJson<AuthResponse>('/api/auth/login', { email, password });
}

export function getMe() {
  return request<{ user: StoredUser }>('/api/auth/me', { auth: true });
}

export function createResume(payload: { title?: string; source?: 'manual' | 'linkedin'; email?: string; data?: unknown }) {
  return requestJson<{ resumeId: string; versionId: string }>('/api/resumes', payload, { auth: true });
}

export function uploadResumePdf(file: File, title = 'Imported Resume') {
  const query = new URLSearchParams({ filename: file.name, title }).toString();
  return request<{ resumeId: string; versionId: string; parsed: unknown; extractedTextPreview: string; warnings?: string[] }>(`/api/resumes/upload?${query}`, {
    method: 'POST',
    auth: true,
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  });
}

export function replaceResumePdf(resumeId: string, file: File, title = 'Uploaded Resume') {
  const query = new URLSearchParams({ filename: file.name, title }).toString();
  return request<{ resumeId: string; versionId: string; version: unknown; parsed: unknown; extractedTextPreview: string; warnings?: string[]; resume: { id: string; source: string; file_name?: string; updated_at: string } }>(`/api/resumes/${resumeId}/upload?${query}`, {
    method: 'POST',
    auth: true,
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  });
}

export async function getResumePdfBlob(resumeId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/resumes/${resumeId}/pdf`, {
    headers: buildRequestHeaders({ auth: true }),
  });
  await assertOk(response);
  return response.blob();
}

export function listResumes() {
  return request<{ resumes: Array<{ id: string; title: string; source: string; file_name?: string; created_at: string; updated_at: string }> }>('/api/resumes', { auth: true });
}

export function getResume(resumeId: string) {
  return request<{
    resume: {
      id: string;
      title: string;
      source: string;
      fileName?: string;
      createdAt: string;
      updatedAt: string;
    };
  }>(`/api/resumes/${resumeId}`, { auth: true });
}

export function listVersions(resumeId: string) {
  return request<{ versions: unknown[] }>(`/api/resumes/${resumeId}/versions`, { auth: true });
}

export function createVersion(resumeId: string, payload: unknown) {
  return requestJson<{ version: unknown }>(`/api/resumes/${resumeId}/versions`, payload, { auth: true });
}

export function updateVersion(resumeId: string, versionId: string, payload: unknown) {
  return requestJson<{ version: unknown }>(`/api/resumes/${resumeId}/versions/${versionId}`, payload, {
    method: 'PATCH',
    auth: true,
  });
}

export function deleteVersion(resumeId: string, versionId: string) {
  return request<{ ok: true }>(`/api/resumes/${resumeId}/versions/${versionId}`, {
    method: 'DELETE',
    auth: true,
  });
}

export function tailorResume(payload: TailorResumeRequest) {
  return requestJson<TailorResumeResponse>('/api/ai/tailor-resume', payload);
}

export function curateResume(payload: CurateResumeRequest) {
  return requestJson<CurateResumeResponse>('/api/ai/curate-resume', payload);
}

export function createResumeShareLink(resumeId: string, versionId: string) {
  return requestJson<{ token: string; resumeId: string; versionId: string }>(`/api/resumes/${resumeId}/share`, { versionId }, { auth: true });
}

export function getSharedResume(token: string) {
  return request<SharedResumeResponse>(`/api/public/resume/${encodeURIComponent(token)}`);
}
