import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthGateProvider } from './components/AuthGate';
import {
  consumePendingSignInMethod,
  consumeSupabaseAccessTokenFromUrl,
  getSignInMethodLabel,
  loginWithSupabaseAccessToken,
  resolvePostLoginPath,
  tokenStore,
  userStore,
  verifySupabaseTokenHash,
} from '../lib/api';

function stripAuthParamsFromUrl() {
  const url = new URL(window.location.href);
  const searchKeys = ['code', 'access_token', 'token_hash', 'type', 'error', 'error_code', 'error_description'];
  const hashKeys = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'provider_token', 'provider_refresh_token'];
  let searchChanged = false;
  let hashChanged = false;

  for (const key of searchKeys) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    searchChanged = true;
  }

  const rawHash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(rawHash);
  for (const key of hashKeys) {
    if (!hashParams.has(key)) continue;
    hashParams.delete(key);
    hashChanged = true;
  }

  if (!searchChanged && !hashChanged) return;

  const nextSearch = url.searchParams.toString();
  const nextHash = hashParams.toString();
  const nextPath = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`;
  window.history.replaceState(null, '', nextPath);
}

export default function App() {
  const [authToast, setAuthToast] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const hasHashParams = new URLSearchParams(hash).has('access_token');
    const queryParams = new URLSearchParams(window.location.search);
    const tokenHash = queryParams.get('token_hash');
    const callbackType = queryParams.get('type');
    const code = queryParams.get('code');
    const queryAccessToken = queryParams.get('access_token');

    // Only run callback exchange when landing from Supabase auth redirect.
    if (!hasHashParams && !code && !queryAccessToken && !(tokenHash && callbackType)) {
      return;
    }

    setIsAuthLoading(true);
    const accessTokenPromise = tokenHash && callbackType
      ? verifySupabaseTokenHash(tokenHash, callbackType)
      : consumeSupabaseAccessTokenFromUrl();

    void accessTokenPromise
      .then((accessToken) => (accessToken ? loginWithSupabaseAccessToken(accessToken) : null))
      .then((result) => {
        if (!result) return;
        tokenStore.set(result.token);
        userStore.set(result.user);
        const pendingMethod = consumePendingSignInMethod();
        if (pendingMethod) {
          setAuthToast(`Signed in with ${getSignInMethodLabel(pendingMethod)}!`);
        }
        return resolvePostLoginPath();
      })
      .then(async (destination) => {
        if (!destination) return;
        stripAuthParamsFromUrl();
        if (window.location.pathname + window.location.search === destination) return;
        await router.navigate(destination, { replace: true });
      })
      .catch(() => {
        stripAuthParamsFromUrl();
        setAuthToast('Sign in failed. Please try again.');
      })
      .finally(() => {
        setIsAuthLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!authToast) return;
    const timeoutId = window.setTimeout(() => setAuthToast(''), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [authToast]);

  return (
    <AuthGateProvider>
      <RouterProvider router={router} />
      {authToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] rounded-[10px] bg-[#1A1A1A] px-4 py-2 text-sm text-white shadow-[0_8px_24px_rgba(0,0,0,0.28)]">
          {authToast}
        </div>
      )}
      {isAuthLoading && (
        <div className="start-loading-overlay fixed inset-0 z-[320] flex items-center justify-center" role="status" aria-live="polite">
          <div className="start-loading-gradient absolute inset-0" />
          <div className="relative rounded-2xl border border-white/70 bg-white/85 px-6 py-4 shadow-[0_14px_40px_rgba(0,0,0,0.08)] backdrop-blur-md">
            <p className="text-sm font-medium text-[#2E2E2E] loading-shimmer-text">Signing you in...</p>
          </div>
        </div>
      )}
    </AuthGateProvider>
  );
}
