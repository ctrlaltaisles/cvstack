import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthGateProvider } from './components/AuthGate';
import { consumeSupabaseAccessTokenFromUrl, loginWithSupabaseAccessToken, tokenStore, userStore, verifySupabaseTokenHash } from '../lib/api';

export default function App() {
  useEffect(() => {
    const queryParams = new URLSearchParams(window.location.search);
    const tokenHash = queryParams.get('token_hash');
    const callbackType = queryParams.get('type');

    const accessTokenPromise = tokenHash && callbackType
      ? verifySupabaseTokenHash(tokenHash, callbackType)
      : consumeSupabaseAccessTokenFromUrl();

    void accessTokenPromise
      .then((accessToken) => (accessToken ? loginWithSupabaseAccessToken(accessToken) : null))
      .then((result) => {
        if (!result) return;
        tokenStore.set(result.token);
        userStore.set(result.user);
        window.history.replaceState(null, '', window.location.pathname);
        window.location.replace('/start');
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
