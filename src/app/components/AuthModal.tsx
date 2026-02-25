import { useState } from 'react';
import { X } from 'lucide-react';
import { login, register, tokenStore, userStore } from '../../lib/api';

type AuthMode = 'login' | 'register';

export default function AuthModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      const result = mode === 'login'
        ? await login(email, password)
        : await register(email, password, fullName);
      tokenStore.set(result.token);
      userStore.set(result.user);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/25 z-[250] flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-[16px] border border-[#EAEAEA] shadow-[0_24px_80px_rgba(0,0,0,0.18)]" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-[#F0F0F0] flex items-center justify-between">
          <div>
            <h2 className="text-base text-[#1A1A1A]" style={{ fontWeight: 500 }}>Continue with CVStack</h2>
            <p className="text-xs text-[#9B9B9B] mt-1">Login is required to use AI features.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        <div className="px-6 py-5">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setMode('login')}
              className={`px-3 py-2 text-xs rounded-[10px] border ${mode === 'login' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E5] text-[#6B6B6B]'}`}
            >
              Login
            </button>
            <button
              onClick={() => setMode('register')}
              className={`px-3 py-2 text-xs rounded-[10px] border ${mode === 'register' ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]' : 'border-[#E5E5E5] text-[#6B6B6B]'}`}
            >
              Sign up
            </button>
          </div>
          <div className="space-y-3">
            {mode === 'register' && (
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Full name"
                className="w-full bg-[#F7F7F8] rounded-[12px] p-3 border border-[#ECECEC] text-sm"
              />
            )}
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
            disabled={loading || !email || !password || (mode === 'register' && password.length < 8)}
            className="w-full bg-[#1A1A1A] text-white px-5 py-3 rounded-[12px] text-sm disabled:opacity-40"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Login' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  );
}
