const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeContext, parseResume } = require('../src/resume-context');
const { buildInterviewContext, detectCategory } = require('../src/interview-context');

// ── buildResumeContext (backward-compat shim) ─────────────────────────────────
test('buildResumeContext returns a structured prompt block for resume text', () => {
  const resume = 'Jane Doe\nSoftware Engineer\n\nSkills\nJavaScript, Node.js\n\nExperience\n3 years at Acme Corp';
  const result = buildResumeContext(resume, '', 'say');
  assert.ok(result !== null, 'should not be null');
  assert.match(result, /Your Background/i);
  assert.match(result, /Jane Doe/);
  assert.match(result, /JavaScript/);
});

test('buildResumeContext returns null for empty input', () => {
  assert.equal(buildResumeContext('', '', 'say'), null);
  assert.equal(buildResumeContext(null, '', 'say'), null);
});

test('buildResumeContext still works with legacy (text, limit) signature', () => {
  const resume = 'Jane Doe\nSoftware Engineer\nSkills: JavaScript, Node.js';
  const result = buildResumeContext(resume, 200);
  assert.ok(result !== null);
  assert.match(result, /Jane Doe/);
});

// ── parseResume ───────────────────────────────────────────────────────────────
test('parseResume detects structured sections', () => {
  const resume = 'Jane Doe\n\nSummary\nExperienced engineer.\n\nSkills\nJavaScript, Node.js\n\nExperience\nAcme Corp 2020-2023';
  const parsed = parseResume(resume);
  assert.ok(parsed.parsed, 'should detect structured resume');
  assert.ok(parsed.sections.name, 'should extract name');
  assert.ok(parsed.sections.skills, 'should extract skills');
});

// ── detectCategory ────────────────────────────────────────────────────────────
test('detectCategory: behavioral questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about a time you failed.' }]), 'behavioral');
  assert.equal(detectCategory([{ channel: 'them', text: 'Give me an example of when you led a team.' }]), 'behavioral');
});

test('detectCategory: motivation questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Why do you want to work here?' }]), 'motivation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Why should we hire you?' }]), 'motivation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Why are you looking for a new opportunity?' }]), 'motivation');
});

test('detectCategory: experience questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'Walk me through your role at PayCo.' }]), 'experience');
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about yourself.' }]), 'experience');
  assert.equal(detectCategory([{ channel: 'them', text: 'Tell me about your current role.' }]), 'experience');
});

test('detectCategory: compensation questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'What are your salary expectations?' }]), 'compensation');
  assert.equal(detectCategory([{ channel: 'them', text: 'Do you have any questions for me?' }]), 'compensation');
});

test('detectCategory: technical questions', () => {
  assert.equal(detectCategory([{ channel: 'them', text: 'How would you design a distributed cache?' }]), 'technical');
  assert.equal(detectCategory([{ channel: 'them', text: 'What is the difference between SQL and NoSQL?' }]), 'technical');
});

test('past presentations and communication examples retain personal story context', () => {
  for (const question of ['Describe a time you presented complex analysis to an executive.', 'How have you communicated findings to leadership?', 'Tell me about a presentation you made to a business leader.']) {
    assert.equal(detectCategory([{ channel: 'them', text: question }]), 'behavioral', question);
  }
  assert.equal(detectCategory([{ channel: 'them', text: 'How do you present findings to executives?' }]), 'experience');
});

test('hypothetical pressure cases and implementation follow-ups are distinguished from personal stories', () => {
  const { answerIntent } = require('../src/interview-context');
  const question = 'Suppose turnover is rising and you are under pressure. How would you investigate?';
  assert.equal(answerIntent(question), 'case');
  assert.equal(detectCategory([{ channel: 'them', text: question }]), 'situational');
  assert.equal(answerIntent('How did you handle backdated corrections in practice?'), 'implementation');
  assert.equal(detectCategory([{ channel: 'them', text: 'How did you handle backdated corrections in practice?' }]), 'technical');
});

test('stakeholder reactions and judgment questions use focused answer tasks', () => {
  const { answerIntent } = require('../src/interview-context');
  const cases = [
    ['How did the stakeholder react to that pushback?', 'reaction', 'behavioral'],
    ['Two executives quote different attrition numbers in the same meeting. What do you do right there in the room, and what do you do after?', 'executive-disagreement', 'situational'],
    ['How do you prioritize when multiple leaders say their request is urgent?', 'prioritization', 'situational'],
  ];
  for (const [question, intent, category] of cases) {
    assert.equal(answerIntent(question), intent);
    assert.equal(detectCategory([{ channel: 'them', text: question }]), category);
  }
  assert.equal(answerIntent('Tell me about a time you prioritized competing urgent requests.'), 'story');
  assert.equal(answerIntent('Tell me about a time two executives disagreed in a meeting.'), 'story');
});

test('pushback story context prioritizes stakeholder interaction and the main-answer resolution', () => {
  const context = buildInterviewContext({ resumeText: 'ExampleCo analytics engineer' }, 'say', [{ channel: 'them', text: 'Tell me about a time you had to push back on a stakeholder request.' }]);
  assert.match(context, /how they reacted/);
  assert.match(context, /listened or negotiated an alternative/);
  assert.match(context, /reaction and resolution in the main story/);
});

test('people privacy and decision recovery get focused tasks without taking over past stories or implementation', () => {
  const { answerIntent } = require('../src/interview-context');
  const { useSpokenModel } = require('../src/latency-policy');
  for (const [question, intent] of [
    ['Say that quality issue slipped through and an exec made a call based on those numbers. What is your next move?', 'decision-recovery'],
    ['A leader acted on incorrect data. What would you do?', 'decision-recovery'],
    ['How do you think about privacy and access control when working with sensitive people data?', 'privacy'],
    ['How do you protect sensitive employee data?', 'privacy'],
  ]) {
    assert.equal(answerIntent(question), intent, question);
    const category = detectCategory([{ channel: 'them', text: question }]);
    assert.equal(category, 'situational');
    assert.equal(useSpokenModel('say', category, question), true);
  }
  assert.equal(answerIntent('Tell me about a time an executive acted on incorrect data.'), 'story');
  assert.equal(answerIntent('Tell me about a time you protected sensitive people data.'), 'story');
  for (const question of ['How would you implement row-level access control for sensitive people data in SQL?', 'Design a privacy model for workforce data in detail.', 'Write a SQL query to flag incorrect data before a decision.', 'Explain differential privacy.']) {
    assert.ok(!['privacy', 'decision-recovery'].includes(answerIntent(question)), question);
  }
});

test('quality story keeps source-owner collaboration and material outcome without fabricating severity', () => {
  const story = 'At ExampleCo, I checked the employee roster with People Operations before publishing the corrected workforce dashboard.';
  const context = buildInterviewContext({ resumeText: 'ExampleCo engineer', starStories: story }, 'say', [{ channel: 'them', text: 'Tell me about a time you caught a data quality issue that could have led to a bad business decision.' }]);
  assert.ok(context.includes(story));
  assert.match(context, /what they confirmed or corrected/);
  assert.match(context, /potential bad decision from one that actually occurred/);
  assert.match(context, /Do not.*invent a severity number/);
  assert.match(context, /corrected output, the decision protected/);
});

test('personal model walkthroughs keep the project episode while a focused follow-up stays on that model', () => {
  const { answerIntent } = require('../src/interview-context');
  const question = 'Can you walk me through one of the more complex dbt models you have built? How was the data structured, what business problem did it solve, and how did HR use the output?';
  const story = 'ExampleCo recruiting duration model: one row per requisition, an agreed approval start date, and an accepted-offer end date. HR compared delays by role.';
  const transcript = [{ channel: 'them', text: question }];
  assert.equal(answerIntent(question), 'project-walkthrough');
  assert.equal(detectCategory(transcript), 'experience');
  const context = buildInterviewContext({ resumeText: 'ExampleCo engineer', starStories: story }, 'say', transcript);
  assert.ok(context.includes(story));
  const followup = 'Can you give me one example of a data quality issue you caught in that model and how you handled it?';
  for (const example of ['one example', 'an example', 'a specific example']) {
    assert.equal(answerIntent(followup.replace('one example', example)), 'example-followup');
  }
  assert.equal(detectCategory([...transcript, { channel: 'you', text: story }, { channel: 'them', text: followup }]), 'behavioral');
  assert.equal(answerIntent('Tell me about a time your project failed.'), 'story');
  assert.equal(answerIntent('How would you design a hiring analytics model?'), 'case');
  assert.notEqual(answerIntent('Explain how a dbt model works.'), 'project-walkthrough');
});

test('executive story requests receive the stored episode and an outcome task', () => {
  const story = 'At ExampleCo, a COO needed to approve workforce planning. I compared the HR roster with Finance FTE totals, showed one reconciled chart and recommended separate definitions. The COO approved the corrected roster for planning.';
  const context = buildInterviewContext({ resumeText: 'ExampleCo engineer', starStories: story }, 'say', [{ channel: 'them', text: 'Describe a time you presented an analysis to an executive.' }]);
  assert.ok(context.includes(story));
  assert.match(context, /what the leader did with it/);
  assert.match(context, /before-and-after result/);
});

test('detectCategory: returns general for empty transcript', () => {
  assert.equal(detectCategory([]), 'general');
  assert.equal(detectCategory(null), 'general');
});

test('detectCategory: only checks "them" channel, not "you" channel', () => {
  // "You" channel saying a behavioral phrase should NOT trigger behavioral detection
  const result = detectCategory([{ channel: 'you', text: 'Tell me about a time you failed.' }]);
  assert.equal(result, 'general');
});

// ── buildInterviewContext ─────────────────────────────────────────────────────
const fullSettings = {
  resumeText: 'Jane Doe\nEngineer\n\nSkills\nPython, Go\n\nExperience\nPayCo 2021-2024, built payment pipeline',
  jobDescription: 'Senior Backend Engineer, Python, distributed systems',
  starStories: 'At PayCo, Black Friday outage. I fixed Redis exhaustion in 12 min. Incidents dropped 80%.',
  whyCompany: 'Love the engineering culture here.',
  whyLeaving: 'Ready for a bigger challenge.',
  workStyle: 'Autonomous, data-driven, direct feedback.',
  salaryTarget: '$170k-$200k',
  questionsToAsk: '1. What does success look like in 90 days?'
};

test('job requirements after a long company introduction are selected for the current question', () => {
  const { selectJobDescription } = require('../src/interview-context');
  const jd = 'About Example Motors\n' + 'We value adventure and build exciting products. '.repeat(90) +
    '\nRole Summary\nWe are seeking a Senior Analytics Engineer for the People Systems team.\nResponsibilities\n' +
    'Model workforce history using effective dates and stable employee identifiers.\n' +
    'Partner with HR and Finance on headcount definitions and dashboard reconciliation.\n' +
    'Build tested dbt pipelines and govern data quality.\nQualifications\nAdvanced SQL and Python for warehouse automation.';
  const selected = selectJobDescription(jd, 'How would you reconcile headcount with Finance?', 1800);
  assert.ok(selected.length <= 1800);
  assert.match(selected, /Senior Analytics Engineer/);
  assert.match(selected, /People Systems/);
  assert.match(selected, /headcount definitions and dashboard reconciliation/);
  assert.match(selected, /Advanced SQL and Python/);
  assert.ok(!selected.includes('adventure'), 'company marketing should not displace requirements');
});

test('short and single-paragraph job descriptions retain role and question-relevant requirements', () => {
  const { selectJobDescription } = require('../src/interview-context');
  assert.equal(selectJobDescription('Senior Backend Engineer, Python, distributed systems'), 'Senior Backend Engineer, Python, distributed systems');
  const jd = 'We make excellent products. '.repeat(100) + 'We are seeking a Senior Analytics Engineer. Responsibilities include backdated corrections using effective dates in dbt and data-quality tests.';
  const selected = selectJobDescription(jd, 'How would you handle backdated corrections?', 900);
  assert.ok(selected.length <= 900);
  assert.match(selected, /Senior Analytics Engineer/);
  assert.match(selected, /backdated corrections/);
});

test('missing behavioral story allows a labeled worked scenario without altering saved background', () => {
  const settings = { resumeText: 'ExampleCo: engineer working on workforce pipelines.', jobDescription: 'Senior Analytics Engineer supporting HR reporting.', starStories: '' };
  const before = JSON.stringify(settings);
  const context = buildInterviewContext(settings, 'say', [{ channel: 'them', text: 'Tell me about a time a stakeholder disagreed with your metric.' }]);
  assert.match(context, /Illustrative scenario to adapt/);
  assert.match(context, /implementation checks/);
  assert.match(context, /requirements, not candidate experience/);
  assert.equal(JSON.stringify(settings), before);
});

test('buildInterviewContext: behavioral injects STAR stories', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'Tell me about a time you faced a major outage.' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('STAR'), 'should include STAR stories');
  assert.ok(ctx.includes('PayCo'), 'should include resume');
});

test('buildInterviewContext: motivation injects why company / why leaving', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'Why do you want to work here?' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Why This Company'), 'should include why company');
  assert.ok(ctx.includes('Why Leaving'), 'should include why leaving');
});

test('buildInterviewContext: compensation injects salary and questions', () => {
  const ctx = buildInterviewContext(fullSettings, 'say',
    [{ channel: 'them', text: 'What are your salary expectations?' }]);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('170k'), 'should include salary target');
  assert.ok(ctx.includes('success look like'), 'should include questions to ask');
});

test('buildInterviewContext: leetcode returns null', () => {
  assert.equal(buildInterviewContext(fullSettings, 'leetcode', []), null);
});

test('buildInterviewContext: returns null with no settings data', () => {
  const empty = { resumeText: '', jobDescription: '', starStories: '', whyCompany: '', whyLeaving: '', workStyle: '', salaryTarget: '', questionsToAsk: '' };
  assert.equal(buildInterviewContext(empty, 'say', [{ channel: 'them', text: 'Tell me about yourself.' }]), null);
});

test('buildInterviewContext: JD tailor note included when JD is set', () => {
  const ctx = buildInterviewContext(fullSettings, 'say', []);
  assert.ok(ctx !== null);
  assert.ok(ctx.includes('Tailor'), 'should include tailor note when JD is set');
});
