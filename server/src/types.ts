export interface DateValue { month: number; year: number; present: boolean; }
export interface AIChange { id: string; field: 'bio' | 'bullet'; expId?: string; bulletIdx?: number; original: string; suggested: string; status: 'pending' | 'accepted' | 'rejected'; }
export interface WorkExperience { id: string; company: string; role: string; startDate: DateValue; endDate: DateValue; bullets: string[]; projectNotes?: string; }
export interface EducationEntry { id: string; school: string; degree: string; location: string; startDate: DateValue; endDate: DateValue; }
export interface Certification { id: string; name: string; organization: string; issuedMonth: number; issuedYear: number; credentialId: string; fileUrl?: string; fileName?: string; fileType?: string; }
export interface Award { id: string; name: string; year: number; }
export interface ContactInfo { email: string; phone: string; location: string; website: string; linkedin: string; }
export interface ResumeData { name: string; title: string; contact: ContactInfo; bio: string; workExperience: WorkExperience[]; education: EducationEntry[]; certifications: Certification[]; awards: Award[]; skills: string[]; }

export interface ResumeVersionDTO {
  id: string;
  name: string;
  isAI: boolean;
  isBase?: boolean;
  matchScore?: number;
  jobTitle?: string;
  jobCompany?: string;
  jobDescription?: string;
  jobLink?: string;
  lastCurationInputHash?: string;
  data: ResumeData;
  aiChanges: AIChange[];
}

export interface ParsedResume {
  name: string;
  email: string;
  phone: string;
  sections: { heading: string; lines: string[] }[];
  bulletPoints: string[];
}
