// Independent adapter for AutoAccounting's documented JSON export; no upstream code.
export const CATEGORIES = Object.freeze(["餐饮", "交通", "购物", "住房", "娱乐", "医疗", "学习", "人情往来", "其他"]);
const KNOWN_TYPES = new Set(["Expend", "ExpendReimbursement", "ExpendLending", "ExpendRepayment", "Income", "IncomeLending", "IncomeRepayment", "IncomeReimbursement", "IncomeRefund", "Transfer"]);
const MAX_CENTS = 10000000000;
const suspicious = /转账|收款|退款|退货|借款|借出|借入|贷款|还款|提现|充值|余额宝|理财|投资|经营|进货|成本|代付|代充|gpt|chatgpt|劳务|工资|补助|报销|红包|备用金/i;
const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export class BillValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function upstreamId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new BillValidationError("INVALID_BILL_ID", "账单 id 必须是正整数；超出安全数字范围时请使用字符串。");
  }
  return id;
}

export function shanghaiDate(value) {
  if (!Number.isSafeInteger(value) || value < 946684800000 || value >= 4133980800000) return "";
  // China has no DST in this accepted 2000–2100 interval. Offset is deliberate,
  // independent of the function host timezone and the browser's timezone.
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

function parseCurrency(value) {
  if (value === "") return "CNY"; // Explicit upstream legacy default.
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "") return "CNY";
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.code === "string" && /^[A-Za-z]{3}$/.test(parsed.code) ? parsed.code.toUpperCase() : "";
  } catch { return ""; }
}

function categoryOf(value) {
  const valueText = clean(value, 100);
  if (/餐|饮|食品|早餐|午餐|晚餐|外卖|水果|零食/.test(valueText)) return "餐饮";
  if (/交通|出行|地铁|公交|打车|出租车|加油|停车|车票/.test(valueText)) return "交通";
  if (/购物|服饰|衣|鞋|日用|数码|电子/.test(valueText)) return "购物";
  if (/住房|房租|水电|物业|燃气|宽带/.test(valueText)) return "住房";
  if (/娱乐|电影|游戏|旅游/.test(valueText)) return "娱乐";
  if (/医疗|药|医院|看病|体检/.test(valueText)) return "医疗";
  if (/学习|教育|书籍|培训|课程|学费/.test(valueText)) return "学习";
  if (/人情|礼物|礼金|送礼/.test(valueText)) return "人情往来";
  return "其他";
}

export function normalizeBill(input, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BillValidationError("INVALID_BODY", "请求必须是单张账单 JSON 对象。");
  const id = upstreamId(input.id);
  const reasons = [];
  const type = clean(input.type, 40) || "Unknown";
  if (type !== "Expend") reasons.push(KNOWN_TYPES.has(type) ? "非普通消费支出，需确认归属" : "未知账单类型");
  const currency = parseCurrency(input.currency);
  if (currency !== "CNY") reasons.push(currency ? "非人民币账单，未自动换算" : "币种不明确");
  const scaled = typeof input.money === "number" ? input.money * 100 : NaN;
  const cents = Math.round(scaled);
  const amountValid = Number.isFinite(scaled) && Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS && Math.abs(scaled - cents) < 0.000001;
  if (!amountValid) reasons.push("金额无效或不是分精度");
  if (typeof input.fee !== "number" || !Number.isFinite(input.fee) || input.fee !== 0) reasons.push("含优惠/手续费或费用字段不明确");
  if (!Number.isSafeInteger(input.flag) || input.flag < 0 || input.flag > 2147483647) reasons.push("统计标志不明确");
  else if ((input.flag & 1) !== 0) reasons.push("来源账单设置为不计入统计");
  if (input.groupId !== -1) reasons.push("不是独立父账单");
  const app = clean(input.app, 100).toLowerCase();
  const payment = app === "com.tencent.mm" || app === "微信" || app === "wechat" || app === "weixin" ? "微信" : app === "com.eg.android.alipaygphone" || app === "支付宝" || app === "alipay" ? "支付宝" : "其他";
  if (payment === "其他") reasons.push("支付来源不是已识别的微信或支付宝");
  const date = shanghaiDate(input.time);
  if (!date) reasons.push("日期无效，不能自动记账");
  else if (input.time > now + 24 * 60 * 60 * 1000) reasons.push("日期晚于当前时间，需确认");
  const merchant = clean(input.shopName, 80);
  const item = clean(input.shopItem, 120);
  // Account names, raw OCR/notification content, rule text and screenshots are
  // never retained. Remark/tags are inspected only to prevent risky auto-posts.
  const riskText = [input.shopName, input.shopItem, input.cateName, input.remark, input.tags, input.bookName].filter(x => typeof x === "string").join(" ");
  if (suspicious.test(riskText)) reasons.push("可能涉及转账、退款或经营用途");
  if (!merchant && !item) reasons.push("缺少商户和商品信息");
  const bill = {
    date,
    amount: amountValid ? cents / 100 : null,
    currency,
    type,
    category: categoryOf(input.cateName),
    payment,
    note: item,
    merchant,
    eligible: reasons.length === 0,
    reviewReason: reasons.join("；"),
    originalCents: amountValid ? cents : null,
  };
  return { upstreamId: id, bill };
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
