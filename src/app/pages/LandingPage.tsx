import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import cvLogo from '../assets/branding/cv-logo.svg';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-screen overflow-hidden bg-white flex flex-col"
    >
      {/* Nav */}
      <div className="px-8 py-5 flex items-center justify-between border-b border-[#F0F0F0]">
        <img src={cvLogo} alt="CV Stack" className="w-6 h-6 object-contain" />
        <button
          onClick={() => navigate('/login')}
          className="text-sm text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors"
        >
          Sign in
        </button>
      </div>

      {/* Hero */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-8 py-10">
        <div className="text-center max-w-xl">
          <p className="text-xs uppercase tracking-widest text-[#CBCBCB] mb-6 leading-relaxed">
            <span className="sm:hidden">
              BUILD.<br />STACK.<br />STORE.
            </span>
            <span className="hidden sm:inline">BUILD. STACK. STORE.</span>
          </p>
          <h1 className="text-[40px] tracking-tight text-[#1A1A1A] mb-4 leading-[1.15]">
            Your Resume.<br />Leveled Up.
          </h1>
          <p className="text-base text-[#6B6B6B] mb-10 leading-relaxed">
            <span className="sm:hidden">
              Stop rewriting. Start stacking.<br />
              Tailor your resume intentionally<br />
              with AI-powered suggestions.
            </span>
            <span className="hidden sm:inline">
              Stop rewriting. Start stacking. Tailor your resume intentionally with AI-powered suggestions.
            </span>
          </p>
          <button
            onClick={() => navigate('/start')}
            className="bg-[#1A1A1A] text-white px-8 py-3 rounded-[12px] text-sm hover:bg-black transition-colors"
          >
            Start Stacking ->
          </button>
          <p className="text-xs text-[#CBCBCB] mt-4">Free to try · No credit card needed</p>
        </div>
      </div>
    </motion.div>
  );
}
