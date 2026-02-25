import { useNavigate } from 'react-router';
import { motion } from 'motion/react';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="min-h-screen bg-white flex flex-col"
    >
      {/* Nav */}
      <div className="px-8 py-5 flex items-center justify-between border-b border-[#F0F0F0]">
        <span className="text-base tracking-tight text-[#1A1A1A]">CVStack</span>
        <button
          onClick={() => navigate('/login')}
          className="text-sm text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors"
        >
          Sign in
        </button>
      </div>

      {/* Hero */}
      <div className="flex-1 flex items-center justify-center px-8 py-20">
        <div className="text-center max-w-xl">
          <p className="text-xs uppercase tracking-widest text-[#CBCBCB] mb-6">AI-powered resume platform</p>
          <h1 className="text-[40px] tracking-tight text-[#1A1A1A] mb-4 leading-[1.15]">
            Your Resume.<br />Leveled Up.
          </h1>
          <p className="text-base text-[#6B6B6B] mb-10 leading-relaxed">
            Stop rewriting. Start stacking. Tailor your resume to any job<br />in seconds with AI-powered suggestions.
          </p>
          <button
            onClick={() => navigate('/start')}
            className="bg-[#1A1A1A] text-white px-8 py-3 rounded-[12px] text-sm hover:bg-black transition-colors"
          >
            Start Building →
          </button>
          <p className="text-xs text-[#CBCBCB] mt-4">Free to try · No credit card needed</p>
        </div>
      </div>

      {/* Resume Preview Mock */}
      <div className="pb-20 px-8 flex justify-center">
        <div className="w-full max-w-[680px] bg-[#FAFAFA] rounded-[16px] p-10 border border-[#E5E5E5]">
          {/* Header skeleton */}
          <div className="flex items-start gap-5 mb-8">
            <div className="w-12 h-12 rounded-full bg-[#E5E5E5] shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-[#E5E5E5] rounded-lg w-40" />
              <div className="h-3 bg-[#E5E5E5] rounded-lg w-56" />
              <div className="h-3 bg-[#E5E5E5] rounded-lg w-32" />
            </div>
          </div>

          <div className="h-px bg-[#EFEFEF] mb-8" />

          {/* Experience skeleton */}
          <div className="space-y-6">
            <div className="h-3 bg-[#E5E5E5] rounded-lg w-20" />
            {[1, 2].map(i => (
              <div key={i} className="flex gap-6">
                <div className="w-20 shrink-0 space-y-1.5">
                  <div className="h-2.5 bg-[#E5E5E5] rounded-lg w-full" />
                  <div className="h-2.5 bg-[#E5E5E5] rounded-lg w-3/4" />
                </div>
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-[#E5E5E5] rounded-lg w-36" />
                  <div className="h-2.5 bg-[#E5E5E5] rounded-lg w-24" />
                  <div className="h-2.5 bg-[#EFEFEF] rounded-lg w-full mt-3" />
                  <div className="h-2.5 bg-[#EFEFEF] rounded-lg w-5/6" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
