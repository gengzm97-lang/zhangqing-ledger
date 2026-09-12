(function (root) {
  "use strict";

  const HEADERS = {
    date: ["交易时间", "交易创建时间", "创建时间", "交易日期", "付款时间", "支付时间"],
    amount: ["金额(元)", "金额", "交易金额(元)", "交易金额"],
    direction: ["收支", "收支类型", "收支方向"],
    merchant: ["交易对方", "商户名称", "对方名称"],
    product: ["商品", "商品说明", "商品名称"],
    type: ["交易类型", "交易分类", "类型"],
    status: ["当前状态", "交易状态", "状态"],
    transactionId: ["交易单号", "交易订单号", "交易号"],
    merchantOrderId: ["商户单号", "商家订单号"],
    note: ["备注"],
    refund: ["成功退款(元)", "成功退款", "退款金额(元)", "退款金额"],
    method: ["支付方式", "收付款方式"]
  };

  function clean(value) {
    const text = String(value == null ? "" : value).replace(/^\uFEFF/, "").trim();
    // Some exporters wrap identifiers this way to protect them from Excel rounding.
    return /^=".*"$/s.test(text) ? text.slice(2, -1).replace(/""/g, '"') : text;
  }

  function headerName(value) {
    return clean(value).replace(/[\s/]/g, "").replace(/（/g, "(").replace(/）/g, ")");
  }

  function csvRows(text) {
    if (typeof text !== "string") throw new Error("请提供 CSV 文本。");
    text = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false, afterQuote = false;
    function endField() { row.push(field); field = ""; afterQuote = false; }
    function endRow() { endField(); rows.push(row); row = []; }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; afterQuote = true; }
        } else field += ch;
      } else if (ch === ",") endField();
      else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        endRow();
      } else if (afterQuote) {
        if (!/[ \t]/.test(ch)) throw new Error("CSV 引号格式不正确，请使用平台原始导出的账单。");
      } else if (ch === '"' && !field.trim()) {
        field = "";
        quoted = true;
      } else field += ch;
    }
    if (quoted) throw new Error("CSV 引号没有闭合，请重新选择完整账单。");
    if (field || row.length || afterQuote) endRow();
    return rows;
  }

  function parseDate(value) {
    let text = clean(value);
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      text = `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()} ${value.getHours()}:${value.getMinutes()}:${value.getSeconds()}`;
    }
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (!match) return null;
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
    const year = Number(y), month = Number(m), day = Number(d);
    const hour = Number(hh), minute = Number(mm), second = Number(ss);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
    const pad = number => String(number).padStart(2, "0");
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  }

  function parseMoney(value) {
    let text = clean(value).replace(/^[¥￥]\s*/, "").replace(/\s*元$/, "");
    const negative = text.startsWith("-");
    text = text.replace(/^[+-]/, "");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents < 0) return null;
    return { cents, amount: cents / 100, negative };
  }

  const CATEGORY_RULES = [
    ["医疗", /医院|诊所|药房|药店|医疗|医药|挂号|体检|医保|口腔/],
    ["住房", /房租|租金|物业|水费|电费|燃气|天然气|供暖|暖气|宽带/],
    ["学习", /学费|培训|课程|教材|书店|图书|考试|报名费|教育|学习/],
    ["交通", /滴滴|高德打车|出租车|网约车|公交|地铁|铁路|火车|高铁|12306|停车|加油|充电站|高速|通行费|机票|航空|单车/],
    ["餐饮", /餐饮|餐厅|饭店|食堂|早餐|午餐|晚餐|外卖|饿了么|美团外卖|咖啡|奶茶|茶饮|瑞幸|星巴克|肯德基|麦当劳|蜜雪|面馆|火锅|烧烤|包子|饺子|小吃|烘焙|蛋糕|水果|零食|快餐|炸鸡/],
    ["娱乐", /电影|影院|游戏|电玩|KTV|音乐|演出|门票|景区|游乐|健身|运动|旅游|酒店|民宿|爱奇艺|优酷|腾讯视频/iu],
    ["人情往来", /礼金|份子|随礼|婚礼|喜酒|丧礼|孝敬|礼物/],
    ["购物", /超市|便利店|商场|百货|淘宝|天猫|京东|拼多多|唯品会|服饰|服装|鞋|电器|数码|家居|购物|杂货|日用/]
  ];

  function classify(text) {
    text = clean(text);
    return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0] || "其他";
  }

  function findHeader(rows) {
    for (let index = 0; index < rows.length; index++) {
      if (!Array.isArray(rows[index])) continue;
      const names = rows[index].map(headerName);
      const fields = {};
      Object.entries(HEADERS).forEach(([key, aliases]) => {
        fields[key] = aliases.map(alias => names.indexOf(headerName(alias))).find(value => value >= 0) ?? -1;
      });
      if (fields.date >= 0 && fields.amount >= 0 && fields.direction >= 0 && fields.merchant >= 0) {
        const prefix = rows.slice(0, index).map(row => Array.isArray(row) ? row.map(clean).join(" ") : "").join("\n");
        const wechat = names.includes("当前状态") || names.includes("交易单号") || /微信.*账单|微信支付/.test(prefix);
        const alipay = names.includes("交易订单号") || names.includes("交易创建时间") || names.includes("收付款方式") || /支付宝/.test(prefix);
        if (!wechat && !alipay) throw new Error("暂未识别出微信或支付宝账单，请选择平台原始导出文件。");
        return { index, fields, platform: wechat ? "微信" : "支付宝" };
      }
    }
    throw new Error("没有找到账单明细表头，请导入微信或支付宝导出的原始账单。");
  }

  const SUCCESS_STATUS = /^(支付成功|交易成功|付款成功|扣款成功|已支付|已完成|交易完成|成功|转账成功|已收钱|对方已收钱|已收款)$/;

  function hasRefund(row, refundValue) {
    const refund = parseMoney(refundValue);
    return /退款|退货|退回/.test(`${row.status} ${row.type} ${row.note}`) || Boolean(refund && refund.cents > 0);
  }

  function dispositionFor(row, money, refundValue) {
    const description = `${row.type} ${row.merchant} ${row.note}`;
    if (hasRefund(row, refundValue)) {
      return ["review", "涉及退款，需要与原消费核对后处理"];
    }
    if (/关闭|失败|取消|撤销|作废/.test(row.status)) return ["skip", "交易未成功，不计入支出"];
    if (/^(收入|收)$/.test(row.direction)) return ["skip", "收入记录，不计入个人支出"];
    if (/不计收支|不计入收支|不计|^\/$|^其他$/.test(row.direction)) return ["skip", "平台标为不计收支"];
    if (!/^(支出|支)$/.test(row.direction)) return ["review", "收支方向不明确，请核对"];
    if (/转账|转帐|红包|提现|还款|信用卡还|花呗还|借呗|借款|还贷|贷款|理财|基金|股票|证券|黄金|余额宝|零钱通|余额充值|零钱充值|充值到余额|余额转入|账户充值|账户转入|储蓄卡转入|银行卡转入|网商贷/.test(description)) {
      return ["review", "可能是转账、资金划转或还款，请确认是否为个人消费"];
    }
    if (/\b(?:gpt|chatgpt|openai|claude|api)\b|代充|接码|账号采购|帐号采购|成品号|业务成本|经营成本|进货|采购|货款|供货/i.test(description)) {
      return ["review", "可能是经营成本，避免与订单成本重复计算"];
    }
    if (money.negative) return ["review", "金额为负数，请核对是否为退款或冲正"];
    if (!SUCCESS_STATUS.test(row.status)) {
      return ["review", "交易状态尚不能确认为成功消费"];
    }
    const consumerType = /消费|商户|商家|扫二维码付款|二维码付款|付款码|公众号支付|小程序支付|餐饮|美食|日用|百货|服饰|装扮|数码|电器|家居|母婴|亲子|美容|美发|交通|出行|酒店|旅游|休闲|娱乐|运动|医疗|健康|教育|培训|生活服务|缴费|话费|通信|购物|网购|食品/;
    if (!consumerType.test(row.type) && row.category === "其他") return ["review", "消费用途不明确，请确认分类后入账"];
    return ["expense", "已识别为成功消费"];
  }

  function parseRows(input) {
    if (!Array.isArray(input)) throw new Error("账单内容格式不正确。");
    const { index, fields, platform } = findHeader(input);
    const rows = [], invalidRows = [];
    for (let i = index + 1; i < input.length; i++) {
      const raw = input[i];
      if (!Array.isArray(raw) || raw.every(value => !clean(value))) continue;
      const get = key => fields[key] < 0 ? "" : clean(raw[fields[key]]);
      // Exported files can append explanatory/footer lines after the records.
      if (!get("amount") && !get("direction") && !get("merchant")) continue;
      const date = parseDate(raw[fields.date]);
      const money = parseMoney(get("amount"));
      if (!date || !money || money.cents === 0) {
        invalidRows.push({ sourceRow: i + 1, canImport: false, reason: !date ? "交易日期无效" : "金额无效或不是正金额，未导入", raw: raw.map(clean) });
        continue;
      }
      const merchant = get("merchant"), product = get("product"), extraNote = get("note");
      const note = [product, extraNote].filter(value => value && value !== "/" && value !== "-" && value !== "无").join(" · ");
      const row = {
        date, amount: money.amount, cents: money.cents, payment: platform,
        category: classify(`${merchant} ${product}`), merchant, note,
        transactionId: get("transactionId"), merchantOrderId: get("merchantOrderId"),
        type: get("type"), status: get("status"), direction: get("direction"),
        paymentMethod: get("method"), sourceRow: i + 1
      };
      if (["", "/", "-", "--", "无", "不详", "0"].includes(row.transactionId)) row.transactionId = "";
      [row.disposition, row.reason] = dispositionFor(row, money, get("refund"));
      row.canImport = /^(支出|支)$/.test(row.direction) && SUCCESS_STATUS.test(row.status) && !money.negative && !hasRefund(row, get("refund"));
      const idValue = fields.transactionId < 0 ? "" : raw[fields.transactionId];
      if (row.disposition !== "skip" && ((typeof idValue === "number" && !Number.isSafeInteger(idValue)) || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(row.transactionId))) {
        row.disposition = "review";
        row.reason = "交易单号可能被表格软件舍入，建议使用原始账单重新导入";
        row.transactionId = "";
      }
      rows.push(row);
    }
    if (!rows.length && !invalidRows.length) throw new Error("账单中没有找到交易明细，请检查导出的日期范围。");
    return { platform, rows, invalidRows, headerRow: index + 1 };
  }

  const api = { parseCsv: text => parseRows(csvRows(text)), parseRows, classify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ZhangQingBillParser = api;
})(typeof window !== "undefined" ? window : null);
