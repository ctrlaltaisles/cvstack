/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');

// Load server environment when the script is run directly from a shell.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (_) {
  // Optional dependency in some environments; keep script usable regardless.
}

const { curateResumeWithAI, lexicalSimilarity } = require('../dist/src/ai/tailorResume.js');

const MASTER_NOTES = `When I first joined Rapsodo, the People team was still quite lean and a lot of processes were pretty manual. I was initially brought in to support HR ops, but over time I ended up owning quite a few cross-functional initiatives because there wasn’t always a clear project owner.

For hiring, I worked quite closely with the engineering and product teams. Early on, we didn’t really have a structured campus hiring pipeline, so I helped coordinate with universities, handled a lot of the scheduling chaos (especially across time zones), and cleaned up candidate tracking because our ATS data was messy. I remember rebuilding parts of the candidate tracking sheet and later helping migrate some workflows properly into the HRIS so reporting wouldn’t be so manual. I also started tracking time-to-hire and offer acceptance rates because leadership wanted better visibility.

For onboarding, I noticed new hires were repeatedly asking the same questions — access, benefits, equipment, probation reviews — so I helped create a central onboarding guide and checklist that managers could follow. It wasn’t glamorous work, but it reduced a lot of back-and-forth emails. I also helped standardize Day 1 workflows with IT and Finance so that laptop provisioning and system access wouldn’t be delayed.

There were also employee lifecycle changes — transfers, promotions, offboarding — and I helped document those workflows because we previously relied on Slack threads and email chains. I worked with managers to formalize some of the approval flows so that changes wouldn’t fall through the cracks.

On the systems side, I spent quite a bit of time digging into reporting. Leadership wanted headcount dashboards and cost visibility, and I ended up building recurring reports (mainly Excel and some HRIS exports) that we used in monthly reviews. I’m not a data analyst by training, but I had to learn quickly because decisions were being made off those numbers.

One of the bigger projects was vendor cost optimization. Our Microsoft and AWS contracts were up for renewal and I supported renegotiations — did cost comparisons, usage audits, and benchmark research before discussions. We ended up reducing recurring costs by 23%, which was significant given our size. I also created a basic tracking model so we wouldn’t miss renewal dates again.

The careers page project was something I kind of inherited midway. It was behind schedule and didn’t reflect our employer branding direction. I coordinated between marketing, design, and external developers, clarified content structure, rewrote some sections to better highlight engineering culture, and pushed for a more metrics-driven approach. We ended up launching in half the expected timeline. After launch, I tracked traffic and engagement — page viewership increased by 128% and time spent increased by 68%, and we also saw an uptick in inbound applications.

Aside from formal projects, I was often the “bridge” person between HR and business teams, especially when processes weren’t clear. I handled sensitive employee questions, helped managers navigate policy grey areas, and sometimes facilitated conversations when there were misunderstandings.

Because we were scaling quickly, ambiguity was normal. I had to operate without a lot of documentation and build things as we went. Looking back, I probably did more process design and stakeholder management than what my title suggests.`;

const VARIANT_PM_NOTES = `Outside of core HR ops work, I became increasingly involved in cross-functional initiatives that required translating business needs into structured requirements.

At one point, engineering leaders were frustrated that hiring pipeline visibility was fragmented across spreadsheets and Slack threads. I initiated a working session with HR, engineering, and IT to map the end-to-end hiring workflow, identified bottlenecks in handoffs, and drafted a lightweight internal “workflow spec” outlining state transitions (screening → technical assessment → offer → onboarding). While I didn’t build the system myself, I collaborated with IT to migrate parts of the tracking logic into the HRIS to reduce manual duplication.

I also ran informal discovery interviews with hiring managers to understand friction points in candidate evaluation, synthesized themes, and proposed a structured feedback template that reduced subjective bias and improved clarity in decision-making.

During the careers page redesign, I worked closely with marketing and developers to define user flows and conversion points. I reviewed heatmap analytics and suggested repositioning engineering culture content higher on the page to improve engagement. Post-launch metrics showed increased time-on-page and stronger inbound application quality.

In parallel, I facilitated a small internal pilot where we tested a standardized onboarding “experience journey,” mapping employee touchpoints from offer acceptance to 90-day milestone. I created a journey visualization deck to highlight drop-off risks and collaborated with team leads to introduce checkpoint reviews.

I also supported leadership offsites by preparing headcount planning scenarios based on hiring velocity assumptions, modeling different growth trajectories in Excel to assess cost implications under conservative vs aggressive scaling strategies.

In one instance, I identified recurring delays in IT provisioning that were affecting new hire productivity. I escalated the issue, proposed a revised SLA agreement with IT, and helped implement a tracking dashboard to monitor turnaround times.

Additionally, I contributed to early discussions around integrating HR reporting with product analytics data to better correlate hiring investment with product team velocity, though this initiative remained exploratory.`;

const JD_HITACHI_PM = `Hitachi Energy Service is a trusted lifecycle partner, providing customers with secure, sustainable, and innovative service solutions, globally.

How You’ll Make An Impact
• You will manage service project from sales handover to financial closing, product and service warranties.
• You will be responsible for the financial results of the project and manage project risks.
• You will effectively monitor and control projects progress and ensure that project risks and opportunities are identified and managed for successful on-time and on-cost completion of projects with customer satisfaction, ensure that contract change and claims management in accordance with project contractual, build and maintain strong relationships with internal and external stakeholders and effectively communicate with all stakeholder and cross-functional resources.
• You will act as main contact point for customer during whole project execution.
• You will review the project closure reports and ensure the implementation of lessons learnt in future projects, ensure project reporting to customers and management, review and monitor timely resolution of customer complaints during after sales support.
• You will collaborate with the service engineering team to finalize and manage spare parts and project schedules for the planned maintenance and service jobs.
• You will be responsible to ensure compliance with applicable external and internal regulations, procedures, and guidelines.

Your Background
• Tertiary education in Engineering.
• Possess 5 years of work experience in Project Management / order execution.
• Experience in HV is highly desired, though LV/MV is also can be considered.
• Project Management certification is an added advantage.
• Good knowledge of contract management terms and commercial terms.
• Proficiency in English communication verbally and written.`;

const JD_AMD_PROGRAM = `At AMD, our mission is to build great products that accelerate next-generation computing experiences.

The Role
We are in search of an experienced program manager with strong analytical, problem-solving and risk management skills.

Key Responsibilities
Responsible for leading program level deliverables and related dependencies.
Responsibilities include defining and leading key product deliverables/schedules and driving cross functional activities to achieve high quality deliverables.
Responsible for program leadership and reports out regularly to executives on status, decisions, and solutions to issues during execution.
Foster relationship with program, development, QA and validation teams.
Advocate strong process discipline for samples deliverables.
Align with AMD cross-functional teams on requirements, schedules, and deliverables.
Develop program schedules by considering various dependencies, negotiate and create a plan that supports the schedule.
Building, creating, and maintaining a well-developed, managed and executed program plan is critical.
Establish formal program management artifacts including a plan of record, project/program timelines, requirements and scope.
Identify program risks and coordinate with stakeholders on mitigation plans.
Initiates significant changes to existing processes and methods to improve project and team efficiencies.

Preferred Experience
Program Management experience in a dynamic and competitive industry.
Experience leading cross-functional and cross-regional teams.
Strong knowledge of productivity and project tools including Jira, Confluence, Microsoft Office Suite, PowerBI reporting tools.
Strong analytical and problem-solving skills.
Ability to structure and execute complex analysis, draw insights, and communicate summary findings with recommendations to senior management and customers.
Ability to assess and scope requirements and features and relate them to overall program schedule.
PMP certification a plus, but not required.`;

const BASE_BULLETS = [
  'Supported people operations and hiring-related projects in a growing sports technology company, working with HR and business stakeholders across multiple teams.',
  'Assisted with coordination of early-career hiring activities, onboarding workflows, and employee lifecycle changes, supporting dozens of hires and movements.',
  'Contributed to operational projects focused on improving documentation, learning resources, and access to HR information.',
  'Supported HR systems and tools to improve reporting, visibility, and day-to-day operational efficiency.',
  'Negotiated and closed IT vendor contracts, achieving a 23% reduction in annual recurring costs across Microsoft and AWS.',
  'Project-managed the redesign and launch of the company careers webpage, delivering the project in 50% of the planned timeline while aligning with employer branding goals. Viewership was up 128% and engagement time was up 68%.',
];

const MASTER_MARKERS = [
  { name: 'time_to_hire', pattern: /\btime[- ]to[- ]hire\b/i },
  { name: 'offer_acceptance', pattern: /\boffer acceptance\b/i },
  { name: 'hris_migration', pattern: /\bhris\b/i },
  { name: 'campus_hiring', pattern: /\bcampus hiring|universit(y|ies)\b/i },
  { name: 'day1_workflow', pattern: /\bday 1|provisioning|onboarding guide|checklist\b/i },
  { name: 'lifecycle_flows', pattern: /\btransfers?|promotions?|offboarding|approval flow\b/i },
  { name: 'headcount_reporting', pattern: /\bheadcount|cost visibility|monthly reviews?\b/i },
  { name: 'career_page_metrics', pattern: /\b128%|68%|engagement|viewership|careers page\b/i },
  { name: 'vendor_optimization', pattern: /\b23%|vendor|microsoft|aws|renewal\b/i },
];

const VARIANT_MARKERS = [
  { name: 'workflow_spec', pattern: /\bworkflow spec|state transitions?\b/i },
  { name: 'discovery_interviews', pattern: /\bdiscovery interviews?|hiring managers\b/i },
  { name: 'feedback_template_bias', pattern: /\bfeedback template|subjective bias\b/i },
  { name: 'heatmap_conversion', pattern: /\bheatmap|conversion\b/i },
  { name: 'journey_90_day', pattern: /\bexperience journey|90-day|touchpoints|drop-off\b/i },
  { name: 'scenario_modeling', pattern: /\bscenarios?|hiring velocity|growth trajectories\b/i },
  { name: 'sla_dashboard', pattern: /\bsla|turnaround|tracking dashboard\b/i },
  { name: 'analytics_integration', pattern: /\bintegrat(e|ing).*(analytics|reporting)|product team velocity\b/i },
];

const PM_SIGNAL_MARKERS = [
  { name: 'scope', pattern: /\bscope\b/i },
  { name: 'timeline', pattern: /\btimeline|schedule|milestone\b/i },
  { name: 'dependencies', pattern: /\bdependencies|handoff\b/i },
  { name: 'stakeholders', pattern: /\bstakeholder|cross-functional|coordina(ted|tion)\b/i },
  { name: 'risk', pattern: /\brisk|issue|mitigat(e|ion)\b/i },
  { name: 'reporting', pattern: /\breport(ing)?|status|dashboard\b/i },
  { name: 'planning', pattern: /\bplan|plan of record|tracker\b/i },
];

const PROGRAM_EXEC_MARKERS = [
  { name: 'workflow_spec_transitions', pattern: /\bworkflow spec|state transitions?\b/i },
  { name: 'program_artifacts', pattern: /\bchecklist|template|artifact|approval flow|tracker\b/i },
  { name: 'capacity_modeling', pattern: /\bscenario|capacity model|hiring velocity|growth trajectories|cost exposure\b/i },
  { name: 'exec_reporting', pattern: /\bexecutive|monthly review|headcount|time-to-hire|cost visibility|dashboard\b/i },
  { name: 'risk_sla_controls', pattern: /\bsla|risk|mitigat(e|ion)|provisioning delays?|turnaround\b/i },
  { name: 'commercial_controls', pattern: /\bvendor|microsoft|aws|renewal|usage audit|benchmark|23%\b/i },
  { name: 'delivery_schedule', pattern: /\bdeliverables?|timeline|schedule|50%|half the expected timeline|launch\b/i },
  { name: 'discovery_to_framework', pattern: /\bdiscovery interviews?|feedback template|subjective bias|decision clarity\b/i },
  { name: 'journey_risk_mapping', pattern: /\bjourney|90-day|touchpoints|drop-off\b/i },
];

function makeResumeData(projectNotes) {
  return {
    name: 'Aileen Ooi',
    title: 'People Projects Intern (HR Operations & Cross-Functional Projects)',
    contact: {
      email: 'aileen@example.com',
      phone: '+65 9000 0000',
      location: 'Singapore',
      website: '',
      linkedin: '',
    },
    bio: '',
    workExperience: [
      {
        id: 'exp_rps',
        company: 'Rapsodo Pte Ltd. (Sports Technology)',
        role: 'People Projects Intern (HR Operations & Cross-Functional Projects)',
        startDate: { month: 1, year: 2020, present: false },
        endDate: { month: 2, year: 2026, present: false },
        bullets: [...BASE_BULLETS],
        projectNotes: projectNotes || '',
      },
    ],
    education: [],
    certifications: [],
    skills: ['HR Operations', 'Stakeholder Coordination', 'Reporting', 'Process Improvement'],
  };
}

function markerCoverage(text, markerDefs) {
  const hits = [];
  for (const marker of markerDefs) {
    if (marker.pattern.test(text)) hits.push(marker.name);
  }
  return hits;
}

function avgSimilarity(beforeBullets, afterBullets) {
  const pairs = [];
  const max = Math.min(beforeBullets.length, afterBullets.length);
  for (let i = 0; i < max; i += 1) {
    const before = (beforeBullets[i] || '').trim();
    const after = (afterBullets[i] || '').trim();
    if (!before || !after) continue;
    pairs.push(lexicalSimilarity(before, after));
  }
  if (pairs.length === 0) return 0;
  return Number((pairs.reduce((a, b) => a + b, 0) / pairs.length).toFixed(2));
}

function countMeaningfulChanges(beforeBullets, afterBullets) {
  const max = Math.max(beforeBullets.length, afterBullets.length);
  let changed = 0;
  for (let i = 0; i < max; i += 1) {
    const before = (beforeBullets[i] || '').trim();
    const after = (afterBullets[i] || '').trim();
    if (!after) continue;
    if (!before) {
      changed += 1;
      continue;
    }
    const sim = lexicalSimilarity(before, after);
    if (sim < 0.82) changed += 1;
  }
  return changed;
}

function notesForScenario(kind) {
  if (kind === 'none') return '';
  if (kind === 'master') return MASTER_NOTES;
  if (kind === 'merged_pm') {
    return `From Master Resume\n${MASTER_NOTES}\n\nFrom Project Manager @ Hitachi Electronics\n${VARIANT_PM_NOTES}`;
  }
  return '';
}

const SCENARIOS = [
  {
    id: 'S1_base_curate_no_jd',
    title: 'First Upload + Curate (no project notes, no JD)',
    role: 'People Projects Intern',
    jobCompany: '',
    jdText: '',
    notesKind: 'none',
    runs: 1,
  },
  {
    id: 'S2_base_curate_with_master_notes_no_jd',
    title: 'Add Master Project Notes + Curate (no JD)',
    role: 'People Projects Intern',
    jobCompany: '',
    jdText: '',
    notesKind: 'master',
    runs: 1,
  },
  {
    id: 'S3_hitachi_pm_with_master_notes',
    title: 'Add Hitachi PM JD + Auto Curate',
    role: 'Project Manager',
    jobCompany: 'Hitachi Electronics',
    jdText: JD_HITACHI_PM,
    notesKind: 'master',
    runs: 1,
  },
  {
    id: 'S4_hitachi_pm_with_master_and_variant_notes',
    title: 'Add PM Variant Notes + Curate',
    role: 'Project Manager',
    jobCompany: 'Hitachi Electronics',
    jdText: JD_HITACHI_PM,
    notesKind: 'merged_pm',
    runs: 2,
  },
  {
    id: 'S5_amd_program_manager_with_merged_notes',
    title: 'Add AMD Program Manager JD + Auto Curate',
    role: 'Program Manager',
    jobCompany: 'AMD',
    jdText: JD_AMD_PROGRAM,
    notesKind: 'merged_pm',
    runs: 2,
  },
];

async function runScenario(scenario, runIndex) {
  const notes = notesForScenario(scenario.notesKind);
  const resumeData = makeResumeData(notes);
  const requestId = `stress_${scenario.id}_${runIndex}`;

  const started = Date.now();
  let result;
  try {
    result = await curateResumeWithAI(
      {
        resumeData,
        targetRole: scenario.role,
        jdText: scenario.jdText || undefined,
        jobCompany: scenario.jobCompany || undefined,
        jobLink: undefined,
      },
      requestId,
    );
  } catch (error) {
    return {
      scenarioId: scenario.id,
      run: runIndex,
      status: 'error',
      elapsedMs: Date.now() - started,
      error: String(error && error.message ? error.message : error),
    };
  }

  const exp = result.improved.experience.find((row) => row.expId === 'exp_rps');
  const outBullets = exp ? exp.bullets.filter((b) => b.trim()) : [];
  const joinedBullets = outBullets.join('\n');
  const masterCoverage = markerCoverage(joinedBullets, MASTER_MARKERS);
  const variantCoverage = markerCoverage(joinedBullets, VARIANT_MARKERS);
  const pmCoverage = markerCoverage(joinedBullets, PM_SIGNAL_MARKERS);
  const programCoverage = markerCoverage(joinedBullets, PROGRAM_EXEC_MARKERS);
  const avgSim = avgSimilarity(BASE_BULLETS, outBullets);
  const meaningfulChanges = countMeaningfulChanges(BASE_BULLETS, outBullets);

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    run: runIndex,
    status: 'ok',
    elapsedMs: Date.now() - started,
    providerStatus: result.meta && result.meta.providerStatus ? result.meta.providerStatus : 'unknown',
    fallbackReason: result.meta && result.meta.fallbackReason ? result.meta.fallbackReason : '',
    quality: result.quality || null,
    bulletCount: outBullets.length,
    bullets: outBullets,
    avgSimilarityToBase: avgSim,
    meaningfulChanges,
    rewordingRisk: avgSim >= 0.82 && meaningfulChanges <= 2,
    masterNotesCoverage: {
      hitCount: masterCoverage.length,
      hits: masterCoverage,
    },
    variantNotesCoverage: {
      hitCount: variantCoverage.length,
      hits: variantCoverage,
    },
    pmSignalCoverage: {
      hitCount: pmCoverage.length,
      hits: pmCoverage,
    },
    programExecutionCoverage: {
      hitCount: programCoverage.length,
      hits: programCoverage,
    },
    questions: result.questions || [],
    redFlags: result.redFlags || [],
    changeSummary: result.changeSummary || [],
    jdFocusAreas: result.jdFocusAreas || [],
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY. Add it to server/.env or export it in your shell before running the stress test.');
    process.exit(1);
  }

  const all = [];
  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= scenario.runs; run += 1) {
      console.log(`Running ${scenario.id} (run ${run}/${scenario.runs})...`);
      const out = await runScenario(scenario, run);
      all.push(out);
      console.log(`  -> ${out.status} (${out.elapsedMs}ms) provider=${out.providerStatus || 'n/a'} bullets=${out.bulletCount || 0} rewordingRisk=${out.rewordingRisk === true ? 'HIGH' : 'LOW'}`);
    }
  }

  const outputDir = path.resolve(__dirname, '..', 'stress-results');
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outputDir, `curate-stress-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: all }, null, 2), 'utf8');

  console.log(`\nSaved detailed results to: ${outPath}`);

  const compact = all.map((row) => ({
    scenario: row.scenarioId,
    run: row.run,
    status: row.status,
    providerStatus: row.providerStatus,
    fallbackReason: row.fallbackReason,
    bulletCount: row.bulletCount,
    avgSimilarityToBase: row.avgSimilarityToBase,
    meaningfulChanges: row.meaningfulChanges,
    rewordingRisk: row.rewordingRisk,
    masterNotesHitCount: row.masterNotesCoverage ? row.masterNotesCoverage.hitCount : 0,
    variantNotesHitCount: row.variantNotesCoverage ? row.variantNotesCoverage.hitCount : 0,
    pmSignalHitCount: row.pmSignalCoverage ? row.pmSignalCoverage.hitCount : 0,
    programSignalHitCount: row.programExecutionCoverage ? row.programExecutionCoverage.hitCount : 0,
  }));
  console.log('\nSummary:');
  console.table(compact);
}

main().catch((error) => {
  console.error('Stress test failed:', error);
  process.exit(1);
});
