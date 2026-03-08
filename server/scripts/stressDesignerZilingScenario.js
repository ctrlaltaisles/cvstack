/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_) {
  // Optional in some environments.
}

const { curateResumeWithAI } = require('../dist/src/ai/tailorResume.js');

const JD_PATH = '/Users/aileenooi/Downloads/Job Application for Product Designer - Design, Dev, & AI Tools at Figma.html';

function jdFromHtml(html) {
  const sections = [...html.matchAll(/<(li|p|h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => match[2] || '')
    .map((value) => value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return sections.join('\n');
}

function buildResumeData() {
  return {
    name: 'Ziling',
    title: 'Designer',
    contact: { location: 'Singapore' },
    bio: '',
    workExperience: [
      {
        id: 'nus',
        company: 'Communication Design Hub, NUS',
        role: 'Communication Designer (Part-time)',
        startDate: { month: 8, year: 2022, present: false },
        endDate: { month: 3, year: 2026, present: true },
        bullets: [
          'Spearheaded the creation and development of brand identity and design concepts for NUS CDE Open House 2023',
          'Conceptualised and executed editorial design for Tan Ean Kiam Arts Awards 2023 and presented design proposal to key decision-makers',
        ],
        projectNotes: '',
      },
      {
        id: 'philips',
        company: 'Philips Experience Design',
        role: 'Service Designer (Contract)',
        startDate: { month: 1, year: 2022, present: false },
        endDate: { month: 6, year: 2022, present: false },
        bullets: [
          'Design consulting for healthcare within APAC markets',
          'Developed and facilitated design thinking workshops across virtual and physical spaces involving multiple high-level stakeholders',
          'Moderated co-create workshops and presented findings to stakeholders',
          'Supported strategic consulting projects for various Personal Health to Health Systems business units within Philips APAC',
          'Conducted market research and social media analysis to revamp Philips Male Grooming and Mother and Child Care branding and retail concepts',
        ],
        projectNotes: '',
      },
      {
        id: 'stuck',
        company: 'STUCK Design',
        role: 'Communication Designer (Contract)',
        startDate: { month: 5, year: 2020, present: false },
        endDate: { month: 9, year: 2020, present: false },
        bullets: [
          'Creation and development of Art Direction, Digital Publication and Editorial Wayfinding Design for an architectural blueprint',
        ],
        projectNotes: '',
      },
      {
        id: 'tribal',
        company: 'Tribal Worldwide, DDB Group',
        role: 'Jr. UX Designer',
        startDate: { month: 5, year: 2018, present: false },
        endDate: { month: 7, year: 2019, present: false },
        bullets: [
          'Examined websites and apps (web audits) pain points to build user journeys',
          'Translated complex content into efficient, bite-sized format to facilitate effective communication',
          'Conducted one-on-one user interviews',
          'Developed test scripts and discussion guides',
          'Built user flows and wireframes',
          'Conducted content audits and built information architecture',
          'Recommended design improvements for websites and mobile apps based on iterative usability testings, design heuristics and best practices',
          'Conducted UX talk internally for knowlege-sharing purpose',
        ],
        projectNotes: '',
      },
    ],
    education: [],
    certifications: [],
    skills: [
      'UIUX Design',
      'User Research',
      'Branding',
      'Usability Testing',
      'Motion Design',
      'Illustration',
      'Content Design',
      'User Flows',
      'Design Thinking',
      'Critical Thinking',
      'Information Architecture',
      'Storytelling',
    ],
  };
}

function scoreOutput(result) {
  const about = String(result.improved?.about || '');
  const bullets = (result.improved?.experience || []).flatMap((exp) => exp.bullets || []);
  const fullText = `${about}\n${bullets.join('\n')}`;
  const checks = [
    { id: 'about_product', pattern: /product designer/i },
    { id: 'about_systems', pattern: /(systems thinking|complex workflows|user-centered product journeys)/i },
    { id: 'about_research_craft', pattern: /(user research|interaction design craft|high-impact product experiences)/i },
    { id: 'philips_research', pattern: /apac healthcare markets.*(opportunities|personal health|health-systems)/i },
    { id: 'philips_workshops', pattern: /(design thinking|co-creation) workshops.*(cross-functional stakeholders|user needs|service opportunities)/i },
    { id: 'philips_strategy', pattern: /strategic design projects.*(business units|experience opportunities|stakeholder inputs)/i },
    { id: 'philips_market', pattern: /(market research|social insights).*(male grooming|mother)/i },
    { id: 'nus_brand', pattern: /open house 2023.*(visual identity|experience design|brand language)/i },
    { id: 'nus_editorial', pattern: /(arts awards|editorial).*(storytelling|decision-makers|design rationale)/i },
    { id: 'stuck_systems', pattern: /(digital publication|editorial wayfinding).*(systems|frameworks|spatial narratives|audience experiences)/i },
    { id: 'tribal_research', pattern: /(user interviews|usability testing).*(websites|mobile apps|friction points)/i },
    { id: 'tribal_ia', pattern: /(user journeys|user flows|wireframes|information architecture).*(complex digital experiences|content structure|simplify)/i },
    { id: 'tribal_recommendations', pattern: /((ux|design) recommendations).*(heuristics|iterative usability testing|research insights)|(heuristics|iterative usability testing|research insights).*((ux|design) recommendations)/i },
    { id: 'tribal_culture', pattern: /(knowledge-sharing|ux methods).*(human-centered design|research)/i },
  ];
  const passed = checks.filter((check) => check.pattern.test(fullText));
  return {
    score: Number((passed.length / checks.length).toFixed(2)),
    passedIds: passed.map((check) => check.id),
    missedIds: checks.filter((check) => !check.pattern.test(fullText)).map((check) => check.id),
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY. Add it to server/.env or export it in your shell before running the Ziling designer stress test.');
    process.exit(1);
  }

  const jdHtml = fs.readFileSync(JD_PATH, 'utf8');
  const jdText = jdFromHtml(jdHtml);
  const resumeData = buildResumeData();
  const runs = [];

  for (let run = 1; run <= 5; run += 1) {
    const started = Date.now();
    const result = await curateResumeWithAI({
      resumeData,
      targetRole: 'Product Designer - Design, Dev, & AI Tools',
      jdText,
      jobCompany: 'Figma',
    }, `designer_figma_ziling_${run}`);
    const score = scoreOutput(result);
    runs.push({
      run,
      elapsedMs: Date.now() - started,
      qualityPassed: Boolean(result.quality?.passed),
      score: score.score,
      passedIds: score.passedIds,
      missedIds: score.missedIds,
      about: result.improved.about,
      experience: result.improved.experience.map((item) => ({
        company: item.company,
        role: item.role,
        bullets: item.bullets,
      })),
    });
    console.log(`run=${run} elapsedMs=${Date.now() - started} quality=${result.quality?.passed} score=${score.score}`);
  }

  const outputDir = path.resolve(__dirname, '..', 'stress-results');
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `designer-ziling-stress-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2), 'utf8');
  console.log(`Saved detailed results to: ${outputPath}`);
}

main().catch((error) => {
  console.error('Ziling designer stress test failed:', error);
  process.exit(1);
});
