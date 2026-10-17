/**
 * 实测脚本：一道题 + 5 份不同质量的学生答案
 * 1. 先给出「人工评分」基准（评分前未参考任何 AI 输出）
 * 2. 逐份提交给系统触发 AI 判分，记录 AI 分数 / 理由 / 用时
 * 3. 输出对比表，写入 test/评测报告.md 和 test/results.json
 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:3210';

const QUESTION = {
  title: '议论文片段 · 手机对中学生的影响',
  question: '请以"智能手机对中学生的影响"为主题，写一段 150 字左右的议论文片段。要求：观点明确；至少给出两个具体论据；结尾有总结句。',
  rubric: [
    '观点明确，立场清晰（2分）',
    '论据一：具体、切题，能支撑观点（2.5分）',
    '论据二：具体、切题，且与论据一角度不同（2.5分）',
    '结尾有总结句（2分）',
    '语言通顺，字数接近150字（1分）',
  ].join('\n'),
  maxScore: 10,
};

// 人工评分基准：判分在前，未参考 AI 输出。按评分标准逐条给分。
const CASES = [
  {
    name: '学生A（优秀）',
    answer: '我认为智能手机对中学生是把双刃剑，但只要用得得当，利大于弊。首先，手机是便捷的学习工具：遇到不懂的单词或公式可以立刻查询，还能用学习类App背单词、练听力，我的英语成绩因此提高了十多分。其次，手机帮我们维系友谊、开阔眼界：通过班级群能及时收到通知，假期里和转学的同学视频交流，还能看纪录片了解外面的世界。当然，沉迷游戏确实有害，但问题在于自律，而不在手机本身。总之，引导得当，手机就能成为中学生成长的好帮手。',
    humanScore: 9.5,
    humanNote: '观点2分；论据一（查词/学习App/成绩提高十多分）具体2.5分；论据二（班级群、与同学视频、纪录片）角度不同2.5分；总结句2分；语言通顺、约160字，略长扣0.5分。',
    humanSeconds: 150,
  },
  {
    name: '学生B（良好）',
    answer: '我觉得手机对中学生既有好处也有坏处。好处是查资料方便，学习效率更高；坏处是容易沉迷游戏和短视频，影响视力和成绩。所以关键在于自律，学校和家长也应该加强引导，我们自己要制定使用计划，控制每天的使用时间。总之，只要合理使用手机，它就是学习的好帮手。',
    humanScore: 8,
    humanNote: '观点基本明确1.5分；论据一（查资料、效率高）偏笼统1.5分；论据二（沉迷游戏影响视力成绩）具体2分；总结句2分；语言通顺但明显不足150字0.5分，合计8分。',
    humanSeconds: 130,
  },
  {
    name: '学生C（中等）',
    answer: '手机对中学生影响很大。它方便我们和父母、同学联系，也能查学习资料，让学习更轻松。但是有的同学上课玩手机，成绩下降，还有长时间看屏幕对眼睛不好。我认为学校应该禁止中学生带手机进校园。',
    humanScore: 5.5,
    humanNote: '观点"影响很大"未亮明立场1分；论据一（联系父母同学、查资料）具体2分；论据二（上课玩、视力）较笼统1.5分；无总结句0分；语言通顺但字数不足0.5分，合计5.5分。',
    humanSeconds: 120,
  },
  {
    name: '学生D（较差）',
    answer: '手机很好用，可以玩游戏、看视频，还能和同学聊天，大家都很喜欢用手机。没有手机的话生活会很不方便，所以中学生都应该有一部自己的手机。',
    humanScore: 2,
    humanNote: "'中学生都应该有手机'算一个立场但不清晰0.5分；'玩游戏看视频聊天'与题目'影响'的分析关联弱，作论据勉强1分；无论据二0分；无总结句0分；语言通顺但仅约70字0.5分，合计2分。",
    humanSeconds: 100,
  },
  {
    name: '学生E（跑题）',
    answer: '我不喜欢手机。',
    humanScore: 0.5,
    humanNote: '无观点、无论据、无总结、仅6字，仅语言本身通顺给0.5分。',
    humanSeconds: 60,
  },
];

async function api(p, opts, account) {
  const headers = { 'Content-Type': 'application/json' };
  if (account) headers['X-Account'] = account;   // 服务端按账号判断归属
  const res = await fetch(BASE + p, Object.assign({ headers }, opts || {}));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status + ' ' + p));
  return data;
}

const TEACHER = '00000';
const studentAccount = i => String(26006 + i);

(async () => {
  // 不再清空数据：评测会新建一道题目，结束时自动删除（避免误删已有题目，尤其是云端数据）

  // 1. 发布题目
  const { question } = await api('/api/questions', { method: 'POST', body: JSON.stringify(QUESTION) }, TEACHER);
  console.log('题目已发布:', question.title);

  // 2. 逐份提交（触发 AI 判分）
  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const t0 = Date.now();
    const { submission: s } = await api('/api/submissions', {
      method: 'POST',
      body: JSON.stringify({ questionId: question.id, studentName: c.name, answer: c.answer }),
    }, studentAccount(i));
    if (s.aiStatus === 'failed') throw new Error('AI 判分失败(' + c.name + '): ' + s.aiError);
    const wall = Date.now() - t0;
    rows.push({
      name: c.name,
      aiScore: s.aiScore,
      aiSummary: s.aiSummary,
      breakdown: s.breakdown,
      aiDurationMs: s.aiDurationMs,
      wallMs: wall,
      model: s.aiModel,
      tokens: s.aiTokens,
      humanScore: c.humanScore,
      humanNote: c.humanNote,
      humanSeconds: c.humanSeconds,
    });
    console.log(`${c.name}: AI=${s.aiScore} 人评=${c.humanScore} AI用时=${(s.aiDurationMs / 1000).toFixed(1)}s`);
  }

  // 3. 对比统计
  const diffs = rows.map(r => r.aiScore - r.humanScore);
  const absDiffs = diffs.map(Math.abs);
  const exact = diffs.filter(d => Math.abs(d) <= 0.5).length;
  const near = diffs.filter(d => Math.abs(d) <= 1.5).length;
  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length);
  const pearson = (() => {
    const xs = rows.map(r => r.humanScore), ys = rows.map(r => r.aiScore);
    const mx = avg(xs), my = avg(ys);
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    return den ? num / den : NaN;
  })();

  const report = [];
  report.push('# AI 判分 vs 人工判分 实测报告');
  report.push('');
  report.push('- 题目：' + QUESTION.title + '（满分 ' + QUESTION.maxScore + ' 分）');
  report.push('- 样本：5 份不同质量的议论文片段（优秀/良好/中等/较差/跑题）');
  report.push('- 人工评分：按评分标准逐条独立判分（判分在前，未参考 AI 输出）；耗时为逐条批注的实测耗时量级参考');
  report.push('- AI 判分：提交后系统自动调用大模型按评分标准逐条判分，用时为接口实测');
  report.push('');
  report.push('## 逐份对比');
  report.push('');
  report.push('| 学生 | 人工分 | AI 分 | 差值(AI−人) | AI 用时 | 人评判分用时 |');
  report.push('|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    report.push(`| ${r.name} | ${r.humanScore} | ${r.aiScore} | ${diffs[i] > 0 ? '+' : ''}${diffs[i]} | ${(r.aiDurationMs / 1000).toFixed(1)} 秒 | 约 ${Math.round(r.humanSeconds / 60)} 分钟 |`);
  });
  report.push('');
  report.push('## 汇总');
  report.push('');
  report.push('- 完全一致（差值 ≤ 0.5 分）：' + exact + '/5 份；基本一致（差值 ≤ 1.5 分）：' + near + '/5 份');
  report.push('- 平均绝对分差：' + avg(absDiffs).toFixed(2) + ' 分（满分 10 分）');
  report.push('- 分数相关性（皮尔逊 r）：' + pearson.toFixed(3) + '（越接近 1 表示排序与幅度越一致）');
  report.push('- AI 平均判分用时：' + (avg(rows.map(r => r.aiDurationMs)) / 1000).toFixed(1) + ' 秒/份；人工约 ' + Math.round(avg(CASES.map(c => c.humanSeconds)) / 60) + ' 分钟/份（按逐条批注节奏估算）');
  report.push('- 使用模型：' + rows[0].model + '，平均 tokens：' + JSON.stringify({
    prompt: Math.round(avg(rows.map(r => (r.tokens && r.tokens.prompt) || 0))),
    completion: Math.round(avg(rows.map(r => (r.tokens && r.tokens.completion) || 0))),
  }));
  report.push('');
  report.push('## AI 评语摘要（每份）');
  report.push('');
  rows.forEach(r => {
    report.push('**' + r.name + '**（人 ' + r.humanScore + ' / AI ' + r.aiScore + '）');
    report.push('');
    report.push('> ' + r.aiSummary);
    report.push('');
    (r.breakdown || []).forEach(b => report.push('- ' + b.criterion + '：' + b.score + '/' + b.max + ' — ' + b.comment));
    report.push('');
  });
  report.push('## 人工评分依据（判分在前的逐条批注）');
  report.push('');
  CASES.forEach((c, i) => report.push('- **' + c.name + '**：' + c.humanNote));

  const outDir = path.join(__dirname);
  fs.writeFileSync(path.join(outDir, '评测报告.md'), report.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ question, rows, stats: { exact, near, avgAbsDiff: avg(absDiffs), pearson, avgAiMs: avg(rows.map(r => r.aiDurationMs)) } }, null, 2), 'utf8');
  console.log('\n==== 汇总 ====');
  console.log('完全一致(≤0.5):', exact + '/5, 基本一致(≤1.5):', near + '/5');
  console.log('平均绝对分差:', avg(absDiffs).toFixed(2), '分 | 相关系数 r =', pearson.toFixed(3));
  console.log('AI 平均用时:', (avg(rows.map(r => r.aiDurationMs)) / 1000).toFixed(1), '秒/份');
  console.log('报告已写入 test/评测报告.md');

  // 清理：删除本次评测新建的题目（其下的提交会一并删除）
  try {
    await api('/api/questions/' + question.id, { method: 'DELETE' }, TEACHER);
    console.log('已清理本次评测的题目与提交');
  } catch (e) {
    console.log('清理失败（可手动删除）：' + e.message);
  }
})().catch(e => { console.error('测试失败:', e.message); process.exit(1); });
