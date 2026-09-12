import { BillValidationError, normalizeBill, sha256 } from "./normalize.mjs";

const MAX_BODY = 256 * 1024;
const SAFE_SOURCE_COLUMNS = "id,label,created_at,last_received_at,revoked_at";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uploadTokenPattern = /^zqa_[0-9a-f]{64}$/;

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function serverConfig() {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new ApiError(503, "NOT_CONFIGURED", "云端接口尚未配置完成。");
  return { url, serviceKey, receiverUrl: `${url}/functions/v1/autoaccounting/v1/bills` };
}

function allowedOrigin(origin: string | null) {
  if (!origin) return true; // Native Android clients have no browser Origin.
  const extra = (Deno.env.get("AUTOACCOUNTING_ALLOWED_ORIGINS") || "").split(",").map(x => x.trim()).filter(Boolean);
  return origin === "https://gengzm97-lang.github.io" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin) || extra.includes(origin);
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  if (!match || match[1].length > 8192) throw new ApiError(401, "UNAUTHORIZED", "请登录账清，或检查设备令牌。");
  return match[1];
}

async function fetchBounded(url: string, options: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function database(path: string, options: RequestInit = {}) {
  const { url, serviceKey } = serverConfig();
  const response = await fetchBounded(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    // Never echo Postgres errors, SQL, request bodies, credentials or account data.
    await response.body?.cancel();
    throw new ApiError(503, "DATABASE_UNAVAILABLE", "云端数据接口暂不可用，请确认初始化脚本已执行后重试。");
  }
  return response.status === 204 ? null : await response.json();
}

async function authenticatedUser(request: Request) {
  const token = bearer(request);
  const { url, serviceKey } = serverConfig();
  // Verify with the Auth service; decoding a JWT locally is not authentication.
  const response = await fetchBounded(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(401, "LOGIN_REQUIRED", "登录已过期，请重新登录账清。");
  }
  const user = await response.json();
  if (!user || !uuidPattern.test(user.id)) throw new ApiError(401, "LOGIN_REQUIRED", "请重新登录账清。");
  return user.id as string;
}

async function readJson(request: Request, limit = MAX_BODY) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ApiError(415, "JSON_REQUIRED", "请发送 application/json 格式。");
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new ApiError(413, "BODY_TOO_LARGE", "账单内容超过允许大小。");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "EMPTY_BODY", "请求内容不能为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, "BODY_TOO_LARGE", "账单内容超过允许大小。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, "INVALID_JSON", "账单不是有效的 JSON。"); }
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "zqa_" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function rpcError(result: { ok: boolean; code?: string }) {
  if (result?.ok) return;
  const errors: Record<string, [number, string]> = {
    INVALID_TOKEN: [401, "设备令牌无效或已撤销。"],
    INVALID_DEVICE: [400, "设备名称无效。"],
    INVALID_BILL: [400, "账单字段无效。"],
    DEVICE_LIMIT: [409, "最多连接 20 个有效设备，请先撤销不用的设备。"],
    RATE_LIMIT: [429, "设备上传过于频繁，请稍后重新导出。"],
    INBOX_LIMIT: [409, "自动账单收件箱已达到 50000 条上限，请联系维护者处理。"],
  };
  const code = result?.code || "DATABASE_UNAVAILABLE";
  const [status, message] = errors[code] || [503, "云端接口暂不可用，请稍后重试。"];
  throw new ApiError(status, code, message);
}

async function route(request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/functions\/v1\/autoaccounting(?=\/|$)/, "").replace(/^\/autoaccounting(?=\/|$)/, "").replace(/\/$/, "") || "/";
  const method = request.method;
  if (path === "/health" && method === "GET") return { ok: true, service: "zhangqing-autoaccounting", version: 1 };

  if (path === "/v1/bills" && method === "POST") {
    const token = bearer(request);
    if (!uploadTokenPattern.test(token)) throw new ApiError(401, "INVALID_TOKEN", "设备令牌无效；请勿填写支付密码或 Supabase 密钥。");
    const normalized = normalizeBill(await readJson(request));
    const result = await database("rpc/autoaccounting_receive_bill", { method: "POST", body: JSON.stringify({
      p_token_hash: await sha256(token), p_upstream_id: normalized.upstreamId,
      p_payload_hash: await sha256(JSON.stringify(normalized.bill)), p_bill: normalized.bill,
    }) });
    rpcError(result);
    return { ...result, eligible: normalized.bill.eligible, reviewReason: normalized.bill.reviewReason };
  }

  if (path === "/devices" && (method === "GET" || method === "POST")) {
    const userId = await authenticatedUser(request);
    if (method === "GET") {
      const sources = await database(`autoaccounting_sources?select=${SAFE_SOURCE_COLUMNS}&user_id=eq.${userId}&order=created_at.desc`);
      return { ok: true, sources, receiverUrl: serverConfig().receiverUrl };
    }
    const body = await readJson(request, 4096);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new ApiError(400, "INVALID_DEVICE", "设备名称需为 1–60 个字符。");
    const token = newToken();
    const result = await database("rpc/autoaccounting_create_source", { method: "POST", body: JSON.stringify({ p_user_id: userId, p_label: label, p_token_hash: await sha256(token) }) });
    rpcError(result);
    return { ok: true, source: result.source, token, receiverUrl: serverConfig().receiverUrl };
  }

  const action = /^\/devices\/([0-9a-f-]{36})\/(rotate|revoke)$/i.exec(path);
  if (action && method === "POST") {
    if (!uuidPattern.test(action[1])) throw new ApiError(400, "INVALID_DEVICE", "设备编号无效。");
    const userId = await authenticatedUser(request);
    const token = action[2] === "rotate" ? newToken() : null;
    const changes = token ? { token_hash: await sha256(token) } : { revoked_at: new Date().toISOString() };
    const sources = await database(`autoaccounting_sources?id=eq.${action[1]}&user_id=eq.${userId}&revoked_at=is.null&select=${SAFE_SOURCE_COLUMNS}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(changes),
    });
    if (!Array.isArray(sources) || !sources.length) throw new ApiError(404, "DEVICE_NOT_FOUND", "设备不存在或已撤销。");
    return token ? { ok: true, source: sources[0], token, receiverUrl: serverConfig().receiverUrl } : { ok: true, source: sources[0] };
  }
  throw new ApiError(404, "NOT_FOUND", "接口不存在。");
}

export async function handler(request: Request) {
  const requestId = crypto.randomUUID();
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId, Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Expose-Headers": "x-request-id",
  });
  if (origin && allowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  const reply = (body: object, status = 200) => new Response(JSON.stringify({ ...body, requestId }), { status, headers });
  try {
    if (!allowedOrigin(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "此网页地址尚未获准连接接口。");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    return reply(await route(request));
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 429) headers.set("Retry-After", "60");
      return reply({ ok: false, code: error.code, message: error.message }, error.status);
    }
    if (error instanceof BillValidationError) return reply({ ok: false, code: error.code, message: error.message }, 400);
    // No body/header/error logging: upstream errors may contain private data.
    return reply({ ok: false, code: "INTERNAL_ERROR", message: "云端接口暂不可用，请稍后重试。" }, 500);
  }
}

Deno.serve(handler);
