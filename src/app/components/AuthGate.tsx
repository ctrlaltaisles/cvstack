import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import AuthModal from './AuthModal';
import { tokenStore } from '../../lib/api';

type Action = () => void | Promise<void>;

interface AuthGateContextValue {
  requireAuth: (action: Action) => void;
}

const AuthGateContext = createContext<AuthGateContextValue | null>(null);

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const [showAuthModal, setShowAuthModal] = useState(false);
  const pendingActionRef = useRef<Action | null>(null);

  const requireAuth = (action: Action) => {
    if (tokenStore.get()) {
      void action();
      return;
    }
    pendingActionRef.current = action;
    setShowAuthModal(true);
  };

  const handleSuccess = async () => {
    setShowAuthModal(false);
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    if (pending) await pending();
  };

  return (
    <AuthGateContext.Provider value={{ requireAuth }}>
      {children}
      <AuthModal open={showAuthModal} onClose={() => setShowAuthModal(false)} onSuccess={() => { void handleSuccess(); }} />
    </AuthGateContext.Provider>
  );
}

export function useAuthGate() {
  const context = useContext(AuthGateContext);
  if (!context) {
    throw new Error('useAuthGate must be used within AuthGateProvider');
  }
  return context;
}
