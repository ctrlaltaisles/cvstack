import { useNavigate } from 'react-router';
import { Linkedin, FileUp, PenLine } from 'lucide-react';
import { motion } from 'motion/react';

const methods = [
  {
    id: 'linkedin',
    icon: Linkedin,
    title: 'Import from LinkedIn',
    description: 'Sync your profile to pre-fill your resume automatically',
  },
  {
    id: 'upload',
    icon: FileUp,
    title: 'Upload Existing CV',
    description: 'Upload a PDF or DOCX and we\'ll parse it for you',
  },
  {
    id: 'manual',
    icon: PenLine,
    title: 'Enter Manually',
    description: 'Start fresh and build your resume from scratch',
  },
];

export default function MethodSelection() {
  const navigate = useNavigate();

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="min-h-screen bg-white flex flex-col items-center justify-center px-8"
    >
      {/* Back */}
      <div className="w-full max-w-md mb-10">
        <button
          onClick={() => navigate('/')}
          className="text-sm text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors"
        >
          ← Back
        </button>
      </div>

      <div className="w-full max-w-md">
        <div className="mb-10">
          <span className="text-base tracking-tight text-[#1A1A1A]">CVStack</span>
        </div>

        <h1 className="text-[28px] tracking-tight text-[#1A1A1A] mb-2">
          How would you like to begin?
        </h1>
        <p className="text-sm text-[#9B9B9B] mb-8">Choose a method to get started.</p>

        <div className="space-y-3">
          {methods.map(method => {
            const Icon = method.icon;
            return (
              <button
                key={method.id}
                onClick={() => navigate('/workspace')}
                className="w-full bg-[#F7F7F8] rounded-[14px] p-5 flex items-center gap-4 border border-transparent hover:border-[#CBCBCB] hover:bg-white transition-all text-left group"
              >
                <div className="w-10 h-10 bg-white rounded-[10px] flex items-center justify-center border border-[#E5E5E5] shrink-0 group-hover:border-[#CBCBCB] transition-colors">
                  <Icon size={18} className="text-[#2B2B2B]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#1A1A1A] mb-0.5">{method.title}</p>
                  <p className="text-xs text-[#9B9B9B] leading-relaxed">{method.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}