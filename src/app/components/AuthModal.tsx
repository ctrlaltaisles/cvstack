import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  AUTH_EVENT_KEY,
  beginOAuthSignIn,
  requestEmailOtp,
  tokenStore,
  type OAuthProvider,
} from '../../lib/api';
import googleLogo from '../assets/social/google-black.svg';
import linkedInLogo from '../assets/social/InBug-Black.png';

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
  const [magicLinkSentTo, setMagicLinkSentTo] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  const magicLinkSentForCurrentEmail = Boolean(magicLinkSentTo && magicLinkSentTo === email.trim().toLowerCase());

  useEffect(() => {
    if (!open) return;
    if (tokenStore.get()) {
      onSuccess();
      return;
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_EVENT_KEY) return;
      if (tokenStore.get()) {
        onSuccess();
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [open, onSuccess]);

  const submit = async () => {
    setError('');
    setHint('');
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      await requestEmailOtp(normalizedEmail);
      setMagicLinkSentTo(normalizedEmail);
      setHint('Magic link sent. Check your email and click the link to continue.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const startOAuth = (provider: OAuthProvider) => {
    setError('');
    setHint('');
    setOauthLoading(provider);
    try {
      beginOAuthSignIn(provider);
    } catch (err) {
      setOauthLoading(null);
      setError(err instanceof Error ? err.message : 'Unable to start social login');
    }
  };

  if (!open) return null;

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
              className="h-12 rounded-[12px] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
              aria-label="Continue with Google"
            >
              <img src={googleLogo} alt="Google" className="w-5 h-5 object-contain" />
            </button>
            <button
              onClick={() => startOAuth('github')}
              disabled={loading || oauthLoading !== null}
              className="h-12 rounded-[12px] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
              aria-label="Continue with GitHub"
            >
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" className="text-[#1A1A1A]">
                <path d="M12 1C5.9225 1 1 5.9225 1 12C1 16.8675 4.14875 20.9787 8.52125 22.4362C9.07125 22.5325 9.2775 22.2025 9.2775 21.9137C9.2775 21.6525 9.26375 20.7862 9.26375 19.865C6.5 20.3737 5.785 19.1912 5.565 18.5725C5.44125 18.2562 4.905 17.28 4.4375 17.0187C4.0525 16.8125 3.5025 16.3037 4.42375 16.29C5.29 16.2762 5.90875 17.0875 6.115 17.4175C7.105 19.0812 8.68625 18.6137 9.31875 18.325C9.415 17.61 9.70375 17.1287 10.02 16.8537C7.5725 16.5787 5.015 15.63 5.015 11.4225C5.015 10.2262 5.44125 9.23625 6.1425 8.46625C6.0325 8.19125 5.6475 7.06375 6.2525 5.55125C6.2525 5.55125 7.17375 5.2625 9.2775 6.67875C10.1575 6.43125 11.0925 6.3075 12.0275 6.3075C12.9625 6.3075 13.8975 6.43125 14.7775 6.67875C16.8813 5.24875 17.8025 5.55125 17.8025 5.55125C18.4075 7.06375 18.0225 8.19125 17.9125 8.46625C18.6138 9.23625 19.04 10.2125 19.04 11.4225C19.04 15.6437 16.4688 16.5787 14.0213 16.8537C14.42 17.1975 14.7638 17.8575 14.7638 18.8887C14.7638 20.36 14.75 21.5425 14.75 21.9137C14.75 22.2025 14.9563 22.5462 15.5063 22.4362C19.8513 20.9787 23 16.8537 23 12C23 5.9225 18.0775 1 12 1Z" />
              </svg>
            </button>
            <button
              onClick={() => startOAuth('linkedin_oidc')}
              disabled={loading || oauthLoading !== null}
              className="h-12 rounded-[12px] bg-[#F6F6F7] hover:bg-[#EFEFF0] text-[#1A1A1A] disabled:opacity-50 flex items-center justify-center"
              aria-label="Continue with LinkedIn"
            >
              <img src={linkedInLogo} alt="LinkedIn" className="w-5 h-5 object-contain" />
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
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
                setHint('');
              }}
              type="email"
              placeholder="Email"
              className="w-full bg-[#F7F7F8] rounded-[12px] p-3 border border-[#ECECEC] text-sm"
            />
            {hint && <p className="text-xs text-[#6B6B6B]">{hint}</p>}
            {error && <p className="text-xs text-[#D14343]">{error}</p>}
            {magicLinkSentForCurrentEmail && (
              <button
                onClick={() => {
                  setError('');
                  setHint('');
                  setLoading(true);
                  void requestEmailOtp(email.trim().toLowerCase())
                    .then(() => setHint('A new magic link was sent to your email.'))
                    .catch((err) => setError(err instanceof Error ? err.message : 'Failed to resend magic link'))
                    .finally(() => setLoading(false));
                }}
                disabled={loading || oauthLoading !== null || !email}
                className="text-xs text-[#6B6B6B] hover:text-[#1A1A1A] underline underline-offset-2 text-left"
              >
                Resend link
              </button>
            )}
          </div>
        </div>
        <div className="px-6 py-5 border-t border-[#F0F0F0]">
          <button
            onClick={submit}
            disabled={loading || oauthLoading !== null || !email}
            className="w-full bg-[#1A1A1A] text-white px-5 py-3 rounded-[12px] text-sm disabled:opacity-40"
          >
            {loading ? 'Please wait...' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
