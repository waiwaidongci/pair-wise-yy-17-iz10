const state = {
  config: null,
  db: {},
  activeTab: '',
  modalResolve: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function fmtNum(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return '-';
  return String(Math.round((n + Number.EPSILON) * 100) / 100);
}

function signed(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return '-';
  return n > 0 ? `+${fmtNum(n)}` : fmtNum(n);
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function siteOf(siteId) {
  return (state.db.sites || []).find((entry) => entry.id === siteId);
}

function siteLabel(site) {
  return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联样点';
}

function reviewsOfSurvey(surveyId) {
  return (state.db.reviews || [])
    .filter((review) => review.surveyId === surveyId)
    .sort((a, b) => a.reviewNo - b.reviewNo);
}

function latestReview(survey) {
  return reviewsOfSurvey(survey.id).at(-1);
}

function openAnomalyCount(siteId) {
  return (state.db.surveys || []).filter((s) => s.siteId === siteId && s.status === '异常待复查').length;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function optionList(items, labelFields) {
  if (!items.length) return '<option value="">（请先建档样点）</option>';
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const step = field.step !== undefined ? `step="${field.step}"` : '';
  const value = field.value !== undefined && field.value !== null
    ? `value="${escapeHtml(field.value)}"`
    : '';
  const wide = field.wide ? 'wide' : '';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(field.value || '')}</textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) =>
      `<option value="${escapeHtml(option)}"${option === field.value ? ' selected' : ''}>${escapeHtml(option)}</option>`
    ).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${step} ${required}></label>`;
}

function modalField(field) {
  return formField(field);
}

function openModal({ title, fields, submitLabel = '提交' }) {
  return new Promise((resolve) => {
    state.modalResolve = resolve;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask">
        <form class="modal panel" data-modal-form>
          <div class="modal-head"><h2>${escapeHtml(title)}</h2><button type="button" class="ghost" data-modal-close>关闭</button></div>
          <div class="form-grid">${fields.map(modalField).join('')}</div>
          <div class="actions"><button type="submit">${escapeHtml(submitLabel)}</button><button type="button" class="ghost" data-modal-close>取消</button></div>
        </form>
      </div>`;
  });
}

function closeModal(value) {
  $('#modalRoot').innerHTML = '';
  const resolve = state.modalResolve;
  state.modalResolve = null;
  if (resolve) resolve(value === undefined ? null : value);
}

function metricGrid(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<div class="metrics">${items.map((item) => `
    <div class="metric ${item.exceeded ? 'over' : 'within'}">
      <span class="metric-tag">${item.exceeded ? '超阈' : '在范围内'}</span>
      <div class="metric-label">${escapeHtml(item.label)}</div>
      <div class="metric-reading">${fmtNum(item.reading)}<small>${escapeHtml(item.unit)}</small></div>
      <div class="metric-delta">${escapeHtml(item.diffLabel)} ${signed(item.delta)} ${escapeHtml(item.deltaUnit)}</div>
      <div class="metric-base">基准 ${fmtNum(item.baseline)}${escapeHtml(item.unit)} · 限值 ${escapeHtml(item.limit)}${escapeHtml(item.deltaUnit)}</div>
    </div>`).join('')}</div>`;
}

function reviewTimeline(survey) {
  const reviews = reviewsOfSurvey(survey.id);
  if (!reviews.length) {
    return survey.status === '异常待复查' ? '<p class="hint">尚未复查，点击下方按钮记录新读数；三项全部回到范围内才能关闭。</p>' : '';
  }
  return `<div class="reviews-timeline">
    <h4>复查记录（已累计 ${reviews.length} 次）</h4>
    ${reviews.map((review) => `
      <div class="review-item ${review.result === '关闭异常' ? 'is-pass' : 'is-fail'}">
        <div class="review-head">
          <strong>第${review.reviewNo}次复查</strong>
          <span>${escapeHtml(review.date)} · ${escapeHtml(review.reviewer)}</span>
          ${pill(review.result, toneFor(review.result === '关闭异常' ? '已关闭' : '异常待复查'))}
        </div>
        ${metricGrid(review.items)}
        ${review.conclusion ? `<p class="review-conclusion">现场结论：${escapeHtml(review.conclusion)}</p>` : ''}
      </div>`).join('')}
  </div>`;
}

function surveyCard(survey) {
  const site = siteOf(survey.siteId);
  const open = survey.status === '异常待复查';
  const reviews = reviewsOfSurvey(survey.id);
  const judgement = survey.judgement || {};
  return `<article class="card ${open ? 'card-bad' : ''}">
    <div class="card-head">
      <h3>${escapeHtml(survey.surveyor)} / ${escapeHtml(survey.date)}</h3>
      <div class="pills">
        ${pill(survey.status, toneFor(survey.status))}
        ${survey.reviewCount ? pill(`复查 ${survey.reviewCount} 次`, 'warn') : ''}
      </div>
    </div>
    <div class="meta">${escapeHtml(siteLabel(site))}${site ? ` · 巡测路线 ${escapeHtml(site.route)}` : ''}</div>
    ${metricGrid(judgement.items)}
    <p class="judgement">最近判定：${escapeHtml(judgement.reason || '巡测登记')} · ${fmtDate(judgement.at)}</p>
    ${survey.status === '已关闭' && survey.closeReason ? `<p class="close-note">关闭原因：${escapeHtml(survey.closeReason)}</p>` : ''}
    ${survey.disturbance ? `<p class="disturbance">干扰痕迹：${escapeHtml(survey.disturbance)}</p>` : ''}
    ${survey.dripRate ? `<p class="meta">滴水频率：${escapeHtml(survey.dripRate)} 次/分${survey.photoUrl ? ` · <a href="${escapeHtml(survey.photoUrl)}" target="_blank" rel="noreferrer">现场照片</a>` : ''}</p>` : ''}
    ${reviewTimeline(survey)}
    ${open ? `<div class="actions"><button data-action="open-review" data-survey="${survey.id}">提交复查（记录新读数）</button></div>` : ''}
    ${historyHtml(survey)}
  </article>`;
}

function siteCard(site) {
  const openCount = openAnomalyCount(site.id);
  return `<article class="card">
    <div class="card-head">
      <h3>${escapeHtml(site.pointCode)} <small class="meta">${escapeHtml(site.zone)}</small></h3>
      ${pill(site.protectedStatus, toneFor(site.protectedStatus))}
    </div>
    <div class="meta">${escapeHtml(site.cave)} · ${escapeHtml(site.route)} · 敏感等级 ${escapeHtml(site.sensitivity || '中')}</div>
    <div class="metrics">
      <div class="metric within"><div class="metric-label">基准温度</div><div class="metric-reading">${fmtNum(site.baselineTemp)}<small>℃</small></div></div>
      <div class="metric within"><div class="metric-label">基准湿度</div><div class="metric-reading">${fmtNum(site.baselineHumidity)}<small>%</small></div></div>
      <div class="metric within"><div class="metric-label">基准CO2</div><div class="metric-reading">${fmtNum(site.baselineCo2)}<small>ppm</small></div></div>
    </div>
    ${site.note ? `<p class="meta">${escapeHtml(site.note)}</p>` : ''}
    <p class="judgement ${openCount ? 'bad-text' : ''}">${openCount ? `该样点有 ${openCount} 条未关闭异常；调整基准将立即按新值重核。` : '当前无未关闭异常。'}</p>
    <div class="actions"><button class="ghost" data-action="edit-baseline" data-site="${site.id}">调整样点基准</button></div>
    ${historyHtml(site)}
  </article>`;
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view) => `
    <button class="tab" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function thresholdHint() {
  const t = state.config.thresholds;
  return `<p class="hint">判定规则（系统自动执行，不可手动标正常）：温差 &gt; ${t.temp}℃、湿度差 &gt; ${t.humidity} 个百分点或 CO2 增量 &gt; ${t.co2}ppm 任一项超阈，即生成“异常待复查”。</p>`;
}

function matchesSearch(item, fields, query, relationFields = []) {
  const own = fields.some((field) => String(item[field] ?? '').includes(query));
  const rel = relationFields.length
    ? ((site) => site && relationFields.some((field) => String(site[field] ?? '').includes(query)))(siteOf(item.siteId))
    : false;
  return own || rel;
}

function renderSurveyList(view, onlyOpen = false) {
  const query = ($(`#search-${view.id}`)?.value || '').trim();
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.surveys || [])];
  if (onlyOpen) items = items.filter((item) => item.status === '异常待复查');
  if (status) items = items.filter((item) => item.status === status);
  if (query) {
    items = items.filter((item) => matchesSearch(item, view.searchFields || [], query, ['cave', 'zone', 'pointCode', 'route']));
  }
  return items.length
    ? items.map(surveyCard).join('')
    : `<div class="empty">暂无${onlyOpen ? '待复查异常' : escapeHtml(collectionLabel(view.collection))}</div>`;
}

function renderDashboardView(view) {
  const items = (state.db.surveys || [])
    .filter((item) => view.focus.values.includes(item.status))
    .slice(0, view.focus.limit || 8);
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel">
      <h2>${escapeHtml(view.focusTitle)}</h2>
      ${thresholdHint()}
      <div class="list">${items.length ? items.map(surveyCard).join('') : '<div class="empty">全部异常均已闭环关闭</div>'}</div>
    </div>
  </section>`;
}

function renderSitesList(view) {
  const query = ($(`#search-${view.id}`)?.value || '').trim();
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.sites || [])];
  if (status) items = items.filter((item) => item.protectedStatus === status);
  if (query) items = items.filter((item) => matchesSearch(item, view.searchFields, query));
  return items.length ? items.map(siteCard).join('') : '<div class="empty">暂无样点档案</div>';
}

function renderSitesView(view) {
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="sites" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel)}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderSitesList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderSurveysView(view) {
  const fields = view.fields.map((field) => {
    if (field.name === 'date') return { ...field, value: new Date().toISOString().slice(0, 10) };
    return field;
  });
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="surveys" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${fields.map(formField).join('')}</div>
        ${thresholdHint()}
        <div class="actions"><button>${escapeHtml(view.submitLabel)}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderSurveyList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderReviewsView(view) {
  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      ${thresholdHint()}
      <div class="toolbar">
        <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
        <select id="status-${view.id}">
          <option value="异常待复查">待复查</option>
          <option value="已关闭">已关闭</option>
          <option value="正常">正常巡测</option>
          <option value="">全部记录</option>
        </select>
      </div>
      <div class="list" id="list-${view.id}">${renderSurveyList(view, false)}</div>
    </div>
  </section>`;
}

function renderView(view) {
  if (view.id === 'dashboard') return renderDashboardView(view);
  if (view.id === 'sites') return renderSitesView(view);
  if (view.id === 'surveys') return renderSurveysView(view);
  return renderReviewsView(view);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map(renderView).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

function formValues(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') payload[key] = value.trim();
  }
  return payload;
}

async function handleReview(surveyId) {
  const survey = (state.db.surveys || []).find((entry) => entry.id === surveyId);
  if (!survey) return;
  const source = latestReview(survey) || survey;
  const result = await openModal({
    title: `异常复查 · ${siteLabel(siteOf(survey.siteId))}`,
    fields: [
      { label: '复查日期', name: 'date', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
      { label: '复查人员', name: 'reviewer', value: survey.surveyor, required: true },
      { label: '新温度(℃)', name: 'temperature', type: 'number', step: 0.1, value: source.temperature, required: true },
      { label: '新湿度(%)', name: 'humidity', type: 'number', step: 1, value: source.humidity, required: true },
      { label: '新CO2(ppm)', name: 'co2', type: 'number', step: 1, value: source.co2, required: true },
      { label: '复查结论（现场情况）', name: 'conclusion', type: 'textarea', wide: true }
    ],
    submitLabel: '提交复查'
  });
  if (!result) return;
  const review = await api('/api/reviews', {
    method: 'POST',
    body: JSON.stringify({ surveyId, ...result })
  });
  await load();
  toast(review.result === '关闭异常' ? '三项回到范围内，异常已关闭' : '仍有指标超阈，复查次数已累计，继续待查');
}

async function handleBaseline(siteId) {
  const site = (state.db.sites || []).find((entry) => entry.id === siteId);
  if (!site) return;
  const result = await openModal({
    title: `调整基准 · ${siteLabel(site)}`,
    fields: [
      { label: '基准温度(℃)', name: 'baselineTemp', type: 'number', step: 0.1, value: site.baselineTemp, required: true },
      { label: '基准湿度(%)', name: 'baselineHumidity', type: 'number', step: 1, value: site.baselineHumidity, required: true },
      { label: '基准CO2(ppm)', name: 'baselineCo2', type: 'number', step: 1, value: site.baselineCo2, required: true },
      { label: '调整原因（必填，未关闭异常将按新基准重核）', name: 'reason', type: 'textarea', wide: true, required: true }
    ],
    submitLabel: '保存并重核未关闭异常'
  });
  if (!result) return;
  const payload = {
    baselineTemp: Number(result.baselineTemp),
    baselineHumidity: Number(result.baselineHumidity),
    baselineCo2: Number(result.baselineCo2),
    reason: result.reason
  };
  await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  await load();
  toast('基准已调整，未关闭异常已按新基准重核');
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const close = event.target.closest('[data-modal-close]');
  if (close) {
    closeModal(null);
    return;
  }
  if (tab) setTab(tab.dataset.tab);
  if (!action) return;
  try {
    if (action.dataset.action === 'open-review') await handleReview(action.dataset.survey);
    if (action.dataset.action === 'edit-baseline') await handleBaseline(action.dataset.site);
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) =>
    event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`);
  if (!view) return;
  const list = $(`#list-${view.id}`);
  if (!list) return;
  if (view.id === 'surveys' || view.id === 'reviews') {
    list.innerHTML = renderSurveyList(view);
  } else if (view.id === 'sites') {
    list.innerHTML = renderSitesList(view);
  }
});

function renderSitesList(view) {
  const query = ($(`#search-${view.id}`)?.value || '').trim();
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.sites || [])];
  if (status) items = items.filter((item) => item.protectedStatus === status);
  if (query) items = items.filter((item) => matchesSearch(item, view.searchFields, query));
  return items.length ? items.map(siteCard).join('') : '<div class="empty">暂无样点档案</div>';
}

document.addEventListener('submit', async (event) => {
  const modalForm = event.target.closest('[data-modal-form]');
  if (modalForm) {
    event.preventDefault();
    closeModal(formValues(modalForm));
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  try {
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(formValues(form)) });
    form.reset();
    await load();
    toast('已保存');
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modalResolve) closeModal(null);
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')).catch((error) => toast(error.message)));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
