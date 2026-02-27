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
      className="h-screen overflow-hidden bg-[#d8dce2]"
    >
      <div className="relative h-full overflow-hidden border border-white/70 bg-[#f3f5f8] shadow-[0_8px_44px_rgba(107,117,137,0.2)]">
        <div className="pointer-events-none absolute inset-0 opacity-[0.55] [background-image:radial-gradient(rgba(255,255,255,0.92)_1px,transparent_1px)] [background-size:26px_26px]" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,rgba(255,255,255,0.7)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.65)_1px,transparent_1px)] [background-size:46px_46px]" />
        <div className="pointer-events-none absolute -left-24 bottom-[-14%] h-[46%] w-[44%] rounded-full bg-[radial-gradient(circle,_rgba(255,146,208,0.82)_0%,_rgba(255,146,208,0)_72%)] blur-2xl" />
        <div className="pointer-events-none absolute left-[28%] bottom-[-18%] h-[56%] w-[42%] rounded-full bg-[radial-gradient(circle,_rgba(176,133,255,0.65)_0%,_rgba(176,133,255,0)_72%)] blur-3xl" />
        <div className="pointer-events-none absolute right-[-8%] bottom-[-16%] h-[62%] w-[48%] rounded-full bg-[radial-gradient(circle,_rgba(118,174,255,0.72)_0%,_rgba(118,174,255,0)_72%)] blur-2xl" />

        {/* Nav */}
        <div className="relative z-20 px-6 py-5 md:px-9 md:py-6 flex items-center justify-between">
          <img src={cvLogo} alt="CV Stack" className="w-6 h-6 object-contain" />
          <button
            onClick={() => navigate('/login')}
            className="text-sm text-[#656d7f] hover:text-[#151923] transition-colors"
          >
            Sign in
          </button>
        </div>

        {/* Hero */}
        <div className="relative z-20 flex-1 min-h-0 flex items-start justify-center px-7 pt-14 md:px-8 md:pt-16">
          <div className="text-center max-w-xl">
            <p className="text-xs uppercase tracking-[0.28em] text-[#b0b6c4] mb-6 leading-relaxed">
              <span className="sm:hidden">
                BUILD.<br />STACK.<br />STORE.
              </span>
              <span className="hidden sm:inline">BUILD. STACK. STORE.</span>
            </p>
            <h1 className="text-[42px] md:text-[56px] tracking-tight text-[#101420] mb-4 leading-[1.05]">
              Your Resume.<br />Leveled Up.
            </h1>
            <p className="text-[15px] md:text-base text-[#5e6677] mb-10 leading-relaxed">
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
              className="bg-[#101420] text-white px-8 py-3 rounded-[14px] text-sm hover:bg-black transition-colors shadow-[0_14px_30px_rgba(16,20,32,0.32)]"
            >
              Start Stacking →
            </button>
            <p className="text-xs text-[#afb6c4] mt-4">Free to try · No credit card needed</p>
          </div>
        </div>

        {/* Exaggerated workspace backdrop */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center">
          <div className="relative h-[230px] w-[94%] max-w-[980px] md:h-[320px] [perspective:1200px]">
            <motion.div
              initial={{ opacity: 0, y: 36, rotateX: 22 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              transition={{ duration: 0.6, delay: 0.05, ease: 'easeOut' }}
              className="absolute bottom-3 left-1/2 h-[78%] w-[92%] -translate-x-1/2 rotate-[-3deg] rounded-[20px] border border-white/80 bg-white/86 shadow-[0_24px_90px_rgba(79,93,126,0.33)] backdrop-blur-md md:bottom-4 md:h-[84%] md:rounded-[24px]"
            >
              <div className="flex h-full">
                <div className="w-[30%] border-r border-[#e9edf4] bg-[#f9fbfe]/90 p-3 md:p-4">
                  <div className="h-2.5 w-16 rounded-full bg-[#d8deea]" />
                  <div className="mt-4 space-y-2.5">
                    <div className="h-2 w-[88%] rounded-full bg-[#c8d2e5]" />
                    <div className="h-2 w-[70%] rounded-full bg-[#d9e1f0]" />
                    <div className="h-2 w-[80%] rounded-full bg-[#d2dbec]" />
                  </div>
                  <div className="mt-5 h-14 rounded-xl bg-[linear-gradient(120deg,#fbe2f3,#ddedff)] md:h-20" />
                </div>
                <div className="flex-1 p-3 md:p-4">
                  <div className="mb-3 h-8 rounded-lg bg-[#f3f6fb]" />
                  <div className="grid grid-cols-3 gap-2 md:gap-3">
                    <div className="h-14 rounded-lg bg-[#f9c7e3]/70 md:h-20" />
                    <div className="h-14 rounded-lg bg-[#d0c5ff]/65 md:h-20" />
                    <div className="h-14 rounded-lg bg-[#bfdcff]/70 md:h-20" />
                    <div className="col-span-2 h-20 rounded-xl bg-[#f7f9fc] md:h-28" />
                    <div className="h-20 rounded-xl bg-[#edf4ff] md:h-28" />
                  </div>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.25 }}
              className="absolute left-[8%] top-[50%] rounded-full border border-white/90 bg-white/93 px-3.5 py-2 shadow-[0_10px_30px_rgba(77,89,117,0.2)] md:left-[5%] md:px-4 md:py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <div className="h-5 w-5 rounded-full bg-[#f8b0d7]" />
                <div className="space-y-1">
                  <div className="h-1.5 w-20 rounded-full bg-[#ced7e8]" />
                  <div className="h-1.5 w-14 rounded-full bg-[#dbe3f0]" />
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.3 }}
              className="absolute right-[9%] top-[34%] rounded-full border border-white/90 bg-white/94 px-3 py-2 shadow-[0_14px_34px_rgba(77,89,117,0.2)] md:right-[6%] md:px-4 md:py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <div className="h-5 w-5 rounded-full bg-[#9dc2ff]" />
                <div className="space-y-1">
                  <div className="h-1.5 w-24 rounded-full bg-[#ced7e8]" />
                  <div className="h-1.5 w-16 rounded-full bg-[#dbe3f0]" />
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
