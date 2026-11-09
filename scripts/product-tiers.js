/**
 * 商品表现分层标签 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：按最近 90 天的效果把购物广告 / PMax 里的每个商品分成几层：
 *   英雄（hero）    转化多、ROAS 达标         → 给足预算
 *   潜力（sleeper） ROAS 达标但展示太少       → 单独拉出来放量
 *   吸金（villain） 花钱多、ROAS 远低于目标   → 单独收紧或排除
 *   一般（normal）  其他有数据的商品
 *   数据不足（lowdata）点击太少，还看不出好坏
 *   僵尸（zombie）  几乎没有展示的商品         → 单独建系列给曝光，或优化标题图片
 * 可选按价格分档（price-1 ~ price-5），可选按毛利计算利润和 POAS。
 * 结果写成 Merchant Center「补充数据源」格式（id + custom_label），在 Merchant Center 里关联这张表，
 * 商品会自动带上标签，然后按标签拆分广告系列或商品组。
 *
 * 思路参考 ProfitMetrics Shopping Booster（付费工具）、Teodor Yordanov 的价格分层脚本、
 * 以及 Mike Rhodes 等人的「英雄/僵尸商品」做法，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-product-tiers-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发一封摘要邮件（留空 = 不发）
  EMAIL: '',

  // 只统计名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 统计最近多少天（建议 60–90 天，太短数据不稳定）
  DAYS: 90,
  // 目标 ROAS（例如 3 = 300%）。0 = 用账户整体 ROAS
  TARGET_ROAS: 0,

  // 分层门槛
  HERO_MIN_CONV: 3,       // 英雄：至少这么多次转化，且 ROAS ≥ 目标
  MIN_CLICKS: 30,         // 少于这么多点击 → 数据不足
  VILLAIN_ROAS_RATIO: 0.5, // 吸金：ROAS 低于目标的这个比例（且花费 ≥ 一次转化的平均成本）
  ZOMBIE_IMPRESSIONS: 50, // 统计期内展示少于这么多 → 僵尸

  // 标签写到哪个 custom_label（0–4）。请选一个 Feed 里没在用的。
  LABEL_INDEX: 0,
  // 价格分档写到哪个 custom_label（0–4），-1 = 不做价格分档
  PRICE_LABEL_INDEX: -1,
  // 标签值（Merchant Center 里显示的文字，建议保持英文）
  LABEL_NAMES: { hero: 'hero', sleeper: 'sleeper', villain: 'villain', normal: 'normal', lowdata: 'lowdata', zombie: 'zombie' },

  // 毛利率（0–1）。填了就会计算利润和 POAS，并用 POAS 代替 ROAS 判断英雄和吸金。0 = 不用
  DEFAULT_MARGIN: 0,
  // 按品牌 / 商品类型 / 商品 ID 设置不同毛利率，第一个匹配的生效。field 可选 'brand' 'type' 'id'
  MARGINS: [
    // { field: 'brand', contains: 'yourbrand', margin: 0.45 },
  ],

  // 商品 ID 的大小写：Google Ads 报告里的 ID 是小写的。
  // Merchant Center 里的 ID 有大写字母时填 'upper'，大小写混合时请看教程里的说明
  ID_CASE: 'as-is'
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var TIER_CN = { hero: '英雄', sleeper: '潜力', villain: '吸金', normal: '一般', lowdata: '数据不足', zombie: '僵尸' };
var TIER_ORDER = ['hero', 'sleeper', 'normal', 'lowdata', 'villain', 'zombie'];


function main() {
  var ss = openSpreadsheet('商品分层标签');
  log('信息', '开始', '版本 ' + VERSION + '，统计最近 ' + CONFIG.DAYS + ' 天');

  var products = safe('读取商品', fetchProducts) || {};
  var list = values(products);
  if (!list.length) { log('错误', '商品', '没有读取到商品，请确认账户在投放购物广告或 PMax'); writeLog(ss); return; }
  log('信息', '商品', list.length + ' 个商品');

  var ref = reference(list);
  log('信息', '目标', '目标 ROAS ' + r2(ref.roas) + (CONFIG.TARGET_ROAS ? '（设置值）' : '（账户整体）') + '，平均每次转化费用 ' + r2(ref.cpa) + (ref.useProfit ? '，按毛利计算 POAS' : ''));
  list.forEach(function (p) { classify(p, ref); });
  if (CONFIG.PRICE_LABEL_INDEX >= 0) priceTiers(list);

  var sum = summarize(list);
  safe('补充 Feed', function () { writeFeed(ss, list); });
  safe('商品分层', function () { writeProducts(ss, list, ref); });
  safe('分层汇总', function () { writeSummary(ss, sum, ref); });
  safe('每日记录', function () { history(ss, sum); });
  var A = buildActions(sum, ref);
  safe('行动清单', function () { writeActions(ss, A, '商品分布正常'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    var rows = [['分层', '商品数', '费用占比', '转化价值占比', 'ROAS']].concat(TIER_ORDER.map(function (t) {
      var x = sum[t]; return [TIER_CN[t], x.n, pct(div(x.cost, sum.all.cost)), pct(div(x.value, sum.all.value)), r2(x.roas)];
    }));
    mail('[商品分层] ' + AdsApp.currentAccount().getName() + '：吸金商品花掉 ' + pct(div(sum.villain.cost, sum.all.cost)) + ' 的预算',
      '最近 ' + CONFIG.DAYS + ' 天，' + list.length + ' 个商品的分层结果如下。补充 Feed 已更新，Merchant Center 会在下次抓取时同步标签。', rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '商品表现分层标签', VERSION, [
      ['统计范围', '最近 ' + CONFIG.DAYS + ' 天的购物广告和 PMax 商品数据'],
      ['目标', '目标 ROAS ' + r2(ref.roas) + (ref.useProfit ? '；已设置毛利率，英雄/吸金按 POAS（利润 ÷ 广告费）判断' : '')],
      ['标签位置', '分层写入 custom_label_' + CONFIG.LABEL_INDEX + (CONFIG.PRICE_LABEL_INDEX >= 0 ? '，价格分档写入 custom_label_' + CONFIG.PRICE_LABEL_INDEX : '')],
      ['', ''],
      ['补充Feed', '这张表是给 Merchant Center 读取的，请保持在第一个位置，不要改表头。在 Merchant Center → 数据源 → 添加补充数据源 → Google 表格，选择这个表格'],
      ['行动清单', '吸金商品花了多少钱、潜力商品有多少，以及怎么按标签调整广告系列'],
      ['商品分层', '每个商品的效果、分层和原因'],
      ['分层汇总', '每一层的商品数、费用占比、价值占比和 ROAS'],
      ['每日记录', '每天的分层数量，用来观察调整后的变化'],
      ['分层规则', '英雄：转化 ≥ ' + CONFIG.HERO_MIN_CONV + ' 且达到目标；潜力：达到目标但展示低于中位数；吸金：点击 ≥ ' + CONFIG.MIN_CLICKS + ' 且效果低于目标的 ' + CONFIG.VILLAIN_ROAS_RATIO * 100 + '%；僵尸：展示 < ' + CONFIG.ZOMBIE_IMPRESSIONS + '；数据不足：点击 < ' + CONFIG.MIN_CLICKS]
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['补充Feed', '使用说明', '行动清单', '分层汇总', '商品分层', '每日记录', '运行日志']);
  // 补充 Feed 要在第一个位置，但打开表格时先显示使用说明
  var g1 = ss.getSheetByName('使用说明'); if (g1) ss.setActiveSheet(g1);
}


// ======================= 读取数据 =======================

function fetchProducts() {
  var map = {};
  // 1. 所有商品（包括没有展示的），用来找僵尸商品
  var all = tryQuery('全部商品', 'SELECT shopping_product.item_id, shopping_product.status, shopping_product.title, shopping_product.brand, ' +
    'shopping_product.price_micros, shopping_product.product_type_level1, shopping_product.availability FROM shopping_product');
  if (!all) all = tryQuery('全部商品', 'SELECT shopping_product.item_id, shopping_product.status FROM shopping_product') || [];
  all.forEach(function (r) {
    var p = r.shoppingProduct || {}, id = String(p.itemId || '').toLowerCase();
    if (!id) return;
    var x = map[id] || (map[id] = zero({ id: id, title: '', brand: '', type: '', price: '', status: '', avail: '' }));
    x.title = x.title || String(p.title || ''); x.brand = x.brand || String(p.brand || ''); x.type = x.type || String(p.productTypeLevel1 || '');
    if (p.priceMicros && x.price === '') x.price = num(p.priceMicros) / 1e6;
    if (p.status === 'ELIGIBLE' || !x.status) x.status = String(p.status || '');
    x.avail = x.avail || String(p.availability || '');
  });
  // 2. 效果数据
  var perf = runQuery('SELECT segments.product_item_id, segments.product_title, segments.product_brand, segments.product_type_l1, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM shopping_performance_view WHERE ' + range(CONFIG.DAYS) + nameFilter());
  perf.forEach(function (r) {
    var id = String(g(r, 'segments.productItemId')).toLowerCase();
    if (!id) return;
    var x = map[id] || (map[id] = zero({ id: id, title: '', brand: '', type: '', price: '', status: '', avail: '' }));
    x.title = x.title || String(g(r, 'segments.productTitle')); x.brand = x.brand || String(g(r, 'segments.productBrand'));
    x.type = x.type || String(g(r, 'segments.productTypeL1'));
    addMetrics(x, metricsOf(r));
  });
  return map;
}

function reference(list) {
  var t = zero({}); list.forEach(function (p) { addMetrics(t, p); });
  var useProfit = CONFIG.DEFAULT_MARGIN > 0 || CONFIG.MARGINS.length > 0;
  var imprs = list.filter(function (p) { return p.impr > 0; }).map(function (p) { return p.impr; }).sort(function (a, b) { return a - b; });
  return { roas: CONFIG.TARGET_ROAS || div(t.value, t.cost) || 0, cpa: div(t.cost, t.conv) || 0, useProfit: useProfit, total: t,
           medianImpr: imprs.length ? imprs[Math.floor(imprs.length / 2)] : 0 };
}


// ======================= 分层 =======================

function marginOf(p) {
  for (var i = 0; i < CONFIG.MARGINS.length; i++) {
    var m = CONFIG.MARGINS[i], v = String(p[m.field] || '').toLowerCase();
    if (m.contains && v.indexOf(String(m.contains).toLowerCase()) >= 0) return num(m.margin);
  }
  return num(CONFIG.DEFAULT_MARGIN);
}

function classify(p, ref) {
  derived(p);
  p.margin = ref.useProfit ? marginOf(p) : '';
  p.profit = ref.useProfit ? p.value * p.margin - p.cost : '';
  p.poas = ref.useProfit && p.cost ? (p.value * p.margin) / p.cost : '';
  // 用 POAS 时，「达标」= 利润为正（POAS ≥ 1）；否则 ROAS ≥ 目标
  var score = ref.useProfit ? p.poas : p.roas, target = ref.useProfit ? 1 : ref.roas;
  var good = score !== '' && target > 0 && score >= target;
  if (p.impr < CONFIG.ZOMBIE_IMPRESSIONS) { p.tier = 'zombie'; p.why = '展示只有 ' + p.impr + ' 次'; }
  else if (p.conv >= CONFIG.HERO_MIN_CONV && good) { p.tier = 'hero'; p.why = '转化 ' + r2(p.conv) + '，' + (ref.useProfit ? 'POAS ' + r2(p.poas) : 'ROAS ' + r2(p.roas)); }
  else if (p.conv >= 1 && good && p.impr < ref.medianImpr) { p.tier = 'sleeper'; p.why = '效果达标，但展示 ' + p.impr + ' 低于中位数 ' + ref.medianImpr; }
  else if (p.clicks >= CONFIG.MIN_CLICKS && target > 0 && (score === '' || score < target * CONFIG.VILLAIN_ROAS_RATIO) && p.cost >= (ref.cpa || 0)) {
    p.tier = 'villain'; p.why = '花费 ' + r2(p.cost) + '，' + (p.conv ? (ref.useProfit ? 'POAS ' + r2(p.poas) : 'ROAS ' + r2(p.roas)) : '没有转化');
  }
  else if (p.clicks < CONFIG.MIN_CLICKS && p.conv < 1) { p.tier = 'lowdata'; p.why = '点击 ' + p.clicks + '，数据还不够'; }
  else { p.tier = 'normal'; p.why = ''; }
  if (p.status === 'NOT_ELIGIBLE') p.why += (p.why ? '；' : '') + '当前不能投放';
  if (p.avail === 'OUT_OF_STOCK') p.why += (p.why ? '；' : '') + '缺货';
}

function priceTiers(list) {
  var priced = list.filter(function (p) { return p.price !== ''; }).sort(function (a, b) { return a.price - b.price; });
  var n = priced.length;
  priced.forEach(function (p, i) { p.priceTier = 'price-' + (Math.floor(i / Math.max(1, n) * 5) + 1); });
  list.forEach(function (p) { if (!p.priceTier) p.priceTier = ''; });
  if (n) log('信息', '价格分档', '按价格把 ' + n + ' 个商品平均分成 5 档（price-1 最便宜）');
}

function summarize(list) {
  var s = { all: zero({ n: 0 }) };
  TIER_ORDER.forEach(function (t) { s[t] = zero({ n: 0 }); });
  list.forEach(function (p) { s[p.tier].n++; addMetrics(s[p.tier], p); s.all.n++; addMetrics(s.all, p); });
  TIER_ORDER.concat(['all']).forEach(function (t) { derived(s[t]); });
  return s;
}


// ======================= 输出 =======================

function outId(id) { return CONFIG.ID_CASE === 'upper' ? id.toUpperCase() : id; }

function writeFeed(ss, list) {
  var head = ['id', 'custom_label_' + CONFIG.LABEL_INDEX];
  if (CONFIG.PRICE_LABEL_INDEX >= 0) head.push('custom_label_' + CONFIG.PRICE_LABEL_INDEX);
  var data = list.map(function (p) {
    var row = [outId(p.id), CONFIG.LABEL_NAMES[p.tier] || p.tier];
    if (CONFIG.PRICE_LABEL_INDEX >= 0) row.push(p.priceTier);
    return row;
  });
  var sh = ss.getSheetByName('补充Feed') || ss.insertSheet('补充Feed');
  sh.clear();
  sh.getRange(1, 1, data.length + 1, 1).setNumberFormat('@');
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (data.length) sh.getRange(2, 1, data.length, head.length).setValues(data);
}

function writeProducts(ss, list, ref) {
  var rank = {}; TIER_ORDER.forEach(function (t, i) { rank[t] = i; });
  list.sort(function (a, b) { return rank[a.tier] - rank[b.tier] || b.cost - a.cost; });
  var head = ['商品 ID', '标题', '品牌', '商品类型', '价格', '分层', '标签值', '原因'].concat(METRIC_HEAD)
    .concat(ref.useProfit ? ['毛利率', '利润', 'POAS'] : []).concat(CONFIG.PRICE_LABEL_INDEX >= 0 ? ['价格档'] : []).concat(['状态']);
  var data = list.map(function (p) {
    return [p.id, p.title, p.brand, p.type, p.price, TIER_CN[p.tier], CONFIG.LABEL_NAMES[p.tier], p.why].concat(metricCells(p))
      .concat(ref.useProfit ? [p.margin, p.profit, p.poas] : []).concat(CONFIG.PRICE_LABEL_INDEX >= 0 ? [p.priceTier] : []).concat([p.status]);
  });
  write(ss, '商品分层', head, data, ['@', '', '', '', FMT.money, '', '', ''].concat(METRIC_FMT).concat(ref.useProfit ? [FMT.pct, FMT.money, FMT.ratio] : []), {
    max: 40000, colors: { col: 5, fn: function (v) { return v === '英雄' ? '#e3f4e8' : v === '潜力' ? '#e6f0fb' : v === '吸金' ? '#fde2e1' : v === '僵尸' ? '#eef1f5' : null; } } });
}

function writeSummary(ss, s, ref) {
  var head = ['分层', '标签值', '商品数', '商品占比', '费用', '费用占比', '转化', '转化价值', '价值占比', 'ROAS', '每次转化费用', '建议'];
  var tip = {
    hero: '单独建广告系列或商品组，给足预算，目标 ROAS 可以设在账户目标附近',
    sleeper: '单独建广告系列，目标 ROAS 设低一些（或用「尽可能提高转化价值」不设目标）帮它们拿到更多展示',
    normal: '保持现状，定期复查',
    lowdata: '新品或冷门商品，先积累数据；可以和僵尸商品放在同一个系列',
    villain: '单独建广告系列并设较高的目标 ROAS，或者直接排除；同时检查价格竞争力和落地页',
    zombie: '检查标题、图片、价格是否有问题；单独建低目标或无目标的广告系列给曝光'
  };
  var data = TIER_ORDER.map(function (t) {
    var x = s[t];
    return [TIER_CN[t], CONFIG.LABEL_NAMES[t], x.n, div(x.n, s.all.n), x.cost, div(x.cost, s.all.cost), x.conv, x.value, div(x.value, s.all.value), x.roas, x.cpa, tip[t]];
  }).concat([['合计', '', s.all.n, 1, s.all.cost, 1, s.all.conv, s.all.value, 1, s.all.roas, s.all.cpa, '']]);
  write(ss, '分层汇总', head, data, ['', '', FMT.int, FMT.pct, FMT.money, FMT.pct, FMT.dec, FMT.money, FMT.pct, FMT.ratio, FMT.money, ''],
    { title: '目标 ' + (ref.useProfit ? 'POAS 1（盈亏平衡）' : 'ROAS ' + r2(ref.roas)) + '，最近 ' + CONFIG.DAYS + ' 天', widths: [80, 80, 70, 70, 90, 70, 70, 90, 70, 60, 90, 520], wrap: true });
}

var HIST_HEAD = ['日期'].concat(TIER_ORDER.map(function (t) { return TIER_CN[t]; })).concat(['吸金费用占比']);
function history(ss, s) {
  var sh = ensureSheet(ss, '每日记录', HIST_HEAD);
  upsertDay(sh, today(), [[today()].concat(TIER_ORDER.map(function (t) { return s[t].n; })).concat([div(s.villain.cost, s.all.cost)])], 400);
}

function buildActions(s, ref) {
  var A = [], all = s.all;
  var vc = div(s.villain.cost, all.cost);
  if (s.villain.n) A.push([vc >= 0.15 ? '高' : '中', '吸金商品', s.villain.n + ' 个商品', '花掉 ' + pct(vc) + ' 的预算，只带来 ' + pct(div(s.villain.value, all.value)) + ' 的转化价值',
    '费用 ' + r2(s.villain.cost) + '，ROAS ' + r2(s.villain.roas), '按标签「' + CONFIG.LABEL_NAMES.villain + '」单独建系列并提高目标 ROAS，或在现有系列里排除']);
  if (s.hero.n) A.push(['中', '英雄商品', s.hero.n + ' 个商品', '带来 ' + pct(div(s.hero.value, all.value)) + ' 的转化价值', 'ROAS ' + r2(s.hero.roas),
    '按标签「' + CONFIG.LABEL_NAMES.hero + '」单独建系列，保证预算充足，不要和吸金商品抢预算']);
  if (s.sleeper.n) A.push(['中', '潜力商品', s.sleeper.n + ' 个商品', '效果达标但展示太少', 'ROAS ' + r2(s.sleeper.roas) + '，展示 ' + s.sleeper.impr,
    '按标签「' + CONFIG.LABEL_NAMES.sleeper + '」单独建系列，降低目标 ROAS 帮它们放量']);
  if (s.zombie.n / Math.max(1, all.n) >= 0.2) A.push(['中', '僵尸商品', s.zombie.n + ' 个商品', '占全部商品的 ' + pct(s.zombie.n / all.n) + '，几乎没有展示', '',
    '先排查是否不能投放或缺货（见「商品分层」的状态列），再优化标题和图片，或单独建系列给曝光']);
  A.push(['低', '设置', 'Merchant Center', '把「补充Feed」表关联为补充数据源', 'custom_label_' + CONFIG.LABEL_INDEX,
    'Merchant Center → 设置 → 数据源 → 添加补充数据源 → Google 表格 → 选择这个表格，设置每天自动抓取。标签同步后，在广告系列里按 custom_label_' + CONFIG.LABEL_INDEX + ' 拆分商品组或列表组']);
  return A;
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
