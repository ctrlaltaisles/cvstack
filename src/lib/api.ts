const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:4000';
const TOKEN_KEY = 'cvstack_token';
const USER_KEY = 'cvstack_user';
const GUEST_KEY = 'cvstack_guest_id';

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

type ReqOpts = RequestInit & { auth?: boolean };

function getGuestId() {
  const existing = localStorage.getItem(GUEST_KEY);
  if (existing) return existing;
  const generated = `gst_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;
  localStorage.setItem(GUEST_KEY, generated);
  return generated;
}

async function request<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  const token = tokenStore.get();
  if (!token) {
    headers.set('X-CVStack-Guest-Id', getGuestId());
  }
  if (opts.auth) {
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
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
}

export interface CurateResumeResponse {
  changeSummary: string[];
  redFlags: string[];
  aboutPointers: string[];
  jdFocusAreas: string[];
  jdTldr: {
    roleAsks: string;
    candidateNeeds: string;
    keyFocusAreas: string[];
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
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fullName }),
  });
}

export function login(email: string, password: string) {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export function getMe() {
  return request<{ user: StoredUser }>('/api/auth/me', { auth: true });
}

export function createResume(payload: { title?: string; source?: 'manual' | 'linkedin'; email?: string; data?: unknown }) {
  return request<{ resumeId: string; versionId: string }>('/api/resumes', {
    method: 'POST',
    auth: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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
  const headers = new Headers();
  const token = tokenStore.get();
  if (!token) {
    headers.set('X-CVStack-Guest-Id', getGuestId());
  } else {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}/api/resumes/${resumeId}/pdf`, { headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.blob();
}

export function listResumes() {
  return request<{ resumes: Array<{ id: string; title: string; source: string; file_name?: string; created_at: string; updated_at: string }> }>('/api/resumes', { auth: true });
}

export function listVersions(resumeId: string) {
  return request<{ versions: unknown[] }>(`/api/resumes/${resumeId}/versions`, { auth: true });
}

export function createVersion(resumeId: string, payload: unknown) {
  return request<{ version: unknown }>(`/api/resumes/${resumeId}/versions`, {
    method: 'POST',
    auth: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateVersion(resumeId: string, versionId: string, payload: unknown) {
  return request<{ version: unknown }>(`/api/resumes/${resumeId}/versions/${versionId}`, {
    method: 'PATCH',
    auth: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteVersion(resumeId: string, versionId: string) {
  return request<{ ok: true }>(`/api/resumes/${resumeId}/versions/${versionId}`, {
    method: 'DELETE',
    auth: true,
  });
}

export function tailorResume(payload: TailorResumeRequest) {
  return request<TailorResumeResponse>('/api/ai/tailor-resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function curateResume(payload: CurateResumeRequest) {
  return request<CurateResumeResponse>('/api/ai/curate-resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createResumeShareLink(resumeId: string, versionId: string) {
  return request<{ token: string; resumeId: string; versionId: string }>(`/api/resumes/${resumeId}/share`, {
    method: 'POST',
    auth: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId }),
  });
}

export function getSharedResume(token: string) {
  return request<SharedResumeResponse>(`/api/public/resume/${encodeURIComponent(token)}`);
}
