import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import {
  Plus, Sparkles, Check, X, Settings, LogOut, ChevronDown, ChevronRight,
  Copy, GripVertical, MoreHorizontal, RefreshCw, FileText, Upload,
  Paperclip, ExternalLink,
} from 'lucide-react';
import { clearAuthStorage, createVersion, listResumes, listVersions, userStore, updateVersion } from '../../lib/api';
import type { AIChange, Certification, ContactInfo, DateValue, EducationEntry, ResumeData, ResumeVersion, WorkExperience } from '../../lib/types';
import { useAuthGate } from '../components/AuthGate';

// ─── Types ─────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Utilities ─────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 1);
function calcDurationFromDates(start: DateValue, end: DateValue): string {
  const endD = end.present ? NOW : new Date(end.year, end.month - 1);
  const startD = new Date(start.year, start.month - 1);
  const total = (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth());
  if (total <= 0) return '';
  const yrs = Math.floor(total / 12); const mos = total % 12;
  const out: string[] = [];
  if (yrs > 0) out.push(`${yrs} yr${yrs !== 1 ? 's' : ''}`);
  if (mos > 0) out.push(`${mos} mo${mos !== 1 ? 's' : ''}`);
  return out.join(' ');
}
function formatDateRange(s: DateValue, e: DateValue) { return `${MONTHS[s.month - 1]} ${s.year} – ${e.present ? 'Present' : `${MONTHS[e.month - 1]} ${e.year}`}`; }
function formatMonthYear(m: number, y: number) { return `${MONTHS[m - 1]} ${y}`; }
function getSectionKey(c: AIChange) { return c.field === 'bio' ? 'bio' : `${c.expId}-${c.bulletIdx}`; }
function getChangeLabel(c: AIChange, d: ResumeData) {
  if (c.field === 'bio') return 'About';
  if (c.field === 'bullet' && c.expId) { const exp = d.workExperience.find(e => e.id === c.expId); return exp ? `${exp.company} · Bullet ${(c.bulletIdx ?? 0) + 1}` : 'Experience'; }
  return 'Suggestion';
}
function buildTextResume(data: ResumeData): string {
  const lines: string[] = [data.name, data.title, [data.contact.email, data.contact.phone, data.contact.location].filter(Boolean).join(' | '), '', 'ABOUT', data.bio, '', 'WORK EXPERIENCE'];
  (data.workExperience ?? []).forEach(exp => { lines.push('', `${exp.role} at ${exp.company}`, formatDateRange(exp.startDate, exp.endDate)); exp.bullets.forEach(b => lines.push(`• ${b}`)); });
  lines.push('', 'EDUCATION');
  (data.education ?? []).forEach(edu => { lines.push('', `${edu.degree} — ${edu.school}`); if (edu.location) lines.push(edu.location); });
  lines.push('', 'SKILLS', (data.skills ?? []).join(', '));
  return lines.join('\n');
}

// ─── Mock Data ──────────────────────────────────────────────────────────────────

const BASE_CONTACT: ContactInfo = { email: 'alex@johnson.co', phone: '+1 415 555 0100', location: 'San Francisco, CA', website: 'alexjohnson.co', linkedin: 'linkedin.com/in/alexjohnson' };
const BASE_DATA: ResumeData = {
  name: 'Alex Johnson', title: 'Senior Product Designer', contact: BASE_CONTACT,
  bio: 'Passionate about creating intuitive digital experiences that solve real user problems. 8+ years of experience in product design, UX research, and design systems.',
  workExperience: [
    { id: 'exp1', company: 'TechCorp Inc.', role: 'Senior Product Designer', startDate: { month: 12, year: 2021, present: false }, endDate: { month: 1, year: 2026, present: true }, bullets: ['Led redesign of main dashboard, improving user engagement by 40%', 'Established design system used across 5 product teams', 'Mentored 3 junior designers'] },
    { id: 'exp2', company: 'StartupCo', role: 'Product Designer', startDate: { month: 3, year: 2018, present: false }, endDate: { month: 1, year: 2021, present: false }, bullets: ['Designed mobile app from 0 to 1, reached 100k users', 'Conducted user research with 50+ customers'] },
  ],
  education: [{ id: 'edu1', school: 'Design University', degree: 'BFA in Graphic Design', location: 'San Francisco, CA', startDate: { month: 9, year: 2014, present: false }, endDate: { month: 5, year: 2018, present: false } }],
  certifications: [{ id: 'cert1', name: 'Google UX Design Certificate', organization: 'Google', issuedMonth: 3, issuedYear: 2022, credentialId: 'GUX-2022-AJ' }],
  skills: ['Figma', 'Prototyping', 'User Research', 'Design Systems', 'React'],
};
const makeVariant = (bio: string, bullets0: string[]): ResumeData => ({ ...BASE_DATA, contact: { ...BASE_CONTACT }, bio, workExperience: [{ ...BASE_DATA.workExperience[0], bullets: bullets0 }, BASE_DATA.workExperience[1]] });
const STRIPE_DATA = makeVariant('Strategic product designer with 8+ years shaping fintech and payment UX. Known for scaling design systems and leading cross-functional teams.', ['Spearheaded end-to-end dashboard redesign, driving 40% lift in DAU and 25% drop in task completion time', 'Architected a scalable design system adopted across 5 product teams, enabling 3× faster feature delivery', 'Mentored 3 junior designers, establishing critique culture that elevated overall team output']);
const AIRBNB_DATA = makeVariant('Creative product designer crafting seamless marketplace experiences. Specialises in 0-to-1 product development.', ['Led host experience redesign, improving listing completion rate by 35% across mobile and web', 'Built and maintained multi-platform design system used by 8 product teams globally', 'Mentored 3 junior designers and established a weekly design critique cadence']);
const META_DATA = makeVariant('Systems-thinking product designer with 8+ years building at scale for consumer platforms.', ['Led redesign of core dashboard serving 2M+ users, increasing engagement by 40% and reducing churn by 18%', 'Built and maintained design system adopted by 5 teams, cutting design-to-dev handoff time by 60%', "Mentored 3 designers to senior level, fostering a critique-driven culture"]);

let versionCounter = 3;
function generateAIVersion(jobTitle: string, jobCompany: string, jobDescription = '', jobLink = ''): ResumeVersion {
  const ts = Date.now();
  const changes: AIChange[] = [
    { id: `c-bio-${ts}`, field: 'bio', original: BASE_DATA.bio, suggested: 'Strategic product designer with 8+ years shaping fintech and SaaS experiences. Known for building scalable design systems and leading cross-functional teams to ship products with measurable business impact.', status: 'pending' },
    { id: `c-b0-${ts}`, field: 'bullet', expId: 'exp1', bulletIdx: 0, original: BASE_DATA.workExperience[0].bullets[0], suggested: 'Spearheaded end-to-end dashboard redesign, driving 40% lift in daily active users and 25% reduction in task completion time, contributing to $2.4M ARR growth', status: 'pending' },
    { id: `c-b1-${ts}`, field: 'bullet', expId: 'exp1', bulletIdx: 1, original: BASE_DATA.workExperience[0].bullets[1], suggested: 'Architected scalable design system adopted across 5 product teams, enabling 3× faster feature delivery and cutting design-to-dev handoff by 60%', status: 'pending' },
  ];
  versionCounter++;
  return { id: `ai-v${versionCounter}-${ts}`, name: jobCompany ? `${jobTitle} @ ${jobCompany}` : jobTitle, isAI: true, matchScore: 82, jobTitle, jobCompany: jobCompany || 'Company', jobDescription, jobLink, data: { ...BASE_DATA, contact: { ...BASE_CONTACT } }, aiChanges: changes };
}
const INITIAL_VERSIONS: ResumeVersion[] = [
  { id: 'base', name: 'Base Resume', isAI: false, data: BASE_DATA, aiChanges: [] },
  { id: 'stripe-v1', name: 'Product Designer @ Stripe', isAI: true, matchScore: 82, jobTitle: 'Product Designer', jobCompany: 'Stripe', jobDescription: 'We are looking for a Senior Product Designer to join our Payments team. You will shape the future of financial infrastructure by designing elegant, intuitive experiences for millions of users worldwide. Requirements: 6+ years product design, strong systems thinking, experience with complex B2B products.', jobLink: 'https://stripe.com/jobs', data: STRIPE_DATA, aiChanges: [] },
  { id: 'airbnb-v1', name: 'Product Designer @ Airbnb', isAI: true, matchScore: 74, jobTitle: 'Product Designer', jobCompany: 'Airbnb', data: AIRBNB_DATA, aiChanges: [] },
  { id: 'meta-v1', name: 'Frontend Engineer @ Meta', isAI: true, matchScore: 78, jobTitle: 'Frontend Engineer', jobCompany: 'Meta', data: META_DATA, aiChanges: [] },
];
function applyChange(change: AIChange, d: ResumeData): ResumeData {
  if (change.field === 'bio') return { ...d, bio: change.suggested };
  if (change.field === 'bullet' && change.expId && change.bulletIdx !== undefined) {
    return { ...d, workExperience: d.workExperience.map(exp => { if (exp.id !== change.expId) return exp; const bullets = [...exp.bullets]; bullets[change.bulletIdx!] = change.suggested; return { ...exp, bullets }; }) };
  }
  return d;
}

// ─── Toast ──────────────────────────────────────────────────────────────────────

function Toast({ message, visible }: { message: string; visible: boolean }) {
  return (
    <div className={`fixed bottom-28 left-1/2 -translate-x-1/2 z-[100] transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
      <div className="bg-[#1A1A1A] text-white px-4 py-2.5 rounded-[10px] shadow-lg whitespace-nowrap flex items-center gap-2" style={{ fontSize: 13 }}>
        <Check size={13} className="text-[#4ADE80]" />{message}
      </div>
    </div>
  );
}

// ─── InlineText ─────────────────────────────────────────────────────────────────

function InlineText({ value, onChange, className = '', placeholder = 'Click to edit', onFocusChange }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; onFocusChange?: (f: boolean) => void }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  const save = () => { setEditing(false); onFocusChange?.(false); if (local !== value) onChange(local); };
  return (
    <div className={className}>
      {editing
        ? <input ref={ref} value={local} onChange={e => setLocal(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setLocal(value); setEditing(false); onFocusChange?.(false); } }} className="w-full bg-[#F5F5F5] border-0 border-b border-[#D0D0D0] outline-none px-1 py-0.5" style={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit', lineHeight: 'inherit', fontWeight: 'inherit' }} />
        : <span onClick={() => { setEditing(true); onFocusChange?.(true); }} className="cursor-text hover:bg-[#F5F5F5] rounded-[4px] px-1 -mx-1 transition-colors inline-block w-full">{local || <span className="text-[#D0D0D0]">{placeholder}</span>}</span>}
    </div>
  );
}

// ─── InlineArea ─────────────────────────────────────────────────────────────────

function InlineArea({ value, onChange, className = '', placeholder = 'Click to edit' }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.style.height = 'auto'; ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [editing]);
  const save = () => { setEditing(false); if (local !== value) onChange(local); };
  return (
    <div className={className}>
      {editing
        ? <textarea ref={ref} value={local} onChange={e => { setLocal(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} onBlur={save} onKeyDown={e => { if (e.key === 'Escape') { setLocal(value); setEditing(false); } }} className="w-full bg-[#F5F5F5] outline-none resize-none overflow-hidden px-2 py-1.5 leading-relaxed rounded-[8px]" style={{ fontSize: 'inherit', fontFamily: 'inherit', color: 'inherit' }} />
        : <p onClick={() => setEditing(true)} className="cursor-text hover:bg-[#F5F5F5] rounded-[8px] px-2 -mx-2 py-1.5 -my-1.5 transition-colors leading-relaxed">{local || <span className="text-[#D0D0D0]">{placeholder}</span>}</p>}
    </div>
  );
}

// ─── BulletInlineArea ─────────────────────────────────────────────────────────

function BulletInlineArea({ value, onChange, onDeleteOnEmpty, onFocusChange, onEnterNewBullet, autoEdit, onAutoEditConsumed }: { value: string; onChange: (v: string) => void; onDeleteOnEmpty?: () => void; onFocusChange?: (f: boolean) => void; onEnterNewBullet?: () => void; autoEdit?: boolean; onAutoEditConsumed?: () => void }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => { if (editing && ref.current) { const el = ref.current; el.focus(); el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; const l = el.value.length; el.setSelectionRange(l, l); } }, [editing]);
  useEffect(() => {
    if (autoEdit) {
      setEditing(true);
      onFocusChange?.(true);
      onAutoEditConsumed?.();
    }
  }, [autoEdit, onAutoEditConsumed, onFocusChange]);
  const resize = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
  const save = () => { setEditing(false); onFocusChange?.(false); if (local !== value) onChange(local); };
  if (editing) return <textarea ref={ref} value={local} rows={1} onChange={e => { setLocal(e.target.value); resize(e.target); }} onBlur={save} onKeyDown={e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (local !== value) onChange(local);
      setEditing(false);
      onFocusChange?.(false);
      onEnterNewBullet?.();
      return;
    }
    if (e.key === 'Escape') { setLocal(value); setEditing(false); onFocusChange?.(false); }
    if (e.key === 'Backspace' && local === '' && onDeleteOnEmpty) { e.preventDefault(); onDeleteOnEmpty(); }
  }} className="w-full bg-transparent outline-none resize-none overflow-hidden text-sm text-[#2B2B2B] leading-relaxed" style={{ fontFamily: 'inherit', minHeight: '1.5em' }} />;
  return <span onClick={() => { setEditing(true); onFocusChange?.(true); }} className="cursor-text inline-block w-full text-sm text-[#2B2B2B] leading-relaxed whitespace-pre-wrap break-words min-h-[1.5em]">{local || <span className="text-[#D0D0D0] not-italic">Add bullet text…</span>}</span>;
}

// ─── ContactInlineField ─────────────────────────────────────────────────────────

function ContactInlineField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [editing, setEditing] = useState(false); const [local, setLocal] = useState(value); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setLocal(value); }, [value]); useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const save = () => { setEditing(false); if (local !== value) onChange(local); };
  if (editing) return <input ref={ref} value={local} onChange={e => setLocal(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setLocal(value); setEditing(false); } }} placeholder={placeholder} className="outline-none border-b border-[#D0D0D0] bg-[#F5F5F5] text-sm text-[#6B6B6B] px-0.5" style={{ width: `${Math.max(local.length, placeholder.length) * 7.5 + 8}px`, minWidth: 60 }} />;
  if (!value) return <span onClick={() => setEditing(true)} className="cursor-text text-sm text-[#D0D0D0] hover:text-[#CBCBCB] italic">{placeholder}</span>;
  return <span onClick={() => setEditing(true)} className="cursor-text text-sm text-[#6B6B6B] hover:bg-[#F5F5F5] rounded-[3px] px-0.5 transition-colors">{value}</span>;
}

// ─── SkillPill + SkillsEditor ────────────────────────────────────────────────

function SkillPill({ skill, onDelete }: { skill: string; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  return <div className="flex items-center gap-1 px-3 py-1.5 bg-[#F5F5F5] rounded-[8px] text-sm text-[#2B2B2B]" onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>{skill}<button onClick={onDelete} className={`ml-0.5 text-[#AAAAAA] hover:text-[#444] transition-all ${hov ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}><X size={11} /></button></div>;
}
function SkillsEditor({ skills, onUpdate }: { skills: string[]; onUpdate: (s: string[]) => void }) {
  const [adding, setAdding] = useState(false); const [input, setInput] = useState(''); const ref = useRef<HTMLInputElement>(null);
  const maxSkills = 8;
  useEffect(() => { if (adding) ref.current?.focus(); }, [adding]);
  const submit = () => {
    const t = input.trim();
    if (t && skills.length < maxSkills && !skills.some((s) => s.toLowerCase() === t.toLowerCase())) {
      onUpdate([...skills, t].slice(0, maxSkills));
    }
    setInput('');
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {skills.map((s, i) => <SkillPill key={i} skill={s} onDelete={() => onUpdate(skills.filter((_, j) => j !== i))} />)}
      {adding && skills.length < maxSkills
        ? <input ref={ref} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Backspace' && input === '') setAdding(false); if (e.key === 'Escape') { setInput(''); setAdding(false); } }} onBlur={submit} placeholder="Type a skill…" className="px-3 py-1.5 bg-[#F0F0F0] rounded-[8px] text-sm text-[#2B2B2B] outline-none min-w-[120px]" />
        : <button onClick={() => setAdding(true)} disabled={skills.length >= maxSkills} className="px-3 py-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{skills.length >= maxSkills ? 'Max 8 skills' : '+ Add Skill'}</button>}
    </div>
  );
}

// ─── MonthGridPicker ─────────────────────────────────────────────────────────

function MonthGridPicker({ year, month, onSelect }: { year: number; month: number; onSelect: (m: number, y: number) => void }) {
  const [dy, setDy] = useState(year);
  const [mode, setMode] = useState<'month' | 'year'>('month');
  useEffect(() => { setDy(year); }, [year]);
  const yearBase = Math.floor(dy / 12) * 12;
  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-3">
        <button onClick={e => { e.stopPropagation(); setDy(y => y + (mode === 'month' ? -1 : -12)); }} className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#9B9B9B] hover:text-[#1A1A1A] hover:bg-[#F0F0F0] transition-colors select-none" style={{ fontSize: 16 }}>‹</button>
        <button onClick={e => { e.stopPropagation(); setMode(m => m === 'month' ? 'year' : 'month'); }} className="text-sm text-[#1A1A1A] hover:text-black transition-colors">{dy}</button>
        <button onClick={e => { e.stopPropagation(); setDy(y => y + (mode === 'month' ? 1 : 12)); }} className="w-6 h-6 flex items-center justify-center rounded-[4px] text-[#9B9B9B] hover:text-[#1A1A1A] hover:bg-[#F0F0F0] transition-colors select-none" style={{ fontSize: 16 }}>›</button>
      </div>
      {mode === 'month' ? (
        <div className="grid grid-cols-4 gap-1">
          {MONTHS.map((m, i) => <button key={m} onClick={e => { e.stopPropagation(); onSelect(i + 1, dy); }} className={`py-2 text-xs rounded-[6px] transition-colors ${i + 1 === month && dy === year ? 'bg-[#1A1A1A] text-white' : 'text-[#2B2B2B] hover:bg-[#F0F0F0]'}`}>{m}</button>)}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 12 }).map((_, i) => {
            const y = yearBase + i;
            return (
              <button key={y} onClick={e => { e.stopPropagation(); setDy(y); setMode('month'); }} className={`py-2 text-xs rounded-[6px] transition-colors ${y === year ? 'bg-[#1A1A1A] text-white' : 'text-[#2B2B2B] hover:bg-[#F0F0F0]'}`}>{y}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── DateRangeEditor & MonthYearEditor ──────────────────────────────────────

function DateRangeEditor({ startDate, endDate, onChangeStart, onChangeEnd }: { startDate: DateValue; endDate: DateValue; onChangeStart: (v: DateValue) => void; onChangeEnd: (v: DateValue) => void; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-full mt-2 w-[220px] bg-white border border-[#E5E5E5] rounded-[12px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-4 z-[60] animate-[fadeInDown_150ms_ease-out]">
      <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA] mb-3">Start</p>
      <MonthGridPicker year={startDate.year} month={startDate.month} onSelect={(m, y) => onChangeStart({ ...startDate, month: m, year: y })} />
      <div className="mt-4 pt-4 border-t border-[#F0F0F0]">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA]">End</p>
          <button onClick={e => { e.stopPropagation(); onChangeEnd({ ...endDate, present: !endDate.present }); }} className="flex items-center gap-2">
            <div className={`relative w-8 h-4 rounded-full transition-colors ${endDate.present ? 'bg-[#1A1A1A]' : 'bg-[#DDDDDD]'}`}><div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${endDate.present ? 'translate-x-4' : 'translate-x-0'}`} /></div>
            <span className="text-xs text-[#6B6B6B]">Present</span>
          </button>
        </div>
        {!endDate.present && <MonthGridPicker year={endDate.year} month={endDate.month} onSelect={(m, y) => onChangeEnd({ ...endDate, month: m, year: y })} />}
      </div>
    </div>
  );
}
function MonthYearEditor({ month, year, onChange, onClose }: { month: number; year: number; onChange: (m: number, y: number) => void; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-full mt-2 w-[200px] bg-white border border-[#E5E5E5] rounded-[12px] shadow-[0_8px_32px_rgba(0,0,0,0.1)] p-4 z-[60] animate-[fadeInDown_150ms_ease-out]">
      <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA] mb-3">Date Issued</p>
      <MonthGridPicker year={year} month={month} onSelect={(m, y) => onChange(m, y)} />
    </div>
  );
}

// ─── BulletRow ───────────────────────────────────────────────────────────────

function BulletRow({ bullet, isDragging, isHighlighted, onGripDragStart, onGripDragEnd, onChange, onDelete, onDuplicate, onEnterNewBullet, autoEdit, onAutoEditConsumed }: { bullet: string; isDragging: boolean; isHighlighted: boolean; onGripDragStart: (e: React.DragEvent) => void; onGripDragEnd: () => void; onChange: (v: string) => void; onDelete: () => void; onDuplicate: () => void; onEnterNewBullet: () => void; autoEdit?: boolean; onAutoEditConsumed?: () => void }) {
  const [rowHov, setRowHov] = useState(false); const [active, setActive] = useState(false); const [showMenu, setShowMenu] = useState(false); const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!showMenu) return; const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [showMenu]);
  return (
    <div className={`flex items-start gap-1 rounded-[6px] -mx-2 px-2 py-0.5 transition-colors duration-300 ${isDragging ? 'opacity-30' : ''} ${active || isHighlighted ? 'bg-[#F5F5F5]' : ''}`} onMouseEnter={() => setRowHov(true)} onMouseLeave={() => { if (!showMenu) setRowHov(false); }}>
      <div draggable onDragStart={onGripDragStart} onDragEnd={onGripDragEnd} className={`shrink-0 mt-[3px] cursor-grab active:cursor-grabbing text-[#D4D4D4] hover:text-[#9B9B9B] transition-opacity ${rowHov ? 'opacity-100' : 'opacity-0'}`}><GripVertical size={13} /></div>
      <span className="text-[#CBCBCB] shrink-0 mt-px select-none text-sm">–</span>
      <div className="flex-1 min-w-0"><BulletInlineArea value={bullet} onChange={onChange} onDeleteOnEmpty={onDelete} onFocusChange={f => setActive(f)} onEnterNewBullet={onEnterNewBullet} autoEdit={autoEdit} onAutoEditConsumed={onAutoEditConsumed} /></div>
      <div className="relative shrink-0" ref={menuRef}>
        <button onClick={() => setShowMenu(!showMenu)} className={`p-0.5 rounded text-[#CBCBCB] hover:text-[#6B6B6B] transition-opacity mt-0.5 ${rowHov || showMenu ? 'opacity-100' : 'opacity-0'}`}><MoreHorizontal size={13} /></button>
        {showMenu && <div className="absolute right-0 top-6 w-28 bg-white border border-[#EBEBEB] rounded-[10px] shadow-[0_4px_16px_rgba(0,0,0,0.08)] overflow-hidden z-50 animate-[fadeInDown_150ms_ease-out]"><button onClick={() => { onDuplicate(); setShowMenu(false); setRowHov(false); }} className="w-full text-left px-3 py-2.5 text-sm text-[#2B2B2B] hover:bg-[#F7F7F8]">Duplicate</button><div className="h-px bg-[#F0F0F0]" /><button onClick={() => { onDelete(); setShowMenu(false); }} className="w-full text-left px-3 py-2.5 text-sm text-red-500 hover:bg-red-50">Delete</button></div>}
      </div>
    </div>
  );
}

// ─── ExperienceBlock ─────────────────────────────────────────────────────────

function ExperienceBlock({ exp, onUpdateExp, onDeleteExp, onDragStartExperience, onDragEndExperience, isDraggingExperience, highlightedSectionKey, registerBulletRef, onShowToast }: { exp: WorkExperience; onUpdateExp: (e: WorkExperience) => void; onDeleteExp: () => void; onDragStartExperience: (e: React.DragEvent) => void; onDragEndExperience: () => void; isDraggingExperience: boolean; highlightedSectionKey: string | null; registerBulletRef: (key: string, el: HTMLElement | null) => void; onShowToast: (msg: string) => void }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null); const [dragTarget, setDragTarget] = useState<number | null>(null); const [showCopyTip, setShowCopyTip] = useState(false); const [editingDate, setEditingDate] = useState(false); const [autoEditBulletIdx, setAutoEditBulletIdx] = useState<number | null>(null); const dateColRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const updateBullets = (bullets: string[]) => onUpdateExp({ ...exp, bullets });
  const insertBulletAfter = (idx: number) => {
    const next = [...exp.bullets];
    next.splice(idx + 1, 0, '');
    updateBullets(next);
    setAutoEditBulletIdx(idx + 1);
  };
  const handleDrop = (toIdx: number) => { if (dragFrom === null || dragFrom === toIdx) { setDragFrom(null); setDragTarget(null); return; } const next = [...exp.bullets]; const [moved] = next.splice(dragFrom, 1); next.splice(toIdx, 0, moved); updateBullets(next); setDragFrom(null); setDragTarget(null); };
  const duration = calcDurationFromDates(exp.startDate, exp.endDate);
  return (
    <div className={`flex gap-10 group/exp transition-opacity ${isDraggingExperience ? 'opacity-35' : 'opacity-100'}`}>
      <div className="w-4 shrink-0 self-start pt-0.5">
        <button
          draggable
          onDragStart={onDragStartExperience}
          onDragEnd={onDragEndExperience}
          className="opacity-0 group-hover/exp:opacity-100 text-[#CBCBCB] hover:text-[#6B6B6B] transition-all p-0.5 cursor-grab active:cursor-grabbing"
        >
          <GripVertical size={12} />
        </button>
      </div>
      <div className="w-44 shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        <div onClick={() => setEditingDate(!editingDate)} className="cursor-pointer"><p className="text-xs text-[#9B9B9B] leading-snug hover:text-[#6B6B6B] transition-colors whitespace-nowrap">{formatDateRange(exp.startDate, exp.endDate)}</p>{duration && <p className="mt-1" style={{ fontSize: 11, color: '#C4C4C4' }}>{duration}</p>}</div>
        {editingDate && <DateRangeEditor startDate={exp.startDate} endDate={exp.endDate} onChangeStart={v => onUpdateExp({ ...exp, startDate: v })} onChangeEnd={v => onUpdateExp({ ...exp, endDate: v })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2 group/role mb-0.5">
          <div className="flex-1 min-w-0"><InlineText value={exp.role} onChange={v => onUpdateExp({ ...exp, role: v })} className="text-sm text-[#1A1A1A]" /></div>
          <div className="relative shrink-0 mt-0.5 flex items-center gap-1">
            <button onClick={() => { const text = [`${exp.role} at ${exp.company}`, formatDateRange(exp.startDate, exp.endDate), '', ...exp.bullets.map(b => `• ${b}`)].join('\n'); navigator.clipboard.writeText(text).catch(() => {}); onShowToast('Copied to clipboard'); }} onMouseEnter={() => setShowCopyTip(true)} onMouseLeave={() => setShowCopyTip(false)} className="opacity-0 group-hover/role:opacity-100 text-[#CBCBCB] hover:text-[#6B6B6B] transition-all p-0.5"><Copy size={12} /></button>
            {showCopyTip && <div className="absolute right-0 top-6 bg-[#1A1A1A] text-white rounded-[6px] px-2 py-1 whitespace-nowrap pointer-events-none z-50" style={{ fontSize: 11 }}>Copy role</div>}
          </div>
        </div>
        <div className="mb-4"><InlineText value={exp.company} onChange={v => onUpdateExp({ ...exp, company: v })} className="text-sm text-[#6B6B6B]" /></div>
        <ul className="space-y-0.5">
          {exp.bullets.map((bullet, idx) => {
            const key = `${exp.id}-${idx}`;
            return (
              <li key={idx} ref={el => registerBulletRef(key, el)} className={`border-t-2 transition-colors ${dragTarget === idx && dragFrom !== null && dragFrom !== idx ? 'border-[#BFBFBF]' : 'border-transparent'}`} onDragOver={e => { e.preventDefault(); if (dragFrom !== null && dragFrom !== idx) setDragTarget(idx); }} onDrop={() => handleDrop(idx)} onDragLeave={() => setDragTarget(null)}>
                <BulletRow bullet={bullet} isDragging={dragFrom === idx} isHighlighted={highlightedSectionKey === key} onGripDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragFrom(idx); }} onGripDragEnd={() => { setDragFrom(null); setDragTarget(null); }} onChange={v => { const n = [...exp.bullets]; n[idx] = v; updateBullets(n); }} onDelete={() => updateBullets(exp.bullets.filter((_, i) => i !== idx))} onDuplicate={() => { const n = [...exp.bullets]; n.splice(idx + 1, 0, bullet); updateBullets(n); }} onEnterNewBullet={() => insertBulletAfter(idx)} autoEdit={autoEditBulletIdx === idx} onAutoEditConsumed={() => setAutoEditBulletIdx(null)} />
              </li>
            );
          })}
        </ul>
        <button onClick={() => updateBullets([...exp.bullets, ''])} className="mt-3 text-xs text-[#CBCBCB] hover:text-[#9B9B9B] transition-colors">+ Add bullet</button>
        <button onClick={onDeleteExp} className="block mt-2 text-xs text-[#CBCBCB] hover:text-red-400 transition-colors opacity-0 group-hover/exp:opacity-100">Remove</button>
      </div>
    </div>
  );
}

// ─── EducationBlock ──────────────────────────────────────────────────────────

function EducationBlock({ edu, onUpdateEdu, onDeleteEdu }: { edu: EducationEntry; onUpdateEdu: (e: EducationEntry) => void; onDeleteEdu: () => void }) {
  const [editingDate, setEditingDate] = useState(false); const dateColRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const duration = calcDurationFromDates(edu.startDate, edu.endDate);
  return (
    <div className="flex gap-10 group/edu">
      <div className="w-44 shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        <div onClick={() => setEditingDate(!editingDate)} className="cursor-pointer"><p className="text-xs text-[#9B9B9B] leading-snug hover:text-[#6B6B6B] transition-colors whitespace-nowrap">{formatDateRange(edu.startDate, edu.endDate)}</p>{duration && <p className="mt-1" style={{ fontSize: 11, color: '#C4C4C4' }}>{duration}</p>}</div>
        {editingDate && <DateRangeEditor startDate={edu.startDate} endDate={edu.endDate} onChangeStart={v => onUpdateEdu({ ...edu, startDate: v })} onChangeEnd={v => onUpdateEdu({ ...edu, endDate: v })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <InlineText value={edu.degree} onChange={v => onUpdateEdu({ ...edu, degree: v })} className="text-sm text-[#1A1A1A] mb-0.5" />
        <InlineText value={edu.school} onChange={v => onUpdateEdu({ ...edu, school: v })} className="text-sm text-[#6B6B6B]" />
        <InlineText value={edu.location} onChange={v => onUpdateEdu({ ...edu, location: v })} className="text-xs text-[#9B9B9B] mt-0.5" placeholder="Location" />
        <button onClick={onDeleteEdu} className="mt-2 text-xs text-[#CBCBCB] hover:text-red-400 transition-colors opacity-0 group-hover/edu:opacity-100">Remove</button>
      </div>
    </div>
  );
}

// ─── CertificationBlock ──────────────────────────────────────────────────────

function CertificationBlock({ cert, onUpdateCert, onDeleteCert }: { cert: Certification; onUpdateCert: (c: Certification) => void; onDeleteCert: () => void }) {
  const [editingDate, setEditingDate] = useState(false); const [showModal, setShowModal] = useState(false); const dateColRef = useRef<HTMLDivElement>(null); const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editingDate) return; const h = (e: MouseEvent) => { if (dateColRef.current && !dateColRef.current.contains(e.target as Node)) setEditingDate(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, [editingDate]);
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; onUpdateCert({ ...cert, fileUrl: URL.createObjectURL(file), fileName: file.name, fileType: file.type }); };
  return (
    <div className="flex gap-10 group/cert">
      <div className="w-44 shrink-0 self-start pt-0.5 relative" ref={dateColRef}>
        <div onClick={() => setEditingDate(!editingDate)} className="cursor-pointer"><p className="text-xs text-[#9B9B9B] hover:text-[#6B6B6B] transition-colors whitespace-nowrap">{formatMonthYear(cert.issuedMonth, cert.issuedYear)}</p></div>
        {editingDate && <MonthYearEditor month={cert.issuedMonth} year={cert.issuedYear} onChange={(m, y) => onUpdateCert({ ...cert, issuedMonth: m, issuedYear: y })} onClose={() => setEditingDate(false)} />}
      </div>
      <div className="flex-1 min-w-0">
        <InlineText value={cert.name} onChange={v => onUpdateCert({ ...cert, name: v })} className="text-sm text-[#1A1A1A] mb-0.5" />
        <InlineText value={cert.organization} onChange={v => onUpdateCert({ ...cert, organization: v })} className="text-sm text-[#6B6B6B]" />
        <InlineText value={cert.credentialId} onChange={v => onUpdateCert({ ...cert, credentialId: v })} className="text-xs text-[#9B9B9B] mt-1" placeholder="Credential ID" />
        {cert.fileUrl ? (
          <div className="mt-3 flex items-center gap-3"><div onClick={() => setShowModal(true)} className="w-12 h-12 rounded-[8px] overflow-hidden bg-[#F5F5F5] border border-[#EBEBEB] flex items-center justify-center cursor-pointer hover:border-[#CBCBCB] shrink-0">{cert.fileType?.startsWith('image/') ? <img src={cert.fileUrl} alt={cert.fileName} className="w-full h-full object-cover" /> : <FileText size={20} className="text-[#9B9B9B]" />}</div><div className="min-w-0"><p className="text-xs text-[#6B6B6B] truncate max-w-[140px]">{cert.fileName}</p><button onClick={() => onUpdateCert({ ...cert, fileUrl: undefined, fileName: undefined, fileType: undefined })} className="text-[11px] text-[#CBCBCB] hover:text-red-400 mt-0.5">Remove</button></div></div>
        ) : <button onClick={() => fileRef.current?.click()} className="mt-2 text-xs text-[#CBCBCB] hover:text-[#9B9B9B]">+ Attach certificate</button>}
        <input ref={fileRef} type="file" accept=".pdf,image/*" onChange={handleFile} className="hidden" />
        <button onClick={onDeleteCert} className="block mt-2 text-xs text-[#CBCBCB] hover:text-red-400 opacity-0 group-hover/cert:opacity-100">Remove entry</button>
      </div>
      {showModal && cert.fileUrl && <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-8" onClick={() => setShowModal(false)}><div className="bg-white rounded-[16px] shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}><div className="flex items-center justify-between px-6 py-4 border-b border-[#F0F0F0]"><p className="text-sm truncate">{cert.fileName}</p><button onClick={() => setShowModal(false)}><X size={16} /></button></div><div className="flex-1 overflow-auto p-6 flex items-center justify-center">{cert.fileType?.startsWith('image/') ? <img src={cert.fileUrl} alt={cert.fileName} className="max-w-full max-h-full object-contain" /> : <iframe src={cert.fileUrl} className="w-full h-96 border-0" />}</div></div></div>}
    </div>
  );
}

// ─── SuggestionCard ──────────────────────────────────────────────────────────

function SuggestionCard({ change, data, isActive, onClick, onAccept, onReject }: { change: AIChange; data: ResumeData; isActive: boolean; onClick: () => void; onAccept: () => void; onReject: () => void }) {
  return (
    <div onClick={onClick} className={`rounded-[10px] border p-4 bg-white cursor-pointer select-none transition-all ${isActive ? 'border-[#C8C8C8] shadow-[0_2px_12px_rgba(0,0,0,0.07)]' : 'border-[#E8E8E8] hover:border-[#D0D0D0]'}`}>
      <p className="text-[10px] uppercase tracking-widest text-[#AAAAAA] mb-2">{getChangeLabel(change, data)}</p>
      <p className="text-sm text-[#2B2B2B] leading-relaxed mb-4">{change.suggested}</p>
      <div className="flex gap-2" onClick={e => e.stopPropagation()}>
        <button onClick={onAccept} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1A1A1A] text-white rounded-[7px] hover:bg-black" style={{ fontSize: 12 }}><Check size={11} /> Accept</button>
        <button onClick={onReject} className="px-3 py-1.5 border border-[#E0E0E0] text-[#6B6B6B] rounded-[7px] hover:bg-[#F5F5F5]" style={{ fontSize: 12 }}>Reject</button>
      </div>
    </div>
  );
}

// ─── ResumeView ──────────────────────────────────────────────────────────────

// Card height estimate for layout (includes gap to next card)
const CARD_EST_H = 155;
const CARD_GAP = 20; // Updated from 12 to 20 for better spacing (16-24px range)

function ResumeView({ version, onUpdateData, onAcceptChange, onRejectChange, onAcceptAll, onRejectAll, onShowToast }: { version: ResumeVersion; onUpdateData: (d: ResumeData) => void; onAcceptChange: (id: string) => void; onRejectChange: (id: string) => void; onAcceptAll: () => void; onRejectAll: () => void; onShowToast: (msg: string) => void }) {
  const { data, aiChanges } = version;
  const update = (p: Partial<ResumeData>) => onUpdateData({ ...data, ...p });
  const [dragExpFrom, setDragExpFrom] = useState<number | null>(null);
  const [dragExpTarget, setDragExpTarget] = useState<number | null>(null);
  const pendingChanges = (aiChanges ?? []).filter(c => c.status === 'pending');
  const hasSuggestions = pendingChanges.length > 0;
  const hasAbout = data.bio.trim().length > 0;
  const hasWorkExperience = (data.workExperience ?? []).length > 0;
  const hasEducation = (data.education ?? []).length > 0;
  const hasCertifications = (data.certifications ?? []).length > 0;
  const hasSkills = (data.skills ?? []).length > 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  // idealTop[id] = card top such that card CENTER aligns to element CENTER
  const [idealTop, setIdealTop] = useState<Record<string, number>>({});
  const [highlightedSectionKey, setHighlightedSectionKey] = useState<string | null>(null);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();

  const recalcPositions = useCallback(() => {
    if (!containerRef.current) return;
    const cRect = containerRef.current.getBoundingClientRect();
    const next: Record<string, number> = {};
    pendingChanges.forEach(ch => {
      const el = sectionRefs.current.get(getSectionKey(ch));
      if (el) {
        const eRect = el.getBoundingClientRect();
        // Center-to-center: top = element_center_Y - card_half_height
        const elementCenterY = eRect.top - cRect.top + eRect.height / 2;
        next[ch.id] = Math.round(elementCenterY - CARD_EST_H / 2);
      }
    });
    setIdealTop(prev => {
      const same = Object.keys(next).length === Object.keys(prev).length && Object.keys(next).every(k => next[k] === prev[k]);
      return same ? prev : next;
    });
  }, [pendingChanges]);

  useLayoutEffect(() => { recalcPositions(); });
  useEffect(() => { window.addEventListener('resize', recalcPositions); return () => window.removeEventListener('resize', recalcPositions); }, [recalcPositions]);
  const registerRef = useCallback((key: string, el: HTMLElement | null) => { if (el) sectionRefs.current.set(key, el); else sectionRefs.current.delete(key); }, []);

  const handleSuggestionClick = (change: AIChange) => {
    const key = getSectionKey(change);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightedSectionKey(key); setActiveSuggestionId(change.id);
    sectionRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightTimer.current = setTimeout(() => { setHighlightedSectionKey(null); setActiveSuggestionId(null); }, 2200);
  };

  // Resolve positions: sort by idealTop, prevent overlap by pushing cards down
  // Active card is prioritized and appears at the top
  const HEADER_H = 38;
  const COLUMN_PADDING_TOP = 24;
  const DISPLACED_THRESHOLD = 30; // px displacement before showing connector
  const sortedPending = [...pendingChanges].sort((a, b) => {
    // Active suggestion goes first
    if (activeSuggestionId === a.id) return -1;
    if (activeSuggestionId === b.id) return 1;
    // Otherwise sort by ideal position
    return (idealTop[a.id] ?? 0) - (idealTop[b.id] ?? 0);
  });
  const resolvedTop: Record<string, number> = {};
  let cursor = Math.max(HEADER_H, COLUMN_PADDING_TOP);
  sortedPending.forEach(ch => {
    const ideal = Math.max(idealTop[ch.id] ?? cursor, HEADER_H);
    const placed = Math.max(ideal, cursor);
    resolvedTop[ch.id] = placed;
    cursor = placed + CARD_EST_H + CARD_GAP;
  });

  const bioChange = pendingChanges.find(c => c.field === 'bio');
  const contactItems: Array<{ key: keyof ContactInfo; placeholder: string }> = [{ key: 'email', placeholder: 'email@email.com' }, { key: 'phone', placeholder: '+1 234 567 890' }, { key: 'location', placeholder: 'City, Country' }, { key: 'website', placeholder: 'website.com' }, { key: 'linkedin', placeholder: 'linkedin.com/in/…' }];

  return (
    <div ref={containerRef} className="relative">
      <div className={`print-main-content ${hasSuggestions ? 'mr-[288px]' : ''}`}>
        {/* Header */}
        <div className="flex items-start gap-5 mb-5">
          <div className="w-14 h-14 rounded-full bg-[#E8E8E8] shrink-0 flex items-center justify-center text-[#9B9B9B] select-none" style={{ fontSize: 13 }}>AJ</div>
          <div className="flex-1 min-w-0 space-y-1 pt-1"><InlineText value={data.name} onChange={v => update({ name: v })} className="text-[#1A1A1A] text-[22px]" /><InlineText value={data.title} onChange={v => update({ title: v })} className="text-base text-[#6B6B6B]" /></div>
        </div>
        {/* Contact */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5 mb-10">
          {contactItems.flatMap((item, idx) => [idx > 0 ? <span key={`d-${item.key}`} className="text-[#D8D8D8] text-sm">•</span> : null, <ContactInlineField key={item.key} value={data.contact[item.key]} onChange={v => update({ contact: { ...data.contact, [item.key]: v } })} placeholder={item.placeholder} />])}
        </div>
        {/* About */}
        <div className="resume-section mb-10" data-empty={!hasAbout}>
          <div className="h-px bg-[#EFEFEF] mb-10" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-4">About</p>
          <div ref={el => registerRef('bio', el)} className={`rounded-[8px] transition-colors duration-500 ${highlightedSectionKey === 'bio' ? 'bg-[#F5F5F5]' : ''} ${bioChange ? 'border-l-2 pl-3 -ml-3 border-[#E0E0E0]' : ''}`}>
            <InlineArea value={data.bio} onChange={v => update({ bio: v })} className="text-sm text-[#2B2B2B]" />
          </div>
        </div>
        {/* Work Experience */}
        <div className="resume-section mb-10" data-empty={!hasWorkExperience}>
          <div className="h-px bg-[#EFEFEF] mb-10" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Work Experience</p>
          <div className="space-y-8">
            {(data.workExperience ?? []).map((exp, idx) => (
              <div
                key={exp.id}
                className={`border-t-2 transition-colors ${dragExpTarget === idx && dragExpFrom !== null && dragExpFrom !== idx ? 'border-[#BFBFBF]' : 'border-transparent'}`}
                onDragOver={(e) => {
                  if (dragExpFrom === null) return;
                  e.preventDefault();
                  if (dragExpFrom !== idx) setDragExpTarget(idx);
                }}
                onDrop={() => {
                  if (dragExpFrom === null || dragExpFrom === idx) {
                    setDragExpFrom(null);
                    setDragExpTarget(null);
                    return;
                  }
                  const next = [...data.workExperience];
                  const [moved] = next.splice(dragExpFrom, 1);
                  next.splice(idx, 0, moved);
                  update({ workExperience: next });
                  setDragExpFrom(null);
                  setDragExpTarget(null);
                }}
                onDragLeave={() => {
                  if (dragExpFrom !== null) setDragExpTarget(null);
                }}
              >
                <ExperienceBlock
                  exp={exp}
                  onUpdateExp={u => update({ workExperience: data.workExperience.map(e => e.id === exp.id ? u : e) })}
                  onDeleteExp={() => update({ workExperience: data.workExperience.filter(e => e.id !== exp.id) })}
                  onDragStartExperience={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragExpFrom(idx);
                  }}
                  onDragEndExperience={() => {
                    setDragExpFrom(null);
                    setDragExpTarget(null);
                  }}
                  isDraggingExperience={dragExpFrom === idx}
                  highlightedSectionKey={highlightedSectionKey}
                  registerBulletRef={registerRef}
                  onShowToast={onShowToast}
                />
              </div>
            ))}
          </div>
          <button onClick={() => update({ workExperience: [...data.workExperience, { id: `exp-${Date.now()}`, company: 'Company Name', role: 'Your Role', startDate: { month: 1, year: 2023, present: false }, endDate: { month: 1, year: 2026, present: true }, bullets: ['Describe your impact here'] }] })} className="mt-7 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} /> Add Experience</button>
        </div>
        {/* Education */}
        <div className="resume-section mb-10" data-empty={!hasEducation}>
          <div className="h-px bg-[#EFEFEF] mb-10" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Education</p>
          <div className="space-y-6">{(data.education ?? []).map(edu => <EducationBlock key={edu.id} edu={edu} onUpdateEdu={u => update({ education: data.education.map(e => e.id === edu.id ? u : e) })} onDeleteEdu={() => update({ education: data.education.filter(e => e.id !== edu.id) })} />)}</div>
          <button onClick={() => update({ education: [...data.education, { id: `edu-${Date.now()}`, school: 'School Name', degree: 'Degree', location: '', startDate: { month: 9, year: 2020, present: false }, endDate: { month: 5, year: 2024, present: false } }] })} className="mt-6 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} /> Add Education</button>
        </div>
        {/* Certifications */}
        <div className="resume-section mb-10" data-empty={!hasCertifications}>
          <div className="h-px bg-[#EFEFEF] mb-10" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-7">Certifications</p>
          <div className="space-y-6">{(data.certifications ?? []).map(cert => <CertificationBlock key={cert.id} cert={cert} onUpdateCert={u => update({ certifications: data.certifications.map(c => c.id === cert.id ? u : c) })} onDeleteCert={() => update({ certifications: data.certifications.filter(c => c.id !== cert.id) })} />)}</div>
          <button onClick={() => update({ certifications: [...data.certifications, { id: `cert-${Date.now()}`, name: 'Certificate Name', organization: 'Issuing Organization', issuedMonth: 1, issuedYear: 2024, credentialId: '' }] })} className="mt-6 flex items-center gap-1.5 text-sm text-[#CBCBCB] hover:text-[#9B9B9B]"><Plus size={13} /> Add Certification</button>
        </div>
        {/* Skills */}
        <div className="resume-section" data-empty={!hasSkills}>
          <div className="h-px bg-[#EFEFEF] mb-10" />
          <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA] mb-5">Skills</p>
          <SkillsEditor skills={data.skills ?? []} onUpdate={s => update({ skills: s })} />
        </div>
      </div>

      {/* ── Suggestion cards — right gutter, center-to-center aligned with connectors ── */}
      {hasSuggestions && (
        <div className="absolute top-0 right-0 w-[264px] print-hide">
          {/* Header */}
          <div className="flex items-center justify-between" style={{ height: HEADER_H }}>
            <p className="text-[11px] uppercase tracking-widest text-[#AAAAAA]">{pendingChanges.length} suggestion{pendingChanges.length !== 1 ? 's' : ''}</p>
            <div className="flex gap-3">
              <button onClick={onAcceptAll} className="text-[#2B2B2B] hover:text-black" style={{ fontSize: 11 }}>Accept all</button>
              <button onClick={onRejectAll} className="text-[#9B9B9B] hover:text-[#2B2B2B]" style={{ fontSize: 11 }}>Reject all</button>
            </div>
          </div>
          {/* Card container — relative for absolute child positioning */}
          <div className="relative pt-6 pb-6" style={{ minHeight: cursor + 48 }}>
            {pendingChanges.map(change => {
              const ideal = idealTop[change.id] ?? HEADER_H;
              const resolved = resolvedTop[change.id] ?? ideal;
              const displaced = resolved - ideal > DISPLACED_THRESHOLD;
              const targetCenterY = ideal + CARD_EST_H / 2;
              const cardCenterY = resolved + CARD_EST_H / 2;

              return (
                // div with display:contents replaces React.Fragment — avoids Figma inspector
                // injecting invalid data-* props into Fragment nodes (React warns on those)
                <div key={change.id} className="contents">
                  {/* Connector: shown when card is displaced below its target line */}
                  {displaced && (
                    <>
                      {/* Anchor dot at the target line center */}
                      <div className="absolute rounded-full bg-[#CBCBCB]" style={{ width: 5, height: 5, top: targetCenterY - 2.5, left: -12 }} />
                      {/* Vertical line from anchor dot down to card left edge */}
                      <div className="absolute bg-[#E5E5E5]" style={{ width: 1.5, top: targetCenterY + 2.5, left: -10, height: Math.max(0, cardCenterY - targetCenterY - 2.5) }} />
                      {/* Horizontal connector line to card */}
                      <div className="absolute bg-[#E5E5E5]" style={{ width: 10, height: 1.5, top: cardCenterY - 0.75, left: -10 }} />
                    </>
                  )}
                  {/* Card with smooth transitions */}
                  <div className="absolute left-0 right-0 transition-all duration-300 ease-out" style={{ top: resolved }}>
                    <SuggestionCard change={change} data={data} isActive={activeSuggestionId === change.id} onClick={() => handleSuggestionClick(change)} onAccept={() => { onAcceptChange(change.id); setActiveSuggestionId(null); }} onReject={() => { onRejectChange(change.id); setActiveSuggestionId(null); }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FloatingToolbar — Granola/Awwwards style capsule ────────────────────────

function FloatingToolbar({ isBaseResume, hasJD, onAddNew, onJDClick, onCurate, onExportPDF, onExportWord }: { isBaseResume: boolean; hasJD: boolean; onAddNew?: () => void; onJDClick: () => void; onCurate: () => void; onExportPDF: () => void; onExportWord: () => void }) {
  const [showExport, setShowExport] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setShowExport(false); } };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const btnBase = 'flex items-center gap-2 px-4 transition-colors whitespace-nowrap text-sm text-[#2B2B2B] hover:bg-[#F5F5F5]';

  return (
    <div ref={ref} className="relative flex flex-col items-center">

      {/* Export dropdown — appears above toolbar */}
      {showExport && (
        <div className="absolute bottom-[calc(100%+8px)] right-0 w-48 bg-white border border-[#EBEBEB] rounded-[12px] shadow-[0_-4px_24px_rgba(0,0,0,0.1),0_4px_12px_rgba(0,0,0,0.04)] overflow-hidden z-50 animate-[fadeInDown_150ms_ease-out]">
          <button onClick={() => { onExportPDF(); setShowExport(false); }} className="w-full text-left px-4 py-2.5 text-sm text-[#2B2B2B] hover:bg-[#F5F5F5] transition-colors">Export to PDF</button>
          <button onClick={() => { onExportWord(); setShowExport(false); }} className="w-full text-left px-4 py-2.5 text-sm text-[#2B2B2B] hover:bg-[#F5F5F5] transition-colors">Export to Word Doc</button>
        </div>
      )}

      {/* ── Main capsule ── */}
      <div className="inline-flex items-stretch bg-white rounded-full border border-[#E5E5E5] shadow-[0_4px_20px_rgba(0,0,0,0.1),0_1px_4px_rgba(0,0,0,0.06)]" style={{ height: 44 }}>

        {/* First Button: Add New (Base Resume) or JD (Role Version) */}
        {isBaseResume ? (
          <button onClick={onAddNew}
            className={`${btnBase} rounded-l-full pl-5 pr-4`}>
            <Plus size={14} className="text-[#1A1A1A]" />
            <span>Add New</span>
          </button>
        ) : (
          <button onClick={onJDClick}
            className={`${btnBase} rounded-l-full pl-5 pr-4 ${hasJD ? '' : 'opacity-60'}`}>
            <Paperclip size={14} className={hasJD ? 'text-[#1A1A1A]' : 'text-[#9B9B9B]'} />
            <span>JD</span>
            {hasJD && <span className="w-1.5 h-1.5 rounded-full bg-[#1A1A1A] ml-0.5" />}
          </button>
        )}

        {/* Divider */}
        <div className="w-px bg-[#EBEBEB] my-2.5 shrink-0" />

        {/* Curate with AI — single action button */}
        <button onClick={onCurate}
          className={`${btnBase} px-4`}>
          <Sparkles size={14} className="text-[#1A1A1A]" />
          <span>Curate</span>
        </button>

        {/* Divider */}
        <div className="w-px bg-[#EBEBEB] my-2.5 shrink-0" />

        {/* Export */}
        <button onClick={() => { setShowExport(p => !p); }}
          className={`${btnBase} rounded-r-full pl-4 pr-5 ${showExport ? 'bg-[#F0F0F0]' : ''}`}>
          <Upload size={14} className="text-[#9B9B9B]" />
          <span>Export</span>
        </button>
      </div>
    </div>
  );
}

// ─── JDSidePanel — right overlay panel ───────────────────────────────────────

function JDSidePanel({ version, onClose, onCopy }: { version: ResumeVersion; onClose: () => void; onCopy: () => void }) {
  return (
    <div className="absolute right-0 top-0 bottom-0 w-[320px] bg-white border-l border-[#F0F0F0] shadow-[-4px_0_24px_rgba(0,0,0,0.06)] flex flex-col z-10 animate-[slideInRight_250ms_ease-out] print-hide">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#F0F0F0] flex items-center justify-between shrink-0">
        <div>
          <p className="text-sm text-[#1A1A1A]" style={{ fontWeight: 500 }}>Job Description</p>
          {version.jobCompany && <p className="text-xs text-[#9B9B9B] mt-0.5">{version.name}</p>}
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] hover:text-[#2B2B2B] transition-colors"><X size={15} /></button>
      </div>
      {/* Content */}
      {version.jobDescription ? (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <p className="text-sm text-[#4B4B4B] leading-[1.75] whitespace-pre-wrap">{version.jobDescription}</p>
          </div>
          <div className="px-6 py-4 border-t border-[#F0F0F0] flex gap-2 shrink-0">
            {version.jobLink && (
              <a href={version.jobLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E8] rounded-[8px] text-xs text-[#6B6B6B] hover:bg-[#F5F5F5] transition-colors">
                <ExternalLink size={12} /> View posting
              </a>
            )}
            <button onClick={onCopy} className="flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E8] rounded-[8px] text-xs text-[#6B6B6B] hover:bg-[#F5F5F5] transition-colors">
              <Copy size={12} /> Copy JD
            </button>
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-12 h-12 bg-[#F7F7F8] rounded-full flex items-center justify-center mb-4"><Paperclip size={20} className="text-[#D4D4D4]" /></div>
          <p className="text-sm text-[#9B9B9B]">No job description attached</p>
          <p className="text-xs text-[#CBCBCB] mt-1.5 max-w-[200px] leading-relaxed">Create a new tailored version with "+ Add new" to attach a JD</p>
        </div>
      )}
    </div>
  );
}

// ─── CreateResumeModal ───────────────────────────────────────────────────────

function CreateResumeModal({ onGenerate, onClose }: { onGenerate: (role: string, company: string, jd: string, link: string) => void; onClose: () => void }) {
  const [roleName, setRoleName] = useState(''); const [company, setCompany] = useState(''); const [jobDesc, setJobDesc] = useState(''); const [jobLink, setJobLink] = useState('');
  const fCls = "w-full px-4 py-2.5 bg-[#F7F7F8] rounded-[10px] border border-[#EFEFEF] text-sm outline-none focus:border-[#CBCBCB] placeholder:text-[#D4D4D4] transition-colors text-[#1A1A1A]";
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/20 z-[200] flex items-center justify-center p-6 backdrop-blur-[2px] animate-[fadeIn_150ms_ease-out]" onClick={onClose}>
      <div className="bg-white rounded-[16px] shadow-[0_24px_80px_rgba(0,0,0,0.14)] w-full max-w-[600px] animate-[fadeInScale_200ms_ease-out]" onClick={e => e.stopPropagation()}>
        <div className="px-8 py-6 border-b border-[#F0F0F0] flex items-center justify-between">
          <div><h2 className="text-base text-[#1A1A1A]" style={{ fontWeight: 500 }}>Create Resume for New Role</h2><p className="text-xs text-[#9B9B9B] mt-0.5">AI will tailor your resume to match this position</p></div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-[8px] text-[#9B9B9B] hover:bg-[#F5F5F5] transition-colors"><X size={16} /></button>
        </div>
        <div className="px-8 py-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Role Name</label><input value={roleName} onChange={e => setRoleName(e.target.value)} placeholder="e.g. Product Designer" className={fCls} autoFocus /></div>
            <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Company <span className="text-[#CBCBCB]">(optional)</span></label><input value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Stripe" className={fCls} /></div>
          </div>
          <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Job Description</label><textarea value={jobDesc} onChange={e => setJobDesc(e.target.value)} placeholder="Paste the full job description here — the more detail, the better the tailoring." rows={7} className={`${fCls} resize-none leading-relaxed`} /></div>
          <div><label className="block text-xs text-[#6B6B6B] mb-1.5">Job Link <span className="text-[#CBCBCB]">(optional)</span></label><input value={jobLink} onChange={e => setJobLink(e.target.value)} placeholder="https://…" className={fCls} /></div>
        </div>
        <div className="px-8 py-5 border-t border-[#F0F0F0] flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-[#E8E8E8] rounded-[10px] text-sm text-[#6B6B6B] hover:bg-[#F5F5F5]">Cancel</button>
          <button onClick={() => { if (roleName.trim()) onGenerate(roleName, company, jobDesc, jobLink); }} disabled={!roleName.trim()} className="flex-[2] py-2.5 bg-[#1A1A1A] text-white rounded-[10px] text-sm hover:bg-black disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2">
            <Sparkles size={13} /> Generate Resume
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Workspace ──────────────────────────────────────────────────────────────────

export default function Workspace() {
  const navigate = useNavigate();
  const { requireAuth } = useAuthGate();
  const [searchParams] = useSearchParams();
  const [resumeId, setResumeId] = useState<string>(searchParams.get('resumeId') ?? '');
  const [versions, setVersions] = useState<ResumeVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showJDPanel, setShowJDPanel] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '' });
  const avatarRef = useRef<HTMLDivElement>(null);
  const currentUser = userStore.get();
  const initialExpanded = INITIAL_VERSIONS.filter(v => v.isAI && v.jobTitle).map(v => v.jobTitle!);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(initialExpanded));

  useEffect(() => {
    const h = (e: MouseEvent) => { if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setShowAvatarMenu(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);

  const showToast = (msg: string) => { setToast({ visible: true, message: msg }); setTimeout(() => setToast({ visible: false, message: '' }), 2500); };

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        const targetResumeId = resumeId || (await listResumes()).resumes[0]?.id;
        if (!targetResumeId) {
          setVersions(INITIAL_VERSIONS);
          setSelectedVersionId(INITIAL_VERSIONS[0].id);
          return;
        }
        if (!resumeId) setResumeId(targetResumeId);
        const response = await listVersions(targetResumeId);
        const loadedVersions = response.versions as ResumeVersion[];
        if (!mounted) return;
        if (loadedVersions.length === 0) {
          setVersions(INITIAL_VERSIONS);
          setSelectedVersionId(INITIAL_VERSIONS[0].id);
        } else {
          setVersions(loadedVersions);
          setSelectedVersionId(loadedVersions.find((v) => v.isBase)?.id ?? loadedVersions[0].id);
        }
      } catch (err) {
        if (!mounted) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load resume workspace');
      } finally {
        if (mounted) setIsLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [resumeId]);

  const activeVersion = versions.find(v => v.id === selectedVersionId) || versions[0];
  const baseVersion = versions.find(v => v.isBase) ?? versions[0];
  const isNonBase = activeVersion ? activeVersion.id !== baseVersion?.id : false;
  const sidebarGroups = versions.filter(v => v.isAI).reduce((acc, v) => { const role = v.jobTitle || v.name; const g = acc.find(x => x.role === role); if (g) g.items.push(v); else acc.push({ role, items: [v] }); return acc; }, [] as { role: string; items: ResumeVersion[] }[]);

  const persistVersion = async (nextVersion: ResumeVersion) => {
    if (!resumeId) return;
    await updateVersion(resumeId, nextVersion.id, nextVersion);
  };

  const updateVersionData = (data: ResumeData) => setVersions(prev => prev.map(v => {
    if (v.id !== selectedVersionId) return v;
    const next = { ...v, data };
    void persistVersion(next).catch(() => {});
    return next;
  }));
  const handleAcceptChange = (id: string) => setVersions(prev => prev.map(v => { if (v.id !== selectedVersionId) return v; const c = v.aiChanges.find(c => c.id === id); if (!c) return v; return { ...v, data: applyChange(c, v.data), aiChanges: v.aiChanges.map(ch => ch.id === id ? { ...ch, status: 'accepted' as const } : ch) }; }));
  const handleRejectChange = (id: string) => setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: v.aiChanges.map(c => c.id === id ? { ...c, status: 'rejected' as const } : c) } : v));
  const handleAcceptAll = () => setVersions(prev => prev.map(v => { if (v.id !== selectedVersionId) return v; let data = v.data; v.aiChanges.filter(c => c.status === 'pending').forEach(c => { data = applyChange(c, data); }); return { ...v, data, aiChanges: v.aiChanges.map(c => ({ ...c, status: 'accepted' as const })) }; }));
  const handleRejectAll = () => setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: v.aiChanges.map(c => ({ ...c, status: 'rejected' as const })) } : v));

  const handleGenerateVersion = (roleName: string, company: string, jd: string, link: string) => {
    requireAuth(async () => {
      const nv = generateAIVersion(roleName || 'New Role', company, jd, link);
      try {
        if (resumeId) {
          const created = await createVersion(resumeId, nv);
          const createdVersion = created.version as ResumeVersion;
          setVersions(prev => [...prev, createdVersion]);
          setSelectedVersionId(createdVersion.id);
        } else {
          setVersions(prev => [...prev, nv]);
          setSelectedVersionId(nv.id);
        }
        setShowModal(false);
        if (nv.jobTitle) setExpandedGroups(prev => new Set([...prev, nv.jobTitle!]));
        showToast(`Resume created for ${nv.name}`);
      } catch {
        showToast('Failed to save generated version');
      }
    });
  };

  const handleCurate = () => {
    requireAuth(() => {
      const ts = Date.now();
      const exp = activeVersion.data.workExperience?.[0];
      const changes: AIChange[] = [];
      if (activeVersion.data.bio) changes.push({ id: `c-bio-${ts}`, field: 'bio', original: activeVersion.data.bio, suggested: 'Strategic product designer with 8+ years shaping complex digital products. Known for building scalable design systems and leading cross-functional teams to deliver measurable business impact.', status: 'pending' });
      if (exp?.bullets?.[0]) changes.push({ id: `c-b0-${ts}`, field: 'bullet', expId: exp.id, bulletIdx: 0, original: exp.bullets[0], suggested: exp.bullets[0].replace(/(\d+)%/, (_, n) => `${Math.min(parseInt(n) + 5, 99)}%`) + ', directly contributing to $2.4M in incremental ARR', status: 'pending' });
      if (exp?.bullets?.[1]) changes.push({ id: `c-b1-${ts}`, field: 'bullet', expId: exp.id, bulletIdx: 1, original: exp.bullets[1], suggested: exp.bullets[1] + ', reducing design-to-dev handoff time by 40%', status: 'pending' });
      setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: [...(v.aiChanges ?? []).filter(c => c.status !== 'rejected'), ...changes] } : v));
      showToast(`${changes.length} suggestions generated`);
    });
  };

  const handleCurateAction = (action: string) => {
    const ts = Date.now();
    const exp = activeVersion.data.workExperience?.[0];
    if (!exp) { showToast('Add experience entries first'); return; }
    const suggestions: Record<string, string> = {
      'curate': 'Strategic product designer with 8+ years shaping fintech and SaaS products. Expert in design systems and cross-functional leadership.',
      'rewrite-about': 'Award-winning product designer with 8+ years driving 40%+ engagement improvements through rigorous UX research and scalable design systems across B2B and B2C products.',
      'rewrite-bullet': 'Orchestrated end-to-end dashboard transformation, achieving 40% improvement in user engagement and 25% faster task completion — directly driving $2.4M incremental ARR',
      'concise': 'Product designer. 8+ years. Design systems, UX research, cross-functional leadership.',
      'metrics': 'Led redesign of main dashboard for 50k+ users, improving engagement by 40% and reducing task completion time by 25%, resulting in $2.4M ARR uplift',
    };
    const changes: AIChange[] = [{ id: `ca-${ts}`, field: action === 'rewrite-about' || action === 'concise' ? 'bio' : 'bullet', expId: action !== 'rewrite-about' && action !== 'concise' ? exp.id : undefined, bulletIdx: action !== 'rewrite-about' && action !== 'concise' ? 0 : undefined, original: action === 'rewrite-about' || action === 'concise' ? activeVersion.data.bio : exp.bullets[0], suggested: suggestions[action] ?? suggestions['curate'], status: 'pending' }];
    setVersions(prev => prev.map(v => v.id === selectedVersionId ? { ...v, aiChanges: [...(v.aiChanges ?? []).filter(c => c.status !== 'rejected'), ...changes] } : v));
    showToast(`"${action.replace('-', ' ')}" applied`);
  };

  const handleUpdateBase = () => {
    if (!baseVersion || !activeVersion) return;
    const nextBase = { ...baseVersion, data: { ...activeVersion.data } };
    setVersions(prev => prev.map(v => v.id === baseVersion.id ? nextBase : v));
    void persistVersion(nextBase).catch(() => {});
    showToast('Base resume updated');
  };
  const hasPendingChanges = activeVersion?.aiChanges.some(c => c.status === 'pending') ?? false;

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#6B6B6B]">Loading workspace...</div>;
  }

  if (loadError) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#D14343]">{loadError}</div>;
  }

  if (!activeVersion || !baseVersion) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[#6B6B6B]">No resume found. Go back to start and import/create one.</div>;
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="h-screen flex bg-white overflow-hidden workspace-shell"
    >

      {/* ── Sidebar ── */}
      <div className="w-[220px] shrink-0 border-r border-[#F0F0F0] flex flex-col print-hide">
        <div className="px-6 py-5 border-b border-[#F0F0F0]"><span className="text-base tracking-tight text-[#1A1A1A]">CVStack</span></div>
        <div className="flex-1 overflow-y-auto py-3">
          <button onClick={() => setSelectedVersionId(baseVersion.id)} className={`w-full text-left px-6 py-2 rounded-[8px] mb-1 text-sm transition-colors ${selectedVersionId === baseVersion.id ? 'bg-[#F0F0F0] text-[#111]' : 'text-[#6B6B6B] hover:bg-[#F5F5F5]'}`}>Base Resume</button>
          {sidebarGroups.map(group => {
            const isOpen = expandedGroups.has(group.role);
            return (
              <div key={group.role} className="mb-1">
                <button onClick={() => setExpandedGroups(prev => { const n = new Set(prev); n.has(group.role) ? n.delete(group.role) : n.add(group.role); return n; })} className="w-full text-left px-4 py-2 flex items-center gap-2 rounded-[8px] hover:bg-[#F5F5F5] group">
                  <ChevronRight size={13} className={`text-[#AAAAAA] group-hover:text-[#6B6B6B] transition-all duration-200 shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                  <span className="text-[13px] text-[#2B2B2B] truncate" style={{ fontWeight: 500 }}>{group.role}</span>
                </button>
                {isOpen && <div className="mt-0.5 mb-1 animate-[fadeIn_150ms_ease-out]">{group.items.map(v => (<button key={v.id} onClick={() => setSelectedVersionId(v.id)} className={`w-full text-left pl-[38px] pr-4 py-1.5 rounded-[8px] mb-0.5 text-[12px] transition-colors ${selectedVersionId === v.id ? 'bg-[#F0F0F0] text-[#111]' : 'text-[#8B8B8B] hover:bg-[#F5F5F5]'}`}>{v.jobCompany}</button>))}</div>}
              </div>
            );
          })}
          <button onClick={() => requireAuth(() => setShowModal(true))} className="w-full text-left px-6 py-2 rounded-[8px] text-sm text-[#9B9B9B] hover:bg-[#F5F5F5] hover:text-[#6B6B6B] flex items-center gap-2 mt-2"><Plus size={13} /> Add new</button>
        </div>
      </div>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Top bar */}
        <div className="h-14 border-b border-[#F0F0F0] px-6 flex items-center justify-between shrink-0 print-hide">
          <div className="flex items-center gap-2 min-w-0 text-sm">
            <span className="text-[#CBCBCB]">Resumes</span><span className="text-[#E0E0E0]">/</span>
            <span className="text-[#1A1A1A] truncate">{activeVersion.name}</span>
            {activeVersion.matchScore && <span className="px-2 py-0.5 bg-[#F5F5F5] rounded-full text-[10px] text-[#9B9B9B] shrink-0">{activeVersion.matchScore}% match</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative" ref={avatarRef}>
              <button onClick={() => setShowAvatarMenu(p => !p)} className="flex items-center gap-1 group">
                <div className="w-8 h-8 rounded-full bg-[#2B2B2B] text-white flex items-center justify-center group-hover:bg-black select-none" style={{ fontSize: 12 }}>
                  {(currentUser?.fullName || currentUser?.email || 'Guest').slice(0, 2).toUpperCase()}
                </div>
                <ChevronDown size={13} className="text-[#CBCBCB]" />
              </button>
              {showAvatarMenu && (
                <div className="absolute right-0 top-11 w-40 bg-white border border-[#EBEBEB] rounded-[12px] shadow-[0_4px_20px_rgba(0,0,0,0.08)] overflow-hidden z-50 animate-[fadeInDown_150ms_ease-out]">
                  <button className="w-full text-left px-4 py-3 text-sm text-[#2B2B2B] hover:bg-[#F5F5F5] flex items-center gap-2.5"><Settings size={14} className="text-[#AAAAAA]" /> Settings</button>
                  <div className="h-px bg-[#F0F0F0]" />
                  <button onClick={() => { clearAuthStorage(); navigate('/start'); }} className="w-full text-left px-4 py-3 text-sm text-[#2B2B2B] hover:bg-[#F5F5F5] flex items-center gap-2.5"><LogOut size={14} className="text-[#AAAAAA]" /> Log Out</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Content + JD overlay + floating toolbar */}
        <div className="flex-1 relative overflow-hidden">

          {/* Scrollable resume content */}
          <div className="absolute inset-0 overflow-y-auto bg-white" id="print-resume-root">
            <div className="max-w-[960px] mx-auto py-14 px-12 pb-32 print-page resume-print-root">
              {hasPendingChanges && (
                <div className="mb-8 flex items-center gap-3 px-4 py-2.5 bg-[#FAFAFA] border border-[#F0F0F0] rounded-[10px] print-hide">
                  <Sparkles size={12} className="text-[#9B9B9B] shrink-0" />
                  <span className="text-sm text-[#6B6B6B]">AI suggestions for <span className="text-[#1A1A1A]">{activeVersion.jobTitle} @ {activeVersion.jobCompany}</span></span>
                  <span className="text-[#D0D0D0]">·</span>
                  <span className="text-xs text-[#9B9B9B]">{activeVersion.aiChanges.filter(c => c.status === 'pending').length} pending</span>
                </div>
              )}
              {isNonBase && (
                <div className="mb-8 flex items-center justify-between px-4 py-2.5 bg-[#FAFAFA] border border-[#F0F0F0] rounded-[10px] print-hide">
                  <span className="text-xs text-[#9B9B9B]">Editing <span className="text-[#6B6B6B]">{activeVersion.name}</span>. Changes apply to this version only.</span>
                  <button onClick={handleUpdateBase} className="flex items-center gap-1.5 text-xs text-[#2B2B2B] hover:text-black ml-4 shrink-0"><RefreshCw size={11} /> Update Base</button>
                </div>
              )}
              <ResumeView version={activeVersion} onUpdateData={updateVersionData} onAcceptChange={handleAcceptChange} onRejectChange={handleRejectChange} onAcceptAll={handleAcceptAll} onRejectAll={handleRejectAll} onShowToast={showToast} />
              <p className="text-center mt-12 print-hide" style={{ fontSize: 12, color: '#D4D4D4' }}>Click dates to edit · Click any text to edit · Drag bullets to reorder</p>
            </div>
          </div>

          {/* JD Side Panel — slides in from right */}
          {showJDPanel && (
            <JDSidePanel version={activeVersion} onClose={() => setShowJDPanel(false)}
              onCopy={() => { if (activeVersion.jobDescription) navigator.clipboard.writeText(activeVersion.jobDescription).catch(() => {}); showToast('Job description copied'); }} />
          )}

          {/* ── Floating toolbar — centered at bottom, above scroll ── */}
          <div className="absolute bottom-8 inset-x-0 flex justify-center z-20 pointer-events-none print-hide">
            <div className="pointer-events-auto">
              <FloatingToolbar
                isBaseResume={selectedVersionId === baseVersion.id}
                hasJD={!!(activeVersion.jobDescription)}
                onAddNew={() => requireAuth(() => setShowModal(true))}
                onJDClick={() => setShowJDPanel(p => !p)}
                onCurate={handleCurate}
                onExportPDF={() => { window.print(); showToast('Opening print dialog...'); }}
                onExportWord={() => { window.print(); showToast('Opening print dialog...'); }}
              />
            </div>
          </div>
        </div>
      </div>

      {showModal && <CreateResumeModal onGenerate={handleGenerateVersion} onClose={() => setShowModal(false)} />}
      <Toast message={toast.message} visible={toast.visible} />
    </motion.div>
  );
}
