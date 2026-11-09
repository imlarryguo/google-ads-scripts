/**
 * 询盘质量与离线转化检查 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：专门给外贸询盘（B2B）账户用。检查「Google 知道哪些询盘是真的」这件事有没有做好：
 *   1. 转化设置：自动标记是否开启、主要转化里是否混进了浏览页面/点击按钮这类「微转化」、
 *      询盘是否按「每次点击只算一次」计数、询盘有没有设置价值、增强型转化是否开启；
 *   2. 离线转化导入（把 CRM 里的有效询盘、成交订单回传给 Google）：最近有没有上传、成功率多少、有哪些报错；
 *   3. 询盘质量漏斗：每个广告系列的询盘 → 有效询盘 → 成交，找出「询盘很多但几乎都是垃圾」的系列；
 *   4. 疑似垃圾询盘：询盘数占点击数比例异常高的系列（机器人提交表单）。
 *
 * 毕瑞出海原创脚本。
 *
 * 教程：https://berightdigital.com/google-ads-offline-conversion-check-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 发现严重问题时发邮件（留空 = 不发）
  EMAIL: '',

  // 统计最近多少天
  DAYS: 90,
  // 名称包含这些词的转化操作算「询盘」（表单提交、邮件、WhatsApp 点击等），不区分大小写
  LEAD_WORDS: ['lead', 'form', 'inquiry', 'enquiry', 'quote', 'contact', 'rfq', '询盘', '表单', 'whatsapp', 'email'],
  // 名称包含这些词的转化操作算「有效询盘」
  QUALIFIED_WORDS: ['qualified', 'mql', 'sql', 'valid', '有效'],
  // 名称包含这些词的转化操作算「成交」
  CLOSED_WORDS: ['closed', 'won', 'deal', 'order', 'customer', '成交', '下单'],
  // 离线导入多少天没有上传就提醒
  UPLOAD_STALE_DAYS: 7,
  // 询盘数 ÷ 点击数超过这个比例，怀疑有机器人提交
  SPAM_RATE: 0.3
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var TYPE_CN = { WEBPAGE: '网站代码', WEBPAGE_CODELESS: '网站（无代码）', UPLOAD_CLICKS: '离线导入（GCLID）', UPLOAD_CALLS: '电话导入', GOOGLE_ANALYTICS_4_CUSTOM: 'GA4 自定义事件',
  GOOGLE_ANALYTICS_4_PURCHASE: 'GA4 购买', AD_CALL: '广告来电', WEBSITE_CALL: '网站来电', CLICK_TO_CALL: '点击致电', SALESFORCE: 'Salesforce', STORE_SALES: '门店销售',
  FIREBASE_ANDROID_FIRST_OPEN: 'App 首次打开', SMART_CAMPAIGN_TRACKED_CALLS: '智能系列来电', UNIVERSAL_ANALYTICS_GOAL: 'UA 目标（已停用）', UNIVERSAL_ANALYTICS_TRANSACTION: 'UA 交易（已停用）' };
var CAT_CN = { SUBMIT_LEAD_FORM: '提交潜在客户表单', QUALIFIED_LEAD: '合格潜在客户', CONVERTED_LEAD: '已转化的潜在客户', CONTACT: '联系', PURCHASE: '购买', PAGE_VIEW: '网页浏览',
  DEFAULT: '其他', IMPORTED_LEAD: '导入的潜在客户', PHONE_CALL_LEAD: '来电潜在客户', REQUEST_QUOTE: '索取报价', SIGNUP: '注册', ENGAGEMENT: '互动', OUTBOUND_CLICK: '出站点击',
  GET_DIRECTIONS: '获取路线', BOOK_APPOINTMENT: '预约', ADD_TO_CART: '加入购物车', BEGIN_CHECKOUT: '开始结账', SUBSCRIBE_PAID: '付费订阅', DOWNLOAD: '下载' };
var MICRO_CATS = { PAGE_VIEW: 1, ENGAGEMENT: 1, OUTBOUND_CLICK: 1, DOWNLOAD: 1, ADD_TO_CART: 1, BEGIN_CHECKOUT: 1, GET_DIRECTIONS: 1 };


function main() {
  var ss = openSpreadsheet('询盘与离线转化检查');
  log('信息', '开始', '版本 ' + VERSION);
  var A = [];

  var acct = safe('账户设置', accountSettings) || {};
  var actions = safe('转化操作', fetchActions) || [];
  safe('转化设置检查', function () { checkActions(ss, actions, acct, A); });
  safe('离线导入状态', function () { uploads(ss, actions, A); });
  safe('询盘质量', function () { funnel(ss, actions, A); });
  safe('行动清单', function () { writeActions(ss, A, '转化设置和离线导入都正常'); });

  var hi = A.filter(function (a) { return a[0] === '高'; });
  if (CONFIG.EMAIL && hi.length && stateGet(ss, 'mailed') !== today()) safe('邮件', function () {
    if (!isPreview()) stateSet(ss, 'mailed', today());
    mail('[询盘转化检查] ' + AdsApp.currentAccount().getName() + '：' + hi.length + ' 个严重问题', '转化跟踪或离线导入有需要马上处理的问题：',
      [['优先级', '类别', '对象', '发现', '建议']].concat(hi.map(function (a) { return [a[0], a[1], a[2], a[3], a[5]]; })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '询盘质量与离线转化检查', VERSION, [
      ['适用账户', '外贸询盘、B2B 获客账户；电商账户也可以用前两部分检查转化设置'],
      ['询盘识别', '转化类别为「提交潜在客户表单 / 联系 / 索取报价」，或名称包含：' + CONFIG.LEAD_WORDS.join('、')],
      ['有效询盘 / 成交', '类别为「合格潜在客户 / 已转化的潜在客户」，或名称包含：' + CONFIG.QUALIFIED_WORDS.join('、') + ' / ' + CONFIG.CLOSED_WORDS.join('、')],
      ['', ''],
      ['行动清单', '先看这里：会直接影响智能出价的设置问题和离线导入故障'],
      ['转化设置检查', '每个转化操作的类型、类别、是否主要转化、计数方式、价值、最近转化数和问题'],
      ['离线导入状态', '离线转化导入的上传次数、成功率、待处理数量和报错'],
      ['询盘质量', '每个广告系列的询盘、有效询盘、成交和转化率；找出垃圾询盘多的系列'],
      ['建议频率', '每天运行一次（离线导入出问题时能及时发现）']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '转化设置检查', '离线导入状态', '询盘质量', '运行日志']);
}


// ======================= 读取 =======================

function accountSettings() {
  var r = tryQuery('自动标记', 'SELECT customer.auto_tagging_enabled, customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled, ' +
    'customer.conversion_tracking_setting.accepted_customer_data_terms FROM customer') ||
    tryQuery('自动标记', 'SELECT customer.auto_tagging_enabled FROM customer') || [];
  var c = (r[0] || {}).customer || {}, ct = c.conversionTrackingSetting || {};
  return { autoTag: c.autoTaggingEnabled, ecl: ct.enhancedConversionsForLeadsEnabled, terms: ct.acceptedCustomerDataTerms };
}

function lower(s) { return String(s || '').toLowerCase(); }
function hasAny(s, words) { s = lower(s); return words.some(function (w) { return s.indexOf(lower(w)) >= 0; }); }

function fetchActions() {
  var full = 'SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.status, ' +
    'conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.counting_type, ' +
    'conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value, ' +
    'conversion_action.click_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model FROM conversion_action ' +
    'WHERE conversion_action.status = "ENABLED"';
  var rows = tryQuery('转化操作', full) || runQuery('SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.status, ' +
    'conversion_action.include_in_conversions_metric, conversion_action.counting_type FROM conversion_action WHERE conversion_action.status = "ENABLED"');
  var list = rows.map(function (r) {
    var c = r.conversionAction || {}, vs = c.valueSettings || {};
    var a = { id: String(c.id), name: String(c.name || ''), type: String(c.type || ''), cat: String(c.category || ''),
      primary: c.primaryForGoal === undefined ? c.includeInConversionsMetric : c.primaryForGoal, counting: String(c.countingType || ''),
      defValue: num(vs.defaultValue), alwaysDefault: !!vs.alwaysUseDefaultValue, window: num(c.clickThroughLookbackWindowDays),
      model: String((c.attributionModelSettings || {}).attributionModel || ''), recent: 0, base: 0, last: '', value: 0 };
    a.role = /QUALIFIED_LEAD/.test(a.cat) || hasAny(a.name, CONFIG.QUALIFIED_WORDS) ? 'qualified'
      : /CONVERTED_LEAD|PURCHASE/.test(a.cat) || hasAny(a.name, CONFIG.CLOSED_WORDS) ? 'closed'
      : /SUBMIT_LEAD_FORM|CONTACT|REQUEST_QUOTE|IMPORTED_LEAD|PHONE_CALL_LEAD/.test(a.cat) || hasAny(a.name, CONFIG.LEAD_WORDS) ? 'lead'
      : MICRO_CATS[a.cat] ? 'micro' : 'other';
    a.offline = /UPLOAD/.test(a.type) || a.type === 'SALESFORCE';
    return a;
  });
  // 最近的转化数（按转化操作）
  var byName = {}; list.forEach(function (a) { byName[a.name] = a; });
  (tryQuery('转化数', 'SELECT segments.conversion_action_name, segments.date, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE ' + range(CONFIG.DAYS)) || []).forEach(function (r) {
    var a = byName[String(g(r, 'segments.conversionActionName'))]; if (!a) return;
    var d = String(g(r, 'segments.date')), v = num(g(r, 'metrics.allConversions'));
    if (d >= dayStr(-14)) a.recent += v; else a.base += v;
    a.value += num(g(r, 'metrics.allConversionsValue'));
    if (v > 0 && d > a.last) a.last = d;
  });
  return list;
}


// ======================= 1. 转化设置 =======================

function checkActions(ss, actions, acct, A) {
  if (acct.autoTag === false) A.push(['高', '账户设置', '自动标记', '自动标记（Auto-tagging）没有开启', '', '离线转化导入依赖 GCLID，必须开启：管理员 → 账户设置 → 自动标记']);
  if (acct.ecl === false) A.push(['中', '账户设置', '增强型转化（潜在客户）', '没有开启「潜在客户的增强型转化」', '', '开启后可以用表单里的邮箱/电话（加密后）回传成交，不完全依赖 GCLID，匹配率更高']);
  var primaries = actions.filter(function (a) { return a.primary; });
  var leads = actions.filter(function (a) { return a.role === 'lead'; });
  actions.forEach(function (a) {
    a.issues = [];
    if (a.primary && a.role === 'micro') a.issues.push('微转化被设为主要转化：智能出价会去优化这种低价值行为');
    if (a.role === 'lead' && a.counting === 'MANY_PER_CLICK') a.issues.push('询盘按「每次」计数：同一个人提交多次会被算成多个询盘，建议改为「一次」');
    if (a.role === 'lead' && a.primary && !a.defValue) a.issues.push('询盘没有设置价值：用转化价值出价时无法区分询盘和成交的价值');
    if (/UNIVERSAL_ANALYTICS/.test(a.type)) a.issues.push('来自已停用的 Universal Analytics，不会再有数据');
    if (a.primary && a.base + a.recent === 0) a.issues.push('主要转化在最近 ' + CONFIG.DAYS + ' 天没有任何数据');
    if (a.primary && a.base / Math.max(1, CONFIG.DAYS - 14) * 14 >= 5 && a.recent === 0) a.issues.push('最近 14 天突然没有转化（之前平均每两周 ' + Math.round(a.base / (CONFIG.DAYS - 14) * 14) + ' 次）');
    if (a.window && a.window < 30 && (a.role === 'qualified' || a.role === 'closed')) a.issues.push('点击后转化窗口只有 ' + a.window + ' 天：B2B 成交周期长，建议设为 90 天');
  });
  if (primaries.filter(function (a) { return a.role === 'lead'; }).length > 1) A.push(['中', '转化设置', '主要转化', primaries.filter(function (a) { return a.role === 'lead'; }).length + ' 个询盘类转化同时是主要转化',
    primaries.filter(function (a) { return a.role === 'lead'; }).map(function (a) { return a.name; }).join('、'), '确认没有重复统计（例如同一个表单既有网站代码又有 GA4 导入）；重复的设为「次要」']);
  var micro = primaries.filter(function (a) { return a.role === 'micro'; });
  if (micro.length) A.push(['高', '转化设置', micro.map(function (a) { return a.name; }).join('、'), '浏览页面、点击按钮这类微转化被设为主要转化', '', '把它们改为「次要」转化，只让询盘、有效询盘、成交作为主要转化']);
  if (leads.length && !actions.some(function (a) { return a.offline; })) A.push(['中', '离线导入', '—', '还没有离线转化导入', '', '把 CRM 里的有效询盘和成交回传给 Google（离线转化导入或潜在客户的增强型转化），智能出价才能分辨好询盘和垃圾询盘']);
  actions.filter(function (a) { return a.issues.length && a.role !== 'micro'; }).forEach(function (a) {
    A.push([/突然|没有任何数据|Universal/.test(a.issues.join()) && a.primary ? '高' : '中', '转化操作', a.name, a.issues[0], '最近 14 天 ' + r2(a.recent) + '，之前 ' + r2(a.base), a.issues.slice(1).join('；') || '见「转化设置检查」表']);
  });
  var ROLE_CN = { lead: '询盘', qualified: '有效询盘', closed: '成交', micro: '微转化', other: '其他' };
  write(ss, '转化设置检查', ['转化操作', '识别为', '类型', '类别', '主要转化', '计数方式', '默认价值', '转化窗口（天）', '归因模型', '最近 14 天', '之前', '最后一次', '问题'],
    actions.map(function (a) {
      return [a.name, ROLE_CN[a.role], TYPE_CN[a.type] || a.type, CAT_CN[a.cat] || a.cat, a.primary ? '是' : '', a.counting === 'ONE_PER_CLICK' ? '一次' : a.counting === 'MANY_PER_CLICK' ? '每次' : a.counting,
        a.defValue || '', a.window || '', a.model.replace('GOOGLE_ADS_', '').replace('_', ' '), a.recent, a.base, a.last, a.issues.join('\n')];
    }), ['', '', '', '', '', '', FMT.money, FMT.int, '', FMT.dec, FMT.dec, '@', ''],
    { title: '自动标记：' + (acct.autoTag === false ? '未开启 ⚠' : acct.autoTag ? '已开启' : '未知') + '；潜在客户的增强型转化：' + (acct.ecl ? '已开启' : acct.ecl === false ? '未开启' : '未知'),
      widths: [220, 80, 120, 120, 70], colors: { col: 12, fn: function (v) { return v ? '#fff1d6' : null; } } });
}


// ======================= 2. 离线导入 =======================

function alertText(al) {
  return (al || []).map(function (x) {
    var e = x.error || {}, code = values(e).filter(function (v) { return typeof v === 'string'; })[0] || JSON.stringify(e).slice(0, 60);
    return code + (x.errorPercentage !== undefined ? '（' + Math.round(num(x.errorPercentage) * 100) + '%）' : '');
  }).join('；');
}

function uploads(ss, actions, A) {
  var rows = [];
  var client = tryQuery('导入汇总', 'SELECT offline_conversion_upload_client_summary.client, offline_conversion_upload_client_summary.status, offline_conversion_upload_client_summary.total_event_count, ' +
    'offline_conversion_upload_client_summary.successful_event_count, offline_conversion_upload_client_summary.success_rate, offline_conversion_upload_client_summary.pending_event_count, ' +
    'offline_conversion_upload_client_summary.last_upload_date_time, offline_conversion_upload_client_summary.alerts FROM offline_conversion_upload_client_summary') || [];
  client.forEach(function (r) {
    var s = r.offlineConversionUploadClientSummary || {};
    rows.push(['全部', String(s.client || ''), String(s.status || ''), num(s.totalEventCount), num(s.successfulEventCount), s.successRate === undefined ? '' : num(s.successRate),
      num(s.pendingEventCount), String(s.lastUploadDateTime || '').slice(0, 16), alertText(s.alerts)]);
    if (s.status === 'NEEDS_ATTENTION') A.push(['高', '离线导入', String(s.client || '导入'), '离线导入需要处理', '成功率 ' + pct(s.successRate) + '；' + alertText(s.alerts), '按报错类型修复（常见：GCLID 过期或无效、转化时间早于点击时间、时区格式错误、转化操作名称不对）']);
  });
  var per = tryQuery('按转化操作', 'SELECT offline_conversion_upload_conversion_action_summary.conversion_action_name, offline_conversion_upload_conversion_action_summary.client, ' +
    'offline_conversion_upload_conversion_action_summary.status, offline_conversion_upload_conversion_action_summary.total_event_count, offline_conversion_upload_conversion_action_summary.successful_event_count, ' +
    'offline_conversion_upload_conversion_action_summary.pending_event_count, offline_conversion_upload_conversion_action_summary.last_upload_date_time, offline_conversion_upload_conversion_action_summary.alerts ' +
    'FROM offline_conversion_upload_conversion_action_summary') || [];
  var seen = {};
  per.forEach(function (r) {
    var s = r.offlineConversionUploadConversionActionSummary || {}, name = String(s.conversionActionName || '');
    seen[name] = 1;
    var last = String(s.lastUploadDateTime || '').slice(0, 10);
    rows.push([name, String(s.client || ''), String(s.status || ''), num(s.totalEventCount), num(s.successfulEventCount), div(num(s.successfulEventCount), num(s.totalEventCount)),
      num(s.pendingEventCount), String(s.lastUploadDateTime || '').slice(0, 16), alertText(s.alerts)]);
    if (last && last < dayStr(-CONFIG.UPLOAD_STALE_DAYS)) A.push(['高', '离线导入', name, '已经 ' + CONFIG.UPLOAD_STALE_DAYS + ' 天以上没有上传', '最后一次 ' + last, '检查 CRM 导出、Zapier/Make 自动化或定时上传任务是否中断']);
    else if (s.status === 'NO_RECENT_UPLOADS') A.push(['中', '离线导入', name, '最近没有上传', '', '确认导入任务还在运行']);
  });
  // 有离线类型的转化操作，但诊断里没有记录
  actions.filter(function (a) { return a.offline && !seen[a.name]; }).forEach(function (a) {
    rows.push([a.name, '', '没有导入记录', '', '', '', '', a.last, '']);
    if (a.recent === 0) A.push(['中', '离线导入', a.name, '离线转化操作最近 14 天没有转化', '最后一次转化 ' + (a.last || '无'), '确认是否还在上传；不再使用的请移除，避免干扰']);
  });
  write(ss, '离线导入状态', ['转化操作', '上传方式', '状态', '上传总数', '成功', '成功率', '待处理', '最后上传', '报错'], rows,
    ['', '', '', FMT.int, FMT.int, FMT.pct, FMT.int, '@', ''], { empty: '没有离线转化导入记录（Google 只保留最近的导入诊断）',
      colors: { col: 2, fn: function (v) { return v === 'NEEDS_ATTENTION' ? '#fde2e1' : v === 'EXCELLENT' ? '#e3f4e8' : v ? '#fff1d6' : null; } } });
}


// ======================= 3. 询盘质量漏斗 =======================

function funnel(ss, actions, A) {
  var role = {}; actions.forEach(function (a) { role[a.name] = a.role; });
  var rows = tryQuery('按系列的转化', 'SELECT campaign.name, segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ' + range(CONFIG.DAYS)) || [];
  var clicks = {};
  (tryQuery('点击', 'SELECT campaign.name, metrics.clicks, metrics.cost_micros FROM campaign WHERE ' + range(CONFIG.DAYS) + ' AND metrics.clicks > 0') || []).forEach(function (r) {
    var c = clicks[g(r, 'campaign.name')] || (clicks[g(r, 'campaign.name')] = { clicks: 0, cost: 0 });
    c.clicks += num(g(r, 'metrics.clicks')); c.cost += money(g(r, 'metrics.costMicros'));
  });
  var map = {};
  rows.forEach(function (r) {
    var c = String(g(r, 'campaign.name')), rl = role[String(g(r, 'segments.conversionActionName'))];
    if (!rl || rl === 'micro' || rl === 'other') return;
    var x = map[c] || (map[c] = { lead: 0, qualified: 0, closed: 0, value: 0 });
    x[rl] += num(g(r, 'metrics.allConversions'));
    if (rl === 'closed') x.value += num(g(r, 'metrics.allConversionsValue'));
  });
  var hasQ = values(map).some(function (x) { return x.qualified > 0 || x.closed > 0; });
  var tot = { lead: 0, qualified: 0 }; values(map).forEach(function (x) { tot.lead += x.lead; tot.qualified += x.qualified; });
  var avgQ = div(tot.qualified, tot.lead);
  var data = Object.keys(map).map(function (c) {
    var x = map[c], k = clicks[c] || { clicks: 0, cost: 0 };
    var qr = div(x.qualified, x.lead), cr = div(x.closed, x.lead), spam = div(x.lead, k.clicks);
    var note = [];
    if (k.clicks >= 30 && spam !== '' && spam >= CONFIG.SPAM_RATE) note.push('询盘/点击 ' + pct(spam) + '，疑似机器人提交');
    if (hasQ && x.lead >= 10 && avgQ && qr !== '' && qr < avgQ * 0.5) note.push('有效询盘比例只有账户平均的 ' + pct(qr / avgQ));
    return [c, k.clicks, k.cost, x.lead, x.qualified, x.closed, x.value, div(k.cost, x.lead), div(k.cost, x.qualified), div(k.cost, x.closed), qr, cr, spam, note.join('；')];
  }).sort(function (a, b) { return b[2] - a[2]; });
  write(ss, '询盘质量', ['广告系列', '点击', '费用', '询盘', '有效询盘', '成交', '成交金额', '每个询盘成本', '每个有效询盘成本', '每单成交成本', '有效率', '成交率', '询盘/点击', '问题'],
    data, ['', FMT.int, FMT.money, FMT.dec, FMT.dec, FMT.dec, FMT.money, FMT.money, FMT.money, FMT.money, FMT.pct, FMT.pct, FMT.pct, ''],
    { title: hasQ ? '账户平均有效率 ' + pct(avgQ) : '还没有「有效询盘 / 成交」数据：需要先设置离线转化导入，才能看到询盘质量', empty: '没有询盘数据',
      colors: { col: 13, fn: function (v) { return v ? '#fde2e1' : null; } } });
  data.filter(function (r) { return r[13]; }).slice(0, 10).forEach(function (r) {
    A.push([/机器人/.test(r[13]) ? '高' : '中', '询盘质量', r[0], r[13], '询盘 ' + r2(r[3]) + '，有效 ' + r2(r[4]) + '，费用 ' + r2(r[2]),
      /机器人/.test(r[13]) ? '在表单加验证（reCAPTCHA、隐藏字段）；检查这个系列的展示位置和搜索字词；把「有效询盘」设为主要转化，让出价不再追求垃圾询盘' : '检查这个系列的搜索字词和地区；考虑用「有效询盘」作为出价目标']);
  });
  if (!hasQ && tot.lead > 0) A.push(['中', '询盘质量', '全部系列', '只统计了询盘数量，没有询盘质量数据', '最近 ' + CONFIG.DAYS + ' 天 ' + r2(tot.lead) + ' 个询盘',
    '在 CRM 里标记有效询盘和成交，通过离线转化导入回传 Google，并把出价目标从「询盘」逐步切换到「有效询盘」']);
}


// ======================= 通用工具函数（毕瑞出海脚本库共用） =======================

var RUN_LOG = [];
var STARTED = new Date();
var FMT = { money: '#,##0.00', int: '#,##0', pct: '0.0%', dec: '#,##0.00', ratio: '0.00' };
var HEAD_BG = '#173a52';

function openSpreadsheet(title) {
  if (CONFIG.SPREADSHEET_URL) return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  var ss = SpreadsheetApp.create(title + ' - ' + AdsApp.currentAccount().getName());
  log('提示', '表格', '已新建表格，请把这个网址填到 SPREADSHEET_URL：' + ss.getUrl());
  Logger.log('★ 新建的表格：' + ss.getUrl());
  return ss;
}

function runQuery(q) {
  var out = [], it = AdsApp.search(q);
  while (it.hasNext()) out.push(it.next());
  return out;
}

// 查询失败时返回 null，并把原因写进日志（不让一个查询拖垮整个脚本）
function tryQuery(step, q) {
  try { return runQuery(q); }
  catch (e) { log('提示', step, '查询失败：' + (e && e.message ? e.message : e)); return null; }
}

function safe(step, fn) {
  try { return fn(); }
  catch (e) { log('错误', step, (e && e.message) ? e.message : String(e)); return null; }
}

function log(level, step, msg) {
  RUN_LOG.push([new Date(), level, step, String(msg)]);
  Logger.log(level + ' | ' + step + ' | ' + msg);
}

function timeLeft() { return 28 * 60 * 1000 - (new Date() - STARTED); }
function isPreview() { try { return AdsApp.getExecutionInfo().isPreview(); } catch (e) { return false; } }

function tz() { return AdsApp.currentAccount().getTimeZone(); }
function today() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd'); }
function dayStr(offsetDays) { return Utilities.formatDate(new Date(Date.now() + offsetDays * 864e5), tz(), 'yyyy-MM-dd'); }
// 截至昨天的 N 天
function range(days) { return ' segments.date BETWEEN "' + dayStr(-Number(days)) + '" AND "' + dayStr(-1) + '" '; }
function between(from, to) { return ' segments.date BETWEEN "' + from + '" AND "' + to + '" '; }

function g(obj, path) {
  var parts = path.split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return ''; cur = cur[parts[i]]; }
  return cur === undefined || cur === null ? '' : cur;
}
function num(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function money(micros) { return num(micros) / 1e6; }
function div(a, b) { return b ? a / b : ''; }
function r2(x) { return x === '' || x === null || x === undefined ? '—' : Math.round(num(x) * 100) / 100; }
function pct(x) { return x === '' || x === null || x === undefined ? '—' : Math.round(num(x) * 1000) / 10 + '%'; }
function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
function clean(s) { return String(s || '').replace(/["\\]/g, ''); }

function nameFilter(field) {
  var inc = clean(CONFIG.CAMPAIGN_NAME_CONTAINS), exc = clean(CONFIG.CAMPAIGN_NAME_EXCLUDES);
  field = field || 'campaign.name';
  return (inc ? ' AND ' + field + ' LIKE "%' + inc.replace(/%/g, '') + '%"' : '') +
         (exc ? ' AND ' + field + ' NOT LIKE "%' + exc.replace(/%/g, '') + '%"' : '');
}

function metricsOf(r) {
  return { impr: num(g(r, 'metrics.impressions')), clicks: num(g(r, 'metrics.clicks')), cost: money(g(r, 'metrics.costMicros')),
           conv: num(g(r, 'metrics.conversions')), value: num(g(r, 'metrics.conversionsValue')) };
}
function zero(o) { o.impr = 0; o.clicks = 0; o.cost = 0; o.conv = 0; o.value = 0; return o; }
function addMetrics(t, m) { t.impr += m.impr; t.clicks += m.clicks; t.cost += m.cost; t.conv += m.conv; t.value += m.value; return t; }
function derived(m) {
  m.ctr = div(m.clicks, m.impr); m.cpc = div(m.cost, m.clicks); m.cpa = div(m.cost, m.conv);
  m.roas = div(m.value, m.cost); m.cvr = div(m.conv, m.clicks); return m;
}
var METRIC_HEAD = ['展示', '点击', '点击率', '费用', '平均点击费用', '转化', '转化价值', '每次转化费用', 'ROAS'];
var METRIC_FMT = [FMT.int, FMT.int, FMT.pct, FMT.money, FMT.money, FMT.dec, FMT.money, FMT.money, FMT.ratio];
function metricCells(m) { derived(m); return [m.impr, m.clicks, m.ctr, m.cost, m.cpc, m.conv, m.value, m.cpa, m.roas]; }

// 以 = + - @ 开头的文字会被表格当成公式，前面加 ' 保持为文字
function cleanRow(row) {
  return row.map(function (v) {
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
    if (typeof v === 'number' && !isFinite(v)) return '';
    return v === undefined || v === null ? '' : v;
  });
}

// 写一张表：清空后写表头和数据，先设格式再写值
function write(ss, name, header, data, formats, opt) {
  opt = opt || {};
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var r0 = 1;
  if (opt.title) { sh.getRange(1, 1).setValue(opt.title).setFontWeight('bold'); r0 = 2; }
  var max = opt.max || 20000;
  if (data.length > max) { log('提示', name, '共 ' + data.length + ' 行，只写入前 ' + max + ' 行'); data = data.slice(0, max); }
  var body = data.length ? data.map(cleanRow) : [header.map(function (_, i) { return i === 0 ? (opt.empty || '（没有数据）') : ''; })];
  if (formats && data.length) formats.forEach(function (f, i) { if (f) sh.getRange(r0 + 1, i + 1, data.length, 1).setNumberFormat(f); });
  sh.getRange(r0, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground(HEAD_BG).setFontColor('#ffffff');
  sh.getRange(r0 + 1, 1, body.length, header.length).setValues(body);
  sh.setFrozenRows(r0);
  if (opt.widths) opt.widths.forEach(function (w, i) { if (w) sh.setColumnWidth(i + 1, w); });
  if (opt.wrap && data.length) sh.getRange(r0 + 1, 1, data.length, header.length).setWrap(true).setVerticalAlignment('top');
  if (opt.colors && data.length) {
    var col = opt.colors.col;
    sh.getRange(r0 + 1, col + 1, data.length, 1).setBackgrounds(data.map(function (r) { return [opt.colors.fn(r[col], r)]; }));
  }
  return sh;
}

function levelColor(v) { return v === '高' ? '#fde2e1' : v === '中' ? '#fff1d6' : v === '低' ? '#eef1f5' : null; }

// 行动清单：[优先级, 类别, 对象, 发现, 数据, 建议]
function writeActions(ss, A, emptyText) {
  var rank = { '高': 0, '中': 1, '低': 2 };
  A.sort(function (a, b) { return (rank[a[0]] === undefined ? 3 : rank[a[0]]) - (rank[b[0]] === undefined ? 3 : rank[b[0]]); });
  if (!A.length) A.push(['—', '—', '—', emptyText || '没有发现需要处理的问题', '', '继续定期运行']);
  return write(ss, '行动清单', ['优先级', '类别', '对象', '发现', '数据', '建议'], A, null,
    { wrap: true, widths: [70, 90, 300, 240, 260, 440], colors: { col: 0, fn: levelColor } });
}

function ensureSheet(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground(HEAD_BG).setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 历史记录表：同一天重复运行时覆盖当天，再追加到末尾；keepDays 天以前的记录删除
function upsertDay(sh, date, rows, keepDays) {
  var last = sh.getLastRow();
  if (last > 1) {
    var v = sh.getRange(2, 1, last - 1, 1).getValues();
    var first = -1, count = 0;
    for (var i = v.length - 1; i >= 0; i--) { if (dateStr(v[i][0]) === date) { first = i; count++; } else if (count) break; }
    if (count) sh.deleteRows(first + 2, count);
  }
  if (rows.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows.map(cleanRow));
  }
  if (keepDays && sh.getLastRow() > 1) {
    var cutoff = Utilities.formatDate(new Date(Date.now() - keepDays * 864e5), tz(), 'yyyy-MM-dd');
    var d = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues(), n = 0;
    while (n < d.length && dateStr(d[n][0]) < cutoff) n++;
    if (n) sh.deleteRows(2, n);
  }
}

function dateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

// 隐藏的状态表：保存键值，用于去重提醒、断点续跑等
function stateGet(ss, key) {
  var sh = ss.getSheetByName('_状态'); if (!sh || sh.getLastRow() < 1) return '';
  var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (var i = 0; i < v.length; i++) if (v[i][0] === key) return String(v[i][1]);
  return '';
}
function stateSet(ss, key, val) {
  var sh = ss.getSheetByName('_状态') || ss.insertSheet('_状态');
  var n = sh.getLastRow(), v = n ? sh.getRange(1, 1, n, 1).getValues() : [];
  for (var i = 0; i < v.length; i++) if (v[i][0] === key) { sh.getRange(i + 1, 2).setNumberFormat('@').setValue(String(val)); sh.hideSheet(); return; }
  sh.getRange(n + 1, 1, 1, 2).setNumberFormat('@').setValues([[key, String(val)]]);
  sh.hideSheet();
}

function writeGuide(ss, title, version, rows) {
  var acct = AdsApp.currentAccount();
  var all = [[title + '（' + version + '）', ''],
             ['账户', acct.getName() + '（' + acct.getCustomerId() + '）'],
             ['运行时间', Utilities.formatDate(STARTED, tz(), 'yyyy-MM-dd HH:mm') + (isPreview() ? '（预览模式）' : '')],
             ['', '']].concat(rows).concat([['', ''], ['脚本库', 'https://berightdigital.com/google-ads-scripts/']]);
  var sh = ss.getSheetByName('使用说明') || ss.insertSheet('使用说明');
  sh.clear();
  sh.getRange(1, 1, all.length, 2).setValues(all.map(cleanRow));
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 720);
  sh.getRange(1, 2, all.length, 1).setWrap(true);
}

function writeLog(ss) {
  log('信息', '完成', '用时 ' + Math.round((new Date() - STARTED) / 1000) + ' 秒');
  var sh = ss.getSheetByName('运行日志') || ss.insertSheet('运行日志');
  sh.clear();
  var rows = [['时间', '级别', '步骤', '内容']].concat(RUN_LOG.map(cleanRow));
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setColumnWidth(4, 700);
}

function orderSheets(ss, order) {
  order.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  ss.getSheets().forEach(function (s) { if (/^_/.test(s.getName())) s.hideSheet(); });
  ['Sheet1', '工作表1', 'Sheet 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  var first = ss.getSheetByName(order[1] || order[0]);
  if (first) ss.setActiveSheet(first);
}

// 发 HTML 邮件：rows 为二维数组（第一行是表头）
function mail(subject, intro, rows, ss) {
  if (!CONFIG.EMAIL) return;
  var h = function (s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var table = rows && rows.length > 1 ? '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #ddd;font-size:13px">' +
    rows.map(function (r, i) {
      return '<tr style="' + (i === 0 ? 'background:' + HEAD_BG + ';color:#fff' : 'border-top:1px solid #ddd;vertical-align:top') + '">' +
        r.map(function (c, j) { var bg = i > 0 && j === 0 ? levelColor(c) : null; return (i === 0 ? '<th>' : '<td' + (bg ? ' style="background:' + bg + '"' : '') + '>') + h(typeof c === 'number' ? r2(c) : c) + (i === 0 ? '</th>' : '</td>'); }).join('') + '</tr>';
    }).join('') + '</table>' : '';
  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#222"><p>' + h(intro).replace(/\n/g, '<br>') + '</p>' + table +
             (ss ? '<p><a href="' + ss.getUrl() + '">打开完整报告</a></p>' : '') + '</div>';
  var plain = intro + '\n\n' + (rows || []).slice(1).map(function (r) { return r.join(' | '); }).join('\n') + (ss ? '\n\n完整报告：' + ss.getUrl() : '');
  MailApp.sendEmail({ to: CONFIG.EMAIL, subject: subject, body: plain, htmlBody: html });
  log('信息', '邮件', '已发送到 ' + CONFIG.EMAIL);
}
