const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const TH = config.thresholds;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  migrate(db);
  return db;
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

function newId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function fmtNum(value) {
  return String(round2(value));
}

function signed(value) {
  const v = round2(value);
  return v > 0 ? `+${fmtNum(v)}` : fmtNum(v);
}

function baselineOf(site) {
  return {
    temp: Number(site.baselineTemp),
    humidity: Number(site.baselineHumidity),
    co2: Number(site.baselineCo2)
  };
}

function readingsOf(source) {
  return {
    temp: Number(source.temperature),
    humidity: Number(source.humidity),
    co2: Number(source.co2)
  };
}

// 核心判定：温差>1.5℃、湿度差>6个百分点（双向），CO2增量>150ppm（仅上升方向）
function evaluate(readings, baseline) {
  const defs = [
    {
      key: 'temperature', label: '温度', reading: readings.temp, base: baseline.temp,
      unit: '℃', deltaUnit: '℃', diffLabel: '温差', limit: TH.temp,
      isOver: (delta) => Math.abs(delta) > TH.temp
    },
    {
      key: 'humidity', label: '湿度', reading: readings.humidity, base: baseline.humidity,
      unit: '%', deltaUnit: '个百分点', diffLabel: '湿度差', limit: TH.humidity,
      isOver: (delta) => Math.abs(delta) > TH.humidity
    },
    {
      key: 'co2', label: 'CO2', reading: readings.co2, base: baseline.co2,
      unit: 'ppm', deltaUnit: 'ppm', diffLabel: 'CO2增量', limit: TH.co2,
      isOver: (delta) => delta > TH.co2
    }
  ];
  const items = defs.map((def) => {
    const delta = round2(def.reading - def.base);
    return {
      key: def.key,
      label: def.label,
      reading: round2(def.reading),
      baseline: round2(def.base),
      delta,
      unit: def.unit,
      deltaUnit: def.deltaUnit,
      diffLabel: def.diffLabel,
      limit: def.limit,
      exceeded: def.isOver(def.reading - def.base)
    };
  });
  const exceeded = items.filter((item) => item.exceeded);
  return { items, exceeded, exceededKeys: exceeded.map((item) => item.key), abnormal: exceeded.length > 0 };
}

// 例如：CO2 920ppm，基准680ppm，CO2增量+240ppm（限值150ppm），超阈
function describeItem(item) {
  return `${item.label} ${fmtNum(item.reading)}${item.unit}，基准${fmtNum(item.baseline)}${item.unit}，` +
    `${item.diffLabel}${signed(item.delta)}${item.deltaUnit}（限值${item.limit}${item.deltaUnit}），` +
    (item.exceeded ? '超阈' : '在范围内');
}

function latestReadingSource(survey, reviews) {
  const done = reviews
    .filter((review) => review.surveyId === survey.id)
    .sort((a, b) => b.reviewNo - a.reviewNo)[0];
  if (done) {
    return {
      readings: readingsOf(done),
      label: `第${done.reviewNo}次复查（${done.date}）`
    };
  }
  return {
    readings: readingsOf(survey),
    label: `初次巡测（${survey.date}）`
  };
}

// 兼容旧数据：补齐判定快照与复查次数，保证刷新后状态不依赖前端
function migrate(db) {
  db.sites = Array.isArray(db.sites) ? db.sites : [];
  db.surveys = Array.isArray(db.surveys) ? db.surveys : [];
  db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
  for (const survey of db.surveys) {
    const site = db.sites.find((entry) => entry.id === survey.siteId);
    if (!survey.judgement && site) {
      const ev = evaluate(readingsOf(survey), baselineOf(site));
      survey.judgement = {
        at: survey.createdAt || new Date().toISOString(),
        reason: '巡测登记',
        source: 'initial',
        baseline: baselineOf(site),
        items: ev.items
      };
    }
    if (typeof survey.reviewCount !== 'number') {
      survey.reviewCount = db.reviews.filter((review) => review.surveyId === survey.id).length;
    }
    if (!survey.status) {
      survey.status = survey.judgement?.abnormal ? '异常待复查' : '正常';
    }
  }
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

// 样点建档
app.post('/api/sites', async (req, res) => {
  const db = await readDb();
  const body = req.body || {};
  const cave = String(body.cave || '').trim();
  const zone = String(body.zone || '').trim();
  const pointCode = String(body.pointCode || '').trim();
  const route = String(body.route || '').trim();
  const baseline = {
    baselineTemp: Number(body.baselineTemp),
    baselineHumidity: Number(body.baselineHumidity),
    baselineCo2: Number(body.baselineCo2)
  };
  if (!cave || !zone || !pointCode || !route) {
    return res.status(400).json({ error: '洞穴、分区、样点编号、巡测路线均为必填' });
  }
  if (Object.values(baseline).some(Number.isNaN)) {
    return res.status(400).json({ error: '基准温度、基准湿度、基准CO2必须是有效数字' });
  }
  const now = new Date().toISOString();
  const item = {
    id: newId('site'),
    cave,
    zone,
    pointCode,
    route,
    sensitivity: body.sensitivity || '中',
    protectedStatus: body.protectedStatus || '常规观察',
    ...baseline,
    note: String(body.note || '').trim(),
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', '样点建档')]
  };
  db.sites.push(item);
  await writeDb(db);
  res.status(201).json(item);
});

// 巡测登记：读数自动对照基准判定，客户端不能指定状态
app.post('/api/surveys', async (req, res) => {
  const db = await readDb();
  const body = req.body || {};
  const site = db.sites.find((entry) => entry.id === body.siteId);
  if (!site) return res.status(400).json({ error: '请选择已建档的样点' });
  const surveyor = String(body.surveyor || '').trim();
  const date = String(body.date || '').trim();
  if (!surveyor || !date) return res.status(400).json({ error: '巡测人员和巡测日期不能为空' });
  const readings = {
    temp: Number(body.temperature),
    humidity: Number(body.humidity),
    co2: Number(body.co2)
  };
  if ([readings.temp, readings.humidity, readings.co2].some(Number.isNaN)) {
    return res.status(400).json({ error: '温度、湿度、CO2 必须是有效数字' });
  }
  const now = new Date().toISOString();
  const baseline = baselineOf(site);
  const ev = evaluate(readings, baseline);
  const note = `对照样点基准判定：${ev.items.map(describeItem).join('；')}。` +
    (ev.abnormal
      ? '读数超阈，生成“异常待复查”，复查前不得标记正常。'
      : '三项均在允许范围内，判为正常。');
  const survey = {
    id: newId('survey'),
    siteId: site.id,
    surveyor,
    date,
    temperature: round2(readings.temp),
    humidity: round2(readings.humidity),
    co2: round2(readings.co2),
    dripRate: Number(body.dripRate) || 0,
    disturbance: String(body.disturbance || '').trim(),
    photoUrl: String(body.photoUrl || '').trim(),
    status: ev.abnormal ? '异常待复查' : '正常',
    reviewCount: 0,
    judgement: {
      at: now,
      reason: '巡测登记',
      source: 'initial',
      baseline,
      items: ev.items
    },
    createdAt: now,
    updatedAt: now,
    history: [stamp('巡测登记', note)]
  };
  db.surveys.push(survey);
  if (ev.abnormal && site.protectedStatus === '常规观察') {
    site.protectedStatus = '重点保护';
    site.updatedAt = now;
    site.history = site.history || [];
    site.history.unshift(stamp(
      '生成异常待复查',
      `${date} ${surveyor} 的巡测超阈：${ev.exceeded.map(describeItem).join('；')}，样点自动列为重点保护（异常编号 ${survey.id}）`
    ));
  }
  await writeDb(db);
  res.status(201).json(survey);
});

// 提交复查：仅“异常待复查”可提交；三项全部回范围才关闭，否则累计次数继续待查
app.post('/api/reviews', async (req, res) => {
  const db = await readDb();
  const body = req.body || {};
  const survey = db.surveys.find((entry) => entry.id === body.surveyId);
  if (!survey) return res.status(404).json({ error: '异常记录不存在' });
  if (survey.status === '已关闭') {
    return res.status(409).json({ error: '该异常已关闭，复查闭环已完成，不能再提交复查（同一异常只能有一条生效的复查结论）' });
  }
  if (survey.status !== '异常待复查') {
    return res.status(409).json({ error: '该巡测判定为正常，没有待复查异常' });
  }
  const site = db.sites.find((entry) => entry.id === survey.siteId);
  if (!site) return res.status(409).json({ error: '关联样点已不存在，无法复查' });
  const date = String(body.date || '').trim();
  const reviewer = String(body.reviewer || '').trim();
  if (!date || !reviewer) return res.status(400).json({ error: '复查日期和复查人员不能为空' });
  const readings = {
    temp: Number(body.temperature),
    humidity: Number(body.humidity),
    co2: Number(body.co2)
  };
  if (Object.values(readings).some(Number.isNaN)) {
    return res.status(400).json({ error: '复查必须记录新的温度、湿度、CO2 读数' });
  }
  const conclusion = String(body.conclusion || '').trim();
  const now = new Date().toISOString();
  const baseline = baselineOf(site);
  const ev = evaluate(readings, baseline);
  const reviewNo = (survey.reviewCount || 0) + 1;
  const passed = !ev.abnormal;
  const autoNote = passed
    ? `第${reviewNo}次复查：${ev.items.map(describeItem).join('；')}，三项均回到允许范围内，异常关闭。`
    : `第${reviewNo}次复查仍有 ${ev.exceeded.length} 项超阈：${ev.exceeded.map(describeItem).join('；')}，累计复查 ${reviewNo} 次，继续待查。`;
  const fullNote = autoNote + (conclusion ? ` 现场结论：${conclusion}` : '');
  const review = {
    id: newId('review'),
    surveyId: survey.id,
    siteId: survey.siteId,
    reviewNo,
    date,
    reviewer,
    temperature: round2(readings.temp),
    humidity: round2(readings.humidity),
    co2: round2(readings.co2),
    conclusion,
    result: passed ? '关闭异常' : '继续待查',
    exceededKeys: ev.exceededKeys,
    baseline,
    items: ev.items,
    createdAt: now,
    history: [stamp(passed ? '复查关闭' : '复查未恢复', fullNote)]
  };
  db.reviews.push(review);

  survey.reviewCount = reviewNo;
  survey.judgement = {
    at: now,
    reason: `第${reviewNo}次复查`,
    source: `review-${reviewNo}`,
    baseline,
    items: ev.items
  };
  survey.updatedAt = now;
  survey.history.unshift(stamp(passed ? '复查关闭' : '复查未恢复', fullNote));
  if (passed) {
    survey.status = '已关闭';
    survey.closedAt = now;
    survey.closeReason = autoNote;
  }
  await writeDb(db);
  res.status(201).json(review);
});

// 调整样点基准：未关闭异常的旧判定立即失效，按新基准重核并写明原因
app.patch('/api/sites/:id', async (req, res) => {
  const db = await readDb();
  const site = db.sites.find((entry) => entry.id === req.params.id);
  if (!site) return res.status(404).json({ error: '样点不存在' });
  const body = req.body || {};
  const reason = String(body.reason || '').trim();
  const oldBaseline = baselineOf(site);
  const nextBaseline = {
    temp: body.baselineTemp === undefined ? oldBaseline.temp : Number(body.baselineTemp),
    humidity: body.baselineHumidity === undefined ? oldBaseline.humidity : Number(body.baselineHumidity),
    co2: body.baselineCo2 === undefined ? oldBaseline.co2 : Number(body.baselineCo2)
  };
  if (Object.values(nextBaseline).some(Number.isNaN)) {
    return res.status(400).json({ error: '基准值必须是有效数字' });
  }
  const defs = [
    ['temp', '基准温度', '℃'],
    ['humidity', '基准湿度', '%'],
    ['co2', '基准CO2', 'ppm']
  ];
  const changes = defs
    .filter(([key]) => round2(nextBaseline[key]) !== round2(oldBaseline[key]))
    .map(([key, label, unit]) => `${label} ${fmtNum(oldBaseline[key])}${unit}→${fmtNum(nextBaseline[key])}${unit}`);

  const now = new Date().toISOString();
  site.baselineTemp = nextBaseline.temp;
  site.baselineHumidity = nextBaseline.humidity;
  site.baselineCo2 = nextBaseline.co2;
  site.updatedAt = now;
  site.history = site.history || [];

  if (!changes.length) return res.json(site);

  site.history.unshift(stamp(
    '基准调整',
    `${changes.join('、')}。自调整之时起，该样点未关闭异常的旧判定失效，一律按新基准重核。` +
      (reason ? ` 调整原因：${reason}` : '')
  ));

  const openSurveys = db.surveys.filter((entry) => entry.siteId === site.id && entry.status === '异常待复查');
  for (const survey of openSurveys) {
    const source = latestReadingSource(survey, db.reviews);
    const ev = evaluate(source.readings, nextBaseline);
    const readingText = `温度${fmtNum(source.readings.temp)}℃、湿度${fmtNum(source.readings.humidity)}%、CO2 ${fmtNum(source.readings.co2)}ppm`;
    survey.judgement = {
      at: now,
      reason: '基准调整重核',
      source: 'baseline-reset',
      baseline: { ...nextBaseline },
      items: ev.items
    };
    survey.updatedAt = now;
    const prefix = `样点基准调整（${changes.join('、')}），旧判定失效；以${source.label}读数（${readingText}）按新基准重核：`;
    if (ev.abnormal) {
      survey.history.unshift(stamp(
        '基准重核',
        `${prefix}${ev.exceeded.map(describeItem).join('；')}，仍超阈，异常继续待查（已累计复查 ${survey.reviewCount || 0} 次）。`
      ));
    } else {
      const closeNote = `${prefix}三项均在允许范围内（温差≤${TH.temp}℃、湿度差≤${TH.humidity}个百分点、CO2增量≤${TH.co2}ppm），异常关闭。`;
      survey.status = '已关闭';
      survey.closedAt = now;
      survey.closeReason = closeNote;
      survey.history.unshift(stamp('基准重核关闭', closeNote));
    }
  }
  await writeDb(db);
  res.json(site);
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
