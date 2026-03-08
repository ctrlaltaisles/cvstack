import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCurateQuality, extractJDKeywords, type CurateResumeOutput } from './tailorResume';
import type { ResumeData } from '../types';

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

function makeResumeData(): ResumeData {
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

function makeOutput(improved: CurateResumeOutput['improved']): CurateResumeOutput {
  return {
    changeSummary: [],
    redFlags: [],
    aboutPointers: [],
    jdFocusAreas: [],
    positioningSummary: '',
    jdTldr: {
      roleAsks: '',
      candidateNeeds: '',
      keyFocusAreas: [],
    },
    companyContext: undefined,
    suggestions: [],
    improved,
    changes: [],
    ats: {
      targetRole: 'Product Designer - Design, Dev, & AI Tools',
      keywordsAdded: [],
      keywordsMissing: [],
    },
    questions: [],
    quality: {
      similarityScore: 0,
      impactScore: 0,
      atsScore: 0,
      passed: false,
      notes: '',
    },
  };
}

test('extractJDKeywords pulls Figma designer signals', () => {
  const keywords = extractJDKeywords(FIGMA_JD, 'Product Designer - Design, Dev, & AI Tools');
  assert.ok(keywords.includes('product direction'));
  assert.ok(keywords.includes('cross-functional'));
  assert.ok(keywords.includes('design systems'));
  assert.ok(keywords.includes('html/css'));
  assert.ok(keywords.includes('origami'));
  assert.ok(keywords.includes('ai'));
});

test('evaluateCurateQuality passes a grounded Level-3 designer rewrite', () => {
  const resumeData = makeResumeData();
  const output = makeOutput({
    about: 'Product designer focused on turning ambiguous product problems into clear, measurable experiences for complex systems. Combines design, research, and front-end fluency to build interfaces and tools that improve how users work.',
    experience: [
      {
        expId: 'exp-cg',
        role: 'Product Designer II',
        company: 'CoinGecko',
        bullets: [
          'Led 0 to 1 design of the DEX Tracking Platform, defining information architecture and trading workflows for a new product surface.',
          'Introduced UX risk assessments to guide feature prioritization, contributing to more than 50 shipped design improvements across core product flows.',
          'Led company-wide design discovery that informed a major app redesign, increasing average retention time by ~2x.',
          'Ran end-to-end research across trading behaviors to uncover product opportunities and reduce asset search time by 75%.',
          'Built customer feedback channels that reduced feature feedback cycles from 2 days to 10 minutes and accelerated iteration.',
        ],
      },
      {
        expId: 'exp-binance',
        role: 'Product Designer (Contract)',
        company: 'Binance',
        bullets: [
          'Redesigned the Binance Earn homepage to improve cross-product discovery and increase conversion through clearer information hierarchy.',
          'Built a plugin on Figma that helped wider Binance Team designers to analyse 2000+ CSAT and NPS surveys responses ~30% faster.',
        ],
      },
      {
        expId: 'exp-grab',
        role: 'Product Designer Intern',
        company: 'Grab',
        bullets: [
          'Redesigned UX of Error Messages that involved 6 different verticals of products, ensuring a uniform content language that helps people recover faster, reducing churn.',
        ],
      },
      {
        expId: 'exp-shopee',
        role: 'UX Designer Intern',
        company: 'Shopee',
        bullets: [
          'Audited ShopeePay payment flows with stakeholders to reduce friction in payment experiences.',
          'Planned, recruited, and ran live usability tests with 10 participants to validate key payment-flow hypotheses.',
          'Prototyped and A/B tested two interaction models in Origami Studio and Figma, uncovering four improvement areas that later shipped.',
        ],
      },
      {
        expId: 'exp-freelance',
        role: 'Freelance Designer & Developer',
        company: 'Various Brands',
        bullets: [
          'Built part of the Hawker Colours web app, using React to strengthen design-development fluency.',
          'Redesigned and developed an online merchandise platform that increased charity donations by 40%.',
        ],
      },
    ],
    skills: ['Figma', 'Origami Studio', 'HTML/CSS', 'React', 'User Research'],
  });
  output.ats.keywordsAdded = [
    { keyword: 'product direction', where: 'about' },
    { keyword: 'cross-functional', where: 'experience' },
    { keyword: 'prototyping', where: 'experience' },
    { keyword: 'design systems', where: 'experience' },
    { keyword: 'html/css', where: 'skills' },
    { keyword: 'origami', where: 'skills' },
    { keyword: 'ai', where: 'about' },
  ];

  const quality = evaluateCurateQuality(
    { resumeData, targetRole: 'Product Designer - Design, Dev, & AI Tools', jdText: FIGMA_JD },
    output,
  );

  assert.equal(quality.passed, true);
  assert.ok(quality.impactScore >= 0.3);
  assert.ok(quality.atsScore >= 0.3);
  assert.match(quality.notes, /Designer rewrite coverage=/);
});

test('evaluateCurateQuality rejects a shallow designer rewrite', () => {
  const resumeData = makeResumeData();
  const output = makeOutput({
    about: 'Product designer with UX/UI experience across multiple companies.',
    experience: [
      {
        expId: 'exp-cg',
        role: 'Product Designer II',
        company: 'CoinGecko',
        bullets: [
          'Worked on the DEX Tracking Platform and improved the UI/UX.',
          'Shared UX risks for features and made many enhancements.',
          'Conducted research and launched a redesigned app.',
          'Looked at trading UX and improved search.',
          'Created feedback channels to get faster feedback.',
        ],
      },
      {
        expId: 'exp-binance',
        role: 'Product Designer (Contract)',
        company: 'Binance',
        bullets: [
          'Proposed a redesign for the Binance Earn homepage.',
          'Built a plugin to review survey responses faster.',
        ],
      },
      {
        expId: 'exp-grab',
        role: 'Product Designer Intern',
        company: 'Grab',
        bullets: [
          'Improved error messages across several products.',
        ],
      },
      {
        expId: 'exp-shopee',
        role: 'UX Designer Intern',
        company: 'Shopee',
        bullets: [
          'Audited payment UX and ran usability testing.',
          'Built prototypes in Origami Studio and Figma.',
          'Found improvements that went live.',
        ],
      },
      {
        expId: 'exp-freelance',
        role: 'Freelance Designer & Developer',
        company: 'Various Brands',
        bullets: [
          'Built part of a web app and learned React.',
          'Redesigned and developed a merchandise platform.',
        ],
      },
    ],
    skills: ['Figma', 'Origami Studio', 'HTML/CSS', 'React', 'User Research'],
  });

  const quality = evaluateCurateQuality(
    { resumeData, targetRole: 'Product Designer - Design, Dev, & AI Tools', jdText: FIGMA_JD },
    output,
  );

  assert.equal(quality.passed, false);
  assert.match(quality.notes, /Designer rewrite coverage=/);
});
