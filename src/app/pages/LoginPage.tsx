import { useNavigate } from 'react-router';
import AuthModal from '../components/AuthModal';
import { resolvePostLoginPath } from '../../lib/api';

export default function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#FAFAFA]">
      <AuthModal
        open
        onClose={() => navigate('/')}
        onSuccess={() => {
          void resolvePostLoginPath().then((destination) => navigate(destination));
        }}
      />
    </div>
  );
}
