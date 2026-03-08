import type { ResumeData, ResumeVersion } from './types';

function cleanSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function firstNameFromFullName(name: string): string {
  const [firstName = 'Resume'] = name.trim().split(/\s+/).filter(Boolean);
  return firstName;
}

function joinNameParts(parts: string[]): string {
  return parts.map(cleanSegment).filter(Boolean).join('_') || 'Resume';
}

export function buildResumeShareBaseName(version: ResumeVersion, data: ResumeData, year = new Date().getFullYear()): string {
  const firstName = firstNameFromFullName(data.name || version.data?.name || '');
  if (version.isBase) {
    const title = data.title || version.data?.title || version.name || 'Resume';
    return joinNameParts([firstName, title, String(year)]);
  }

  const roleTitle = version.jobTitle || data.title || version.data?.title || version.name || 'Role';
  const company = version.jobCompany || 'Company';
  return joinNameParts([firstName, roleTitle, company, String(year)]);
}

export function buildResumeSharePath(version: ResumeVersion, data: ResumeData, year = new Date().getFullYear()): string {
  return `/${buildResumeShareBaseName(version, data, year)}`;
}
