import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthGateProvider } from './components/AuthGate';
import { loginWithSupabaseAccessToken, tokenStore, userStore } from '../lib/api';

export default function App() {
  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    if (!accessToken) return;

    void loginWithSupabaseAccessToken(accessToken)
      .then((result) => {
        tokenStore.set(result.token);
        userStore.set(result.user);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        window.location.replace('/workspace');
      })
      .catch(() => {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      });
  }, []);

  return (
    <AuthGateProvider>
      <RouterProvider router={router} />
    </AuthGateProvider>
  );
}
