"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const categories = ["餐饮", "交通", "购物", "住房", "娱乐", "医疗", "学习", "人情往来", "其他"];
  let rows = [], loadToken = 0, busy = false, xlsxReady;
  let pageIndex = 0;
  const PAGE_SIZE = 100;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = value => new Intl.NumberFormat("zh-CN", {style:"currency",currency:"CNY"}).format(value || 0);
  function message(text, error = false) { $("#billImportMessage").textContent = text; $("#billImportMessage").classList.toggle("error", error); }
  function getVisible() { const month = $("#billImportMonth").value; return rows.filter(row => !month || row.date.startsWith(month)); }
  function canSelect(row) { return row.canImport && row.transactionId && !row.exactDuplicate && !row.conflict; }
  function countSelected() {
    const selected = getVisible().filter(row => row.selected && canSelect(row));
    $("#billImportTotal").textContent = `已选 ${selected.length} 笔 · ${money(selected.reduce((sum, row) => sum + row.cents, 0) / 100)}`;
    $("#billImportConfirm").disabled = busy || !selected.length;
  }
  function render() {
    const visible = getVisible();
    const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    pageIndex = Math.min(pageIndex, totalPages - 1);
    $("#billPageInfo").textContent = `第 ${pageIndex + 1}/${totalPages} 页 · ${visible.length} 笔`;
    $("#billPagePrev").disabled = pageIndex === 0;
    $("#billPageNext").disabled = pageIndex === totalPages - 1;
    $("#billImportRows").innerHTML = visible.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map(row => `<tr class="${canSelect(row) ? "" : "bill-disabled"}">
      <td><input type="checkbox" data-bill-select="${row.index}" aria-label="选择第${row.sourceRow}行支出" ${row.selected && canSelect(row) ? "checked" : ""} ${canSelect(row) ? "" : "disabled"}></td>
      <td>${esc(row.date.replace("T", " "))}<small>${esc(row.payment)}</small></td>
      <td class="bill-description">${esc(row.merchant || "未标注商户")}<small>${esc(row.note)}</small></td>
      <td class="num">${money(row.amount)}</td>
      <td><select data-bill-category="${row.index}" aria-label="支出分类" ${canSelect(row) ? "" : "disabled"}>${categories.map(category => `<option ${category === row.category ? "selected" : ""}>${category}</option>`).join("")}</select></td>
      <td class="bill-reason">${esc(row.checkReason || row.reason || "可导入，请核对分类")}<small>${esc(row.fileName)} · 第 ${row.sourceRow} 行</small></td>
    </tr>`).join("") || '<tr><td colspan="6">暂无预览记录。</td></tr>';
    countSelected();
  }
  async function hash(value) {
    if (!globalThis.crypto?.subtle) throw new Error("请使用 HTTPS 在线版或本机浏览器打开账清后导入。");
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
  }
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxReady) xlsxReady = new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = "./vendor/xlsx.full.min.js";
      script.onload = () => resolve(); script.onerror = () => { xlsxReady = null; script.remove(); reject(new Error("表格读取组件未加载，请联网打开一次账清后重试。")); };
      document.head.appendChild(script);
    });
    return xlsxReady;
  }
  function decodeCsv(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_) { return new TextDecoder("gb18030").decode(bytes); }
  }
  async function parseFile(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB，请按月导出后导入。`);
    const extension = file.name.split(".").pop().toLowerCase();
    if (!["csv", "xls", "xlsx"].includes(extension)) throw new Error("请选择解压后的 CSV / Excel 文件，不能直接导入 ZIP 或 PDF。");
    const buffer = await file.arrayBuffer();
    const parser = window.ZhangQingBillParser;
    if (extension === "csv") return parser.parseCsv(decodeCsv(buffer));
    await loadXlsx();
    let workbook;
    try { workbook = XLSX.read(buffer, { type:"array", cellDates:false, cellText:true, cellNF:true, sheetRows:10002 }); }
    catch (_) { throw new Error("无法打开这份 Excel。请使用用于个人对账的表格；加密或压缩文件需先在本机处理。"); }
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (sheet["!fullref"] && XLSX.utils.decode_range(sheet["!fullref"]).e.r >= 10002) throw new Error("文件记录过多，请按月导出后导入。");
      // Exported transaction IDs must stay text; number cells have already lost precision in Excel.
      const data = XLSX.utils.sheet_to_json(sheet, { header:1, defval:"", raw:true, range:0 });
      data.forEach((row, r) => row.forEach((value, c) => {
        const cell = sheet[XLSX.utils.encode_cell({r, c})];
        if (typeof value === "number" && cell?.z && XLSX.SSF.is_date(cell.z)) {
          const d = XLSX.SSF.parse_date_code(value, {date1904:!!workbook.Workbook?.WBProps?.date1904});
          if (d) { const pad = n => String(n).padStart(2, "0"); row[c] = `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}`; }
        }
      }));
      try { return parser.parseRows(data); } catch (_) { /* Check the next sheet. */ }
    }
    throw new Error("没有找到可识别的微信/支付宝账单表头，请使用‘用于个人对账’文件。");
  }
  function reviewDuplicates(ledger, selectDefaults) {
    const existing = new Map(ledger.expenses.map(item => [item.id, item]));
    const deleted = ledger.deleted?.expenses || {};
    const grouped = new Map();
    rows.forEach(row => { if (row.id) { if (!grouped.has(row.id)) grouped.set(row.id, []); grouped.get(row.id).push(row); } });
    for (const group of grouped.values()) {
      const signatures = new Set(group.map(row => `${row.cents}|${row.date}|${row.status}|${row.disposition}`));
      if (signatures.size > 1) group.forEach(row => { row.conflict = true; row.selected = false; row.checkReason = "同一交易有不同状态或金额，请核对原支出（可能退款）。"; });
      else group.slice(1).forEach(row => { row.exactDuplicate = true; row.selected = false; row.checkReason = "本次文件中的重复交易。"; });
    }
    for (const row of rows) {
      if (!row.transactionId) { row.selected = false; row.checkReason = "缺少交易号，暂不批量导入，请手工核对。"; continue; }
      const saved = existing.get(row.id);
      if (saved || deleted[row.id]) {
        row.exactDuplicate = true; row.selected = false;
        row.checkReason = deleted[row.id] ? "这条导入记录曾被删除，不会自动恢复。" : "已导入过，跳过重复交易。";
        if (saved && (row.disposition !== "expense" || row.cents !== saved.billSource?.originalCents)) row.checkReason = "此交易已有记录；本次金额/状态需核对，请检查原支出。";
      }
      const suspects = ledger.expenses.filter(item => !item.billSource && Math.round(Number(item.amount) * 100) === row.cents
        && String(item.date).slice(0, 10) === row.date.slice(0, 10) && (!item.payment || item.payment === row.payment));
      const signature = suspects.map(item => item.id).sort().join("|");
      if (suspects.length && !row.exactDuplicate && !row.conflict) {
        row.checkReason = "疑似已手记：同日同金额，请核对后再勾选。";
        if (selectDefaults || signature !== row.suspects) row.selected = false;
      } else if (selectDefaults) row.selected = row.disposition === "expense" && canSelect(row);
      row.suspects = signature;
    }
  }
  async function loadFiles() {
    const token = ++loadToken; busy = true; rows = []; pageIndex = 0; render();
    const files = Array.from($("#billImportFiles").files || []);
    if (!files.length) { busy = false; message("请选择账单文件。"); countSelected(); return; }
    if (files.length > 6) { busy = false; message("一次最多选择 6 份账单。", true); countSelected(); return; }
    message("正在本机解析账单，请稍候…");
    let collected = [], invalid = 0;
    try {
      for (const file of files) {
        const parsed = await parseFile(file);
        invalid += parsed.invalidRows?.length || 0;
        for (const row of parsed.rows) {
          const copy = {...row, fileName:file.name, selected:false, index:collected.length};
          copy.id = row.transactionId ? `bill_${row.payment === "微信" ? "wx" : "ali"}_${await hash(row.payment + "|" + row.transactionId)}` : "";
          collected.push(copy);
          if (collected.length > 10000) throw new Error("本次记录超过 10000 笔，请缩小账单时间范围。");
        }
      }
      if (token !== loadToken) return;
      rows = collected; reviewDuplicates(window.ZhangQingApp.getState(), true);
      const duplicate = rows.filter(row => row.exactDuplicate).length;
      const review = rows.filter(row => row.disposition === "review" || row.suspects || row.conflict || !row.transactionId).length;
      message(`识别 ${rows.length} 笔 · 重复 ${duplicate} 笔 · 待核对 ${review} 笔${invalid ? ` · ${invalid} 行日期/金额无效，未纳入` : ""}。请检查勾选的消费。`);
    } catch (error) { if (token === loadToken) { rows = []; message(error.message || "读取失败，请核对账单格式。", true); } }
    finally { if (token === loadToken) { busy = false; render(); } }
  }
  function confirmImport() {
    if (busy) return;
    reviewDuplicates(window.ZhangQingApp.getState(), false);
    const selected = getVisible().filter(row => row.selected && canSelect(row));
    if (!selected.length) { render(); message("没有可新增的支出；请检查重复提示或重新勾选。"); return; }
    busy = true; countSelected();
    try {
      const now = new Date().toISOString();
      const added = window.ZhangQingApp.importBillExpenses(selected.map(row => ({
        id:row.id, amount:row.cents / 100, date:row.date, category:row.category, payment:row.payment,
        note:[row.merchant, row.note].filter(Boolean).join(" · ").slice(0, 2000), updatedAt:now,
        billSource:{platform:row.payment, transactionId:row.transactionId, merchant:row.merchant, originalCents:row.cents, originalStatus:row.status, importedAt:now}
      })));
      reviewDuplicates(window.ZhangQingApp.getState(), false);
      message(`已新增 ${added} 笔支出。重复记录未再加入，个人账本已切到本次导入的日期范围。`);
      window.ZhangQingApp.showToast(`已导入 ${added} 笔支出`);
    } catch (_) { message("保存未完成，请检查本机存储空间，并核对账本后重试。", true); }
    finally { busy = false; render(); }
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("#openBillImportBtn").addEventListener("click", () => { window.ZhangQingApp.openBillImport(); render(); });
    $("#billImportFiles").addEventListener("change", loadFiles);
    $("#billImportMonth").addEventListener("change", () => { pageIndex = 0; reviewDuplicates(window.ZhangQingApp.getState(), false); render(); });
    $("#billPagePrev").addEventListener("click", () => { pageIndex = Math.max(0, pageIndex - 1); render(); });
    $("#billPageNext").addEventListener("click", () => { pageIndex++; render(); });
    $("#billSelectSafe").addEventListener("click", () => { if (busy) return; getVisible().forEach(row => row.selected = row.disposition === "expense" && !row.suspects && canSelect(row)); render(); });
    $("#billSelectNone").addEventListener("click", () => { getVisible().forEach(row => row.selected = false); render(); });
    $("#billImportRows").addEventListener("change", event => {
      const select = event.target.dataset.billSelect, category = event.target.dataset.billCategory;
      if (select !== undefined && rows[Number(select)]) rows[Number(select)].selected = event.target.checked && canSelect(rows[Number(select)]);
      if (category !== undefined && categories.includes(event.target.value)) rows[Number(category)].category = event.target.value;
      countSelected();
    });
    $("#billImportConfirm").addEventListener("click", confirmImport);
  });
})();
