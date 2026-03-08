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
  const sections = [...html.matchAll(/<li>(.*?)<\/li>|<p>(.*?)<\/p>/g)]
    .map((match) => (match[1] || match[2] || ''))
    .map((value) => value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return sections.join('\n');
}

function buildResumeData() {
  return {
    name: 'Choo Yuan Jie',
    title: 'Product Designer',
    contact: {
      email: 'deceiveyoureyes@gmail.com',
      phone: '+65 8133 5537',
      location: 'Singapore',
      website: 'yuanjie.info',
      linkedin: 'LinkedIn',
    },
    bio: 'Yuan Jie designs simple and logical digital user experiences, informed through research and built intuition. He loves diving deep into interesting problem spaces, is a crypto native and admires data as an art form.',
    workExperience: [
      {
        id: 'cg',
        company: 'CoinGecko',
        role: 'Product Designer II',
        startDate: { month: 11, year: 2023, present: false },
        endDate: { month: 3, year: 2026, present: true },
        bullets: [
          'Lead UI/UX of DEX Tracking Platform, from 0 to 1.',
          'Provide UX risks to prioritise features, and shipped more than 50 design enhancements.',
          'Led company wide design discovery research to uncover UX opportunities. Launched redesigned App to increase of average retention time by ~2x.',
          'Led end-to-end design and research to uncover trading UX opportunities, such as reducing search time by 75%.',
          'Spearhead creation of feedback channels to iterate with customers faster, reducing feature feedback time from 2 days to 10 minutes.',
        ],
        projectNotes: '',
      },
      {
        id: 'bn',
        company: 'Binance',
        role: 'Product Designer (Contract)',
        startDate: { month: 6, year: 2023, present: false },
        endDate: { month: 11, year: 2023, present: false },
        bullets: [
          'Analysed and Proposed a redesign UI and UX of Binance Earn App Homepage to increase conversion rate through cross-product promotion.',
          'Built a plugin on Figma that helped wider Binance Team designers to analyse 2000+ CSAT and NPS surveys responses ~30% faster.',
        ],
        projectNotes: '',
      },
      {
        id: 'gr',
        company: 'Grab',
        role: 'Product Designer Intern',
        startDate: { month: 11, year: 2022, present: false },
        endDate: { month: 2, year: 2023, present: false },
        bullets: [
          'Redesigned UX of Error Messages that involved 6 different verticals of products, ensuring a uniform content language that helps people recover faster, reducing churn.',
        ],
        projectNotes: '',
      },
      {
        id: 'sh',
        company: 'Shopee',
        role: 'UX Designer Intern',
        startDate: { month: 11, year: 2021, present: false },
        endDate: { month: 1, year: 2022, present: false },
        bullets: [
          'Collaborated with stakeholders to audit ShopeePay’s Payment UX to let users make payments more efciently.',
          'Planned, recruited and conducted live usability testing on 10 participants.',
          'Executed A/B testing by building and testing two prototypes on Origami Studio and Figma.',
          'Uncovered 4 improvements areas and explored various UI and Interaction Design solutions, which went live',
        ],
        projectNotes: '',
      },
      {
        id: 'fr',
        company: 'Various Brands',
        role: 'Freelance Designer & Developer',
        startDate: { month: 3, year: 2019, present: false },
        endDate: { month: 3, year: 2026, present: true },
        bullets: [
          'Built a part of a web app, Hawker Colours, learned React the hard way.',
          'Redesigned and developed an online merchandise platform to increase user donations to charities by 40%.',
        ],
        projectNotes: '',
      },
    ],
    education: [],
    certifications: [],
    skills: [
      'Interaction Design',
      'Visual Design',
      'Motion Design',
      'Usability Testing',
      'User Interviews',
      'User Research',
      'Surveys',
      'User Flows',
      'Origami Studio',
      'Figma',
      'HTML/CSS',
      'Javascript',
      'React',
    ],
  };
}

function scoreOutput(result) {
  const about = String(result.improved?.about || '');
  const bullets = (result.improved?.experience || []).flatMap((exp) => exp.bullets || []);
  const fullText = `${about}\n${bullets.join('\n')}`;
  const checks = [
    { id: 'about_product_systems', pattern: /product designer.*(complex systems|data-driven|tools)/i },
    { id: 'about_dev_fluency', pattern: /(front-end development|tooling fluency|design, research, and tooling)/i },
    { id: 'coingecko_0to1', pattern: /dex tracking platform.*(0 to 1|from 0 to 1|foundation of the product experience)/i },
    { id: 'coingecko_prioritization', pattern: /(ux risk|prioritization).*(50\+|50)/i },
    { id: 'coingecko_retention', pattern: /retention time.*(2x|2 x|doubled)/i },
    { id: 'coingecko_search', pattern: /search time.*75%/i },
    { id: 'coingecko_feedback', pattern: /feedback (cycles|time).*(2 days).*(10 minutes)/i },
    { id: 'binance_homepage', pattern: /binance earn homepage.*(conversion|cross-product discovery|information hierarchy)/i },
    { id: 'binance_plugin', pattern: /figma plugin.*(2000\+|2000).*(csat|nps).*(30%|30)/i },
    { id: 'grab_error_system', pattern: /error messaging.*(verticals|content system|recover faster|reduced churn)/i },
    { id: 'shopee_audit', pattern: /shopeepay.*(payment flows|payment experience|audit)/i },
    { id: 'shopee_testing', pattern: /(usability testing).*(10 participants|10)/i },
    { id: 'shopee_ab', pattern: /(origami studio|figma).*(a\/b testing|competing prototypes|interaction patterns)/i },
    { id: 'shopee_shipped', pattern: /(4|four).*(improvements|usability improvements).*(shipped|went live)/i },
    { id: 'freelance_react', pattern: /react.*(web app|front-end)/i },
    { id: 'freelance_40', pattern: /40%/i },
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
    console.error('Missing OPENAI_API_KEY. Add it to server/.env or export it in your shell before running the designer stress test.');
    process.exit(1);
  }

  const jdHtml = fs.readFileSync(JD_PATH, 'utf8');
  const jdText = jdFromHtml(jdHtml);
  const resumeData = buildResumeData();
  const runs = [];

  for (let run = 1; run <= 3; run += 1) {
    const started = Date.now();
    const result = await curateResumeWithAI({
      resumeData,
      targetRole: 'Product Designer - Design, Dev, & AI Tools',
      jdText,
      jobCompany: 'Figma',
    }, `designer_figma_${run}`);
    const score = scoreOutput(result);
    const exp = result.improved.experience.map((item) => ({
      company: item.company,
      role: item.role,
      bullets: item.bullets,
    }));
    runs.push({
      run,
      elapsedMs: Date.now() - started,
      qualityPassed: Boolean(result.quality?.passed),
      score: score.score,
      passedIds: score.passedIds,
      missedIds: score.missedIds,
      about: result.improved.about,
      experience: exp,
    });
    console.log(`run=${run} elapsedMs=${Date.now() - started} quality=${result.quality?.passed} score=${score.score}`);
  }

  const outputDir = path.resolve(__dirname, '..', 'stress-results');
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `designer-stress-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2), 'utf8');
  console.log(`Saved detailed results to: ${outputPath}`);
}

main().catch((error) => {
  console.error('Designer stress test failed:', error);
  process.exit(1);
});
