export interface DateValue { month: number; year: number; present: boolean; }
export type AIChangeField = 'bio' | 'bullet';
export interface AIChange { id: string; field: AIChangeField; expId?: string; bulletIdx?: number; original: string; suggested: string; status: 'pending' | 'accepted' | 'rejected'; }
export interface WorkExperience { id: string; company: string; role: string; startDate: DateValue; endDate: DateValue; bullets: string[]; projectNotes?: string; }
export interface EducationEntry { id: string; school: string; degree: string; location: string; startDate: DateValue; endDate: DateValue; }
export interface Certification { id: string; name: string; organization: string; issuedMonth: number; issuedYear: number; credentialId: string; fileUrl?: string; fileName?: string; fileType?: string; }
export interface ContactInfo { email: string; phone: string; location: string; website: string; linkedin: string; }
export interface ResumeData { name: string; title: string; contact: ContactInfo; bio: string; workExperience: WorkExperience[]; education: EducationEntry[]; certifications: Certification[]; skills: string[]; }
export interface BaseResumeModel { id: string; content: string; updatedAt: string; }
export interface JDVariantModel { id: string; baseResumeId: string; title: string; jdText: string; variantContent: string; createdAt: string; }
export interface ResumeVersion { id: string; name: string; isAI: boolean; isBase?: boolean; matchScore?: number; jobTitle?: string; jobCompany?: string; jobDescription?: string; jobLink?: string; baseResumeId?: string; jdVariantId?: string; variantContent?: string; lastCurationInputHash?: string; data: ResumeData; aiChanges: AIChange[]; }
