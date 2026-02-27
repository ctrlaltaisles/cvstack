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

export default function App() {
  const [authToast, setAuthToast] = useState('');

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
      .then((destination) => {
        if (!destination) return;
        window.history.replaceState(null, '', window.location.pathname);
        if (window.location.pathname + window.location.search !== destination) {
          window.location.replace(destination);
        }
      })
      .catch(() => {
        window.history.replaceState(null, '', window.location.pathname);
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
    </AuthGateProvider>
  );
}
