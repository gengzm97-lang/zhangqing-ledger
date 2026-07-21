"use strict";

(() => {
  const CONFIG_KEY = "zhangqing_cloud_config_v1";
  const SESSION_KEY = "zhangqing_cloud_session_v1";
  let config = loadConfig();
  let session = loadSession();
  let syncTimer = null;
  let syncing = false;
  let installPrompt = null;

  const $ = selector => document.querySelector(selector);

  function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch (_) {}
    const builtIn = window.ZHANGQING_CLOUD || {};
    return {
      url: String(builtIn.supabaseUrl || saved.url || "").trim().replace(/\/$/, ""),
      key: String(builtIn.supabasePublishableKey || saved.key || "").trim()
    };
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (_) { return null; }
  }

  function saveSession(next) {
    session = next;
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
    renderCloudUI();
  }

  function configured() {
    return /^https:\/\/.+/.test(config.url) && config.key.length > 20;
  }

  function cloudHeaders(token = null, extra = {}) {
    return {
      apikey: config.key,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra
    };
  }

  async function request(path, options = {}) {
    if (!configured()) throw new Error("请先填写并保存 Supabase 项目地址和公开密钥");
    const response = await fetch(`${config.url}${path}`, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!response.ok) {
      const message = data?.msg || data?.message || data?.error_description || data?.error || `请求失败（${response.status}）`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function authPayload(data, fallbackEmail = "") {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
      user: data.user || { email: fallbackEmail }
    };
  }

  async function ensureSession() {
    if (!session?.refresh_token) throw new Error("请先登录云同步账号");
    if (session.access_token && session.expires_at > Date.now() + 60000) return session;
    const data = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: cloudHeaders(), body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    saveSession(authPayload(data, session.user?.email));
    return session;
  }

  function setStatus(type, badgeText, message = "") {
    const badge = $("#cloudStatusBadge");
    const status = $("#storageStatus");
    const messageBox = $("#cloudMessage");
    if (badge) { badge.className = `sync-badge ${type}`; badge.textContent = badgeText; }
    if (status) status.textContent = type === "online" ? "云端已同步" : type === "syncing" ? "正在同步…" : "数据保存在本机";
    if (messageBox && message) {
      messageBox.textContent = message;
      messageBox.classList.toggle("error", type === "error");
    }
  }

  function renderCloudUI() {
    if (!$("#cloudUrl")) return;
    $("#cloudUrl").value = config.url;
    $("#cloudKey").value = config.key;
    const loggedIn = Boolean(session?.refresh_token && session?.user);
    $("#cloudAuthForm").classList.toggle("hidden", loggedIn);
    $("#cloudAccountPanel").classList.toggle("hidden", !loggedIn);
    if (loggedIn) {
      $("#cloudAccountEmail").textContent = session.user.email || session.user.id || "已登录";
      const lastSync = localStorage.getItem("zhangqing_last_sync_v1");
      $("#cloudLastSync").textContent = lastSync ? `上次同步：${new Date(lastSync).toLocaleString("zh-CN")}` : "等待首次同步";
      setStatus(navigator.onLine ? "online" : "local", navigator.onLine ? "已登录" : "离线", navigator.onLine ? "已登录，数据更改会自动同步。" : "当前离线，恢复网络后自动同步。");
    } else {
      setStatus("local", "仅本机", configured() ? "云端已配置，请登录账号。" : "配置 Supabase 后即可启用。");
    }
  }

  async function signIn() {
    const email = $("#cloudEmail").value.trim();
    const password = $("#cloudPassword").value;
    if (!email || !password) return setStatus("error", "登录失败", "请输入邮箱和密码。");
    setStatus("syncing", "登录中", "正在验证账号…");
    try {
      const data = await request("/auth/v1/token?grant_type=password", {
        method: "POST", headers: cloudHeaders(), body: JSON.stringify({ email, password })
      });
      saveSession(authPayload(data, email));
      $("#cloudPassword").value = "";
      await syncNow(true);
    } catch (error) { setStatus("error", "登录失败", friendlyError(error)); }
  }

  async function signUp() {
    const email = $("#cloudEmail").value.trim();
    const password = $("#cloudPassword").value;
    if (!email || password.length < 6) return setStatus("error", "注册失败", "请输入有效邮箱，密码至少 6 位。");
    setStatus("syncing", "注册中", "正在创建账号…");
    try {
      const data = await request("/auth/v1/signup", {
        method: "POST", headers: cloudHeaders(), body: JSON.stringify({ email, password })
      });
      if (data?.access_token) {
        saveSession(authPayload(data, email));
        $("#cloudPassword").value = "";
        await syncNow(true);
      } else {
        setStatus("local", "待验证", "注册成功，请先打开邮箱完成验证，然后回来登录。");
      }
    } catch (error) { setStatus("error", "注册失败", friendlyError(error)); }
  }

  function friendlyError(error) {
    const message = String(error?.message || error || "未知错误");
    if (/invalid login credentials/i.test(message)) return "邮箱或密码不正确。";
    if (/email not confirmed/i.test(message)) return "请先在邮箱中完成账号验证。";
    if (/failed to fetch|network/i.test(message)) return "无法连接云端，请检查网络和项目地址。";
    return message;
  }

  async function fetchRemote(token, userId) {
    const query = `/rest/v1/ledger_snapshots?user_id=eq.${encodeURIComponent(userId)}&select=payload,client_updated_at,updated_at`;
    const rows = await request(query, { method: "GET", headers: cloudHeaders(token) });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function pushRemote(token, userId, payload) {
    return request("/rest/v1/ledger_snapshots?on_conflict=user_id", {
      method: "POST",
      headers: cloudHeaders(token, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ user_id: userId, payload, client_updated_at: payload.updatedAt, updated_at: new Date().toISOString() })
    });
  }

  async function syncNow(showFeedback = false) {
    if (syncing || !configured() || !session || !navigator.onLine) return;
    syncing = true;
    setStatus("syncing", "同步中", "正在合并电脑与手机数据…");
    try {
      const currentSession = await ensureSession();
      const userId = currentSession.user?.id;
      if (!userId) throw new Error("账号信息无效，请重新登录");
      const remote = await fetchRemote(currentSession.access_token, userId);
      const localState = window.ZhangQingApp.getState();
      const merged = remote?.payload ? window.ZhangQingApp.mergeStates(localState, remote.payload) : localState;
      if (remote?.payload) window.ZhangQingApp.replaceState(merged);
      await pushRemote(currentSession.access_token, userId, merged);
      const syncedAt = new Date().toISOString();
      localStorage.setItem("zhangqing_last_sync_v1", syncedAt);
      renderCloudUI();
      $("#cloudLastSync").textContent = `上次同步：${new Date(syncedAt).toLocaleString("zh-CN")}`;
      setStatus("online", "已同步", "电脑与手机数据已同步。你可以继续记账。");
      if (showFeedback) window.ZhangQingApp.showToast("云端同步完成");
    } catch (error) {
      if (error.status === 401) saveSession(null);
      setStatus("error", "同步失败", friendlyError(error));
    } finally { syncing = false; }
  }

  async function logout() {
    try {
      if (session?.access_token) await request("/auth/v1/logout", { method: "POST", headers: cloudHeaders(session.access_token) });
    } catch (_) {}
    saveSession(null);
    setStatus("local", "仅本机", "已退出云同步，本机数据仍然保留。");
  }

  function saveConfig() {
    const url = $("#cloudUrl").value.trim().replace(/\/$/, "");
    const key = $("#cloudKey").value.trim();
    if (!/^https:\/\/.+/.test(url) || key.length < 20) return setStatus("error", "配置错误", "请填写正确的 HTTPS 项目地址和 Publishable / anon key。");
    config = { url, key };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    saveSession(null);
    setStatus("local", "已配置", "云端配置已保存，请使用邮箱登录。");
  }

  function localChanged() {
    if (!session || !configured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), 1200);
    setStatus(navigator.onLine ? "syncing" : "local", navigator.onLine ? "等待同步" : "离线", navigator.onLine ? "本机有新数据，即将同步。" : "已保存在本机，联网后自动同步。");
  }

  async function initPwa() {
    const installBtn = $("#installAppBtn");
    if (window.matchMedia("(display-mode: standalone)").matches) {
      installBtn.disabled = true;
      installBtn.textContent = "已安装到设备";
      $("#installHint").textContent = "当前正在以独立应用模式运行。";
    } else if (location.protocol === "file:") {
      installBtn.disabled = true;
      $("#installHint").textContent = "本地文件不能安装；部署到 HTTPS 后即可在安卓安装。";
    }
    if (window.isSecureContext && "serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch (error) { console.warn("离线服务注册失败", error); }
    }
  }

  async function installApp() {
    if (!installPrompt) {
      $("#installHint").textContent = "请在安卓 Chrome 右上角菜单选择“添加到主屏幕”或“安装应用”。";
      return;
    }
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
  }

  function init() {
    renderCloudUI();
    initPwa();
    $("#saveCloudConfigBtn").addEventListener("click", saveConfig);
    $("#cloudSignInBtn").addEventListener("click", signIn);
    $("#cloudSignUpBtn").addEventListener("click", signUp);
    $("#cloudSyncNowBtn").addEventListener("click", () => syncNow(true));
    $("#cloudLogoutBtn").addEventListener("click", logout);
    $("#installAppBtn").addEventListener("click", installApp);
    window.addEventListener("online", () => { renderCloudUI(); syncNow(false); });
    window.addEventListener("offline", renderCloudUI);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(false); });
    setInterval(() => syncNow(false), 60000);
    if (session && configured() && navigator.onLine) syncNow(false);
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); installPrompt = event;
    const button = $("#installAppBtn");
    if (button) { button.disabled = false; button.textContent = "安装账清"; }
  });
  window.addEventListener("appinstalled", () => {
    const button = $("#installAppBtn");
    if (button) { button.disabled = true; button.textContent = "已安装到设备"; }
  });

  window.ZhangQingCloud = { localChanged, syncNow };
  document.addEventListener("DOMContentLoaded", init);
})();
