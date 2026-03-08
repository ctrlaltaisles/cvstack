/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_) {
  // Optional in some environments.
}

const { curateResumeWithAI, evaluateCurateQuality } = require('../dist/src/ai/tailorResume.js');

const FIGMA_JD = `
Product Designer - Design, Dev, & AI Tools
Contribute to overall strategy and decision-making about product direction.
Work cross-functionally with product management, engineering, design, and research peers.
Create and iterate on flows, prototypes, and high-fidelity visuals.
Design and ship high-quality features and product improvements in Figma's core product surfaces.
The ability to guide decision-making with structured thinking and user-centered research.
Experience researching, prototyping, or building products with AI and other emerging tools.
Familiarity with web technologies like HTML/CSS, prototyping tools such as Origami, or advanced Figma features like Auto Layout, Variables, and Components.
Prior work involving design systems or tools that support creative workflows.
`;

function makeResumeData() {
  return {
    name: 'Choo Yuan Jie',
    title: 'Product Designer',
    contact: {
      email: 'deceiveyoureyes@gmail.com',
      phone: '+65 8133 5537',
      location: 'Singapore',
      website: 'https://yuanjie.info',
      linkedin: '',
    },
    bio: '',
    workExperience: [
      {
        id: 'exp-cg',
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
        id: 'exp-binance',
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
        id: 'exp-grab',
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
        id: 'exp-shopee',
        company: 'Shopee',
        role: 'UX Designer Intern',
        startDate: { month: 11, year: 2021, present: false },
        endDate: { month: 1, year: 2022, present: false },
        bullets: [
          'Collaborated with stakeholders to audit ShopeePay’s Payment UX to let users make payments more efficiently.',
          'Planned, recruited and conducted live usability testing on 10 participants.',
          'Executed A/B testing by building and testing two prototypes on Origami Studio and Figma.',
          'Uncovered 4 improvements areas and explored various UI and Interaction Design solutions, which went live.',
        ],
        projectNotes: '',
      },
      {
        id: 'exp-freelance',
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
    awards: [],
    skills: ['Figma', 'Origami Studio', 'HTML/CSS', 'React', 'User Research'],
  };
}

const MARKERS = {
  productThinking: /\b(product|priorit|decision|information architecture|workflow|0 to 1|0->1|from 0 to 1|strategy)\b/i,
  collaboration: /\b(engineer|product management|pm\b|cross-functional|stakeholder|research)\b/i,
  systemsToolingCraft: /\b(plugin|tool|system|design system|components?|variables|html|css|react|prototype|origami|figma|craft)\b/i,
  impactIteration: /\b(iterat|feedback|research|usability|a\/b|retention|conversion|engagement|search time|csat|nps|reduced|increased|launched|shipped)\b/i,
};

function scoreBullets(bullets) {
  const text = bullets.join('\n');
  return {
    productThinking: MARKERS.productThinking.test(text),
    collaboration: MARKERS.collaboration.test(text),
    systemsToolingCraft: MARKERS.systemsToolingCraft.test(text),
    impactIteration: MARKERS.impactIteration.test(text),
  };
}

async function runOnce(run) {
  const resumeData = makeResumeData();
  const result = await curateResumeWithAI(
    {
      resumeData,
      targetRole: 'Product Designer - Design, Dev, & AI Tools',
      jdText: FIGMA_JD,
      jobCompany: 'Figma',
    },
    `designer_stress_${run}`,
  );

  const quality = evaluateCurateQuality(
    { resumeData, targetRole: 'Product Designer - Design, Dev, & AI Tools', jdText: FIGMA_JD },
    result,
  );
  const allBullets = result.improved.experience.flatMap((exp) => exp.bullets);
  return {
    run,
    providerStatus: result.meta?.providerStatus ?? 'unknown',
    fallbackReason: result.meta?.fallbackReason ?? '',
    quality,
    dimensions: scoreBullets(allBullets),
    about: result.improved.about,
    experience: result.improved.experience,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY. Export it or add it to server/.env before running this stress test.');
    process.exit(1);
  }

  const runs = Number(process.env.CVSTACK_DESIGNER_STRESS_RUNS ?? 3);
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    console.log(`Running Figma designer stress test ${run}/${runs}...`);
    const result = await runOnce(run);
    results.push(result);
    console.log(`  -> provider=${result.providerStatus} passed=${result.quality.passed} impact=${result.quality.impactScore} ats=${result.quality.atsScore}`);
  }

  const outDir = path.resolve(__dirname, '..', 'stress-results');
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `designer-stress-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`Saved detailed results to ${outPath}`);
}

main().catch((error) => {
  console.error('Designer stress test failed:', error);
  process.exit(1);
});
