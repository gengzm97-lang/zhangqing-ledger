"use strict";

(() => {
  const CATEGORIES = ["餐饮", "交通", "购物", "住房", "娱乐", "医疗", "学习", "人情往来", "其他"];
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const UPSTREAM_ID = /^[1-9]\d{0,15}$/;
  const HASH = /^[a-f0-9]{64}$/i;
  const PAGE_SIZE = 20;
  let rows = [], ledger = null, pending = [], sources = [], secret = null;
  let page = 0, busy = false, generation = 0, syncMessage = "", deviceMessage = "";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const query = selector => document.querySelector(selector);
  const context = () => window.ZhangQingCloud?.getAutoContext?.() || { loggedIn: false, configured: false };
  const notify = message => window.ZhangQingApp?.showToast?.(message);
  const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) && Number.isFinite(new Date(value).getTime());
  const day = value => validDate(value) ? value.slice(0, 10) : "";
  const cents = value => Math.round(Number(value) * 100);
  const money = (value, currency = "CNY") => currency === "CNY" ? `¥${Number(value || 0).toFixed(2)}` : `${Number(value || 0).toFixed(2)} ${String(currency || "未知币种")}`;

  function stableExpenseId(row) {
    if (!UUID.test(String(row?.id || "")) || !UUID.test(String(row?.source_id || "")) ||
        !UPSTREAM_ID.test(String(row?.upstream_id || "")) || !Number.isSafeInteger(Number(row?.upstream_id)) ||
        !HASH.test(String(row?.payload_hash || ""))) {
      throw new Error("自动账单标识无效");
    }
    return `auto_${row.source_id}_${row.upstream_id}`;
  }

  function expenseFromRow(row) {
    const id = stableExpenseId(row);
    const bill = row.bill || {};
    const amount = Number(bill.amount);
    if (bill.type !== "Expend" || bill.currency !== "CNY" || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents(amount)) ||
        !["微信", "支付宝"].includes(bill.payment) || !validDate(bill.date) || !validDate(row.first_received_at)) {
      throw new Error("请核对自动账单的金额、币种、日期和支付方式");
    }
    return {
      id, date: bill.date, amount: cents(amount) / 100,
      category: CATEGORIES.includes(bill.category) ? bill.category : "其他",
      payment: bill.payment,
      note: [bill.merchant, bill.note].filter(Boolean).join(" · ") || "自动识别支出",
      updatedAt: row.first_received_at,
      billSource: {
        origin: "autoaccounting", sourceId: row.source_id, upstreamId: String(row.upstream_id),
        payloadHash: row.payload_hash, platform: bill.payment, merchant: String(bill.merchant || ""),
        originalCents: Number.isSafeInteger(bill.originalCents) ? bill.originalCents : cents(amount),
        importedAt: row.first_received_at
      }
    };
  }

  // Pure reconciliation: replays have stable IDs/timestamps and never overwrite a recorded expense.
  function applyToState(input, incoming) {
    const original = input || {};
    const expenses = Array.isArray(original.expenses) ? original.expenses.slice() : [];
    const deleted = original.deleted?.expenses || {};
    const decisions = new Map((Array.isArray(original.autoDecisions) ? original.autoDecisions : []).map(item => [item.id, item]));
    const existing = new Map(expenses.map(item => [item.id, item]));
    const pendingItems = [];
    let added = 0;
    const seen = new Set();
    const ordered = (Array.isArray(incoming) ? incoming : []).slice().sort((a, b) =>
      String(a?.first_received_at || "").localeCompare(String(b?.first_received_at || "")) || String(a?.id || "").localeCompare(String(b?.id || "")));
    for (const row of ordered) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      let id;
      try { id = stableExpenseId(row); } catch (_) { continue; }
      if (Object.prototype.hasOwnProperty.call(deleted, id)) continue;
      const decision = decisions.get(row.id);
      if (decision?.action === "ignore" && decision.payloadHash === row.payload_hash) continue;
      const recorded = existing.get(id);
      if (recorded?.billSource?.payloadHash === row.payload_hash) continue;
      let expense = null;
      try { expense = expenseFromRow(row); } catch (_) {}
      const isExpense = row.bill?.type === "Expend";
      let reason = "";
      if (recorded) reason = "这笔账已记入，但来源金额或状态有变化，请核对原支出。";
      else if (decision?.action === "ignore") reason = "这笔账曾被忽略，但来源内容有变化，请重新核对。";
      else if (!expense) reason = row.bill?.reviewReason || "金额、币种、日期或支付方式需要核对。";
      else if (!isExpense) reason = row.bill?.reviewReason || "这不是明确的消费支出，请核对用途。";
      else if (row.bill?.eligible !== true) reason = row.bill?.reviewReason || "这笔账需要确认是否属于个人支出。";
      const suspect = !recorded && expense && expenses.find(item =>
        day(item.date) === day(expense.date) && cents(item.amount) === cents(expense.amount) && (!item.payment || item.payment === expense.payment));
      if (suspect) reason = "同一天已有相同金额和支付方式的支出，可能已手记或导入。";
      if (reason) {
        pendingItems.push({ ...row, pendingReason: reason, expenseId: recorded?.id || "", canAccept: Boolean(expense && row.bill?.eligible === true && !recorded) });
        continue;
      }
      expenses.push(expense);
      existing.set(id, expense);
      added += 1;
    }
    const next = added ? { ...original, expenses } : original;
    return { state: next, added, pending: pendingItems };
  }

  function statusText() {
    const current = context();
    if (!current.configured) return "先配置云同步";
    if (!current.loggedIn) return "登录后可连接手机";
    const count = sources.filter(source => !source.revoked_at && source.active !== false).length;
    return count ? `${count} 台设备已连接` : "尚未连接手机";
  }

  function renderSettings() {
    const host = query("#autoAccountingSettings");
    if (!host) return;
    const oldLabel = query("#autoDeviceLabel")?.value || "Redmi K70 Pro";
    const enabled = context().loggedIn && !busy;
    host.classList.add("panel", "auto-settings");
    host.innerHTML = `<div class="panel-head"><div><p class="eyebrow">付款后自动收集</p><h2>手机自动记账连接</h2></div><span class="auto-status">${esc(statusText())}</span></div>
      <p class="auto-copy">连接手机上的“自动记账”后，明确的微信、支付宝消费会进入个人支出；转账、退款和疑似重复的记录留待核对。</p>
      <div class="auto-connect-form"><label class="field"><span>设备名称</span><input id="autoDeviceLabel" maxlength="60" value="${esc(oldLabel)}" autocomplete="off"></label>
      <button class="button primary" type="button" data-auto-action="create" ${enabled ? "" : "disabled"}>生成连接配置</button>
      <button class="button ghost" type="button" data-auto-action="refresh" ${enabled ? "" : "disabled"}>刷新连接</button></div>
      <div class="auto-message" role="status">${esc(deviceMessage || (context().loggedIn ? "在手机“自动记账”应用中打开：数据管理 → 账单导出。将下面生成的地址和令牌填入，再开启“同步账单到 NAS”。" : "请先在上方登录云同步账号。"))}</div>
      <div id="autoConnectionSecret" class="auto-secret ${secret ? "" : "hidden"}"></div>
      <div class="auto-device-list">${sources.length ? sources.map(source => {
        const revoked = Boolean(source.revoked_at || source.active === false);
        const last = source.last_received_at || source.last_seen_at;
        const received = last && Number.isFinite(new Date(last).getTime()) ? new Date(last).toLocaleString("zh-CN") : "";
        return `<div class="auto-device"><div><strong>${esc(source.label || source.name || "手机")}</strong><small>${revoked ? "连接已撤销" : received ? `最近收到：${esc(received)}` : "已连接，等待手机发送账单"}</small></div>
          <div class="auto-device-actions">${revoked ? "" : `<button class="button ghost" type="button" data-auto-action="rotate" data-source="${esc(source.id)}" ${busy ? "disabled" : ""}>重置令牌</button><button class="button ghost auto-danger" type="button" data-auto-action="revoke" data-source="${esc(source.id)}" ${busy ? "disabled" : ""}>撤销连接</button>`}</div></div>`;
      }).join("") : `<p class="auto-copy">尚无设备连接。点击“生成连接配置”开始。</p>`}</div>`;
    renderSecret();
  }

  function renderSecret() {
    const host = query("#autoConnectionSecret");
    if (!host || !secret) return;
    host.innerHTML = `<div class="auto-secret-heading"><strong>复制到手机“自动记账”的账单导出设置</strong><button type="button" class="button ghost" data-auto-action="hide-secret">收起配置</button></div>
      <label class="field"><span>NAS 接收地址（Webhook）</span><div class="auto-copy-field"><input id="autoReceiverUrl" readonly autocomplete="off" aria-label="Webhook 地址"><button type="button" class="button ghost" data-auto-action="copy-url">复制地址</button></div></label>
      <label class="field"><span>NAS 令牌（专用上传令牌）</span><div class="auto-copy-field"><input id="autoReceiverToken" type="password" readonly autocomplete="off" aria-label="专用令牌"><button type="button" class="button ghost" data-auto-action="copy-token">复制令牌</button></div></label>
      <p class="auto-copy">这个令牌不是微信或支付宝密码，只允许此设备上传账单。令牌仅在本次页面中显示；收起或退出后如需重新配置，请重置令牌。</p>`;
    query("#autoReceiverUrl").value = secret.receiverUrl;
    query("#autoReceiverToken").value = secret.token;
  }

  function renderInbox() {
    const host = query("#autoAccountingInbox");
    if (!host) return;
    host.classList.add("panel", "auto-inbox");
    const loggedIn = context().loggedIn;
    if (!loggedIn) pending = [];
    const pages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const visible = pending.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    host.innerHTML = `<div class="panel-head"><div><p class="eyebrow">自动记账</p><h2>待确认支出 <span class="auto-count">${pending.length}</span></h2></div><button type="button" class="button ghost" data-auto-action="sync" ${loggedIn && !busy ? "" : "disabled"}>检查新账单</button></div>
      <p class="auto-copy">这里显示全部月份待核对的自动账单。收入和经营成本请按实际用途核对后处理。</p>
      <div class="auto-message" role="status">${esc(syncMessage)}</div>
      ${visible.length ? `<div class="auto-inbox-table"><table><thead><tr><th>时间 / 商户</th><th>金额</th><th>需要核对</th><th>操作</th></tr></thead><tbody>${visible.map(row => `<tr>
        <td><strong>${esc(row.bill?.merchant || row.bill?.note || "未注明商户")}</strong><small>${esc(String(row.bill?.date || "未注明日期").replace("T", " ").slice(0, 16))} · ${esc(row.bill?.payment || "未注明方式")}</small></td>
        <td class="auto-amount">${esc(money(row.bill?.amount, row.bill?.currency))}</td><td class="auto-reason">${esc(row.pendingReason)}</td>
        <td><div class="auto-row-actions">${row.expenseId ? `<button type="button" class="button ghost" data-auto-action="edit" data-row="${esc(row.id)}">编辑原支出</button>` : row.canAccept ? `<button type="button" class="button ghost" data-auto-action="accept" data-row="${esc(row.id)}">确认为个人支出</button>` : ""}<button type="button" class="button ghost" data-auto-action="ignore" data-row="${esc(row.id)}">忽略</button></div></td></tr>`).join("")}</tbody></table></div>
        <div class="auto-pagination"><span>共 ${pending.length} 条 · 第 ${page + 1} / ${pages} 页</span><button type="button" class="button ghost" data-auto-action="previous" ${page === 0 ? "disabled" : ""}>上一页</button><button type="button" class="button ghost" data-auto-action="next" ${page + 1 >= pages ? "disabled" : ""}>下一页</button></div>` : `<p class="auto-empty">${loggedIn ? "暂无待确认账单。明确的消费会在同步后自动记入个人支出。" : "登录云同步后，可接收手机自动识别的支出。"}</p>`}`;
  }

  async function api(path, options = {}) {
    if (!context().loggedIn || !window.ZhangQingCloud?.autoRequest) throw new Error("not_logged_in");
    return window.ZhangQingCloud.autoRequest(path, options);
  }

  async function refreshDevices() {
    const ticket = generation;
    const owner = context().userId;
    if (!context().loggedIn) return;
    const result = await api("/devices");
    if (ticket !== generation || owner !== context().userId) return;
    sources = Array.isArray(result?.sources) ? result.sources : [];
    renderSettings();
  }

  async function withBusy(action) {
    if (busy) return;
    const ticket = generation;
    busy = true;
    renderSettings();
    try { await action(ticket); }
    catch (error) { if (ticket === generation) {
      const detail = typeof error?.message === "string" ? error.message : "";
      deviceMessage = detail && !["not_logged_in", "not_ready"].includes(detail)
        ? detail.slice(0, 200) : "请先登录云同步账号，或刷新页面后重试。";
      notify(deviceMessage);
    } }
    finally { if (ticket === generation) { busy = false; renderSettings(); renderInbox(); } }
  }

  async function copyValue(value, inputId) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); notify("已复制"); }
    catch (_) { const input = query(inputId); input?.focus(); input?.select(); notify("请长按或按 Ctrl+C 复制选中的内容"); }
  }

  async function handleClick(event) {
    const button = event.target.closest?.("[data-auto-action]");
    if (!button || button.disabled || !button.closest("#autoAccountingSettings, #autoAccountingInbox")) return;
    const action = button.dataset.autoAction;
    if (action === "copy-url") return copyValue(secret?.receiverUrl, "#autoReceiverUrl");
    if (action === "copy-token") return copyValue(secret?.token, "#autoReceiverToken");
    if (action === "hide-secret") { secret = null; renderSettings(); return; }
    if (action === "previous" || action === "next") { page += action === "next" ? 1 : -1; renderInbox(); return; }
    if (action === "sync") return withBusy(async () => {
      if (!window.ZhangQingCloud?.syncNow) throw new Error("not_ready");
      await window.ZhangQingCloud.syncNow();
    });
    if (action === "refresh") return withBusy(refreshDevices);
    if (action === "create" || action === "rotate" || action === "revoke") {
      const label = String(query("#autoDeviceLabel")?.value || "Redmi K70 Pro").trim().slice(0, 60);
      const sourceId = button.dataset.source;
      if (action !== "create" && !UUID.test(sourceId || "")) return;
      if (action === "rotate" && !window.confirm("重置后旧令牌会立即失效。需要把新令牌重新填写到手机小助手，继续吗？")) return;
      if (action === "revoke" && !window.confirm("撤销后，这台设备不能再上传账单。已记入的支出会保留，继续吗？")) return;
      return withBusy(async ticket => {
        const result = await api(action === "create" ? "/devices" : `/devices/${encodeURIComponent(sourceId)}/${action}`, { method: "POST", body: JSON.stringify(action === "create" ? { label: label || "Redmi K70 Pro" } : {}) });
        if (ticket !== generation) return;
        secret = action !== "revoke" && result?.token && result?.receiverUrl ? { token: String(result.token), receiverUrl: String(result.receiverUrl) } : null;
        deviceMessage = action === "revoke" ? "设备连接已撤销。" : "连接配置已生成。请在手机“自动记账 → 数据管理 → 账单导出”填写两项配置，启用同步后点击“立即导出”。";
        await refreshDevices();
      });
    }
    const row = pending.find(item => item.id === button.dataset.row);
    if (!row || !context().loggedIn) return;
    if (action === "edit" && row.expenseId) return window.ZhangQingApp?.editAutoExpense?.(row.expenseId);
    if (action === "accept" && (!row.canAccept || !window.confirm(`将 ${row.bill?.merchant || "这笔账单"} 的 ${money(row.bill?.amount)} 确认为个人支出？请确认它不是经营成本，也没有重复记账。`))) return;
    if (!["ignore", "accept"].includes(action)) return;
    return withBusy(async () => {
      const app = window.ZhangQingApp;
      if (action === "ignore") {
        if (!app?.saveAutoDecision) throw new Error("not_ready");
        await app.saveAutoDecision(row.id, row.payload_hash);
      } else {
        if (!app?.acceptAutoExpense) throw new Error("not_ready");
        await app.acceptAutoExpense(row);
      }
      ledger = app.getState();
      pending = applyToState(ledger, rows).pending;
      renderInbox();
    });
  }

  function onSync(incoming, currentState, status) {
    rows = Array.isArray(incoming) ? incoming.slice() : [];
    ledger = currentState;
    pending = applyToState(currentState, rows).pending;
    syncMessage = typeof status === "string" ? status : String(status?.message || "");
    renderInbox();
  }

  function onAuthChanged() {
    generation += 1;
    rows = []; ledger = null; pending = []; sources = []; secret = null; page = 0; busy = false;
    syncMessage = ""; deviceMessage = "";
    renderSettings(); renderInbox();
    if (context().loggedIn) refreshDevices().catch(() => {
      deviceMessage = "暂时无法读取连接状态，请点击“刷新连接”重试。";
      renderSettings();
    });
  }

  function init() {
    document.addEventListener("click", handleClick);
    renderSettings(); renderInbox();
    if (context().loggedIn) refreshDevices().catch(() => {});
  }

  window.ZhangQingAuto = { applyToState, stableExpenseId, expenseFromRow, onSync, onAuthChanged, refreshDevices };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
