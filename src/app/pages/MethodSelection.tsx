import { type ChangeEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileUp, PenLine } from 'lucide-react';
import { motion } from 'motion/react';
import { clearAuthStorage, createResume, uploadResumePdf, userStore } from '../../lib/api';

const MAX_UPLOAD_SIZE_BYTES = 1024 * 1024;

const methods = [
  {
    id: 'upload',
    icon: FileUp,
    title: 'Upload Your Resume (PDF)',
    description: 'Upload a PDF to pre-fill the master resume editor. File size limited to 1MB.',
  },
  {
    id: 'manual',
    icon: PenLine,
    title: 'Enter Manually',
    description: 'Start fresh with a master resume template',
  },
];

export default function MethodSelection() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isParsingUpload, setIsParsingUpload] = useState(false);
  const currentUser = userStore.get();

  const startManual = async () => {
    setError('');
    setLoading(true);
    try {
      const payload = {
        source: 'manual' as const,
        title: 'Master Resume',
      };
      let created;
      try {
        created = await createResume(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        const likelyAuthIssue = /401|invalid bearer token|missing or invalid bearer token/i.test(message);
        if (!likelyAuthIssue) throw err;
        clearAuthStorage();
        created = await createResume(payload);
      }
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
      event.target.value = '';
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setError('File size must be 1MB or less.');
      event.target.value = '';
      return;
    }

    setError('');
    setLoading(true);
    setIsParsingUpload(true);
    try {
      const created = await uploadResumePdf(file, 'Uploaded Resume');
      navigate(`/workspace?resumeId=${created.resumeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      setIsParsingUpload(false);
      event.target.value = '';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="relative min-h-screen bg-[#eef1f6] overflow-hidden"
      aria-busy={isParsingUpload}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.45] [background-image:radial-gradient(rgba(255,255,255,0.9)_1px,transparent_1px)] [background-size:26px_26px]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.3] [background-image:linear-gradient(to_right,rgba(255,255,255,0.65)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:46px_46px]" />
      <div className="pointer-events-none absolute -left-28 bottom-[-18%] h-[52%] w-[52%] rounded-full bg-[radial-gradient(circle,_rgba(255,156,214,0.68)_0%,_rgba(255,156,214,0)_72%)] blur-3xl" />
      <div className="pointer-events-none absolute right-[-14%] bottom-[-20%] h-[58%] w-[54%] rounded-full bg-[radial-gradient(circle,_rgba(137,184,255,0.7)_0%,_rgba(137,184,255,0)_72%)] blur-3xl" />

      <div
        className={[
          'relative z-10 w-full min-h-screen flex flex-col items-center justify-center px-8 transition-[filter,opacity] duration-300',
          isParsingUpload ? 'blur-[5px] opacity-70 pointer-events-none select-none' : '',
        ].join(' ')}
      >
        <div className="absolute top-6 left-8">
          <button
            onClick={() => {
              if (window.history.length > 1) {
                navigate(-1);
                return;
              }
              navigate('/', { replace: true });
            }}
            className="text-sm text-[#5f6779] hover:text-[#131824] transition-colors"
          >
            Back
          </button>
        </div>

        <div className="absolute top-6 right-8">
          {currentUser ? (
            <button
              onClick={() => {
                clearAuthStorage();
                navigate('/', { replace: true });
              }}
              className="text-sm text-[#5f6779] hover:text-[#131824] transition-colors"
            >
              Log out
            </button>
          ) : (
            <button
              onClick={() => navigate('/login')}
              className="text-sm text-[#5f6779] hover:text-[#131824] transition-colors"
            >
              Sign in
            </button>
          )}
        </div>

        <div className="w-full max-w-lg rounded-[24px] border border-white/70 bg-white/82 p-7 shadow-[0_16px_54px_rgba(68,79,106,0.18)] backdrop-blur-sm md:p-8">
          <h1 className="text-[30px] tracking-tight text-[#151a27] mb-2">Let's start building</h1>
          <p className="text-sm text-[#7f8798] mb-8">No account required for upload, extraction preview, editing, and export.</p>

          <div className="space-y-3">
            {methods.map((method) => {
              const Icon = method.icon;
              return (
                <button
                  key={method.id}
                  onClick={() => onMethodClick(method.id)}
                  disabled={loading}
                  className="w-full bg-white/75 rounded-[14px] p-5 flex items-center gap-4 border border-[#e8edf6] hover:border-[#cfd7e8] hover:bg-white transition-all text-left group disabled:opacity-60"
                >
                  <div className="w-10 h-10 bg-white rounded-[10px] flex items-center justify-center border border-[#dce3f0] shrink-0 group-hover:border-[#c6cfdf] transition-colors">
                    <Icon size={18} strokeWidth={1.8} className="text-[#2B2B2B]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1A1A1A] mb-0.5">{method.title}</p>
                    <p className="text-xs text-[#828b9d] leading-relaxed">{method.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
          {error && <p className="text-xs text-[#D14343] mt-3">{error}</p>}
        </div>

        <div className="pointer-events-none absolute bottom-[-18px] left-1/2 w-[80%] max-w-[760px] -translate-x-1/2 [perspective:1000px]">
          <div className="h-[130px] rotate-[-2deg] rounded-[20px] border border-white/80 bg-white/72 p-3 shadow-[0_20px_65px_rgba(73,90,127,0.22)] backdrop-blur-sm md:h-[165px] md:p-4">
            <div className="grid h-full grid-cols-[0.9fr_1.6fr] gap-3 md:gap-4">
              <div className="rounded-xl border border-[#e7edf8] bg-[#f8fbff]/90 p-3">
                <div className="h-2 w-12 rounded-full bg-[#cad4e8]" />
                <div className="mt-3 space-y-2">
                  <div className="h-2 w-full rounded-full bg-[#d6deef]" />
                  <div className="h-2 w-[76%] rounded-full bg-[#dde5f3]" />
                </div>
              </div>
              <div className="rounded-xl border border-[#e7edf8] bg-white/88 p-3">
                <div className="mb-3 h-6 rounded-lg bg-[#f3f6fb]" />
                <div className="grid grid-cols-3 gap-2">
                  <div className="h-10 rounded-lg bg-[#f8cae3]/75" />
                  <div className="h-10 rounded-lg bg-[#d6cbff]/72" />
                  <div className="h-10 rounded-lg bg-[#c8dfff]/74" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={onFilePicked} />
      </div>

      {isParsingUpload && (
        <div className="start-loading-overlay absolute inset-0 z-30 flex items-center justify-center" role="status" aria-live="polite">
          <div className="start-loading-gradient absolute inset-0" />
          <div className="relative rounded-2xl border border-white/70 bg-white/80 px-6 py-4 shadow-[0_14px_40px_rgba(0,0,0,0.08)] backdrop-blur-md">
            <p className="text-sm font-medium text-[#2E2E2E] loading-shimmer-text">Parsing your resume...</p>
          </div>
        </div>
      )}
    </motion.div>
  );
}
