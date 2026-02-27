import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthGateProvider } from './components/AuthGate';
import { consumeSupabaseAccessTokenFromUrl, loginWithSupabaseAccessToken, resolvePostLoginPath, tokenStore, userStore, verifySupabaseTokenHash } from '../lib/api';

export default function App() {
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

  return (
    <AuthGateProvider>
      <RouterProvider router={router} />
    </AuthGateProvider>
  );
}
