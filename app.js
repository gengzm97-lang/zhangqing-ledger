"use strict";

const STORAGE_KEY = "zhangqing_gpt_ledger_v1";
const PRODUCTS = ["GPT Plus", "5x", "20x"];
const EXPENSE_CATEGORIES = ["餐饮", "交通", "购物", "住房", "娱乐", "医疗", "学习", "人情往来", "其他"];
const PAGE_META = {
  dashboard: ["经营概览", "今天生意怎么样？"],
  orders: ["收支明细", "每一笔，都清清楚楚"],
  customers: ["客户运营", "了解每一位老客户"],
  expenses: ["个人账本", "我的钱花到哪里了？"],
  settings: ["安全与备份", "数据由你掌控"]
};

let state = loadState();
let currentRange = "month";
let expenseRange = "month";
let activePage = "dashboard";
let confirmAction = null;
let resizeTimer = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function emptyState() {
  return { version: 3, orders: [], customers: [], expenses: [], deleted: { orders: {}, customers: {}, expenses: {} }, updatedAt: new Date().toISOString() };
}

function normalizeStateData(data) {
  const base = emptyState();
  return {
    ...base, ...data, version: 3,
    orders: Array.isArray(data?.orders) ? data.orders : [],
    customers: Array.isArray(data?.customers) ? data.customers : [],
    expenses: Array.isArray(data?.expenses) ? data.expenses : [],
    deleted: {
      orders: data?.deleted?.orders || {},
      customers: data?.deleted?.customers || {},
      expenses: data?.deleted?.expenses || {}
    }
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.orders) && Array.isArray(saved.customers)) {
      return normalizeStateData(saved);
    }
  } catch (error) {
    console.warn("无法读取本地数据", error);
  }
  return emptyState();
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.ZhangQingCloud?.localChanged();
}

function markDeleted(collection, id, target = state) {
  if (!target.deleted) target.deleted = { orders: {}, customers: {}, expenses: {} };
  if (!target.deleted[collection]) target.deleted[collection] = {};
  target.deleted[collection][id] = new Date().toISOString();
}

function recordTime(record) {
  return new Date(record?.updatedAt || record?.createdAt || record?.date || 0).getTime() || 0;
}

function mergeCloudState(localData, remoteData) {
  const local = normalizeStateData(localData);
  const remote = normalizeStateData(remoteData);
  const merged = emptyState();
  ["orders", "customers", "expenses"].forEach(collection => {
    const deleted = { ...remote.deleted[collection] };
    Object.entries(local.deleted[collection]).forEach(([id, time]) => {
      if (!deleted[id] || new Date(time) > new Date(deleted[id])) deleted[id] = time;
    });
    merged.deleted[collection] = deleted;
    const records = new Map();
    [...remote[collection], ...local[collection]].forEach(record => {
      const previous = records.get(record.id);
      if (!previous || recordTime(record) >= recordTime(previous)) records.set(record.id, record);
    });
    merged[collection] = [...records.values()].filter(record => {
      const deletedAt = deleted[record.id];
      return !deletedAt || new Date(deletedAt).getTime() < recordTime(record);
    });
  });
  merged.updatedAt = new Date(Math.max(new Date(local.updatedAt).getTime() || 0, new Date(remote.updatedAt).getTime() || 0)).toISOString();
  return merged;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function money(value, compact = false) {
  const number = Number(value) || 0;
  if (compact && Math.abs(number) >= 10000) return `¥${(number / 10000).toFixed(2).replace(/\.00$/, "")}万`;
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(number);
}

function parseLocalDate(value) {
  if (!value) return new Date();
  const normalized = value.length === 10 ? `${value}T00:00:00` : value;
  return new Date(normalized);
}

function dateKey(value) {
  const d = parseLocalDate(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(value, withTime = false) {
  const d = parseLocalDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function toLocalInput(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function sum(items, getter) {
  return items.reduce((total, item) => total + Number(getter(item) || 0), 0);
}

function daysBetween(a, b) {
  return Math.round(Math.abs(parseLocalDate(a) - parseLocalDate(b)) / 86400000);
}

function pluralDay(days) {
  if (!Number.isFinite(days)) return "待积累";
  if (days === 0) return "今天";
  return `${days} 天`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function customerByName(name) {
  return state.customers.find(c => c.name.trim().toLowerCase() === String(name).trim().toLowerCase());
}

function ensureCustomer(name) {
  let customer = customerByName(name);
  if (!customer) {
    customer = { id: uid("cus"), name: name.trim(), contact: "", source: "", cycle: "auto", tags: [], note: "", createdAt: new Date().toISOString() };
    state.customers.push(customer);
  }
  return customer;
}

function customerOrders(customer) {
  return state.orders.filter(order => order.customerId === customer.id || (!order.customerId && order.customerName === customer.name));
}

function mostCommon(items) {
  if (!items.length) return "—";
  const counts = items.reduce((map, item) => (map[item] = (map[item] || 0) + 1, map), {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function getCustomerStats(customer) {
  const orders = customerOrders(customer).sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date));
  const totalRevenue = sum(orders, o => o.revenue);
  const totalProfit = sum(orders, o => o.profit ?? (o.revenue - o.cost));
  const lastDate = orders[0]?.date || null;
  const intervals = [];
  const asc = [...orders].sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));
  for (let i = 1; i < asc.length; i++) intervals.push(Math.max(1, daysBetween(asc[i].date, asc[i - 1].date)));
  const averageInterval = intervals.length ? Math.round(sum(intervals, n => n) / intervals.length) : null;
  const cycle = customer.cycle === "none" ? null : customer.cycle !== "auto" && customer.cycle ? Number(customer.cycle) : averageInterval;
  let nextDate = null;
  if (lastDate && cycle) {
    nextDate = parseLocalDate(lastDate);
    nextDate.setDate(nextDate.getDate() + cycle);
  }
  const daysUntil = nextDate ? Math.ceil((nextDate - new Date()) / 86400000) : null;
  const weekday = mostCommon(orders.map(o => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parseLocalDate(o.date).getDay()]));
  const timeBand = mostCommon(orders.map(o => {
    const h = parseLocalDate(o.date).getHours();
    return h < 6 ? "凌晨" : h < 12 ? "上午" : h < 18 ? "下午" : "晚上";
  }));
  return {
    orders, totalRevenue, totalProfit, lastDate, averageInterval, cycle, nextDate, daysUntil,
    preferredProduct: mostCommon(orders.map(o => o.product)),
    preferredService: mostCommon(orders.map(o => o.service)),
    weekday, timeBand,
    averageTicket: orders.length ? totalRevenue / orders.length : 0,
    due: daysUntil !== null && daysUntil <= 0,
    active: lastDate ? daysBetween(lastDate, new Date()) <= 30 : false
  };
}

function getRangeDates(range, items = state.orders) {
  const now = new Date();
  let start = new Date(now.getFullYear(), now.getMonth(), 1);
  let end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  if (range === "lastMonth") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (range === "year") {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
  } else if (range === "all") {
    const dates = items.map(o => parseLocalDate(o.date)).filter(d => !Number.isNaN(d.getTime()));
    start = dates.length ? new Date(Math.min(...dates)) : new Date(now.getFullYear(), now.getMonth(), 1);
    end = now;
  }
  return { start, end };
}

function setDateRange(range) {
  currentRange = range;
  const { start, end } = getRangeDates(range);
  $("#startDate").value = dateKey(start);
  $("#endDate").value = dateKey(end);
  $$("#datePresets button").forEach(btn => btn.classList.toggle("active", btn.dataset.range === range));
  renderDashboard();
}

function setExpenseDateRange(range) {
  expenseRange = range;
  const { start, end } = getRangeDates(range, state.expenses);
  $("#expenseStartDate").value = dateKey(start);
  $("#expenseEndDate").value = dateKey(end);
  $$("#expenseDatePresets button").forEach(btn => btn.classList.toggle("active", btn.dataset.range === range));
  renderExpenses();
}

function dashboardOrders() {
  const start = parseLocalDate($("#startDate").value);
  const end = parseLocalDate($("#endDate").value);
  end.setHours(23, 59, 59, 999);
  return state.orders.filter(o => {
    const date = parseLocalDate(o.date);
    return date >= start && date <= end;
  });
}

function renderDashboard() {
  const orders = dashboardOrders();
  const revenue = sum(orders, o => o.revenue);
  const cost = sum(orders, o => o.cost);
  const profit = sum(orders, o => o.profit ?? (o.revenue - o.cost));
  const margin = revenue ? profit / revenue * 100 : 0;
  const customers = new Set(orders.map(o => o.customerId || o.customerName)).size;
  const cards = [
    ["期间总利润", money(profit, true), `收入 ${money(revenue, true)} · 成本 ${money(cost, true)}`, `profit-card ${profit < 0 ? "loss-card" : ""}`],
    ["平均每单利润", money(orders.length ? profit / orders.length : 0, true), `${orders.length} 笔订单`, ""],
    ["综合利润率", `${margin.toFixed(1)}%`, `每 ¥100 收入赚 ${money(margin)}`, ""],
    ["成交订单", `${orders.length} 笔`, `${customers} 位成交客户`, ""]
  ];
  $("#summaryCards").innerHTML = cards.map(([label, value, note, cls]) => `
    <article class="summary-card ${cls}"><div class="label"><i></i>${label}</div><strong>${value}</strong><small>${note}</small></article>`).join("");

  const productRows = PRODUCTS.map(product => {
    const items = orders.filter(o => o.product === product);
    return { product, items, productRevenue: sum(items, o => o.revenue), productProfit: sum(items, o => o.profit ?? (o.revenue - o.cost)) };
  }).sort((a, b) => b.productProfit - a.productProfit);
  const maxProfit = Math.max(1, ...productRows.map(row => Math.abs(row.productProfit)));
  $("#productBreakdown").innerHTML = productRows.map(({ product, items, productRevenue, productProfit }) => {
    return `<div class="product-row ${productProfit < 0 ? "loss" : ""}">
      <div class="product-meta"><span>${product}<small>${items.length} 笔</small></span><strong>${money(productProfit)}</strong></div>
      <div class="progress"><i style="width:${Math.abs(productProfit) / maxProfit * 100}%"></i></div>
      <div class="product-sub"><span>收入 ${money(productRevenue)}</span><span>利润率 ${productRevenue ? (productProfit / productRevenue * 100).toFixed(1) : 0}%</span></div>
    </div>`;
  }).join("");

  renderTrendChart(orders);
  renderRecentOrders();
  renderFollowups();
}

function renderTrendChart(orders) {
  const canvas = $("#trendChart");
  $("#chartTooltip").classList.add("hidden");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height;
  const pad = { left: 47, right: 12, top: 17, bottom: 28 };
  const chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom;
  const start = parseLocalDate($("#startDate").value), end = parseLocalDate($("#endDate").value);
  const span = Math.max(1, daysBetween(start, end));
  const bucket = span > 100 ? "month" : span > 35 ? "week" : "day";
  const grouped = new Map();
  orders.forEach(order => {
    const date = parseLocalDate(order.date);
    let key, label, fullLabel;
    if (bucket === "month") {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      label = `${date.getMonth() + 1}月`;
      fullLabel = `${date.getFullYear()}年${date.getMonth() + 1}月`;
    } else if (bucket === "week") {
      const weekStart = new Date(date); weekStart.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = dateKey(weekStart); label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
      fullLabel = `${weekStart.getFullYear()}年${weekStart.getMonth() + 1}月${weekStart.getDate()}日当周`;
    } else {
      key = dateKey(date); label = `${date.getMonth() + 1}/${date.getDate()}`;
      fullLabel = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }
    const point = grouped.get(key) || { key, label, fullLabel, revenue: 0, profit: 0, count: 0 };
    point.revenue += Number(order.revenue) || 0;
    point.profit += Number(order.profit ?? (order.revenue - order.cost)) || 0;
    point.count += 1;
    grouped.set(key, point);
  });
  let points = [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (!points.length) points = [{ key: "", label: "暂无", fullLabel: "暂无数据", revenue: 0, profit: 0, count: 0 }];
  const maxVal = Math.max(1, ...points.map(p => p.profit));
  const minVal = Math.min(0, ...points.map(p => p.profit));
  const range = maxVal - minVal || 1;
  const x = i => pad.left + (points.length === 1 ? chartW / 2 : i / (points.length - 1) * chartW);
  const y = value => pad.top + (maxVal - value) / range * chartH;
  ctx.clearRect(0, 0, width, height);
  ctx.font = "10px Microsoft YaHei";
  ctx.strokeStyle = "#e7ecea"; ctx.fillStyle = "#87928f"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = maxVal - range * i / 4;
    const yy = pad.top + chartH * i / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(width - pad.right, yy); ctx.stroke();
    const axisLabel = value >= 10000 ? `${(value / 10000).toFixed(1)}万` : maxVal <= 5 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value);
    ctx.textAlign = "right"; ctx.fillText(axisLabel, pad.left - 8, yy + 3);
  }
  const drawLine = (key, color, fill) => {
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(x(i), y(p[key])) : ctx.moveTo(x(i), y(p[key])));
    if (fill && points.length > 1) {
      ctx.lineTo(x(points.length - 1), y(0)); ctx.lineTo(x(0), y(0)); ctx.closePath();
      const grad = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom); grad.addColorStop(0, "rgba(31,128,108,.18)"); grad.addColorStop(1, "rgba(31,128,108,0)");
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(x(i), y(p[key])) : ctx.moveTo(x(i), y(p[key])));
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
    points.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(i), y(p[key]), 3, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); });
  };
  drawLine("profit", "#0d5c4d", true);
  ctx.fillStyle = "#87928f"; ctx.textAlign = "center";
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, i) => { if (i % labelStep === 0 || i === points.length - 1) ctx.fillText(p.label, x(i), height - 8); });
  canvas._chartData = { points, xPositions: points.map((_, i) => x(i)), yPositions: points.map(p => y(p.profit)), width, height, bucket };
}

function showTrendTooltip(event) {
  const canvas = $("#trendChart");
  const data = canvas._chartData;
  const tooltip = $("#chartTooltip");
  if (!data?.points?.length || !data.points.some(point => point.count)) return;
  const rect = canvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  let index = 0;
  let distance = Infinity;
  data.xPositions.forEach((position, i) => {
    const current = Math.abs(position - mouseX);
    if (current < distance) { distance = current; index = i; }
  });
  const spacing = data.xPositions.length > 1 ? Math.abs(data.xPositions[1] - data.xPositions[0]) : 80;
  if (distance > Math.max(18, Math.min(42, spacing / 2))) {
    tooltip.classList.add("hidden");
    canvas.style.cursor = "default";
    return;
  }
  const point = data.points[index];
  if (!point.count) return;
  const periodName = data.bucket === "day" ? "当日利润" : data.bucket === "week" ? "本周利润" : "本月利润";
  tooltip.innerHTML = `<strong>${escapeHtml(point.fullLabel)}</strong><span>${periodName}<b>${money(point.profit)}</b></span><span>成交笔数<b>${point.count} 笔</b></span>`;
  tooltip.classList.remove("hidden");
  const half = tooltip.offsetWidth / 2;
  const left = Math.max(half + 5, Math.min(data.width - half - 5, data.xPositions[index]));
  const above = data.yPositions[index] - tooltip.offsetHeight - 12;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above > 3 ? above : data.yPositions[index] + 12}px`;
  canvas.style.cursor = "pointer";
}

function hideTrendTooltip() {
  $("#chartTooltip").classList.add("hidden");
  $("#trendChart").style.cursor = "default";
}

function renderRecentOrders() {
  const orders = [...state.orders].sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date)).slice(0, 5);
  $("#recentOrders").innerHTML = orders.length ? orders.map(o => `<div class="compact-item">
    <div class="compact-avatar">${escapeHtml((o.customerName || "客").slice(0, 1))}</div>
    <div class="compact-main"><strong>${escapeHtml(o.customerName)}</strong><span>${escapeHtml(o.product)} · ${escapeHtml(o.service)} · ${formatDate(o.date, true)}</span></div>
    <div class="compact-value"><strong class="${o.profit >= 0 ? "profit-positive" : "profit-negative"}">利润 ${money(o.profit)}</strong><span>收入 ${money(o.revenue)}</span></div>
  </div>`).join("") : `<div class="empty-state">${emptyMarkup("还没有订单", "点击右上角“记一笔”，开始记录第一笔收入。", "▤")}</div>`;
}

function renderFollowups() {
  const customers = state.customers.map(c => ({ customer: c, stats: getCustomerStats(c) }))
    .filter(x => x.stats.orders.length && x.stats.daysUntil !== null)
    .sort((a, b) => a.stats.daysUntil - b.stats.daysUntil).slice(0, 5);
  $("#followupList").innerHTML = customers.length ? customers.map(({ customer, stats }) => {
    const status = stats.daysUntil <= 0 ? `已到期 ${Math.abs(stats.daysUntil)} 天` : `${stats.daysUntil} 天后`;
    return `<div class="compact-item">
      <div class="compact-avatar">${escapeHtml(customer.name.slice(0, 1))}</div>
      <div class="compact-main"><strong>${escapeHtml(customer.name)}</strong><span>偏好 ${stats.preferredProduct} · 平均 ${pluralDay(stats.averageInterval)}复购</span></div>
      <div class="compact-value"><strong>${status}</strong><span>${stats.due ? "建议现在联系" : "预计复购"}</span></div>
    </div>`;
  }).join("") : `<div class="empty-state">${emptyMarkup("暂无回访提醒", "录入同一客户的多笔订单后，会自动分析复购周期。", "◎")}</div>`;
}

function renderOrders() {
  const keyword = $("#orderSearch").value.trim().toLowerCase();
  const product = $("#productFilter").value;
  const service = $("#serviceFilter").value;
  const sort = $("#orderSort").value;
  let orders = state.orders.filter(o => {
    const haystack = `${o.customerName} ${o.note || ""}`.toLowerCase();
    return (!keyword || haystack.includes(keyword)) && (!product || o.product === product) && (!service || o.service === service);
  });
  orders.sort((a, b) => {
    if (sort === "date-asc") return parseLocalDate(a.date) - parseLocalDate(b.date);
    if (sort === "revenue-desc") return b.revenue - a.revenue;
    if (sort === "profit-desc") return b.profit - a.profit;
    return parseLocalDate(b.date) - parseLocalDate(a.date);
  });
  const revenue = sum(orders, o => o.revenue), profit = sum(orders, o => o.profit);
  $("#orderResultSummary").innerHTML = `共 <b>${orders.length}</b> 笔，利润 <b class="${profit >= 0 ? "profit-positive" : "profit-negative"}">${money(profit)}</b>，收入 ${money(revenue)}`;
  $("#ordersTableBody").innerHTML = orders.map(o => `<tr>
    <td>${formatDate(o.date)}</td><td><strong>${escapeHtml(o.customerName)}</strong></td>
    <td><span class="pill">${escapeHtml(o.product)}</span></td><td><span class="pill service">${escapeHtml(o.service)}</span></td>
    <td class="num ${o.profit >= 0 ? "profit-positive" : "profit-negative"}">${money(o.profit)}</td><td class="num">${money(o.revenue)}</td><td class="num">${money(o.cost)}</td>
    <td class="note-cell" title="${escapeHtml(o.note || "")}">${escapeHtml(o.note || "—")}</td>
    <td><div class="row-actions"><button data-edit-order="${o.id}">编辑</button><button class="delete" data-delete-order="${o.id}">删除</button></div></td>
  </tr>`).join("");
  $("#ordersEmpty").classList.toggle("hidden", orders.length > 0);
  $("#ordersEmpty").innerHTML = emptyMarkup(state.orders.length ? "没有匹配的订单" : "还没有订单", state.orders.length ? "试试清除搜索词或更换筛选条件。" : "记录收入、成本后，利润会自动算好。", "▤");
}

function customerStatus(stats) {
  if (!stats.orders.length) return "new";
  if (stats.due) return "due";
  if (stats.active) return "active";
  return "inactive";
}

function renderCustomers() {
  const keyword = $("#customerSearch").value.trim().toLowerCase();
  const filter = $("#customerFilter").value;
  const data = state.customers.map(customer => ({ customer, stats: getCustomerStats(customer) }))
    .filter(({ customer, stats }) => {
      const haystack = `${customer.name} ${customer.contact || ""} ${(customer.tags || []).join(" ")} ${customer.note || ""}`.toLowerCase();
      return (!keyword || haystack.includes(keyword)) && (!filter || customerStatus(stats) === filter);
    }).sort((a, b) => (b.stats.lastDate ? parseLocalDate(b.stats.lastDate) : 0) - (a.stats.lastDate ? parseLocalDate(a.stats.lastDate) : 0));
  const allStats = state.customers.map(c => getCustomerStats(c));
  const dueCount = allStats.filter(s => s.due).length;
  const activeCount = allStats.filter(s => s.active).length;
  const repeatCount = allStats.filter(s => s.orders.length >= 2).length;
  const consumers = allStats.filter(s => s.orders.length).length;
  $("#customerStats").innerHTML = [
    ["客户总数", state.customers.length], ["需要回访", dueCount], ["30天活跃", activeCount], ["复购率", `${consumers ? (repeatCount / consumers * 100).toFixed(0) : 0}%`]
  ].map(([label, value]) => `<div class="mini-stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#customerGrid").innerHTML = data.map(({ customer, stats }) => {
    const due = stats.due ? `<span class="due-badge">待回访</span>` : "";
    const sourceTag = customer.source
      ? `<span class="tag source-tag">来源 · ${escapeHtml(customer.source)}</span>`
      : `<span class="tag source-tag empty-source">来源未记录</span>`;
    const tags = (customer.tags || []).slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    return `<article class="customer-card">
      <div class="customer-card-head"><div class="customer-avatar">${escapeHtml(customer.name.slice(0, 1))}</div><div class="customer-name"><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.contact || customer.source || "未记录联系方式")}</small></div>${due}</div>
      <div class="customer-metrics"><div><span>贡献利润</span><strong class="${stats.totalProfit >= 0 ? "profit-positive" : "profit-negative"}">${money(stats.totalProfit, true)}</strong></div><div><span>订单数</span><strong>${stats.orders.length} 笔</strong></div><div><span>平均单利</span><strong>${money(stats.orders.length ? stats.totalProfit / stats.orders.length : 0, true)}</strong></div></div>
      <div class="habit-line"><span>常购项目</span><strong>${stats.preferredProduct}</strong></div>
      <div class="habit-line"><span>充值节奏</span><strong>${stats.averageInterval ? `约 ${stats.averageInterval} 天` : "待积累"}</strong></div>
      <div class="tag-list">${sourceTag}${tags}</div>
      <div class="customer-card-actions"><button class="quick-order" data-customer-order="${customer.id}">＋ 记订单</button><button data-view-customer="${customer.id}">查看画像</button></div>
    </article>`;
  }).join("");
  $("#customersEmpty").classList.toggle("hidden", data.length > 0);
  $("#customersEmpty").innerHTML = emptyMarkup(state.customers.length ? "没有匹配的客户" : "还没有客户", state.customers.length ? "试试更换搜索或筛选条件。" : "新增客户后，可持续分析其充值习惯。", "◎");
}

function expenseRangeItems() {
  const start = parseLocalDate($("#expenseStartDate").value);
  const end = parseLocalDate($("#expenseEndDate").value);
  end.setHours(23, 59, 59, 999);
  return state.expenses.filter(expense => {
    const date = parseLocalDate(expense.date);
    return date >= start && date <= end;
  });
}

function renderExpenses() {
  const rangeExpenses = expenseRangeItems();
  const total = sum(rangeExpenses, expense => expense.amount);
  const todayKey = dateKey(new Date());
  const todayTotal = sum(state.expenses.filter(expense => dateKey(expense.date) === todayKey), expense => expense.amount);
  const uniqueDays = new Set(rangeExpenses.map(expense => dateKey(expense.date))).size;
  const average = rangeExpenses.length ? total / rangeExpenses.length : 0;
  const cards = [
    ["期间总支出", money(total, true), `${uniqueDays} 个消费日`, "expense-main-card"],
    ["今日支出", money(todayTotal, true), `${state.expenses.filter(expense => dateKey(expense.date) === todayKey).length} 笔`, ""],
    ["支出笔数", `${rangeExpenses.length} 笔`, `覆盖 ${uniqueDays} 天`, ""],
    ["平均每笔", money(average, true), "仅统计所选时间", ""]
  ];
  $("#expenseSummaryCards").innerHTML = cards.map(([label, value, note, cls]) => `
    <article class="summary-card ${cls}"><div class="label"><i></i>${label}</div><strong>${value}</strong><small>${note}</small></article>`).join("");

  const categoryRows = EXPENSE_CATEGORIES.map(category => {
    const items = rangeExpenses.filter(expense => expense.category === category);
    return { category, items, amount: sum(items, expense => expense.amount) };
  }).filter(row => row.items.length).sort((a, b) => b.amount - a.amount);
  const maxAmount = Math.max(1, ...categoryRows.map(row => row.amount));
  $("#expenseBreakdown").innerHTML = categoryRows.length ? categoryRows.map(row => `<div class="product-row">
    <div class="product-meta"><span>${escapeHtml(row.category)}<small>${row.items.length} 笔</small></span><strong>${money(row.amount)}</strong></div>
    <div class="progress"><i style="width:${row.amount / maxAmount * 100}%"></i></div>
    <div class="product-sub"><span>占总支出 ${total ? (row.amount / total * 100).toFixed(1) : 0}%</span><span>平均 ${money(row.amount / row.items.length)}</span></div>
  </div>`).join("") : `<div class="empty-state">${emptyMarkup("暂无支出数据", "记下第一笔个人支出后，这里会显示分类占比。", "¥")}</div>`;

  const highest = [...rangeExpenses].sort((a, b) => b.amount - a.amount)[0];
  const commonPayment = mostCommon(rangeExpenses.map(expense => expense.payment).filter(Boolean));
  const topCategory = categoryRows[0];
  $("#expenseInsight").innerHTML = rangeExpenses.length ? `
    <div class="expense-insight-item"><span>花费最多</span><strong>${escapeHtml(topCategory.category)} · ${money(topCategory.amount)}</strong></div>
    <div class="expense-insight-item"><span>单笔最高</span><strong>${money(highest.amount)} · ${escapeHtml(highest.category)}</strong></div>
    <div class="expense-insight-item"><span>常用支付</span><strong>${escapeHtml(commonPayment === "—" ? "未记录" : commonPayment)}</strong></div>
    <div class="expense-insight-item"><span>消费频率</span><strong>${uniqueDays} 天 / ${rangeExpenses.length} 笔</strong></div>`
    : `<div class="empty-state">${emptyMarkup("还没有消费小结", "支出记录会自动汇总，无需手工计算。", "⌁")}</div>`;

  const keyword = $("#expenseSearch").value.trim().toLowerCase();
  const categoryFilter = $("#expenseCategoryFilter").value;
  const filtered = rangeExpenses.filter(expense => {
    const haystack = `${expense.note || ""} ${expense.payment || ""} ${expense.category}`.toLowerCase();
    return (!keyword || haystack.includes(keyword)) && (!categoryFilter || expense.category === categoryFilter);
  }).sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date));
  $("#expenseResultSummary").innerHTML = `共 <b>${filtered.length}</b> 笔，合计支出 <b class="expense-amount">${money(sum(filtered, expense => expense.amount))}</b>`;
  $("#expensesTableBody").innerHTML = filtered.map(expense => `<tr>
    <td>${formatDate(expense.date)}</td><td><span class="pill service">${escapeHtml(expense.category)}</span></td>
    <td class="num expense-amount">−${money(expense.amount)}</td><td>${escapeHtml(expense.payment || "—")}</td>
    <td class="note-cell" title="${escapeHtml(expense.note || "")}">${escapeHtml(expense.note || "—")}</td>
    <td><div class="row-actions"><button data-edit-expense="${expense.id}">编辑</button><button class="delete" data-delete-expense="${expense.id}">删除</button></div></td>
  </tr>`).join("");
  $("#expensesEmpty").classList.toggle("hidden", filtered.length > 0);
  $("#expensesEmpty").innerHTML = emptyMarkup(state.expenses.length ? "没有匹配的支出" : "还没有个人支出", state.expenses.length ? "试试清除搜索词或调整日期、分类。" : "点击“记支出”，开始记录日常消费。", "¥");
}

function openExpenseDrawer(expense = null) {
  $("#expenseForm").reset();
  $("#expenseId").value = expense?.id || "";
  $("#expenseDrawerTitle").textContent = expense ? "编辑个人支出" : "记一笔个人支出";
  $("#expenseAmount").value = expense?.amount ?? "";
  $("#expenseCategory").value = expense?.category || "餐饮";
  $("#expensePayment").value = expense?.payment || "";
  $("#expenseDate").value = expense ? toLocalInput(parseLocalDate(expense.date)) : toLocalInput();
  $("#expenseNote").value = expense?.note || "";
  openDrawer("#expenseDrawer");
  setTimeout(() => $("#expenseAmount").focus(), 280);
}

function saveExpense(event) {
  event.preventDefault();
  const amount = Number($("#expenseAmount").value);
  if (!Number.isFinite(amount) || amount <= 0) return showToast("请输入正确的支出金额");
  const id = $("#expenseId").value;
  const expense = {
    id: id || uid("exp"), amount, category: $("#expenseCategory").value,
    payment: $("#expensePayment").value, date: $("#expenseDate").value,
    note: $("#expenseNote").value.trim(), updatedAt: new Date().toISOString()
  };
  if (id) state.expenses[state.expenses.findIndex(item => item.id === id)] = expense;
  else state.expenses.push(expense);
  saveState(); closeDrawers(); renderExpenses();
  showToast(id ? "支出已更新" : "个人支出已记入账本");
}

function deleteExpense(id) {
  askConfirm("删除这笔个人支出？", "删除后个人支出统计会同步更新。此操作无法撤销。", () => {
    markDeleted("expenses", id);
    state.expenses = state.expenses.filter(expense => expense.id !== id);
    saveState(); renderExpenses(); showToast("个人支出已删除");
  });
}

function emptyMarkup(title, text, icon) {
  return `<div class="empty-icon">${icon}</div><h3>${title}</h3><p>${text}</p>`;
}

function renderAll() {
  renderCustomerOptions();
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderExpenses();
}

function renderCustomerOptions() {
  $("#customerOptions").innerHTML = state.customers.map(c => `<option value="${escapeHtml(c.name)}"></option>`).join("");
}

function switchPage(page) {
  activePage = page;
  $$(".page").forEach(section => section.classList.toggle("active", section.id === `${page}Page`));
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === page));
  $("#eyebrow").textContent = PAGE_META[page][0];
  $("#pageTitle").textContent = PAGE_META[page][1];
  $("#quickCustomerBtn").classList.toggle("hidden", page === "expenses" || page === "settings");
  $("#quickOrderBtn").classList.toggle("hidden", page === "settings");
  $("#quickOrderBtn").textContent = page === "expenses" ? "＋ 记支出" : "＋ 记一笔";
  $(".sidebar").classList.remove("open");
  if (page === "dashboard") setTimeout(() => renderTrendChart(dashboardOrders()), 30);
  if (page === "orders") renderOrders();
  if (page === "customers") renderCustomers();
  if (page === "expenses") renderExpenses();
}

function openDrawer(id) {
  closeDrawers();
  $("#drawerBackdrop").classList.remove("hidden");
  const drawer = $(id);
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDrawers() {
  $$(".drawer").forEach(drawer => { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); });
  $("#drawerBackdrop").classList.add("hidden");
  document.body.style.overflow = "";
}

function openOrderDrawer(order = null, customer = null) {
  $("#orderForm").reset();
  const orderCustomer = customer || (order ? state.customers.find(c => c.id === order.customerId) || customerByName(order.customerName) : null);
  $("#orderId").value = order?.id || "";
  $("#orderDrawerTitle").textContent = order ? "编辑订单" : "记一笔新订单";
  $("#orderCustomer").value = order?.customerName || customer?.name || "";
  $("#orderCustomerSource").value = orderCustomer?.source || "";
  $("#orderProduct").value = order?.product || "GPT Plus";
  $("#orderService").value = order?.service || "代充";
  $("#orderDate").value = order ? toLocalInput(parseLocalDate(order.date)) : toLocalInput();
  $("#orderRevenue").value = order?.revenue ?? "";
  $("#orderCost").value = order?.cost ?? "";
  $("#orderNote").value = order?.note || "";
  updateProfitPreview();
  openDrawer("#orderDrawer");
  setTimeout(() => $("#orderCustomer").focus(), 280);
}

function updateProfitPreview() {
  const revenue = Number($("#orderRevenue").value) || 0;
  const cost = Number($("#orderCost").value) || 0;
  const profit = revenue - cost;
  $("#profitPreview").textContent = money(profit);
  $("#profitPreview").style.color = profit < 0 ? "var(--red)" : "var(--green)";
  $("#marginPreview").textContent = `利润率 ${revenue ? (profit / revenue * 100).toFixed(1) : 0}%`;
}

function saveOrder(event) {
  event.preventDefault();
  const name = $("#orderCustomer").value.trim();
  const revenue = Number($("#orderRevenue").value);
  const cost = Number($("#orderCost").value);
  if (!name) return showToast("请填写客户姓名");
  if (!Number.isFinite(revenue) || !Number.isFinite(cost) || revenue < 0 || cost < 0) return showToast("请输入正确的收款和成本金额");
  const customer = ensureCustomer(name);
  customer.source = $("#orderCustomerSource").value;
  customer.updatedAt = new Date().toISOString();
  const id = $("#orderId").value;
  const order = {
    id: id || uid("ord"), customerId: customer.id, customerName: customer.name,
    product: $("#orderProduct").value, service: $("#orderService").value,
    date: $("#orderDate").value, revenue, cost, profit: revenue - cost,
    note: $("#orderNote").value.trim(), updatedAt: new Date().toISOString()
  };
  if (id) state.orders[state.orders.findIndex(o => o.id === id)] = order;
  else state.orders.push(order);
  saveState(); closeDrawers(); renderAll();
  showToast(id ? "订单已更新" : "订单已记入账本");
}

function openCustomerDrawer(customer = null) {
  $("#customerForm").reset();
  $("#customerId").value = customer?.id || "";
  $("#customerDrawerTitle").textContent = customer?.id ? "编辑客户资料" : "新建客户";
  $("#customerName").value = customer?.name || "";
  $("#customerContact").value = customer?.contact || "";
  $("#customerSource").value = customer?.source || "";
  $("#customerCycle").value = customer?.cycle || "auto";
  $("#customerTags").value = (customer?.tags || []).join("，");
  $("#customerNote").value = customer?.note || "";
  openDrawer("#customerDrawer");
  setTimeout(() => $("#customerName").focus(), 280);
}

function saveCustomer(event) {
  event.preventDefault();
  const name = $("#customerName").value.trim();
  const id = $("#customerId").value;
  const duplicate = state.customers.find(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return showToast("已有同名客户，请换一个称呼");
  const customer = {
    id: id || uid("cus"), name, contact: $("#customerContact").value.trim(), source: $("#customerSource").value,
    cycle: $("#customerCycle").value, tags: $("#customerTags").value.split(/[,，]/).map(v => v.trim()).filter(Boolean),
    note: $("#customerNote").value.trim(), createdAt: id ? state.customers.find(c => c.id === id)?.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  if (id) {
    const old = state.customers.find(c => c.id === id);
    state.customers[state.customers.findIndex(c => c.id === id)] = customer;
    state.orders.filter(o => o.customerId === id).forEach(o => o.customerName = name);
    if (old && old.name !== name) state.orders.filter(o => !o.customerId && o.customerName === old.name).forEach(o => { o.customerId = id; o.customerName = name; });
  } else state.customers.push(customer);
  saveState(); closeDrawers(); renderAll();
  showToast(id ? "客户资料已更新" : "客户已添加");
}

function openProfile(customer) {
  const stats = getCustomerStats(customer);
  $("#profileName").textContent = customer.name;
  const nextText = !stats.orders.length ? "暂无消费记录" : !stats.nextDate ? "继续记录后自动预测" : stats.due ? `建议现在回访（已到预计复购日）` : `预计 ${formatDate(stats.nextDate)} 前后复购`;
  const habitInsight = stats.orders.length < 2
    ? "当前订单样本较少。再记录一笔消费后，系统会开始分析充值间隔与复购时间。"
    : `${customer.name}通常每 ${stats.averageInterval} 天左右购买一次，偏好${stats.preferredService}的 ${stats.preferredProduct}，常在${stats.weekday}${stats.timeBand}下单。${nextText}。`;
  $("#profileContent").innerHTML = `
    <div class="profile-hero"><div><p>贡献利润 / 累计收入</p><strong>${money(stats.totalProfit)} · ${money(stats.totalRevenue)}</strong></div><div class="profile-hero-actions"><button data-edit-customer="${customer.id}">编辑资料</button><button data-delete-customer="${customer.id}">删除</button></div></div>
    <div class="profile-metrics">
      <div class="profile-metric"><span>累计订单</span><strong>${stats.orders.length} 笔</strong></div>
      <div class="profile-metric"><span>平均单利</span><strong>${money(stats.orders.length ? stats.totalProfit / stats.orders.length : 0)}</strong></div>
      <div class="profile-metric"><span>平均间隔</span><strong>${stats.averageInterval ? `${stats.averageInterval} 天` : "待积累"}</strong></div>
      <div class="profile-metric"><span>常购项目</span><strong>${stats.preferredProduct}</strong></div>
      <div class="profile-metric"><span>交付偏好</span><strong>${stats.preferredService}</strong></div>
      <div class="profile-metric"><span>最近消费</span><strong>${stats.lastDate ? formatDate(stats.lastDate) : "—"}</strong></div>
    </div>
    <section class="profile-section"><h3>习惯分析</h3><div class="insight-box">${escapeHtml(habitInsight)}</div></section>
    <section class="profile-section"><h3>联系与备注</h3><div class="insight-box">联系方式：${escapeHtml(customer.contact || "未记录")}<br>来源：${escapeHtml(customer.source || "未记录")}<br>标签：${escapeHtml((customer.tags || []).join("、") || "暂无")}<br>备注：${escapeHtml(customer.note || "暂无")}</div></section>
    <section class="profile-section"><h3>消费记录</h3>${stats.orders.length ? stats.orders.slice(0, 20).map(o => `<div class="profile-order"><div><strong>${escapeHtml(o.product)} · ${escapeHtml(o.service)}</strong><small>${formatDate(o.date, true)}${o.note ? ` · ${escapeHtml(o.note)}` : ""}</small></div><span>${money(o.revenue)}</span></div>`).join("") : `<div class="insight-box">暂无消费记录，可从客户卡片快速记一笔订单。</div>`}</section>`;
  openDrawer("#profileDrawer");
}

function askConfirm(title, message, action, dangerText = "确认删除") {
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmOk").textContent = dangerText;
  confirmAction = action;
  $("#confirmModal").classList.remove("hidden");
}

function deleteOrder(id) {
  askConfirm("删除这笔订单？", "删除后收入、利润和客户画像都会同步更新。此操作无法撤销。", () => {
    markDeleted("orders", id);
    state.orders = state.orders.filter(o => o.id !== id); saveState(); renderAll(); showToast("订单已删除");
  });
}

function deleteCustomer(id) {
  const customer = state.customers.find(c => c.id === id);
  const count = customer ? customerOrders(customer).length : 0;
  askConfirm("删除这位客户？", count ? `该客户有 ${count} 笔订单。客户资料将删除，但历史订单会保留。` : "客户资料将永久删除。", () => {
    markDeleted("customers", id);
    state.customers = state.customers.filter(c => c.id !== id);
    state.orders.filter(o => o.customerId === id).forEach(o => o.customerId = "");
    saveState(); closeDrawers(); renderAll(); showToast("客户已删除，历史订单已保留");
  });
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function exportCsv() {
  const headers = ["日期", "客户", "业务项目", "交付方式", "收入", "成本", "利润", "利润率", "备注"];
  const rows = [...state.orders].sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date)).map(o => [
    o.date, o.customerName, o.product, o.service, o.revenue, o.cost, o.profit, o.revenue ? `${(o.profit / o.revenue * 100).toFixed(2)}%` : "0%", o.note || ""
  ]);
  const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(`账清-订单明细-${dateKey(new Date())}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
  showToast("订单明细已导出");
}

function exportExpensesCsv() {
  const headers = ["日期", "分类", "金额", "支付方式", "备注"];
  const rows = [...state.expenses].sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date)).map(expense => [
    expense.date, expense.category, expense.amount, expense.payment || "", expense.note || ""
  ]);
  const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(`账清-个人支出-${dateKey(new Date())}.csv`, `\ufeff${csv}`, "text/csv;charset=utf-8");
  showToast("个人支出明细已导出");
}

function backupData(silent = false) {
  downloadFile(`账清-完整备份-${dateKey(new Date())}.json`, JSON.stringify(state, null, 2), "application/json");
  if (!silent) showToast("完整备份已导出");
}

async function restoreData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.orders) || !Array.isArray(data.customers)) throw new Error("格式错误");
    if (state.orders.length || state.customers.length || state.expenses.length) backupData(true);
    state = normalizeStateData(data);
    saveState(); renderAll(); showToast("备份恢复成功");
  } catch (error) { showToast("无法导入：请选择正确的账清备份文件"); }
  $("#restoreInput").value = "";
}

function initEvents() {
  $$(".nav-item").forEach(btn => btn.addEventListener("click", () => switchPage(btn.dataset.page)));
  $$('[data-goto]').forEach(btn => btn.addEventListener("click", () => switchPage(btn.dataset.goto)));
  $("#menuBtn").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#quickOrderBtn").addEventListener("click", () => activePage === "expenses" ? openExpenseDrawer() : openOrderDrawer());
  $("#quickCustomerBtn").addEventListener("click", () => openCustomerDrawer());
  $("#addCustomerBtn").addEventListener("click", () => openCustomerDrawer());
  $("#addExpenseBtn").addEventListener("click", () => openExpenseDrawer());
  $("#inlineAddCustomer").addEventListener("click", () => { const name = $("#orderCustomer").value; closeDrawers(); openCustomerDrawer(name ? { name } : null); });
  $$(".close-drawer").forEach(btn => btn.addEventListener("click", closeDrawers));
  $("#drawerBackdrop").addEventListener("click", closeDrawers);
  $("#orderForm").addEventListener("submit", saveOrder);
  $("#customerForm").addEventListener("submit", saveCustomer);
  $("#expenseForm").addEventListener("submit", saveExpense);
  $("#orderRevenue").addEventListener("input", updateProfitPreview);
  $("#orderCost").addEventListener("input", updateProfitPreview);
  $("#orderCustomer").addEventListener("input", () => {
    const customer = customerByName($("#orderCustomer").value);
    $("#orderCustomerSource").value = customer?.source || "";
  });
  $("#trendChart").addEventListener("mousemove", showTrendTooltip);
  $("#trendChart").addEventListener("mouseleave", hideTrendTooltip);
  $("#trendChart").addEventListener("click", showTrendTooltip);
  $$("#datePresets button").forEach(btn => btn.addEventListener("click", () => setDateRange(btn.dataset.range)));
  $("#startDate").addEventListener("change", () => { currentRange = "custom"; $$("#datePresets button").forEach(b => b.classList.remove("active")); renderDashboard(); });
  $("#endDate").addEventListener("change", () => { currentRange = "custom"; $$("#datePresets button").forEach(b => b.classList.remove("active")); renderDashboard(); });
  $$("#expenseDatePresets button").forEach(btn => btn.addEventListener("click", () => setExpenseDateRange(btn.dataset.range)));
  $("#expenseStartDate").addEventListener("change", () => { expenseRange = "custom"; $$("#expenseDatePresets button").forEach(b => b.classList.remove("active")); renderExpenses(); });
  $("#expenseEndDate").addEventListener("change", () => { expenseRange = "custom"; $$("#expenseDatePresets button").forEach(b => b.classList.remove("active")); renderExpenses(); });
  ["#orderSearch", "#productFilter", "#serviceFilter", "#orderSort"].forEach(id => $(id).addEventListener(id === "#orderSearch" ? "input" : "change", renderOrders));
  ["#customerSearch", "#customerFilter"].forEach(id => $(id).addEventListener(id === "#customerSearch" ? "input" : "change", renderCustomers));
  ["#expenseSearch", "#expenseCategoryFilter"].forEach(id => $(id).addEventListener(id === "#expenseSearch" ? "input" : "change", renderExpenses));
  $("#ordersTableBody").addEventListener("click", event => {
    const edit = event.target.closest("[data-edit-order]"); const del = event.target.closest("[data-delete-order]");
    if (edit) openOrderDrawer(state.orders.find(o => o.id === edit.dataset.editOrder));
    if (del) deleteOrder(del.dataset.deleteOrder);
  });
  $("#customerGrid").addEventListener("click", event => {
    const order = event.target.closest("[data-customer-order]"); const view = event.target.closest("[data-view-customer]");
    if (order) openOrderDrawer(null, state.customers.find(c => c.id === order.dataset.customerOrder));
    if (view) openProfile(state.customers.find(c => c.id === view.dataset.viewCustomer));
  });
  $("#expensesTableBody").addEventListener("click", event => {
    const edit = event.target.closest("[data-edit-expense]"); const del = event.target.closest("[data-delete-expense]");
    if (edit) openExpenseDrawer(state.expenses.find(expense => expense.id === edit.dataset.editExpense));
    if (del) deleteExpense(del.dataset.deleteExpense);
  });
  $("#profileContent").addEventListener("click", event => {
    const edit = event.target.closest("[data-edit-customer]"); const del = event.target.closest("[data-delete-customer]");
    if (edit) openCustomerDrawer(state.customers.find(c => c.id === edit.dataset.editCustomer));
    if (del) deleteCustomer(del.dataset.deleteCustomer);
  });
  $("#exportCsvBtn").addEventListener("click", exportCsv);
  $("#settingsCsvBtn").addEventListener("click", exportCsv);
  $("#expenseCsvBtn").addEventListener("click", exportExpensesCsv);
  $("#settingsExpenseCsvBtn").addEventListener("click", exportExpensesCsv);
  $("#backupBtn").addEventListener("click", () => backupData());
  $("#restoreBtn").addEventListener("click", () => $("#restoreInput").click());
  $("#restoreInput").addEventListener("change", event => event.target.files[0] && restoreData(event.target.files[0]));
  $("#clearDataBtn").addEventListener("click", () => askConfirm("清空全部数据？", "所有订单、客户和个人支出都会永久删除。请确认已经完成备份。", () => {
    const cleared = emptyState();
    state.orders.forEach(item => markDeleted("orders", item.id, cleared));
    state.customers.forEach(item => markDeleted("customers", item.id, cleared));
    state.expenses.forEach(item => markDeleted("expenses", item.id, cleared));
    state = cleared; saveState(); renderAll(); showToast("全部数据已清空");
  }, "确认清空"));
  $("#confirmCancel").addEventListener("click", () => { $("#confirmModal").classList.add("hidden"); confirmAction = null; });
  $("#confirmOk").addEventListener("click", () => { const action = confirmAction; $("#confirmModal").classList.add("hidden"); confirmAction = null; if (action) action(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { closeDrawers(); $("#confirmModal").classList.add("hidden"); } });
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderTrendChart(dashboardOrders()), 120); });
}

function init() {
  initEvents();
  setDateRange("month");
  setExpenseDateRange("month");
  renderAll();
}

window.ZhangQingApp = {
  getState: () => JSON.parse(JSON.stringify(state)),
  mergeStates: mergeCloudState,
  replaceState: nextState => {
    state = normalizeStateData(nextState);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();
  },
  showToast
};

document.addEventListener("DOMContentLoaded", init);
