const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// 判定阈值：温差>1.5℃、湿度差>6个百分点、CO2增量>150ppm
const THRESHOLDS = config.thresholds || { temp: 1.5, humidity: 6, co2: 150 };
const METRICS = [
  { key: 'temperature', label: '温度', unit: '℃', baseline: 'baselineTemp', limit: THRESHOLDS.temp, kind: 'abs' },
  { key: 'humidity', label: '湿度', unit: '%', baseline: 'baselineHumidity', limit: THRESHOLDS.humidity, kind: 'abs' },
  { key: 'co2', label: 'CO2', unit: 'ppm', baseline: 'baselineCo2', limit: THRESHOLDS.co2, kind: 'incr' }
];

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// 巡测/复查读数相对基准的判定：任一指标越限即异常
function evaluateReadings(readings, baseline) {
  const breaches = [];
  for (const metric of METRICS) {
    const value = toNum(readings[metric.key]);
    const base = toNum(baseline[metric.baseline]);
    if (!Number.isFinite(value) || !Number.isFinite(base)) continue;
    const delta = round1(value - base);
    const over = metric.kind === 'incr' ? value - base > metric.limit : Math.abs(value - base) > metric.limit;
    if (over) {
      breaches.push({ metric: metric.key, label: metric.label, unit: metric.unit, delta, limit: metric.limit, baseline: base, value });
    }
  }
  return {
    isAbnormal: breaches.length > 0,
    breaches,
    verdict: breaches.map((entry) => `${entry.label}偏差${formatDelta(entry)}`).join('、')
  };
}

function formatDelta(entry) {
  return `${entry.delta > 0 ? '+' : ''}${entry.delta}${entry.unit}`;
}

function baselineOf(site) {
  return {
    baselineTemp: site.baselineTemp,
    baselineHumidity: site.baselineHumidity,
    baselineCo2: site.baselineCo2
  };
}

function readingsOf(source) {
  return { temperature: source.temperature, humidity: source.humidity, co2: source.co2 };
}

function baselineText(baseline) {
  return `基准 温度${baseline.baselineTemp}℃/湿度${baseline.baselineHumidity}%/CO2 ${baseline.baselineCo2}ppm`;
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// 样点建档：通用新增保留
app.post('/api/sites', async (req, res) => {
  const db = await readDb();
  const now = new Date().toISOString();
  const item = {
    id: `sites-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || '样点建档')]
  };
  db.sites.push(item);
  await writeDb(db);
  res.status(201).json(item);
});

// 登记巡测：服务端按样点基准自动判定，越限只能“异常待复查”，不能标正常
app.post('/api/surveys', async (req, res) => {
  const db = await readDb();
  const body = req.body || {};
  const site = db.sites.find((entry) => entry.id === body.siteId);
  if (!site) return res.status(400).json({ error: '请选择有效的样点' });
  if (!body.surveyor || !body.date) return res.status(400).json({ error: '巡测人员与日期必填' });
  const readings = {
    temperature: toNum(body.temperature),
    humidity: toNum(body.humidity),
    co2: toNum(body.co2)
  };
  if (Object.values(readings).some((value) => !Number.isFinite(value))) {
    return res.status(400).json({ error: '温度、湿度、CO2读数必须为数字' });
  }
  const baseline = baselineOf(site);
  const result = evaluateReadings(readings, baseline);
  const now = new Date().toISOString();
  const item = {
    id: `surveys-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId: site.id,
    surveyor: body.surveyor,
    date: body.date,
    ...readings,
    dripRate: toNum(body.dripRate) || 0,
    photoUrl: body.photoUrl || '',
    disturbance: body.disturbance || '',
    status: result.isAbnormal ? '异常待复查' : '正常',
    reviewCount: 0,
    reviews: [],
    baselineSnapshot: baseline,
    initialBreaches: result.breaches,
    closeReason: '',
    note: '',
    createdAt: now,
    updatedAt: now,
    history: []
  };
  item.history.unshift(stamp(
    '登记巡测',
    result.isAbnormal
      ? `读数越限（${result.verdict}），生成待复查；${baselineText(baseline)}`
      : `三项读数均在允许范围内；${baselineText(baseline)}`
  ));
  if (result.isAbnormal && site.protectedStatus !== '暂停开放') {
    site.protectedStatus = '重点保护';
    site.updatedAt = now;
    site.history = site.history || [];
    site.history.unshift(stamp('巡检预警', `${site.pointCode || ''}出现异常待复查，转重点保护`.trim()));
  }
  db.surveys.push(item);
  await writeDb(db);
  res.status(201).json(item);
});

// 复查：同一异常只保留一条“有效复查”；三项回范围内才关闭，否则累计次数继续待查
app.post('/api/surveys/:id/reviews', async (req, res) => {
  const db = await readDb();
  const survey = db.surveys.find((entry) => entry.id === req.params.id);
  if (!survey) return res.status(404).json({ error: '巡测记录不存在' });
  if (survey.status !== '异常待复查') {
    return res.status(409).json({ error: '该记录不在待复查状态，无需复查' });
  }
  const body = req.body || {};
  const readings = {
    temperature: toNum(body.temperature),
    humidity: toNum(body.humidity),
    co2: toNum(body.co2)
  };
  if (Object.values(readings).some((value) => !Number.isFinite(value))) {
    return res.status(400).json({ error: '复查的温度、湿度、CO2读数必须为数字' });
  }
  if (!body.reviewer || !body.conclusion) return res.status(400).json({ error: '复查人与复查结论必填' });

  const now = new Date().toISOString();
  // 同一异常只能有一条有效复查：新复查提交时旧的有效复查失效
  for (const review of survey.reviews || []) {
    if (review.state === '有效') review.state = '已被替代';
  }
  survey.reviews = survey.reviews || [];
  const seq = survey.reviews.length + 1;
  const baseline = survey.baselineSnapshot || baselineOf(db.sites.find((entry) => entry.id === survey.siteId) || {});
  const result = evaluateReadings(readings, baseline);
  const review = {
    seq,
    at: now,
    reviewer: body.reviewer,
    ...readings,
    conclusion: body.conclusion,
    state: '有效',
    breaches: result.breaches
  };
  survey.reviews.push(review);
  survey.reviewCount = seq;
  survey.updatedAt = now;
  survey.history = survey.history || [];
  if (!result.isAbnormal) {
    survey.status = '已关闭';
    survey.closeReason = `第${seq}次复查三项读数均回到范围内（${baselineText(baseline)}），闭环关闭`;
    review.outcome = '已恢复';
    survey.history.unshift(stamp(`复查#${seq}·关闭`, `复查人${body.reviewer}：三项回范围内，异常闭环。结论：${body.conclusion}`));
  } else {
    review.outcome = '仍异常';
    survey.history.unshift(stamp(`复查#${seq}·继续待查`, `复查人${body.reviewer}：仍超 ${result.verdict}，累计${seq}次，继续待查。结论：${body.conclusion}`));
  }
  await writeDb(db);
  res.status(201).json(survey);
});

// 调整样点基准：未关闭异常的旧判定失效，按新基准重核并写明原因
app.patch('/api/sites/:id/baseline', async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.params.id);
  if (!site) return res.status(404).json({ error: '样点不存在' });
  const body = req.body || {};
  const next = {
    baselineTemp: toNum(body.baselineTemp),
    baselineHumidity: toNum(body.baselineHumidity),
    baselineCo2: toNum(body.baselineCo2)
  };
  if (Object.values(next).some((value) => !Number.isFinite(value))) {
    return res.status(400).json({ error: '三项新基准必须为数字' });
  }
  if (!body.reason || !String(body.reason).trim()) return res.status(400).json({ error: '调整原因必填' });
  const oldBaseline = baselineOf(site);
  if (next.baselineTemp === oldBaseline.baselineTemp &&
      next.baselineHumidity === oldBaseline.baselineHumidity &&
      next.baselineCo2 === oldBaseline.baselineCo2) {
    return res.status(400).json({ error: '新基准与当前基准一致，无需调整' });
  }
  const now = new Date().toISOString();
  Object.assign(site, next);
  site.updatedAt = now;
  site.history = site.history || [];
  const changesText = `温度 ${oldBaseline.baselineTemp}→${next.baselineTemp}℃，湿度 ${oldBaseline.baselineHumidity}→${next.baselineHumidity}%，CO2 ${oldBaseline.baselineCo2}→${next.baselineCo2}ppm`;
  site.history.unshift(stamp('调整基准', `${changesText}。原因：${String(body.reason).trim()}`));

  // 仅重核未关闭异常；旧判定与既有复查一律失效，按新基准重核
  const reopened = [];
  for (const survey of db.surveys) {
    if (survey.siteId !== site.id || survey.status !== '异常待复查') continue;
    survey.history = survey.history || [];
    for (const review of survey.reviews || []) {
      if (review.state === '有效') review.state = '基准调整失效';
    }
    survey.baselineSnapshot = { ...next };
    const result = evaluateReadings(readingsOf(survey), next);
    if (result.isAbnormal) {
      survey.initialBreaches = result.breaches;
      survey.closeReason = '';
      survey.updatedAt = now;
      survey.history.unshift(stamp('基准重核', `样点基准调整，旧判定失效并按新基准重核：仍超 ${result.verdict}，保持待查。调整原因：${String(body.reason).trim()}`));
    } else {
      survey.status = '已关闭';
      survey.initialBreaches = [];
      survey.closeReason = `基准调整后按新基准重核：原始读数三项均回到范围内（${baselineText(next)}），系统自动关闭`;
      survey.updatedAt = now;
      survey.history.unshift(stamp('基准重核·关闭', `样点基准调整，旧判定失效；按新基准重核原始读数已达标，自动关闭。调整原因：${String(body.reason).trim()}`));
    }
    reopened.push(survey);
  }
  await writeDb(db);
  res.json({ site, rechecked: reopened });
});

// 通用写入收口：闭环状态、复查记录与基准快照只允许通过专用接口变更，防止绕过判定手标正常
const SURVEY_RESERVED = ['status', 'reviews', 'reviewCount', 'baselineSnapshot', 'initialBreaches', 'closeReason'];
const SITE_RESERVED = ['baselineTemp', 'baselineHumidity', 'baselineCo2'];

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const reserved = collection === 'surveys' ? SURVEY_RESERVED : collection === 'sites' ? SITE_RESERVED : [];
  const touched = reserved.filter((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field));
  if (touched.length) {
    return res.status(409).json({ error: `闭环字段不可直接修改：${touched.join('、')}；基准请走“调整基准”，状态由判定/复查自动流转` });
  }
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
