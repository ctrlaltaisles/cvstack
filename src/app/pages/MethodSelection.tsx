import { type ChangeEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileUp, PenLine } from 'lucide-react';
import { motion } from 'motion/react';
import { clearAuthStorage, createResume, uploadResumePdf, userStore } from '../../lib/api';

const methods = [
  {
    id: 'upload',
    icon: FileUp,
    title: 'Upload Existing CV (PDF)',
    description: 'Upload a PDF and pre-fill the base resume editor',
  },
  {
    id: 'manual',
    icon: PenLine,
    title: 'Enter Manually',
    description: 'Start fresh with a base resume template',
  },
];

export default function MethodSelection() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const currentUser = userStore.get();

  const startManual = async () => {
    setError('');
    setLoading(true);
    try {
      const created = await createResume({
        source: 'manual',
        title: 'Base Resume',
      });
      navigate(`/workspace?resumeId=${created.resumeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create resume');
    } finally {
      setLoading(false);
    }
  };

  const onMethodClick = (id: string) => {
    if (id === 'upload') {
      fileRef.current?.click();
      return;
    }
    void startManual();
  };

  const onFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      setError('Please upload a PDF file.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const created = await uploadResumePdf(file, 'Uploaded Resume');
      navigate(`/workspace?resumeId=${created.resumeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="relative min-h-screen bg-white flex flex-col items-center justify-center px-8"
    >
      <div className="absolute top-6 right-8">
        {currentUser ? (
          <button
            onClick={() => {
              clearAuthStorage();
              navigate('/', { replace: true });
            }}
            className="text-sm text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors"
          >
            Log out
          </button>
        ) : (
          <button
            onClick={() => navigate('/login')}
            className="text-sm text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors"
          >
            Sign in
          </button>
        )}
      </div>

      <div className="w-full max-w-md">
        <h1 className="text-[28px] tracking-tight text-[#1A1A1A] mb-2">
          Upload your resume to get started
        </h1>
        <p className="text-sm text-[#9B9B9B] mb-8">No account required for upload, extraction preview, editing, and export.</p>

        <div className="space-y-3">
          {methods.map((method) => {
            const Icon = method.icon;
            return (
              <button
                key={method.id}
                onClick={() => onMethodClick(method.id)}
                disabled={loading}
                className="w-full bg-[#F7F7F8] rounded-[14px] p-5 flex items-center gap-4 border border-transparent hover:border-[#CBCBCB] hover:bg-white transition-all text-left group disabled:opacity-60"
              >
                <div className="w-10 h-10 bg-white rounded-[10px] flex items-center justify-center border border-[#E5E5E5] shrink-0 group-hover:border-[#CBCBCB] transition-colors">
                  <Icon size={18} strokeWidth={1.8} className="text-[#2B2B2B]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#1A1A1A] mb-0.5">{method.title}</p>
                  <p className="text-xs text-[#9B9B9B] leading-relaxed">{method.description}</p>
                </div>
              </button>
            );
          })}
        </div>
        {error && <p className="text-xs text-[#D14343] mt-3">{error}</p>}
      </div>

      <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={onFilePicked} />
    </motion.div>
  );
}
