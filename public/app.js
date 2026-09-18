const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const METRIC_DEFS = [
  { key: 'temperature', label: '温度', unit: '℃', baselineKey: 'baselineTemp', limit: 1.5, kind: 'abs' },
  { key: 'humidity', label: '湿度', unit: '%', baselineKey: 'baselineHumidity', limit: 6, kind: 'abs' },
  { key: 'co2', label: 'CO2', unit: 'ppm', baselineKey: 'baselineCo2', limit: 150, kind: 'incr' }
];

function escapeHtml(value = '') {
  return String(value)
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

function siteById(id) {
  return state.db.sites?.find((entry) => entry.id === id);
}

function siteLabel(site) {
  if (!site) return '未关联样点';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item, limit = 12) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history"><div class="history-title">处置时间线（异常历史）</div>${history.slice(0, limit).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span><b>${escapeHtml(entry.action)}</b>${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function formValues(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return payload;
}

// ---- 巡测判定展示 ----

function metricDelta(value, baseline, kind) {
  return kind === 'incr' ? value - baseline : Math.abs(value - baseline);
}

function metricGrid(survey, baseline, breachList) {
  const breachKeys = new Set((breachList || []).map((entry) => entry.metric || entry.key));
  return `<div class="metrics">${METRIC_DEFS.map((metric) => {
    const value = Number(survey[metric.key]);
    const base = Number(baseline?.[metric.baselineKey]);
    const delta = Number.isFinite(value) && Number.isFinite(base) ? metricDelta(value, base, metric.kind) : null;
    const signed = metric.kind === 'incr' ? delta : Math.abs(value - base) * (value >= base ? 1 : -1);
    const over = breachKeys.has(metric.key);
    return `<div class="metric ${over ? 'breach' : 'ok'}">
      <span class="metric-label">${metric.label}</span>
      <strong>${Number.isFinite(value) ? value : '-'}</strong>
      <small>基准 ${Number.isFinite(base) ? base : '-'}${metric.unit} · 差 ${delta === null ? '-' : (signed > 0 ? '+' : '') + Math.round(signed * 10) / 10}${metric.unit}${metric.kind === 'incr' ? '（增量）' : '（绝对差）'}</small>
      <em>${over ? `超阈值 ${metric.limit}${metric.unit}` : `≤ ${metric.limit}${metric.unit}`}</em>
    </div>`;
  }).join('')}</div>`;
}

function reviewOutcomePill(review) {
  const tone = review.outcome === '已恢复' ? 'ok' : 'bad';
  const stateTone = review.state === '有效' ? tone : 'muted';
  return `<span class="pill ${stateTone}">${escapeHtml(review.outcome || (review.state === '有效' ? '待判定' : review.state))}</span>`;
}

function reviewsHtml(survey) {
  const reviews = survey.reviews || [];
  if (!reviews.length) return '';
  return `<div class="reviews">
    <div class="history-title">复查记录${survey.reviewCount ? `（累计 ${survey.reviewCount} 次）` : ''}</div>
    ${reviews.map((review) => `
      <div class="review-item ${review.state === '有效' ? 'active' : 'void'}">
        <div class="review-head">
          <b>第${review.seq}次复查 · ${escapeHtml(review.reviewer)} · ${fmtDate(review.at)}</b>
          ${reviewOutcomePill(review)}
          ${review.state !== '有效' ? `<span class="void-tag">${escapeHtml(review.state)}</span>` : '<span class="valid-tag">当前有效复查</span>'}
        </div>
        <div class="review-reads">
          ${METRIC_DEFS.map((metric) => {
            const breach = (review.breaches || []).find((entry) => (entry.metric || entry.key) === metric.key);
            return `<span class="${breach ? 'bad-text' : 'ok-text'}">${metric.label} ${review[metric.key]}${metric.unit}${breach ? `（差${breach.delta > 0 ? '+' : ''}${breach.delta}${metric.unit}）` : ''}</span>`;
          }).join('')}
        </div>
        <div class="review-conclusion">结论：${escapeHtml(review.conclusion || '-')}</div>
      </div>`).join('')}
  </div>`;
}

function reviewFormHtml(survey) {
  if (survey.status !== '异常待复查') return '';
  const site = siteById(survey.siteId);
  const baseline = survey.baselineSnapshot || {};
  return `<form class="review-form" data-review="${survey.id}">
    <div class="review-form-title">登记复查（同一异常仅保留一条有效复查，提交新读数后旧复查自动失效）</div>
    <div class="review-grid">
      <label>复查温度(℃)<input name="temperature" type="number" step="0.1" value="${escapeHtml(survey.temperature ?? '')}" required></label>
      <label>复查湿度(%)<input name="humidity" type="number" step="0.1" value="${escapeHtml(survey.humidity ?? '')}" required></label>
      <label>复查CO2(ppm)<input name="co2" type="number" step="1" value="${escapeHtml(survey.co2 ?? '')}" required></label>
      <label>复查人<input name="reviewer" required placeholder="姓名"></label>
      <label class="wide">复查结论（现场处置与判断）<textarea name="conclusion" required placeholder="三项全部回到允许范围内才可关闭；仍有越限将累计次数并继续待查"></textarea></label>
    </div>
    <div class="review-hint">当前判定基准：温度${baseline.baselineTemp ?? '?'}℃ / 湿度${baseline.baselineHumidity ?? '?'}% / CO2 ${baseline.baselineCo2 ?? '?'}ppm${site ? `（${escapeHtml(siteLabel(site))}）` : ''}</div>
    <div class="actions"><button type="submit">提交复查并自动判定</button></div>
  </form>`;
}

function renderSurveyCard(item) {
  const site = siteById(item.siteId);
  const open = item.status === '异常待复查';
  const title = `${item.surveyor || '-'} · ${item.date || '-'}`;
  return `<article class="card survey-card ${open ? 'is-open' : 'is-closed'}">
    <div class="card-head">
      <h3>${escapeHtml(title)}</h3>
      ${pill(item.status, toneFor(item.status))}
    </div>
    <div class="meta">${escapeHtml(siteLabel(site))}${open && item.reviewCount ? ` · 已累计复查 <b>${item.reviewCount}</b> 次仍未闭环` : ''}</div>
    ${metricGrid(item, item.baselineSnapshot, item.initialBreaches)}
    ${item.disturbance ? `<p class="disturbance">干扰痕迹：${escapeHtml(item.disturbance)}</p>` : ''}
    ${!open && item.closeReason ? `<div class="close-box"><b>关闭原因</b>：${escapeHtml(item.closeReason)}</div>` : ''}
    ${reviewsHtml(item)}
    ${reviewFormHtml(item)}
    ${historyHtml(item)}
  </article>`;
}

// ---- 样点卡片（含基准调整） ----

function baselineAdjustForm(site) {
  if (site.protectedStatus === '暂停开放') return '';
  return `<details class="baseline-editor">
    <summary>调整样点基准（将重核未关闭异常）</summary>
    <form data-baseline="${site.id}">
      <div class="review-grid">
        <label>新基准温度(℃)<input name="baselineTemp" type="number" step="0.1" value="${escapeHtml(site.baselineTemp)}" required></label>
        <label>新基准湿度(%)<input name="baselineHumidity" type="number" step="0.1" value="${escapeHtml(site.baselineHumidity)}" required></label>
        <label>新基准CO2(ppm)<input name="baselineCo2" type="number" step="1" value="${escapeHtml(site.baselineCo2)}" required></label>
        <label class="wide">调整原因（必填，会写入受影响异常的历史）<textarea name="reason" required placeholder="例如：季节转换、长期监测后修订基准"></textarea></label>
      </div>
      <div class="baseline-warn">提交后：该样点所有未关闭异常的旧判定与既有复查结论立即失效，按新基准重核——达标的自动关闭，仍越限的继续待查。</div>
      <div class="actions"><button type="submit" class="danger">提交调整并重核</button></div>
    </form>
  </details>`;
}

function renderSiteCard(item) {
  const openCount = (state.db.surveys || []).filter((survey) => survey.siteId === item.id && survey.status === '异常待复查').length;
  const title = [item.pointCode, item.zone].filter(Boolean).join(' / ') || item.id;
  const actions = state.config.actions
    .filter((action) => action.collection === 'sites')
    .map((action) => `<button type="button" class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card site-card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${item.protectedStatus ? pill(item.protectedStatus, toneFor(item.protectedStatus)) : ''}</div>
    <div class="meta">${escapeHtml([item.cave, item.route, `敏感等级${item.sensitivity || '-'}`].filter(Boolean).join(' · '))}</div>
    <div class="metrics baseline">
      <div class="metric"><span class="metric-label">基准温度</span><strong>${escapeHtml(item.baselineTemp ?? '-')}</strong><small>℃，温差允许 ≤ ${state.config.thresholds.temp}</small></div>
      <div class="metric"><span class="metric-label">基准湿度</span><strong>${escapeHtml(item.baselineHumidity ?? '-')}</strong><small>%，湿度差允许 ≤ ${state.config.thresholds.humidity}pp</small></div>
      <div class="metric"><span class="metric-label">基准CO2</span><strong>${escapeHtml(item.baselineCo2 ?? '-')}</strong><small>ppm，增量允许 ≤ ${state.config.thresholds.co2}</small></div>
    </div>
    ${item.note ? `<p class="disturbance">备注：${escapeHtml(item.note)}</p>` : ''}
    <div class="meta open-badge">未关闭异常：<b class="${openCount ? 'bad-text' : 'ok-text'}">${openCount}</b> 条</div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${baselineAdjustForm(item)}
    ${historyHtml(item)}
  </article>`;
}

// ---- 视图与列表 ----

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view) => `
    <button type="button" class="tab" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
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

function ruleBanner() {
  const t = state.config.thresholds;
  return `<div class="rules">判定规则：|温差| &gt; ${t.temp}℃、|湿度差| &gt; ${t.humidity}个百分点、CO2增量 &gt; ${t.co2}ppm 任一成立即生成“异常待复查”，不可标正常；复查须三项全部回到范围内才关闭，否则累计次数继续待查。</div>`;
}

function filterItems(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[view.collection] || [])];
  if (query) {
    items = items.filter((item) => {
      const haystack = view.searchFields.some((field) => String(item[field] || '').includes(query));
      const inReviews = (item.reviews || []).some((review) => String(review.conclusion || '').includes(query) || String(review.reviewer || '').includes(query));
      return haystack || inReviews;
    });
  }
  if (status) items = items.filter((item) => item[view.statusField] === status);
  // 待复查优先，其余按更新时间
  items.sort((a, b) => {
    const ao = a.status === '异常待复查' ? 0 : 1;
    const bo = b.status === '异常待复查' ? 0 : 1;
    return ao - bo || new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
  });
  return items;
}

function renderSurveyList(view) {
  const items = filterItems(view);
  return items.length ? items.map(renderSurveyCard).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(view.collection))}</div>`;
}

function renderSiteList(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.sites || [])];
  if (query) items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  if (status) items = items.filter((item) => item[view.statusField] === status);
  return items.length ? items.map(renderSiteCard).join('') : `<div class="empty">暂无样点</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = (state.db[source.collection] || []).filter((item) => source.values.includes(item[source.field]));
  items.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  const closed = (state.db.surveys || []).filter((item) => item.status === '已关闭')
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);
  return `<section class="view" id="${view.id}">
    ${renderStats()}
    ${ruleBanner()}
    <div class="panel dashboard-panel">
      <h2>${escapeHtml(view.focusTitle)} <span class="count-tag">${items.length}</span></h2>
      <div class="list">${items.length ? items.map(renderSurveyCard).join('') : '<div class="empty">暂无待复查异常，全部闭环 🎉</div>'}</div>
    </div>
    <div class="panel dashboard-panel closed-panel">
      <h2>最近关闭的异常</h2>
      <div class="closed-summary">${closed.length ? closed.map((item) => {
        const site = siteById(item.siteId);
        return `<div class="closed-row"><span>${escapeHtml(siteLabel(site))} · ${escapeHtml(item.date || '')}</span>${pill(item.status, 'ok')}<em>${escapeHtml(item.closeReason || '复查达标关闭')}</em></div>`;
      }).join('') : '<div class="empty">暂无已关闭记录</div>'}</div>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const listRenderer = view.collection === 'sites' ? renderSiteList : renderSurveyList;
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        ${view.collection === 'surveys' ? ruleBanner() : ''}
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${listRenderer(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view)).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

// ---- 交互：复查提交 / 基准调整 / 保护状态动作 ----

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  if (tab) { setTab(tab.dataset.tab); return; }
  if (!action) return;
  try {
    await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
    await load();
    toast('保护状态已更新');
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (!view) return;
  const renderer = view.collection === 'sites' ? renderSiteList : renderSurveyList;
  $(`#list-${view.id}`).innerHTML = renderer(view);
});

document.addEventListener('submit', async (event) => {
  const createForm = event.target.closest('[data-create]');
  const reviewForm = event.target.closest('[data-review]');
  const baselineForm = event.target.closest('[data-baseline]');
  if (!createForm && !reviewForm && !baselineForm) return;
  event.preventDefault();

  try {
    if (createForm) {
      const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
      const payload = formValues(createForm, view);
      const created = await api(`/api/${createForm.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
      createForm.reset();
      await load();
      toast(created.status === '异常待复查' ? '读数越限，已生成待复查' : '三项在范围内，已登记为正常');
      return;
    }
    if (reviewForm) {
      const id = reviewForm.dataset.review;
      const payload = Object.fromEntries(new FormData(reviewForm).entries());
      payload.temperature = Number(payload.temperature);
      payload.humidity = Number(payload.humidity);
      payload.co2 = Number(payload.co2);
      const updated = await api(`/api/surveys/${id}/reviews`, { method: 'POST', body: JSON.stringify(payload) });
      await load();
      toast(updated.status === '已关闭' ? '复查达标，异常已闭环关闭' : '复查后仍有越限，已累计次数并继续待查');
      return;
    }
    const id = baselineForm.dataset.baseline;
    const payload = Object.fromEntries(new FormData(baselineForm).entries());
    payload.baselineTemp = Number(payload.baselineTemp);
    payload.baselineHumidity = Number(payload.baselineHumidity);
    payload.baselineCo2 = Number(payload.baselineCo2);
    const result = await api(`/api/sites/${id}/baseline`, { method: 'PATCH', body: JSON.stringify(payload) });
    await load();
    const closedCount = result.rechecked.filter((entry) => entry.status === '已关闭').length;
    toast(`基准已调整并重核 ${result.rechecked.length} 条未关闭异常${closedCount ? `，其中 ${closedCount} 条达标自动关闭` : '，均仍需待查'}`);
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新，状态与服务器一致')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
