import type { ResumeData } from './types';

export const defaultResumeData = (email = ''): ResumeData => ({
  name: 'Your Name',
  title: 'Your Role',
  contact: {
    email,
    phone: '',
    location: '',
    website: '',
    linkedin: '',
  },
  bio: 'Write a concise professional summary here.',
  workExperience: [],
  education: [],
  certifications: [],
  skills: [],
});
