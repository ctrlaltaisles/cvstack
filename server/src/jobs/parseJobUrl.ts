export type ParsedJobDetails = {
  title?: string;
  company?: string;
  description?: string;
  sourceUrl: string;
  sourceType?: string;
  success: boolean;
  error?: string;
};

const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; CVStackBot/1.0; +https://cvstack.app)',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|h1|h2|h3|h4|h5|h6)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/li>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function normalizeWhitespace(value?: string): string | undefined {
  const normalized = (value ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMetaContent(html: string, attrName: string, attrValue: string): string | undefined {
  const regex = new RegExp(`<meta[^>]+${attrName}=["']${escapeRegExp(attrValue)}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`, 'i');
  const match = html.match(regex);
  return normalizeWhitespace(match ? decodeHtmlEntities(match[1]) : '');
}

function extractTagInnerHtml(html: string, tag: string, classNamePart: string): string | undefined {
  const regex = new RegExp(
    `<${tag}[^>]*class=["'][^"']*${escapeRegExp(classNamePart)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'i',
  );
  const match = html.match(regex);
  return match?.[1];
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function findJsonLdJobPosting(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findJsonLdJobPosting(item);
      if (found) return found;
    }
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const typeValue = record['@type'];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  if (types.some((item) => String(item).toLowerCase() === 'jobposting')) {
    return record;
  }

  return firstDefined(
    findJsonLdJobPosting(record['@graph']),
    ...Object.values(record).map((value) => findJsonLdJobPosting(value)),
  );
}

function extractJsonLdJobPosting(html: string) {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1]).trim());
      const jobPosting = findJsonLdJobPosting(parsed);
      if (jobPosting) return jobPosting;
    } catch {
      // Ignore malformed JSON-LD blocks and keep scanning.
    }
  }
  return undefined;
}

function parseLinkedInTitle(metaTitle?: string) {
  const normalized = normalizeWhitespace(metaTitle);
  if (!normalized) return {};
  const withoutSuffix = normalized.replace(/\s+\|\s+LinkedIn\s*$/i, '').trim();
  const match = withoutSuffix.match(/^(.*?)\s+hiring\s+(.*?)\s+in\s+/i);
  if (!match) return { title: withoutSuffix };
  return {
    company: normalizeWhitespace(match[1]),
    title: normalizeWhitespace(match[2]),
  };
}

function parseLinkedInJob(html: string) {
  const metaTitle = firstDefined(
    extractMetaContent(html, 'property', 'og:title'),
    extractMetaContent(html, 'name', 'twitter:title'),
  );
  const titleParts = parseLinkedInTitle(metaTitle);
  const title = firstDefined(
    normalizeWhitespace(stripHtml(extractTagInnerHtml(html, 'h1', 'top-card-layout__title') ?? '')),
    titleParts.title,
  );
  const company = firstDefined(
    normalizeWhitespace(stripHtml(extractTagInnerHtml(html, 'a', 'topcard__org-name-link') ?? '')),
    titleParts.company,
  );
  const description = firstDefined(
    normalizeWhitespace(stripHtml(extractTagInnerHtml(html, 'div', 'show-more-less-html__markup') ?? '')),
    extractMetaContent(html, 'property', 'og:description'),
    extractMetaContent(html, 'name', 'description'),
  );

  return { title, company, description };
}

function parseGenericJob(html: string) {
  const jobPosting = extractJsonLdJobPosting(html);
  const title = firstDefined(
    normalizeWhitespace(typeof jobPosting?.title === 'string' ? jobPosting.title : ''),
    extractMetaContent(html, 'property', 'og:title'),
    extractMetaContent(html, 'name', 'twitter:title'),
  );
  const company = firstDefined(
    normalizeWhitespace(
      typeof jobPosting?.hiringOrganization === 'object' && jobPosting?.hiringOrganization
        ? String((jobPosting.hiringOrganization as Record<string, unknown>).name ?? '')
        : '',
    ),
    extractMetaContent(html, 'name', 'company'),
  );
  const description = firstDefined(
    normalizeWhitespace(typeof jobPosting?.description === 'string' ? stripHtml(jobPosting.description) : ''),
    extractMetaContent(html, 'property', 'og:description'),
    extractMetaContent(html, 'name', 'description'),
  );

  return { title, company, description };
}

function getSourceType(url: URL) {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

export async function parseJobUrl(rawUrl: string): Promise<ParsedJobDetails> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { sourceUrl: '', success: false, error: 'jobUrl is required' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { sourceUrl: trimmed, success: false, error: 'Please provide a valid URL.' };
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return { sourceUrl: url.toString(), success: false, error: 'Only http(s) job links are supported.' };
  }

  try {
    const response = await fetch(url.toString(), {
      headers: REQUEST_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      return {
        sourceUrl: url.toString(),
        sourceType: getSourceType(url),
        success: false,
        error: `Could not fetch job page (${response.status}).`,
      };
    }

    const html = await response.text();
    const parsed = /(^|\.)linkedin\.com$/i.test(url.hostname)
      ? parseLinkedInJob(html)
      : parseGenericJob(html);
    const title = normalizeWhitespace(parsed.title);
    const company = normalizeWhitespace(parsed.company);
    const description = normalizeWhitespace(parsed.description);
    const success = Boolean(title || company || description);

    return {
      title,
      company,
      description,
      sourceUrl: url.toString(),
      sourceType: getSourceType(url),
      success,
      error: success ? undefined : 'No job details were detected on this page.',
    };
  } catch (error) {
    return {
      sourceUrl: url.toString(),
      sourceType: getSourceType(url),
      success: false,
      error: error instanceof Error ? error.message : 'Unable to fetch job details.',
    };
  }
}
