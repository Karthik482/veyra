const test = require('node:test');
const assert = require('node:assert/strict');
const { selectStoryContext, buildInterviewContext, detectCategory } = require('../src/interview-context');

const definitions = [
  ['Mobility', 'CONFIRMED REAL', 'technically challenging project complex implementation identity internal transfers', 'Identity records linked; enterprise departures excluded internal transfers.'],
  ['History', 'ILLUSTRATIVE PRACTICE', 'data quality leadership reporting late backdated corrections historical headcount incremental processing', 'Historical snapshots rebuilt; spreadsheet corrections removed.'],
  ['Disagreement', 'ILLUSTRATIVE PRACTICE', 'disagreed business stakeholder pushback retention ranking', 'Stakeholder removed a department from an escalation list.'],
  ['Executive', 'ILLUSTRATIVE PRACTICE', 'analysis influenced leadership executive decision recruiting time to fill', 'Leader assigned a feedback review rather than extra hiring capacity.'],
  ['Mistake', 'ILLUSTRATIVE PRACTICE', 'mistake learned failure ownership status inclusion rule', 'The leave-status exception stopped recurring.'],
  ['Priorities', 'ILLUSTRATIVE PRACTICE', 'multiple urgent requests priorities deadline competing deliver everything', 'Reporting deadline met and smaller dashboard delivery agreed.'],
];
const cards = definitions.map(([name, status, questions, outcome], index) =>
  `=== INTERVIEW STORY: ExampleCo ${name} [${status}] ===\nQuestions: ${questions}\n` +
  `Episode: ${index === 0 ? 'Source detail. '.repeat(130) : 'Specific action in this episode. '.repeat(12)}\nOutcome: ${outcome}`);
const bank = cards.join('\n\n');

test('compensation analytics experience receives project notes rather than salary negotiation fields', () => {
  const card = '=== INTERVIEW STORY: Compensation approach [HYPOTHETICAL] ===\nQuestions: compensation analytics\nMethod: join historical pay and job bands at the same effective date.\nBoundary: proposed approach, not confirmed work.';
  const settings = { starStories: card, salaryTarget: 'PRIVATE_PAY_TARGET', questionsToAsk: 'PRIVATE_CLOSING_QUESTIONS' };
  const transcript = [{ channel: 'them', text: 'Have you worked on compensation analytics?' }];
  assert.equal(detectCategory(transcript), 'experience');
  const context = buildInterviewContext(settings, 'say', transcript);
  assert.ok(context.includes(card));
  assert.ok(!context.includes(settings.salaryTarget));
  assert.ok(!context.includes(settings.questionsToAsk));
  assert.equal(detectCategory([{ channel: 'them', text: 'Explain compensation modeling and salary bands.' }]), 'technical');
  const pay = [{ channel: 'them', text: 'What are your salary expectations for this compensation analytics role?' }];
  assert.equal(detectCategory(pay), 'compensation');
  const payContext = buildInterviewContext(settings, 'say', pay);
  assert.ok(payContext.includes(settings.salaryTarget));
  assert.ok(!payContext.includes(card));
});

test('requirements-discovery questions retain the relevant interview example', () => {
  const card = '=== INTERVIEW STORY: Requirements discovery [ILLUSTRATIVE PRACTICE] ===\nQuestions: ambiguous requirements\nAction: agree the business decision and validate sample source records.';
  const transcript = [{ channel: 'them', text: 'How do you handle ambiguous requirements?' }];
  assert.equal(detectCategory(transcript), 'experience');
  assert.ok(buildInterviewContext({ starStories: card }, 'say', transcript).includes(card));
  assert.equal(detectCategory([{ channel: 'them', text: 'How does an index work?' }]), 'technical');
});

test('story selection finds each episode even beyond the old beginning-of-notes limit', () => {
  const questions = [
    'Tell me about the most technically challenging project you worked on.',
    'Tell me about a data quality issue involving late corrections.',
    'Tell me about a time you disagreed with a business stakeholder.',
    'Tell me about a time your analysis influenced a leadership decision.',
    'Tell me about a mistake you made and what you learned.',
    'Tell me about a time you had multiple urgent requests and could not deliver everything.',
  ];
  questions.forEach((question, index) => {
    const selected = selectStoryContext(bank, question);
    assert.ok(selected.startsWith(cards[index].split('\n')[0]), question);
    assert.ok(selected.includes(definitions[index][3]), 'selected outcome must survive');
    assert.equal((selected.match(/=== INTERVIEW STORY:/g) || []).length, 1);
    assert.ok(selected.length <= 2000);
  });
});

test('a reaction or result follow-up retains the previous episode and its practice status', () => {
  const question = 'What happened after that?';
  const transcript = [
    { channel: 'them', text: 'Tell me about a mistake you made and what you learned.' },
    { channel: 'you', text: 'I assumed a status inclusion rule. I fixed the mistake after a review and changed the acceptance checks.' },
    { channel: 'them', text: question },
  ];
  const selected = selectStoryContext(bank, question, 600, transcript);
  assert.ok(selected.includes('ExampleCo Mistake [ILLUSTRATIVE PRACTICE]'));
  assert.ok(selected.includes('leave-status exception stopped recurring'));
  const decision = 'What did the leader actually decide to do?';
  const executive = selectStoryContext(bank, decision, 2000, [
    { channel: 'them', text: 'Tell me about a time your analysis influenced a leadership decision.' },
    { channel: 'you', text: 'I compared delivery-stage timestamps. The leader assigned a feedback review rather than extra hiring capacity.' },
    { channel: 'them', text: decision },
  ]);
  assert.ok(executive.includes('ExampleCo Executive [ILLUSTRATIVE PRACTICE]'));
});

test('an explicit new story request takes precedence over a previous long episode', () => {
  const question = 'Tell me about a time your analysis influenced a leadership decision.';
  const selected = selectStoryContext(bank, question, 2000, [
    { channel: 'them', text: 'Tell me about competing priorities.' },
    { channel: 'you', text: 'Multiple urgent requests and deadlines. '.repeat(70) },
    { channel: 'them', text: question },
  ]);
  assert.ok(selected.includes('ExampleCo Executive [ILLUSTRATIVE PRACTICE]'));
  assert.ok(!selected.includes('ExampleCo Priorities'));
});

test('short questions about the model or method keep the project being discussed', () => {
  const planning = '=== INTERVIEW STORY: ExampleCo workforce planning [CONFIRMED REAL] ===\nQuestions: workforce planning capacity forecast allocation labor cost\nEpisode: Estimated required role-hours against available capacity.\nOutcome: Compared staffing-plan costs.';
  const expandedBank = bank + '\n\n' + planning;
  for (const question of ['What kind of model did you use?', 'Which method did you choose?', 'So what type of approach did you use here?']) {
    const selected = selectStoryContext(expandedBank, question, 2000, [
      { channel: 'them', text: 'Tell me more about the workforce planning project and how you estimated staffing costs.' },
      { channel: 'you', text: 'I compared required role-hours with remaining capacity using allocation and labor cost data.' },
      { channel: 'them', text: question },
    ]);
    assert.ok(selected.includes('ExampleCo workforce planning [CONFIRMED REAL]'), question);
  }
});

test('a business outcome follow-up retains the project despite a competing stakeholder keyword', () => {
  const planning = '=== INTERVIEW STORY: ExampleCo workforce planning [CONFIRMED REAL] ===\nQuestions: end-to-end project sources capacity dbt\nEpisode: Connected assignments and labor rates.\nOutcome: Compared staffing against capacity before budgeting discussions.';
  const competing = '=== INTERVIEW STORY: Salary reconciliation [HYPOTHETICAL] ===\nQuestions: Finance actually costs differently\nMethod: Reconcile project costs to a salary pool.';
  const question = 'What did Finance actually do differently after your project?';
  const transcript = [
    { channel: 'them', text: 'Walk me through an end-to-end project, including sources and what you built.' },
    { channel: 'you', text: 'I built workforce planning dbt models connecting assignments and labor rates to capacity.' },
    { channel: 'them', text: question },
  ];
  const stories = bank + '\n\n' + planning + '\n\n' + competing;
  assert.equal(selectStoryContext(stories, question, 2000, transcript), planning);
  assert.equal(selectStoryContext(stories, 'Tell me about a mistake you made and what you learned after your project.', 2000, transcript).split('\n')[0], cards[4].split('\n')[0]);
});

test('structured cards keep their outcome for small context budgets while legacy notes stay compatible', () => {
  const selected = selectStoryContext(bank, 'What did you learn from a mistake?', 100);
  assert.ok(selected.includes('Outcome: The leave-status exception stopped recurring.'));
  assert.ok(selected.includes('[ILLUSTRATIVE PRACTICE]'));
  assert.equal(selectStoryContext('Unstructured old notes', '', 2000), 'Unstructured old notes');
  assert.ok(selectStoryContext('x'.repeat(1000), '', 100).length <= 101);
  assert.equal(selectStoryContext('', 'mistake'), '');
});

test('interview context includes the selected card rather than truncating the bank to its first episode', () => {
  const context = buildInterviewContext({ resumeText: 'ExampleCo engineer', starStories: bank }, 'say', [
    { channel: 'them', text: 'Tell me about a mistake you made and what you learned.' },
  ]);
  assert.ok(context.includes('ExampleCo Mistake [ILLUSTRATIVE PRACTICE]'));
  assert.ok(context.includes('leave-status exception stopped recurring'));
  assert.ok(!context.includes('ExampleCo Mobility [CONFIRMED REAL]'));
});

test('technical SQL follow-ups receive the selected case while unrelated definitions omit story notes', () => {
  const allocation = '=== INTERVIEW STORY: Allocation cost reconciliation [HYPOTHETICAL] ===\nQuestions: employee allocation utilization labor cost salary overallocation SQL\nMethod: check overlapping working days and reconcile allocated plus unallocated cost to one salary pool.\nBoundary: hypothetical case, not past work.';
  const settings = { resumeText: 'ExampleCo analytics engineer', starStories: bank + '\n\n' + allocation };
  const context = buildInterviewContext(settings, 'say', [
    { channel: 'them', text: 'An employee has overlapping client allocations totaling 110%. How would you prevent labor-cost double counting?' },
    { channel: 'you', text: 'I would keep the overallocation exception and reconcile salary distribution to the cost pool.' },
    { channel: 'them', text: 'How would you implement this in SQL? Explain in words.' },
  ]);
  assert.ok(context.includes(allocation));
  const generic = buildInterviewContext(settings, 'say', [{ channel: 'them', text: 'Explain what a primary key is.' }]);
  assert.ok(!generic || !generic.includes(allocation));
});
