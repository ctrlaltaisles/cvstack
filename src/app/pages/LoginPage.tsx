import { useNavigate } from 'react-router';
import AuthModal from '../components/AuthModal';

export default function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#FAFAFA]">
      <AuthModal
        open
        onClose={() => navigate('/')}
        onSuccess={() => navigate('/workspace')}
      />
    </div>
  );
}
