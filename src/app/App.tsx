import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthGateProvider } from './components/AuthGate';
import { loginWithSupabaseAccessToken, tokenStore, userStore, verifySupabaseTokenHash } from '../lib/api';

export default function App() {
  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(window.location.search);

    const hashAccessToken = hashParams.get('access_token');
    const queryAccessToken = queryParams.get('access_token');
    const tokenHash = queryParams.get('token_hash');
    const callbackType = queryParams.get('type');

    const accessTokenPromise = hashAccessToken
      ? Promise.resolve(hashAccessToken)
      : queryAccessToken
        ? Promise.resolve(queryAccessToken)
        : tokenHash && callbackType
          ? verifySupabaseTokenHash(tokenHash, callbackType)
          : null;

    if (!accessTokenPromise) return;

    void accessTokenPromise
      .then((accessToken) => loginWithSupabaseAccessToken(accessToken))
      .then((result) => {
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
