import { useNavigate } from 'react-router';
import AuthModal from '../components/AuthModal';
import { resolvePostLoginPath } from '../../lib/api';

export default function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#FAFAFA]">
      <AuthModal
        open
        onClose={() => {
          if (window.history.length > 1) {
            navigate(-1);
            return;
          }
          navigate('/start', { replace: true });
        }}
        onSuccess={() => {
          void resolvePostLoginPath().then((destination) => navigate(destination));
        }}
      />
    </div>
  );
}
