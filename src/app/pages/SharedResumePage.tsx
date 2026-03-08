import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { getSharedResume, getSharedResumeBySlug } from '../../lib/api';
import type { ResumeData, ResumeVersion } from '../../lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateRange(start: { month: number; year: number }, end: { month: number; year: number; present: boolean }) {
  return `${MONTHS[start.month - 1]} ${start.year} – ${end.present ? 'Present' : `${MONTHS[end.month - 1]} ${end.year}`}`;
}

export default function SharedResumePage() {
  const { token = '', shareSlug = '' } = useParams();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState<ResumeVersion | null>(null);

  useEffect(() => {
    const normalizedShareSlug = shareSlug.replace(/^\/+|\/+$/g, '');
    if (!token && !normalizedShareSlug) {
      setError('Invalid share link');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError('');
    const request = normalizedShareSlug
      ? getSharedResumeBySlug(normalizedShareSlug)
      : getSharedResume(token);
    void request
      .then((response) => {
        setVersion(response.version as ResumeVersion);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unable to load shared resume');
      })
      .finally(() => setIsLoading(false));
  }, [shareSlug, token]);

  const data = useMemo(() => (version?.data ?? null) as ResumeData | null, [version]);

  if (isLoading) return <div className="min-h-screen flex items-center justify-center text-sm text-[#6B6B6B] bg-white">Loading shared resume...</div>;
  if (error || !data) return <div className="min-h-screen flex items-center justify-center text-sm text-[#9B9B9B] bg-white">{error || 'Resume unavailable'}</div>;

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-[960px] mx-auto py-14 px-12 pb-32">
        <div className="mb-5">
          <div className="min-w-0 space-y-1">
            <p className="text-[#1A1A1A] text-[22px] leading-tight">{data.name}</p>
            <p className="text-base text-[#6B6B6B] leading-tight">{data.title}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 mb-10 text-sm text-[#6B6B6B]">
          {[data.contact.email, data.contact.phone, data.contact.location, data.contact.website, data.contact.linkedin].filter(Boolean).map((item, index) => (
            <span key={`${item}-${index}`}>{index > 0 ? '• ' : ''}{item}</span>
          ))}
        </div>

        <div className="h-px bg-[#EFEFEF] mb-7" />
        {data.bio?.trim() && (
          <section className="mb-7">
            <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-4">About</p>
            <p className="text-sm text-[#2B2B2B] leading-relaxed whitespace-pre-wrap">{data.bio}</p>
          </section>
        )}

        {data.workExperience?.length > 0 && (
          <section className="mb-7">
            <div className="h-px bg-[#EFEFEF] mb-7" />
            <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Work Experience</p>
            <div className="space-y-6">
              {data.workExperience.map((exp) => (
                <div key={exp.id} className="flex gap-10">
                  <div className="w-44 shrink-0 pt-0.5">
                    <p className="text-xs text-[#9B9B9B] leading-snug whitespace-nowrap">{formatDateRange(exp.startDate, exp.endDate)}</p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1A1A1A] leading-tight">{exp.role}</p>
                    <p className="text-sm text-[#6B6B6B] mt-1">{exp.company}</p>
                    <ul className="mt-4 space-y-0.5">
                      {exp.bullets.map((bullet, idx) => (
                        <li key={`${exp.id}-${idx}`} className="flex items-start gap-3">
                          <span className="text-[#CBCBCB] shrink-0 mt-px select-none text-sm">–</span>
                          <span className="text-sm text-[#2B2B2B] leading-relaxed">{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {data.education?.length > 0 && (
          <section className="mb-7">
            <div className="h-px bg-[#EFEFEF] mb-7" />
            <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Education</p>
            <div className="space-y-5">
              {data.education.map((edu) => (
                <div key={edu.id} className="flex gap-10">
                  <div className="w-44 shrink-0 pt-0.5">
                    <p className="text-xs text-[#9B9B9B] leading-snug whitespace-nowrap">{formatDateRange(edu.startDate, edu.endDate)}</p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1A1A1A] leading-tight">{edu.degree}</p>
                    <p className="text-sm text-[#6B6B6B] mt-1">{edu.school}</p>
                    {edu.location && <p className="text-xs text-[#8B8B8B] mt-1">{edu.location}</p>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {data.skills?.length > 0 && (
          <section>
            <div className="h-px bg-[#EFEFEF] mb-7" />
            <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-5">Skills</p>
            <div className="flex flex-wrap gap-2">
              {data.skills.map((skill, idx) => (
                <span key={`${skill}-${idx}`} className="px-4 py-1.5 bg-[#F5F5F5] rounded-full text-sm text-[#2B2B2B]">{skill}</span>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="fixed bottom-8 inset-x-0 flex justify-center pointer-events-none">
        <button
          onClick={() => navigate('/')}
          className="pointer-events-auto inline-flex items-center rounded-full border border-[#DADADA] bg-[#F8F8F8] px-5 py-2 shadow-[0_14px_34px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.6)] hover:bg-white transition-colors"
        >
          <span className="text-sm text-[#2B2B2B]" style={{ fontWeight: 700 }}>cv stack</span>
        </button>
      </div>
    </div>
  );
}
