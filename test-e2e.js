const BASE = 'http://localhost:3912';
const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const BACKUP = path.join(__dirname, 'data', 'db.test-backup.json');
let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅', msg); }
  else { fail++; console.log('  ❌', msg); }
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function resetDb() {
  // 用文件快照还原：测试结束后统一恢复，避免污染演示数据
}

(async () => {
  fs.copyFileSync(DB_FILE, BACKUP);
  try {
    await runTests();
  } finally {
    // 等待服务端最后一次写盘完成后还原演示数据
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.copyFileSync(BACKUP, DB_FILE);
    fs.unlinkSync(BACKUP);
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

async function runTests() {
  // 先读取现状（种子含 1 样点 + 1 待复查）
  let db = (await api('/api/db')).body;
  const seedSite = db.sites.find((s) => s.id === 'site-seed-1');
  const seedSurvey = db.surveys.find((s) => s.id === 'survey-seed-1');
  ok(seedSite && seedSurvey, '种子数据加载（1 样点 + 1 待复查异常）');
  ok(seedSurvey.status === '异常待复查', '种子巡测按基准越限处于待复查');
  ok(seedSurvey.initialBreaches.length === 2, `越限项为湿度与CO2（温度差1.2≤1.5 不算），实际 ${seedSurvey.initialBreaches.length}`);

  console.log('\n[1] 边界阈值：恰好等于阈值不算异常');
  // 基准 16.2/92/680。温差恰 1.5、湿度差恰 6、CO2 增量恰 150 → 正常
  let r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({
    siteId: 'site-seed-1', surveyor: '边界测试', date: '2026-09-01',
    temperature: 17.7, humidity: 86, co2: 830, dripRate: 1
  }) });
  ok(r.status === 201, `边界读数登记成功 HTTP ${r.status}`);
  ok(r.body.status === '正常', `温差1.5/湿度差6/CO2+150 恰好等于阈值 → 正常（实际 ${r.body.status}）`);
  const boundaryId = r.body.id;

  console.log('\n[2] 任一越限即异常，且不能手标正常');
  r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({
    siteId: 'site-seed-1', surveyor: '越限测试', date: '2026-09-02',
    temperature: 16.3, humidity: 85, co2: 680, dripRate: 1
  }) });
  const abnormalId = r.body.id;
  ok(r.body.status === '异常待复查', '湿度差 7 > 6 → 异常待复查');
  ok(r.body.initialBreaches.some((b) => b.metric === 'humidity'), '越限明细记录湿度');
  r = await api(`/api/surveys/${abnormalId}`, { method: 'PATCH', body: JSON.stringify({ status: '正常' }) });
  ok(r.status === 409, `PATCH 手标正常被拒绝 HTTP 409（实际 ${r.status}）`);

  console.log('\n[3] 复查未全部回范围 → 累计次数、继续待查，新复查替代旧有效复查');
  r = await api(`/api/surveys/${abnormalId}/reviews`, { method: 'POST', body: JSON.stringify({
    temperature: 16.3, humidity: 85.5, co2: 680, reviewer: '甲', conclusion: '湿度仍偏低，加强通风观察'
  }) });
  ok(r.status === 201 && r.body.status === '异常待复查', '第1次复查湿度差6.5仍越限 → 保持待查');
  ok(r.body.reviewCount === 1 && r.body.reviews[0].outcome === '仍异常', '累计复查 1 次，结论为仍异常');

  r = await api(`/api/surveys/${abnormalId}/reviews`, { method: 'POST', body: JSON.stringify({
    temperature: 16.3, humidity: 86, co2: 680, reviewer: '乙', conclusion: '湿度回到边界'
  }) });
  ok(r.body.reviewCount === 2, '第2次复查提交，累计为 2');
  ok(r.body.reviews[0].state === '已被替代' && r.body.reviews[1].state === '有效', '同一异常只有一条有效复查（旧的标记已被替代）');
  ok(r.body.status === '已关闭', '三项全部回范围内（湿度差恰6）→ 关闭');
  ok(/第2次复查/.test(r.body.closeReason || ''), '关闭原因写明第2次复查达标');

  console.log('\n[4] 已关闭异常不能再复查');
  r = await api(`/api/surveys/${abnormalId}/reviews`, { method: 'POST', body: JSON.stringify({
    temperature: 16.3, humidity: 86, co2: 680, reviewer: '丙', conclusion: '不应成功'
  }) });
  ok(r.status === 409, `已关闭记录再复查返回 409（实际 ${r.status}）`);

  console.log('\n[5] 调整基准 → 未关闭异常旧判定失效并重核：达标的自动关闭，仍越限的继续待查');
  // 新建样点，基准 20.0/80/500
  r = await api('/api/sites', { method: 'POST', body: JSON.stringify({
    cave: '测试洞', zone: 'Z1', pointCode: 'T-1', route: 'R1', sensitivity: '中',
    protectedStatus: '常规观察', baselineTemp: 20, baselineHumidity: 80, baselineCo2: 500, note: ''
  }) });
  const site2 = r.body.id;
  // 巡测：温度21（差1，正常）湿度70（差10，越限）→ 异常
  r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({
    siteId: site2, surveyor: '重核测试', date: '2026-09-03',
    temperature: 21, humidity: 70, co2: 500, dripRate: 1
  }) });
  const reopenSurvey = r.body.id;
  ok(r.body.status === '异常待复查', '测试洞巡测湿度越限 → 待复查');
  // 先做一次仍异常的复查
  r = await api(`/api/surveys/${reopenSurvey}/reviews`, { method: 'POST', body: JSON.stringify({
    temperature: 21, humidity: 72, co2: 500, reviewer: '丁', conclusion: '仍干燥'
  }) });
  ok(r.body.reviews[0].state === '有效', '基准调整前存在一条有效复查');

  // 该样点再加一条 CO2 越限的异常：调整后仍会越限
  r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({
    siteId: site2, surveyor: '重核测试2', date: '2026-09-04',
    temperature: 20, humidity: 80, co2: 900, dripRate: 1
  }) });
  const stillBadSurvey = r.body.id;

  // 调整基准：湿度 70（使 reopenSurvey 湿度差0达标），CO2 600（900-600=300 仍越限）
  r = await api(`/api/sites/${site2}/baseline`, { method: 'PATCH', body: JSON.stringify({
    baselineTemp: 20, baselineHumidity: 70, baselineCo2: 600, reason: '季节性基准修订'
  }) });
  ok(r.status === 200, `基准调整成功 HTTP ${r.status}`);
  ok(r.body.rechecked.length === 2, `重核 2 条未关闭异常（实际 ${r.body.rechecked.length}）`);

  db = (await api('/api/db')).body;
  const s1 = db.surveys.find((x) => x.id === reopenSurvey);
  const s2 = db.surveys.find((x) => x.id === stillBadSurvey);
  const updatedSite = db.sites.find((x) => x.id === site2);
  ok(updatedSite.baselineHumidity === 70 && updatedSite.baselineCo2 === 600, '样点基准已更新');
  ok(s1.status === '已关闭', '旧异常按新基准重核达标 → 自动关闭');
  ok(/新基准重核/.test(s1.closeReason), '关闭原因写明基准调整重核');
  ok(s1.reviews[0].state === '基准调整失效', '旧的有效复查因基准调整失效');
  ok(s1.baselineSnapshot.baselineHumidity === 70, '异常快照更新为新基准');
  ok(s2.status === '异常待复查', 'CO2 增量 300 > 150 仍越限 → 继续待查');
  ok(s2.initialBreaches.some((b) => b.metric === 'co2' && b.delta === 300), '继续待查项按新基准记录 CO2 差 +300');
  ok(s2.history[0].action === '基准重核' && /季节性基准修订/.test(s2.history[0].note), '重核历史写明原因');

  console.log('\n[6] 基准相同/原因缺失被拒');
  r = await api(`/api/sites/${site2}/baseline`, { method: 'PATCH', body: JSON.stringify({
    baselineTemp: 20, baselineHumidity: 70, baselineCo2: 600, reason: 'x'
  }) });
  ok(r.status === 400, `基准未变化拒绝（实际 ${r.status}）`);
  r = await api(`/api/sites/${site2}/baseline`, { method: 'PATCH', body: JSON.stringify({
    baselineTemp: 21, baselineHumidity: 70, baselineCo2: 600, reason: ''
  }) });
  ok(r.status === 400, `调整原因必填（实际 ${r.status}）`);

  console.log('\n[7] 通用 PATCH 不能改基准（必须走重核接口）');
  r = await api(`/api/sites/${site2}`, { method: 'PATCH', body: JSON.stringify({ baselineTemp: 99 }) });
  ok(r.status === 409, `直接 PATCH 基准被拒（实际 ${r.status}）`);

  console.log('\n[8] 无效样点/缺字段校验');
  r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({
    siteId: 'nope', surveyor: 'x', date: '2026-09-05', temperature: 1, humidity: 1, co2: 1
  }) });
  ok(r.status === 400, `无效样点拒绝（实际 ${r.status}）`);
  r = await api(`/api/surveys/${s2.id}/reviews`, { method: 'POST', body: JSON.stringify({
    temperature: 'abc', humidity: 80, co2: 600, reviewer: 'x', conclusion: 'y'
  }) });
  ok(r.status === 400, `复查读数非数字拒绝（实际 ${r.status}）`);

  console.log('\n[9] 刷新后状态一致：再次拉取 /api/db 与前次相同');
  const db2 = (await api('/api/db')).body;
  const a = JSON.stringify(db2.surveys.find((x) => x.id === s1.id));
  const b = JSON.stringify(db.surveys.find((x) => x.id === s1.id));
  ok(a === b, '两次读取同一异常数据一致（持久化在 db.json）');
}
