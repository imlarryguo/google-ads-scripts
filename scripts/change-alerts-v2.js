/**
 * 账户变更提醒脚本 v2.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：定时检查 Google Ads 的「更改历史记录」，把不在信任名单里的人、
 *       Google 自动应用的建议、以及预算/出价/状态等高风险改动找出来，
 *       写进 Google 表格并发邮件提醒。改动前后的数值会翻译成看得懂的中文，
 *       例如「预算：100.00 → 300.00（+200%）」。
 *
 * 思路参考 Nils Rooijmans 的 Change History Alerts 脚本，代码为重新编写：
 *   - 不依赖外部表头表格，自动建好所有工作表；
 *   - 可以每小时运行，自动去重，同一条改动只提醒一次；
 *   - 按改动内容判断风险等级，不只是按改动人筛选；
 *   - 解析改动前后的值（预算、出价、目标 CPA/ROAS、状态、网址等）；
 *   - 按改动来源（网页版、编辑器、自动规则、自动应用的建议、脚本、API）分类；
 *   - 支持在经理账户（MCC）里运行，一次检查多个账户。
 *
 * 使用方法和每个工作表的解读：https://berightdigital.com/google-ads-change-history-alerts/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',

  // 接收提醒的邮箱，多个用英文逗号分隔。留空 = 只写表格，不发邮件。
  EMAIL: '',

  // 信任的用户：这些邮箱做的改动只记录，不单独提醒（高风险改动除外，见下方设置）
  TRUSTED_USERS: [
    // 'you@example.com',
  ],
  // 信任的邮箱域名：例如 '@youragency.com'，整个团队的改动都算信任
  TRUSTED_DOMAINS: [
    // '@youragency.com',
  ],

  // 完全忽略的改动来源（不记录也不提醒）。可选值见下方 CLIENT_CN 列表，例如：
  // 'GOOGLE_ADS_AUTOMATED_RULE'（自动规则）、'GOOGLE_ADS_SCRIPTS'（脚本）
  IGNORE_CLIENT_TYPES: [],

  // 提醒哪些改动（满足任意一条就提醒）
  ALERT_UNTRUSTED_USERS: true,   // 不在信任名单里的人做的改动
  ALERT_HIGH_RISK_ANY_USER: true, // 任何人做的高风险改动（包括信任的人）
  ALERT_AUTO_APPLIED: true,       // Google 自动应用的建议、Google 内部工具做的改动

  // 高风险判断标准
  BUDGET_CHANGE_PCT: 20,   // 预算变化超过 ±20% 算高风险
  TARGET_CHANGE_PCT: 15,   // 目标 CPA / 目标 ROAS 变化超过 ±15% 算高风险
  BID_CHANGE_PCT: 50,      // 关键字或广告组出价变化超过 ±50% 算中风险

  // 每次检查过去多少小时（更改记录有时会延迟出现，建议不低于 24）
  LOOKBACK_HOURS: 48,
  // 第一次运行时导入过去多少天的记录（接口最多只能查 30 天），这部分不发邮件
  FIRST_RUN_DAYS: 30,

  // 「变更记录」最多保留多少行，超过的删除最旧的记录
  MAX_LOG_ROWS: 50000,
  // 每封邮件最多列出多少条改动
  EMAIL_MAX_ROWS: 50,

  // 只在经理账户（MCC）里运行时有效：要检查的账户 ID（留空 = 下属全部账户，最多 50 个）
  MCC_ACCOUNT_IDS: [
    // '123-456-7890',
  ]
};
// ======================= 设置结束，下面的代码一般不需要改 =======================


var VERSION = 'v2.0';
var RUN_LOG = [];
var STARTED = new Date();
var TIME_BUDGET_MS = 25 * 60 * 1000; // 脚本最多运行 30 分钟，留 5 分钟余量

var LOG_HEADER = ['变更时间', '账户', '风险', '风险原因', '用户', '来源', '对象类型', '操作', '广告系列', '广告组',
                  '对象', '改动内容', '改动字段', '是否提醒', '记录时间', '唯一键'];
var COL = {}; LOG_HEADER.forEach(function (h, i) { COL[h] = i; });

var CLIENT_CN = {
  GOOGLE_ADS_WEB_CLIENT: '网页版后台',
  GOOGLE_ADS_EDITOR: 'Google Ads 编辑器',
  GOOGLE_ADS_MOBILE_APP: '手机 App',
  GOOGLE_ADS_AUTOMATED_RULE: '自动规则',
  GOOGLE_ADS_SCRIPTS: '脚本',
  GOOGLE_ADS_BULK_UPLOAD: '批量上传',
  GOOGLE_ADS_API: 'API（第三方工具）',
  GOOGLE_ADS_RECOMMENDATIONS: '建议页面（手动应用）',
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: '自动应用的建议',
  SEARCH_ADS_360_SYNC: 'SA360 同步',
  SEARCH_ADS_360_POST: 'SA360',
  INTERNAL_TOOL: 'Google 内部工具',
  OTHER: '其他',
  UNKNOWN: '未知', UNSPECIFIED: '未知'
};
var AUTO_CLIENTS = { GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: 1, INTERNAL_TOOL: 1 };

var TYPE_CN = {
  CAMPAIGN: '广告系列', CAMPAIGN_BUDGET: '预算', AD_GROUP: '广告组', AD_GROUP_AD: '广告', AD: '广告内容',
  AD_GROUP_CRITERION: '关键字/受众（广告组）', CAMPAIGN_CRITERION: '定位/否定（广告系列）',
  AD_GROUP_BID_MODIFIER: '出价调整', ASSET: '素材', CUSTOMER_ASSET: '账户素材', CAMPAIGN_ASSET: '广告系列素材',
  AD_GROUP_ASSET: '广告组素材', ASSET_SET: '素材组合', ASSET_SET_ASSET: '素材组合内容', CAMPAIGN_ASSET_SET: '广告系列素材组合',
  ASSET_GROUP: '素材资源组', ASSET_GROUP_ASSET: '素材资源组素材',
  FEED: 'Feed', FEED_ITEM: 'Feed 项', CAMPAIGN_FEED: '广告系列 Feed', AD_GROUP_FEED: '广告组 Feed'
};
var OP_CN = { CREATE: '新建', UPDATE: '修改', REMOVE: '移除', UNKNOWN: '未知', UNSPECIFIED: '未知' };
var STATUS_CN = { ENABLED: '已启用', PAUSED: '已暂停', REMOVED: '已移除' };

// 常见字段的中文名（按字段路径的最后一段或完整路径匹配）
var FIELD_CN = {
  'status': '状态', 'name': '名称', 'amountMicros': '预算', 'deliveryMethod': '投放方式',
  'biddingStrategyType': '出价策略', 'biddingStrategy': '组合出价策略',
  'targetCpa.targetCpaMicros': '目标每次转化费用', 'maximizeConversions.targetCpaMicros': '目标每次转化费用',
  'targetRoas.targetRoas': '目标广告支出回报率', 'maximizeConversionValue.targetRoas': '目标广告支出回报率',
  'manualCpc.enhancedCpcEnabled': '智能点击付费', 'targetImpressionShare.location': '目标展示位置',
  'targetImpressionShare.locationFractionMicros': '目标展示份额', 'targetImpressionShare.cpcBidCeilingMicros': '出价上限',
  'cpcBidMicros': '每次点击费用出价', 'cpmBidMicros': '每千次展示出价', 'cpvBidMicros': '每次观看出价',
  'targetCpaMicros': '目标每次转化费用', 'targetRoas': '目标广告支出回报率',
  'effectiveCpcBidMicros': '有效出价', 'bidModifier': '出价调整',
  'finalUrls': '最终到达网址', 'finalMobileUrls': '手机版最终到达网址', 'trackingUrlTemplate': '跟踪模板',
  'finalUrlSuffix': '最终网址后缀', 'urlCustomParameters': '自定义参数',
  'networkSettings.targetGoogleSearch': 'Google 搜索', 'networkSettings.targetSearchNetwork': '搜索网络合作伙伴',
  'networkSettings.targetContentNetwork': '展示广告网络', 'networkSettings.targetPartnerSearchNetwork': '合作伙伴网络',
  'startDate': '开始日期', 'endDate': '结束日期', 'startDateTime': '开始时间', 'endDateTime': '结束时间',
  'keyword.text': '关键字', 'keyword.matchType': '匹配方式', 'negative': '否定',
  'location.geoTargetConstant': '地理位置', 'language.languageConstant': '语言', 'proximity.radius': '半径',
  'geoTargetTypeSetting.positiveGeoTargetType': '地理位置选项', 'geoTargetTypeSetting.negativeGeoTargetType': '排除地理位置选项',
  'ad.responsiveSearchAd.headlines': '标题', 'ad.responsiveSearchAd.descriptions': '说明',
  'ad.responsiveSearchAd.path1': '路径 1', 'ad.responsiveSearchAd.path2': '路径 2',
  'ad.finalUrls': '最终到达网址', 'responsiveSearchAd.headlines': '标题', 'responsiveSearchAd.descriptions': '说明',
  'adSchedule.dayOfWeek': '投放日', 'device.type': '设备', 'shoppingSetting.merchantId': 'Merchant Center 账户',
  'shoppingSetting.feedLabel': 'Feed 标签', 'optimizationGoalSetting.optimizationGoalTypes': '优化目标',
  'urlExpansionOptOut': '网址扩展', 'assetAutomationSettings': '素材自动化设置',
  'textAsset.text': '文字', 'sitelinkAsset.linkText': '附加链接文字', 'calloutAsset.calloutText': '宣传信息',
  'type': '类型', 'fieldType': '素材用途'
};

// 不显示的技术字段
var SKIP_FIELDS = /^(resourceName|id|campaign|adGroup|baseCampaign|labels|servingStatus|primaryStatus|primaryStatusReasons|effective.*|criterionId|systemServingStatus|approvalStatus|policySummary.*)$/;


function main() {
  var ss = openSpreadsheet();
  var logSh = ensureSheet(ss, '变更记录', LOG_HEADER);
  var existing = readLog(logSh);
  var firstRun = existing.rows.length === 0 && !readState(ss).lastRun;
  log('信息', '开始', '版本 ' + VERSION + (firstRun ? '，第一次运行，导入过去 ' + CONFIG.FIRST_RUN_DAYS + ' 天的记录' : ''));

  var accounts = listAccounts();
  var fresh = [];
  accounts.forEach(function (acc) {
    if (new Date() - STARTED > TIME_BUDGET_MS) { log('提示', '时间', '接近 30 分钟上限，跳过账户 ' + acc.label); return; }
    var got = safe('读取 ' + acc.label, function () { return processAccount(acc, existing.keys, firstRun); }) || [];
    fresh = fresh.concat(got);
  });

  fresh.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
  var alerts = fresh.filter(function (c) { return c.alert; });
  log('信息', '结果', '新增改动 ' + fresh.length + ' 条，需要提醒 ' + alerts.length + ' 条（高风险 ' +
      alerts.filter(function (c) { return c.risk === '高'; }).length + ' 条）');

  safe('写入变更记录', function () { appendLog(logSh, fresh); });
  safe('提醒', function () { writeAlerts(ss, alerts, firstRun); });
  safe('汇总', function () { writeSummary(ss, logSh); });
  safe('使用说明', function () { writeGuide(ss, accounts); });
  writeState(ss);

  if (CONFIG.EMAIL && alerts.length && !firstRun) safe('邮件', function () { sendEmail(ss, alerts, accounts); });
  if (firstRun && alerts.length) log('提示', '邮件', '第一次运行导入的是历史记录，不发邮件。之后的新改动会正常提醒。');

  log('信息', '完成', '用时 ' + Math.round((new Date() - STARTED) / 1000) + ' 秒，表格：' + ss.getUrl());
  writeLog(ss);
  orderSheets(ss);
}


// ======================= 账户 =======================

// 在经理账户里运行时，逐个切换到下属账户；在普通账户里运行时，只检查当前账户
function listAccounts() {
  var isMcc = false;
  try { isMcc = typeof AdsManagerApp !== 'undefined' && !!AdsManagerApp.accounts; } catch (e) { isMcc = false; }
  if (isMcc) {
    try {
      var sel = AdsManagerApp.accounts();
      if (CONFIG.MCC_ACCOUNT_IDS.length) sel = sel.withIds(CONFIG.MCC_ACCOUNT_IDS);
      var it = sel.withLimit(50).get(), out = [];
      while (it.hasNext()) {
        var a = it.next();
        out.push({ obj: a, id: a.getCustomerId(), name: a.getName(), label: a.getName() + '（' + a.getCustomerId() + '）' });
      }
      if (out.length) { log('信息', '账户', '经理账户模式，检查 ' + out.length + ' 个账户'); return out; }
    } catch (e) {
      log('提示', '账户', '无法读取下属账户，只检查当前账户：' + e.message);
    }
  }
  var cur = AdsApp.currentAccount();
  return [{ obj: null, id: cur.getCustomerId(), name: cur.getName(), label: cur.getName() + '（' + cur.getCustomerId() + '）' }];
}

function processAccount(acc, seenKeys, firstRun) {
  if (acc.obj) AdsManagerApp.select(acc.obj);
  var tz = AdsApp.currentAccount().getTimeZone();
  // Google 只允许查询最近 30 天内的记录，留 1 小时余量
  var hours = Math.min(firstRun ? CONFIG.FIRST_RUN_DAYS * 24 : CONFIG.LOOKBACK_HOURS, 30 * 24 - 1);
  var rows = fetchChanges(tz, hours, acc.label);
  var out = [];
  rows.forEach(function (r) {
    var c = safe('解析改动', function () { return parseChange(r, acc, tz); });
    if (!c || c.ignored) return;
    if (seenKeys[c.key]) return;
    seenKeys[c.key] = 1;
    out.push(c);
  });
  safe('补充对象名称', function () { enrich(out); });
  out.forEach(function (c) { safe('判断风险', function () { finalize(c); }); });
  log('信息', acc.label, '读取 ' + rows.length + ' 条，新增 ' + out.length + ' 条');
  return out;
}


// ======================= 读取更改记录 =======================

// change_event 每次查询最多返回 10000 条，所以按天分段查询
function fetchChanges(tz, hours, label) {
  var fields = ['change_event.change_date_time', 'change_event.user_email', 'change_event.client_type',
    'change_event.change_resource_type', 'change_event.change_resource_name', 'change_event.resource_change_operation',
    'change_event.changed_fields', 'change_event.old_resource', 'change_event.new_resource',
    'campaign.name', 'ad_group.name'];
  var end = new Date(), all = [], DAY = 864e5;
  var start = new Date(end.getTime() - hours * 36e5);
  for (var from = start; from < end; from = new Date(from.getTime() + DAY)) {
    var to = new Date(Math.min(from.getTime() + DAY, end.getTime()));
    var q = 'SELECT ' + fields.join(', ') + ' FROM change_event' +
      ' WHERE change_event.change_date_time >= "' + fmt(from, tz) + '"' +
      ' AND change_event.change_date_time <= "' + fmt(to, tz) + '"' +
      ' ORDER BY change_event.change_date_time ASC LIMIT 10000';
    var part;
    try {
      part = runQuery(q);
    } catch (e) {
      // 部分账户不能同时选择 campaign / ad_group 名称，去掉后重试
      log('提示', label, '查询失败，去掉广告系列/广告组名称后重试：' + e.message);
      part = runQuery(q.replace(', campaign.name, ad_group.name', ''));
    }
    if (part.length >= 10000) log('提示', label, fmt(from, tz) + ' 起的一天内超过 10000 条改动，超出部分没有读取');
    all = all.concat(part);
  }
  return all;
}

function fmt(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss'); }


// ======================= 解析一条改动 =======================

function parseChange(r, acc, tz) {
  var ce = r.changeEvent || {};
  var client = String(ce.clientType || 'UNKNOWN');
  var type = String(ce.changeResourceType || 'UNKNOWN');
  var op = String(ce.resourceChangeOperation || 'UNKNOWN');
  var user = String(ce.userEmail || '');
  var time = String(ce.changeDateTime || '').slice(0, 19);
  var c = {
    time: time, account: acc.label, user: user, client: client, type: type, op: op,
    campaign: g(r, 'campaign.name'), group: g(r, 'adGroup.name'),
    key: acc.id + '|' + ce.changeResourceName + '|' + ce.changeDateTime + '|' + op,
    ignored: CONFIG.IGNORE_CLIENT_TYPES.indexOf(client) >= 0
  };
  if (c.ignored) return c;

  // 注意：old_resource / new_resource 里只有被修改的字段，名称等信息要另外查询（见 enrich）
  c.oldR = unwrap(ce.oldResource); c.newR = unwrap(ce.newResource);
  c.resName = String(ce.changeResourceName || '');
  c.paths = changedPaths(ce.changedFields);
  return c;
}

// 新建对象时，关键字文字、地理位置等已经显示在「对象」里，说明里不再重复
function createDiffs(diffs) {
  return diffs.filter(function (d) { return !/^(keyword\.|location\.|language\.|negative$|type$)/.test(d.path); });
}

// 第二步：补充名称后，生成改动说明并判断风险
function finalize(c) {
  var oldR = c.oldR, newR = c.newR, paths = c.paths, op = c.op, type = c.type;

  var diffs = [];
  paths.forEach(function (p) {
    var last = p.split('.').pop();
    if (SKIP_FIELDS.test(p) || SKIP_FIELDS.test(last)) return;
    var ov = getPath(oldR, p), nv = getPath(newR, p);
    diffs.push({ path: p, name: fieldName(p), oldV: ov, newV: nv, text: fieldName(p) + '：' + show(p, ov) + ' → ' + show(p, nv) + pctText(p, ov, nv) });
  });
  c.diffs = diffs;
  c.fields = paths.join(', ');
  c.object = objectLabel(c);
  c.detail = op === 'CREATE' ? '新建' + (c.object ? '：' + c.object : '') + (createDiffs(diffs).length ? '（' + createDiffs(diffs).slice(0, 4).map(function (d) { return d.name + ' ' + show(d.path, d.newV); }).join('，') + '）' : '')
           : op === 'REMOVE' ? '移除' + (c.object ? '：' + c.object : '')
           : diffs.map(function (d) { return d.text; }).join('；') || '（Google 没有返回具体字段）';

  var rk = assessRisk(c);
  c.risk = rk.level; c.reason = rk.reasons.join('；');
  c.trusted = isTrusted(c.user);
  c.auto = !!AUTO_CLIENTS[c.client];
  c.alert = (CONFIG.ALERT_UNTRUSTED_USERS && !c.trusted && !c.auto) ||
            (CONFIG.ALERT_HIGH_RISK_ANY_USER && c.risk === '高') ||
            (CONFIG.ALERT_AUTO_APPLIED && c.auto);
  if (!c.trusted && !c.auto && c.risk === '低') { c.risk = '中'; c.reason = (c.reason ? c.reason + '；' : '') + '不在信任名单里的用户'; }
  delete c.oldR; delete c.newR;
  return c;
}

// old_resource / new_resource 是 { campaign: {...} } 这样的结构，取出里面那一层
function unwrap(res) {
  if (!res || typeof res !== 'object') return {};
  var keys = Object.keys(res).filter(function (k) { return res[k] && typeof res[k] === 'object'; });
  return keys.length ? res[keys[0]] : res;
}

// changed_fields 可能是 "status,amount_micros" 这样的文字，也可能是 { paths: [...] }
function changedPaths(f) {
  var list = [];
  if (!f) return list;
  if (typeof f === 'string') list = f.split(',');
  else if (f.paths) list = f.paths;
  else if (Array.isArray(f)) list = f;
  return list.map(function (p) { return camel(String(p).trim()); }).filter(function (p) { return p; });
}
function camel(p) { return p.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); }); }

function getPath(o, p) {
  var parts = p.split('.'), cur = o;
  for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return undefined; cur = cur[parts[i]]; }
  return cur;
}

function fieldName(p) {
  if (FIELD_CN[p]) return FIELD_CN[p];
  var parts = p.split('.');
  for (var i = 1; i < parts.length; i++) { var sub = parts.slice(i).join('.'); if (FIELD_CN[sub]) return FIELD_CN[sub]; }
  return p;
}

function isMicros(p) { return /Micros$/.test(p) && !/FractionMicros$/.test(p); }

function show(p, v) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (isMicros(p)) return (Number(v) / 1e6).toFixed(2);
  if (/FractionMicros$/.test(p)) return (Number(v) / 1e4).toFixed(1) + '%';
  if (/targetRoas$/.test(p)) return Math.round(Number(v) * 100) + '%';
  if (/bidModifier$/.test(p)) return (Number(v) === 0 ? '排除' : (Math.round((Number(v) - 1) * 100) >= 0 ? '+' : '') + Math.round((Number(v) - 1) * 100) + '%');
  if (/(^|\.)status$/.test(p) && STATUS_CN[v]) return STATUS_CN[v];
  if (/geoTargetConstant$/.test(p)) return geoName(v);
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (Array.isArray(v)) return trim(v.map(function (x) { return x && typeof x === 'object' ? (x.text || x.asset || JSON.stringify(x)) : String(x); }).join(' | '), 120);
  if (typeof v === 'object') return trim(JSON.stringify(v), 120);
  return trim(String(v), 120);
}
function trim(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function pctOf(ov, nv) {
  var a = Number(ov), b = Number(nv);
  if (!(a > 0) || isNaN(b)) return null;
  return (b - a) / a * 100;
}
function pctText(p, ov, nv) {
  if (!(isMicros(p) || /targetRoas$/.test(p))) return '';
  var x = pctOf(ov, nv);
  return x === null ? '' : '（' + (x >= 0 ? '+' : '') + Math.round(x) + '%）';
}

function objectLabel(c) {
  // 合并：查询到的当前信息 + 改动前 + 改动后
  var res = merge(merge(merge({}, c.lookup || {}), c.oldR || {}), c.newR || {});
  if (c.type === 'CAMPAIGN') return c.campaign || res.name || shortName(c.resName);
  if (c.type === 'AD_GROUP') return c.group || res.name || shortName(c.resName);
  if (res.keyword && res.keyword.text) return res.keyword.text + '（' + ({ EXACT: '完全', PHRASE: '词组', BROAD: '广泛' }[res.keyword.matchType] || res.keyword.matchType || '') + '）' + (res.negative ? ' [否定]' : '');
  if (res.location && res.location.geoTargetConstant) return '地理位置 ' + geoName(res.location.geoTargetConstant) + (res.negative ? ' [排除]' : '');
  if (res.language && res.language.languageConstant) return '语言 ' + String(res.language.languageConstant).split('/').pop();
  if (res.ad) return '广告 ' + (res.ad.id || shortName(c.resName).split('~').pop()) + (res.ad.type ? '（' + res.ad.type + '）' : '');
  if (res.name) return String(res.name);
  if (res.textAsset && res.textAsset.text) return trim(res.textAsset.text, 60);
  if (res.sitelinkAsset && res.sitelinkAsset.linkText) return '附加链接：' + res.sitelinkAsset.linkText;
  if (res.type) return String(res.type);
  return shortName(c.resName);
}
function shortName(rn) { return rn ? String(rn).split('/').slice(-2).join('/') : ''; }
function merge(a, b) {
  Object.keys(b || {}).forEach(function (k) {
    var v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    else if (v !== undefined && v !== null && v !== '') a[k] = v;
  });
  return a;
}

// ======================= 补充名称 =======================
// old/new_resource 里只有被修改的字段，例如改了关键字出价，里面就只有出价，没有关键字文字。
// 这里按资源名称批量查询关键字、定位、预算的名称，以及地理位置的中文/英文名。
var GEO_NAMES = {};
function enrich(list) {
  var groups = {
    AD_GROUP_CRITERION: { res: 'ad_group_criterion', key: 'adGroupCriterion',
      fields: 'ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative' },
    CAMPAIGN_CRITERION: { res: 'campaign_criterion', key: 'campaignCriterion',
      fields: 'campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant' },
    CAMPAIGN_BUDGET: { res: 'campaign_budget', key: 'campaignBudget', fields: 'campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros' }
  };
  Object.keys(groups).forEach(function (type) {
    var gdef = groups[type], byName = {};
    list.forEach(function (c) { if (c.type === type && c.resName) (byName[c.resName] = byName[c.resName] || []).push(c); });
    var names = Object.keys(byName);
    for (var i = 0; i < names.length; i += 300) {
      var chunk = names.slice(i, i + 300);
      try {
        runQuery('SELECT ' + gdef.fields + ' FROM ' + gdef.res + ' WHERE ' + gdef.res + '.resource_name IN ("' + chunk.join('","') + '")')
          .forEach(function (r) {
            var obj = r[gdef.key] || {};
            (byName[obj.resourceName] || []).forEach(function (c) { c.lookup = obj; });
          });
      } catch (e) { log('提示', '补充名称', gdef.res + ' 查询失败（不影响提醒，只是对象名称会显示为 ID）：' + e.message); }
    }
  });

  // 地理位置名称
  var geos = {};
  list.forEach(function (c) {
    [c.lookup, c.oldR, c.newR].forEach(function (o) { if (o && o.location && o.location.geoTargetConstant) geos[o.location.geoTargetConstant] = 1; });
  });
  var ids = Object.keys(geos).filter(function (k) { return !GEO_NAMES[k]; });
  if (ids.length) {
    try {
      runQuery('SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN ("' + ids.slice(0, 500).join('","') + '")')
        .forEach(function (r) { var gt = r.geoTargetConstant || {}; GEO_NAMES[gt.resourceName] = gt.canonicalName; });
    } catch (e) { log('提示', '补充名称', '地理位置名称查询失败：' + e.message); }
  }
}
function geoName(rn) { return GEO_NAMES[rn] || ('ID ' + String(rn).split('/').pop()); }


// ======================= 风险判断 =======================

function assessRisk(c) {
  var lv = 0, reasons = [];
  function hit(level, why) { lv = Math.max(lv, level); reasons.push(why); }

  if (AUTO_CLIENTS[c.client]) hit(2, CLIENT_CN[c.client] + '做的改动');

  if (c.type === 'CAMPAIGN') {
    if (c.op === 'REMOVE') hit(2, '移除了广告系列');
    if (c.op === 'CREATE') hit(1, '新建了广告系列');
  }
  if (c.type === 'AD_GROUP' && c.op === 'REMOVE') hit(1, '移除了广告组');
  if (c.type === 'CAMPAIGN_BUDGET' && c.op === 'CREATE') hit(1, '新建了预算');

  c.diffs.forEach(function (d) {
    var p = d.path;
    if (/(^|\.)status$/.test(p) && c.type === 'CAMPAIGN') hit(2, '广告系列状态：' + show(p, d.oldV) + ' → ' + show(p, d.newV));
    else if (/(^|\.)status$/.test(p) && c.type === 'AD_GROUP') hit(1, '广告组状态改变');
    if (p === 'amountMicros') {
      var x = pctOf(d.oldV, d.newV);
      if (x !== null && Math.abs(x) >= CONFIG.BUDGET_CHANGE_PCT) hit(2, '预算变化 ' + Math.round(x) + '%');
      else hit(1, '预算调整');
    }
    if (/biddingStrategyType$|^biddingStrategy$/.test(p)) hit(2, '更换了出价策略');
    if (/targetCpaMicros$|targetRoas$/.test(p)) {
      var y = pctOf(d.oldV, d.newV);
      if (y === null || Math.abs(y) >= CONFIG.TARGET_CHANGE_PCT) hit(2, fieldName(p) + (y === null ? '改变' : '变化 ' + Math.round(y) + '%'));
      else hit(1, fieldName(p) + '小幅调整');
    }
    if (/cpcBidMicros$|cpmBidMicros$/.test(p)) {
      var z = pctOf(d.oldV, d.newV);
      if (z !== null && Math.abs(z) >= CONFIG.BID_CHANGE_PCT) hit(1, '出价变化 ' + Math.round(z) + '%');
    }
    if (/^networkSettings\./.test(p)) hit(2, '投放网络改变：' + fieldName(p) + ' ' + show(p, d.oldV) + ' → ' + show(p, d.newV));
    if (/geoTargetTypeSetting/.test(p)) hit(2, '地理位置选项改变');
    if (c.op !== 'CREATE' && /finalUrls$|finalMobileUrls$|trackingUrlTemplate$|finalUrlSuffix$/.test(p)) hit(1, fieldName(p) + '改变');
    if (/^(endDate|endDateTime)$/.test(p)) hit(1, '结束日期改变');
    if (/shoppingSetting/.test(p)) hit(2, '购物设置改变');
    if (/urlExpansionOptOut$|assetAutomationSettings/.test(p)) hit(1, '自动化设置改变');
  });

  if (c.type === 'CAMPAIGN_CRITERION') {
    if (/地理位置|语言/.test(c.object)) hit(2, (c.op === 'REMOVE' ? '移除了' : c.op === 'CREATE' ? '添加了' : '修改了') + '定位：' + c.object);
    else if (/\[否定\]/.test(c.object) && c.op === 'REMOVE') hit(1, '移除了否定关键字');
  }
  if (c.type === 'AD_GROUP_CRITERION' && /\[否定\]/.test(c.object) && c.op === 'REMOVE') hit(1, '移除了否定关键字');
  if (c.type === 'AD_GROUP_AD' && c.op === 'CREATE' && AUTO_CLIENTS[c.client]) hit(2, 'Google 自动添加了广告');

  return { level: lv >= 2 ? '高' : lv === 1 ? '中' : '低', reasons: reasons };
}

function isTrusted(email) {
  var e = String(email || '').toLowerCase();
  if (!e) return false;
  if (CONFIG.TRUSTED_USERS.some(function (u) { return String(u).toLowerCase() === e; })) return true;
  return CONFIG.TRUSTED_DOMAINS.some(function (d) { d = String(d).toLowerCase(); return d && e.slice(-d.length) === d; });
}


// ======================= 写入表格 =======================

function readLog(sh) {
  var last = sh.getLastRow(), rows = [], keys = {};
  if (last > 1) {
    rows = sh.getRange(2, 1, last - 1, LOG_HEADER.length).getValues();
    rows.forEach(function (r) { keys[String(r[COL['唯一键']])] = 1; });
  }
  return { rows: rows, keys: keys };
}

function toRow(c, now) {
  return [c.time, c.account, c.risk, c.reason, c.user || '（无）', cn(CLIENT_CN, c.client), cn(TYPE_CN, c.type), cn(OP_CN, c.op),
          c.campaign, c.group, c.object, c.detail, c.fields, c.alert ? '是' : '', now, c.key];
}

function appendLog(sh, list) {
  if (!list.length) return;
  var now = Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd HH:mm');
  var rows = list.map(function (c) { return cleanRow(toRow(c, now)); });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(start, 15, rows.length, 2).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, LOG_HEADER.length).setValues(rows);
  sh.getRange(start, 3, rows.length, 1).setBackgrounds(rows.map(function (r) { return [riskColor(r[2])]; }));

  var over = sh.getLastRow() - 1 - CONFIG.MAX_LOG_ROWS;
  if (over > 0) { sh.deleteRows(2, over); log('信息', '变更记录', '超过 ' + CONFIG.MAX_LOG_ROWS + ' 行，删除了最旧的 ' + over + ' 行'); }
  sh.hideColumns(COL['唯一键'] + 1);
}

function writeAlerts(ss, alerts, firstRun) {
  var rank = { '高': 0, '中': 1, '低': 2 };
  var list = alerts.slice().sort(function (a, b) { return rank[a.risk] - rank[b.risk] || (a.time < b.time ? 1 : -1); });
  var header = ['风险', '变更时间', '账户', '用户', '来源', '对象类型', '操作', '广告系列', '广告组', '对象', '改动内容', '风险原因', '建议'];
  var data = list.map(function (c) {
    return [c.risk, c.time, c.account, c.user || '（无）', cn(CLIENT_CN, c.client), cn(TYPE_CN, c.type), cn(OP_CN, c.op),
            c.campaign, c.group, c.object, c.detail, c.reason, adviceFor(c)];
  });
  var sh = ss.getSheetByName('本次提醒') || ss.insertSheet('本次提醒');
  sh.clear();
  var title = firstRun ? '第一次运行：以下是过去 ' + CONFIG.FIRST_RUN_DAYS + ' 天里符合提醒条件的改动（只写表格，不发邮件）'
                       : '本次运行新发现的改动（' + Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd HH:mm') + '）';
  sh.getRange(1, 1).setValue(title).setFontWeight('bold');
  sh.getRange(2, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  if (data.length) {
    sh.getRange(3, 1, data.length, header.length).setValues(data.map(cleanRow));
    sh.getRange(3, 1, data.length, 1).setBackgrounds(data.map(function (r) { return [riskColor(r[0])]; }));
    sh.getRange(3, 1, data.length, header.length).setWrap(true).setVerticalAlignment('top');
  } else {
    sh.getRange(3, 1).setValue('没有需要提醒的新改动');
  }
  sh.setFrozenRows(2);
  sh.setColumnWidth(10, 220); sh.setColumnWidth(11, 360); sh.setColumnWidth(12, 240); sh.setColumnWidth(13, 300);
}

function adviceFor(c) {
  if (c.client === 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION')
    return '这是 Google 自动应用的建议。确认是否需要；不需要的话到「建议」→「自动应用」里关闭对应类型';
  if (c.client === 'INTERNAL_TOOL') return 'Google 系统做的改动（例如暂停长期无展示的对象），确认是否影响投放';
  if (/预算/.test(c.reason)) return '确认预算调整是计划内的，并留意之后几天的花费节奏';
  if (/出价策略|目标/.test(c.reason)) return '出价策略或目标改动后会重新进入学习期，1–2 周内避免再次大幅调整';
  if (/状态|移除了广告系列/.test(c.reason)) return '确认暂停/启用/移除是计划内的操作';
  if (/投放网络|地理位置|定位|购物设置/.test(c.reason)) return '定位和网络设置会直接影响流量来源，确认是计划内的改动';
  if (/网址|跟踪/.test(c.reason)) return '打开新网址确认页面能正常访问、跟踪参数正确';
  if (!c.trusted) return '确认这个用户是谁、是否应该有账户权限；不需要的话到「访问权限和安全」里移除';
  return '确认改动是计划内的';
}

function writeSummary(ss, logSh) {
  var v = readLog(logSh).rows;
  var tz = AdsApp.currentAccount().getTimeZone();
  var since = Utilities.formatDate(new Date(Date.now() - 30 * 864e5), tz, 'yyyy-MM-dd');
  v = v.filter(function (r) { return String(r[0]).slice(0, 10) >= since; });

  function group(idx) {
    var m = {};
    v.forEach(function (r) {
      var k = String(r[idx] || '（空）');
      var x = m[k] || (m[k] = { n: 0, hi: 0, alert: 0, last: '' });
      x.n++; if (r[COL['风险']] === '高') x.hi++; if (r[COL['是否提醒']] === '是') x.alert++;
      if (String(r[0]) > x.last) x.last = String(r[0]);
    });
    return Object.keys(m).map(function (k) { return [k, m[k].n, m[k].hi, m[k].alert, m[k].last]; })
                 .sort(function (a, b) { return b[1] - a[1]; });
  }

  var sh = ss.getSheetByName('汇总') || ss.insertSheet('汇总');
  sh.clear();
  sh.getRange(1, 1).setValue('过去 30 天的改动汇总（' + since + ' 起，共 ' + v.length + ' 条）').setFontWeight('bold').setFontSize(13);
  var row = 3;
  [['按用户', COL['用户']], ['按来源', COL['来源']], ['按对象类型', COL['对象类型']], ['按账户', COL['账户']]].forEach(function (s) {
    var data = group(s[1]);
    var head = [[s[0], '改动数', '高风险', '已提醒', '最近一次']];
    sh.getRange(row, 1, 1, 5).setValues(head).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
    if (data.length) sh.getRange(row + 1, 1, data.length, 5).setValues(data.map(cleanRow));
    row += data.length + 3;
  });

  // 每天的改动数
  var days = {};
  v.forEach(function (r) { var d = String(r[0]).slice(0, 10); var x = days[d] || (days[d] = [0, 0]); x[0]++; if (r[COL['风险']] === '高') x[1]++; });
  var dd = Object.keys(days).sort().map(function (d) { return [d, days[d][0], days[d][1]]; });
  sh.getRange(3, 8, 1, 3).setValues([['日期', '改动数', '高风险']]).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  if (dd.length) {
    sh.getRange(4, 8, dd.length, 1).setNumberFormat('@');
    sh.getRange(4, 8, dd.length, 3).setValues(dd);
    sh.getCharts().forEach(function (c) { sh.removeChart(c); });
    sh.insertChart(sh.newChart().asColumnChart().addRange(sh.getRange(3, 8, dd.length + 1, 3))
      .setOption('title', '每天的改动数').setPosition(3, 12, 0, 0).build());
  }
  sh.setColumnWidth(1, 260);
}

function writeGuide(ss, accounts) {
  var rows = [
    ['账户变更提醒（' + VERSION + '）', ''],
    ['检查的账户', accounts.map(function (a) { return a.label; }).join('、')],
    ['每次检查范围', '过去 ' + CONFIG.LOOKBACK_HOURS + ' 小时，已记录过的改动不会重复提醒'],
    ['信任的用户', CONFIG.TRUSTED_USERS.concat(CONFIG.TRUSTED_DOMAINS).join('、') || '（未设置：所有人的改动都会提醒）'],
    ['忽略的来源', CONFIG.IGNORE_CLIENT_TYPES.map(function (t) { return cn(CLIENT_CN, t); }).join('、') || '（无）'],
    ['', ''],
    ['工作表', '看什么'],
    ['本次提醒', '这一次运行新发现、符合提醒条件的改动，高风险排在前面'],
    ['变更记录', '所有改动的完整记录（包括信任用户的），可以筛选用户、来源、广告系列'],
    ['汇总', '过去 30 天按用户、来源、对象类型、账户统计的改动数，以及每天的改动数'],
    ['运行日志', '每一步是否成功，出错时看这里'],
    ['', ''],
    ['风险等级', '高：预算大幅变化、出价策略或目标变化、广告系列暂停/启用/移除、投放网络和地理位置改变、Google 自动应用的建议'],
    ['', '中：不在信任名单里的人做的改动、出价大幅变化、网址改变、移除否定关键字、新建广告系列等'],
    ['', '低：信任用户做的日常改动'],
    ['注意', '脚本通过接口只能读取最近 30 天的更改记录（所以要持续运行、在表格里积累历史）；部分改动（例如转化设置、受众列表、账户层级设置）不在更改记录接口里'],
    ['教程', 'https://berightdigital.com/google-ads-change-history-alerts/']
  ];
  var sh = ss.getSheetByName('使用说明') || ss.insertSheet('使用说明');
  sh.clear();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(7, 1, 1, 2).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 720);
}


// ======================= 邮件 =======================

function sendEmail(ss, alerts, accounts) {
  var rank = { '高': 0, '中': 1, '低': 2 };
  var list = alerts.slice().sort(function (a, b) { return rank[a.risk] - rank[b.risk] || (a.time < b.time ? 1 : -1); });
  var hi = list.filter(function (c) { return c.risk === '高'; }).length;
  var name = accounts.length === 1 ? accounts[0].name : accounts.length + ' 个账户';
  var subject = '[Google Ads 变更提醒] ' + name + '：' + list.length + ' 条改动' + (hi ? '（高风险 ' + hi + ' 条）' : '');

  var h = function (s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var shown = list.slice(0, CONFIG.EMAIL_MAX_ROWS);
  var html = '<div style="font-family:Arial,sans-serif;font-size:13px;color:#222">' +
    '<p>' + h(name) + ' 有 <b>' + list.length + '</b> 条需要留意的改动' + (hi ? '，其中 <b style="color:#c62828">' + hi + '</b> 条高风险' : '') + '。</p>' +
    '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #ddd">' +
    '<tr style="background:#173a52;color:#fff"><th>风险</th><th>时间</th>' + (accounts.length > 1 ? '<th>账户</th>' : '') +
    '<th>用户 / 来源</th><th>对象</th><th>改动内容</th><th>原因</th></tr>' +
    shown.map(function (c) {
      return '<tr style="border-top:1px solid #ddd;vertical-align:top"><td style="background:' + riskColor(c.risk) + '">' + c.risk + '</td>' +
        '<td>' + h(c.time) + '</td>' + (accounts.length > 1 ? '<td>' + h(c.account) + '</td>' : '') +
        '<td>' + h(c.user || '（无）') + '<br><span style="color:#666">' + h(cn(CLIENT_CN, c.client)) + '</span></td>' +
        '<td>' + h([c.campaign, c.group].filter(String).join(' / ')) + '<br><span style="color:#666">' + h(cn(TYPE_CN, c.type) + ' ' + cn(OP_CN, c.op) + ' ' + (c.object || '')) + '</span></td>' +
        '<td>' + h(c.detail) + '</td><td>' + h(c.reason) + '</td></tr>';
    }).join('') + '</table>' +
    (list.length > shown.length ? '<p>另外还有 ' + (list.length - shown.length) + ' 条，见表格。</p>' : '') +
    '<p><a href="' + ss.getUrl() + '">打开完整报告</a></p></div>';
  var plain = subject + '\n\n' + shown.map(function (c) {
    return '[' + c.risk + '] ' + c.time + ' ' + (c.user || cn(CLIENT_CN, c.client)) + '：' + [c.campaign, c.group, c.object].filter(String).join(' / ') + ' - ' + c.detail;
  }).join('\n') + '\n\n完整报告：' + ss.getUrl();
  MailApp.sendEmail({ to: CONFIG.EMAIL, subject: subject, body: plain, htmlBody: html });
  log('信息', '邮件', '已发送到 ' + CONFIG.EMAIL);
}


// ======================= 工具函数 =======================

function openSpreadsheet() {
  if (CONFIG.SPREADSHEET_URL) return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  var ss = SpreadsheetApp.create('账户变更提醒 - ' + AdsApp.currentAccount().getName());
  log('提示', '表格', '已新建表格，请把这个网址填到 SPREADSHEET_URL：' + ss.getUrl());
  Logger.log('★ 新建的表格：' + ss.getUrl());
  return ss;
}

function readState(ss) {
  var sh = ss.getSheetByName('_状态');
  if (!sh || sh.getLastRow() < 1) return {};
  return { lastRun: sh.getRange(1, 2).getValue() };
}
function writeState(ss) {
  var sh = ss.getSheetByName('_状态') || ss.insertSheet('_状态');
  sh.getRange(1, 1, 1, 2).setValues([['上次运行', Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd HH:mm:ss')]]);
  sh.hideSheet();
}

function runQuery(q) {
  var out = [], it = AdsApp.search(q);
  while (it.hasNext()) out.push(it.next());
  return out;
}

function safe(step, fn) {
  try { return fn(); }
  catch (e) { log('错误', step, (e && e.message) ? e.message : String(e)); return null; }
}

function log(level, step, msg) {
  RUN_LOG.push([new Date(), level, step, msg]);
  Logger.log(level + ' | ' + step + ' | ' + msg);
}

function writeLog(ss) {
  var sh = ss.getSheetByName('运行日志') || ss.insertSheet('运行日志');
  sh.clear();
  var rows = [['时间', '级别', '步骤', '内容']].concat(RUN_LOG.map(cleanRow));
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setColumnWidth(4, 700);
}

function ensureSheet(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function orderSheets(ss) {
  ['使用说明', '本次提醒', '汇总', '变更记录', '运行日志'].forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  var st = ss.getSheetByName('_状态'); if (st) st.hideSheet();
  ['Sheet1', '工作表1', 'Sheet 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  var first = ss.getSheetByName('本次提醒');
  if (first) ss.setActiveSheet(first);
}

function g(obj, path) {
  var parts = path.split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return ''; cur = cur[parts[i]]; }
  return cur === undefined || cur === null ? '' : String(cur);
}
function cn(map, v) { return v === '' || v === undefined ? '' : (map[v] !== undefined ? map[v] : String(v)); }
function riskColor(r) { return r === '高' ? '#fde2e1' : r === '中' ? '#fff1d6' : '#eef1f5'; }

// 以 = + - @ 开头的文字会被表格当成公式，前面加 ' 保持为文字
function cleanRow(row) {
  return row.map(function (v) {
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
    return v === undefined || v === null ? '' : v;
  });
}
