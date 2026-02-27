import { useState } from 'react';
import { Github, Linkedin, X } from 'lucide-react';
import { beginOAuthSignIn, login, register, tokenStore, userStore, type OAuthProvider } from '../../lib/api';

export default function AuthModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);

  if (!open) return null;

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      let result;
      try {
        result = await register(email, password);
      } catch (registerErr) {
        if (registerErr instanceof Error && /already registered/i.test(registerErr.message)) {
          result = await login(email, password);
        } else {
          throw registerErr;
        }
      }
      tokenStore.set(result.token);
      userStore.set(result.user);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const startOAuth = (provider: OAuthProvider) => {
    setError('');
    setOauthLoading(provider);
    try {
      beginOAuthSignIn(provider);
    } catch (err) {
      setOauthLoading(null);
      setError(err instanceof Error ? err.message : 'Unable to start social login');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/25 z-[250] flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-[16px] border border-[#EAEAEA] shadow-[0_24px_80px_rgba(0,0,0,0.18)]" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-[#F0F0F0] flex items-center justify-between">
          <div>
            <h2 className="text-base text-[#1A1A1A]" style={{ fontWeight: 700 }}>Sign in or Create an Account</h2>
            <p className="text-xs text-[#9B9B9B] mt-1">Save, sync and use AI features</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <button
              onClick={() => startOAuth('google')}
              disabled={loading || oauthLoading !== null}
              className="h-12 rounded-[12px] border border-[#E6E6E6] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
            >
              <span aria-hidden className="text-xl leading-none">G</span>
            </button>
            <button
              onClick={() => startOAuth('github')}
              disabled={loading || oauthLoading !== null}
              className="h-12 rounded-[12px] border border-[#E6E6E6] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
            >
              <Github size={22} />
            </button>
            <button
              onClick={() => startOAuth('linkedin_oidc')}
              disabled={loading || oauthLoading !== null}
              className="h-12 rounded-[12px] border border-[#E6E6E6] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
            >
              <Linkedin size={22} />
            </button>
          </div>
          <div className="space-y-3">
            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#EFEFEF]" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-2 text-[11px] text-[#9B9B9B]">or continue with email</span>
              </div>
            </div>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="Email"
              className="w-full bg-[#F7F7F8] rounded-[12px] p-3 border border-[#ECECEC] text-sm"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Password (min 8 chars)"
              className="w-full bg-[#F7F7F8] rounded-[12px] p-3 border border-[#ECECEC] text-sm"
            />
            {error && <p className="text-xs text-[#D14343]">{error}</p>}
          </div>
        </div>
        <div className="px-6 py-5 border-t border-[#F0F0F0]">
          <button
            onClick={submit}
            disabled={loading || oauthLoading !== null || !email || password.length < 8}
            className="w-full bg-[#1A1A1A] text-white px-5 py-3 rounded-[12px] text-sm disabled:opacity-40"
          >
            {loading ? 'Please wait...' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
