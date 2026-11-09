/**
 * Merchant Center 健康检查 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：每天检查购物广告和 PMax 里的商品状态：
 *   1. 多少商品可以投放、受限、不能投放，按国家/语言（Feed 标签）分开看；
 *   2. 每种问题影响了多少商品，哪些是新出现的问题；
 *   3. 有问题的商品里，哪些最近还在花钱或带来转化（优先修）；
 *   4. 按品牌、商品类型汇总问题，找出整批出错的原因；
 *   5. 每天记录问题数量，画趋势图，问题增加时发邮件。
 *
 * 不需要 Merchant Center API：直接读取 Google Ads 里的 shopping_product 数据，
 * 所以 2026 年 8 月 Content API for Shopping 停用后依然可用。
 * 思路参考 jack.tm 的 Merchant Center Health Check 和 PMax V4 看板，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-merchant-center-health-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 提醒邮箱（留空 = 不发）。多个用英文逗号分隔。
  EMAIL: '',
  // true = 每天都发；false = 只在不能投放的商品增加或出现新问题时发
  EMAIL_ALWAYS: false,

  // 效果数据统计天数（用来判断有问题的商品是否重要）
  DAYS: 30,
  // 不能投放的商品比昨天增加多少个（或多少比例）就提醒
  ALERT_INCREASE: 20,
  ALERT_INCREASE_PCT: 5,
  // 每日记录保留多少天
  KEEP_DAYS: 400,
  // 「问题商品」表最多写多少行
  MAX_ROWS: 10000
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var STATUS_CN = { ELIGIBLE: '可投放', ELIGIBLE_LIMITED: '受限', NOT_ELIGIBLE: '不能投放', UNKNOWN: '未知', UNSPECIFIED: '未知' };
var SEV_CN = { ERROR: '错误', WARNING: '警告', NOTIFICATION: '提示', UNKNOWN: '', UNSPECIFIED: '' };
var AVAIL_CN = { IN_STOCK: '有货', OUT_OF_STOCK: '缺货', PREORDER: '预购', BACKORDER: '延期交货' };


function main() {
  var ss = openSpreadsheet('Merchant Center 健康检查');
  log('信息', '开始', '版本 ' + VERSION);

  var products = safe('读取商品状态', fetchProducts);
  if (!products) { log('错误', '商品', '无法读取商品状态：请确认账户已关联 Merchant Center 并在投放购物广告或 PMax'); writeLog(ss); return; }
  log('信息', '商品', products.length + ' 个商品');
  safe('效果数据', function () { attachPerformance(products); });

  var s = summarize(products);
  var prev = safe('昨天的记录', function () { return previous(ss); }) || null;

  safe('概况', function () { writeOverview(ss, s, prev); });
  safe('问题汇总', function () { writeIssues(ss, s, prev); });
  safe('问题商品', function () { writeProducts(ss, products); });
  safe('按品牌和类型', function () { writeGroups(ss, products); });
  safe('每日记录', function () { writeHistory(ss, s); });
  var A = buildActions(s, prev, products);
  safe('行动清单', function () { writeActions(ss, A, '商品状态正常'); });

  var worse = prev && (s.notEligible - prev.notEligible >= CONFIG.ALERT_INCREASE ||
    (prev.notEligible && (s.notEligible - prev.notEligible) / Math.max(1, s.total) * 100 >= CONFIG.ALERT_INCREASE_PCT));
  var newIssues = prev ? s.issueList.filter(function (x) { return !prev.issues[x.key] && x.products >= 3; }) : [];
  if (CONFIG.EMAIL && (CONFIG.EMAIL_ALWAYS || worse || newIssues.length) && stateGet(ss, 'mailed') !== today()) safe('邮件', function () {
    if (!isPreview()) stateSet(ss, 'mailed', today());
    var rows = [['级别', '问题', '影响商品', '近期花费']].concat(s.issueList.slice(0, 20).map(function (x) {
      return [x.sev === 'ERROR' ? '高' : '中', x.text, x.products, x.cost];
    }));
    mail('[商品健康] ' + AdsApp.currentAccount().getName() + '：' + s.notEligible + ' 个商品不能投放' + (prev ? '（昨天 ' + prev.notEligible + '）' : ''),
      '共 ' + s.total + ' 个商品：可投放 ' + s.eligible + '，受限 ' + s.limited + '，不能投放 ' + s.notEligible + '。' +
      (newIssues.length ? '\n新出现的问题：' + newIssues.map(function (x) { return x.text; }).join('；') : ''), rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, 'Merchant Center 健康检查', VERSION, [
      ['数据来源', 'Google Ads 里的商品数据（shopping_product），和 Merchant Center 里的商品状态一致，另外包含 Google Ads 层面的问题'],
      ['效果数据', '最近 ' + CONFIG.DAYS + ' 天（截至昨天）'],
      ['', ''],
      ['行动清单', '先看这里：影响最多商品、或影响正在花钱的商品的问题'],
      ['概况', '商品总数、可投放、受限、不能投放，按 Feed 标签（通常对应国家/语言）分开'],
      ['问题汇总', '每种问题影响的商品数量、严重程度、对应的属性和说明链接；标出今天新出现的问题'],
      ['问题商品', '每个有问题的商品，按近期花费排序，越靠前越该先修'],
      ['按品牌和类型', '问题集中在哪些品牌或商品类型，通常是同一个 Feed 规则出错'],
      ['每日记录', '每天一行，画出不能投放的商品数量趋势'],
      ['注意', '只能看到关联到这个 Google Ads 账户、并且用于购物广告或 PMax 的商品；商品数据通常每天更新']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '概况', '问题汇总', '问题商品', '按品牌和类型', '每日记录', '运行日志']);
}


// ======================= 读取数据 =======================

function fetchProducts() {
  var full = 'SELECT shopping_product.resource_name, shopping_product.merchant_center_id, shopping_product.feed_label, shopping_product.language_code, ' +
    'shopping_product.item_id, shopping_product.status, shopping_product.issues, shopping_product.title, shopping_product.brand, ' +
    'shopping_product.availability, shopping_product.price_micros, shopping_product.currency_code, shopping_product.product_type_level1 ' +
    'FROM shopping_product';
  var rows = tryQuery('商品（完整字段）', full);
  if (!rows) {
    log('提示', '商品', '改用基本字段');
    rows = runQuery('SELECT shopping_product.resource_name, shopping_product.merchant_center_id, shopping_product.feed_label, shopping_product.language_code, ' +
      'shopping_product.item_id, shopping_product.status, shopping_product.issues FROM shopping_product');
  }
  return rows.map(function (r) {
    var p = r.shoppingProduct || {};
    return zero({ id: String(p.itemId || ''), mc: String(p.merchantCenterId || ''), feed: String(p.feedLabel || ''), lang: String(p.languageCode || ''),
      status: String(p.status || 'UNKNOWN'), issues: (p.issues || []).map(function (i) {
        return { code: String(i.errorCode || ''), sev: String(i.adsSeverity || ''), attr: String(i.attributeName || ''),
                 text: String(i.description || i.errorCode || '未知问题'), detail: String(i.detail || ''), doc: String(i.documentation || ''),
                 regions: (i.affectedRegions || []).join(',') };
      }),
      title: String(p.title || ''), brand: String(p.brand || ''), avail: String(p.availability || ''),
      price: p.priceMicros ? num(p.priceMicros) / 1e6 : '', currency: String(p.currencyCode || ''), type: String(p.productTypeLevel1 || '') });
  });
}

function attachPerformance(products) {
  var rows = tryQuery('商品效果', 'SELECT segments.product_item_id, segments.product_feed_label, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM shopping_performance_view WHERE ' + range(CONFIG.DAYS));
  if (!rows) return;
  var map = {};
  rows.forEach(function (r) {
    var k = String(g(r, 'segments.productItemId')).toLowerCase() + '|' + String(g(r, 'segments.productFeedLabel')).toLowerCase();
    addMetrics(map[k] || (map[k] = zero({})), metricsOf(r));
  });
  products.forEach(function (p) {
    var m = map[p.id.toLowerCase() + '|' + p.feed.toLowerCase()];
    if (m) addMetrics(p, m);
  });
}


// ======================= 汇总 =======================

function summarize(products) {
  var s = { total: products.length, eligible: 0, limited: 0, notEligible: 0, outOfStock: 0, feeds: {}, issues: {}, issueList: [] };
  products.forEach(function (p) {
    if (p.status === 'ELIGIBLE') s.eligible++; else if (p.status === 'ELIGIBLE_LIMITED') s.limited++; else if (p.status === 'NOT_ELIGIBLE') s.notEligible++;
    if (p.avail === 'OUT_OF_STOCK') s.outOfStock++;
    var fk = (p.feed || '（无）') + ' / ' + (p.lang || '');
    var f = s.feeds[fk] || (s.feeds[fk] = zero({ name: fk, total: 0, eligible: 0, limited: 0, notEligible: 0 }));
    f.total++; if (p.status === 'ELIGIBLE') f.eligible++; else if (p.status === 'ELIGIBLE_LIMITED') f.limited++; else if (p.status === 'NOT_ELIGIBLE') f.notEligible++;
    addMetrics(f, p);
    var seen = {};
    p.issues.forEach(function (i) {
      var key = i.code + '|' + i.attr;
      if (seen[key]) return; seen[key] = 1;
      var x = s.issues[key] || (s.issues[key] = zero({ key: key, code: i.code, text: i.text, sev: i.sev, attr: i.attr, doc: i.doc, products: 0, regions: {} }));
      x.products++; addMetrics(x, p);
      if (i.sev === 'ERROR' && x.sev !== 'ERROR') x.sev = 'ERROR';
      i.regions.split(',').forEach(function (rg) { if (rg) x.regions[rg] = 1; });
    });
  });
  s.issueList = values(s.issues).sort(function (a, b) { return (b.sev === 'ERROR') - (a.sev === 'ERROR') || b.products - a.products; });
  return s;
}

// 昨天（或之前最近一天）的记录
function previous(ss) {
  var sh = ss.getSheetByName('_问题快照');
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
  var date = String(v[0][1]);
  if (date >= today()) {
    // 同一天重复运行：用保存的上一期
    var p = ss.getSheetByName('_问题快照_上一期');
    if (!p || p.getLastRow() < 2) return null;
    v = p.getRange(1, 1, p.getLastRow(), 3).getValues(); date = String(v[0][1]);
  }
  var out = { date: date, notEligible: num(v[0][2]), issues: {} };
  v.slice(1).forEach(function (r) { out.issues[String(r[0])] = num(r[1]); });
  return out;
}

function saveSnapshot(ss, s) {
  var cur = ss.getSheetByName('_问题快照');
  if (cur && cur.getLastRow() && String(cur.getRange(1, 2).getValue()) < today()) {
    var old = ss.getSheetByName('_问题快照_上一期'); if (old) ss.deleteSheet(old);
    cur.setName('_问题快照_上一期'); cur = null;
  }
  var sh = cur || ss.insertSheet('_问题快照');
  sh.clear();
  var rows = [['日期', today(), s.notEligible]].concat(s.issueList.map(function (x) { return [x.key, x.products, '']; }));
  sh.getRange(1, 1, rows.length, 3).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.hideSheet();
}


// ======================= 输出 =======================

function writeOverview(ss, s, prev) {
  var head = ['Feed 标签 / 语言', '商品数', '可投放', '受限', '不能投放', '不能投放比例'].concat(METRIC_HEAD);
  var feeds = values(s.feeds).sort(function (a, b) { return b.total - a.total; });
  var data = [['全部', s.total, s.eligible, s.limited, s.notEligible, div(s.notEligible, s.total)].concat(metricCells(feeds.reduce(function (t, f) { return addMetrics(t, f); }, zero({}))))]
    .concat(feeds.map(function (f) { return [f.name, f.total, f.eligible, f.limited, f.notEligible, div(f.notEligible, f.total)].concat(metricCells(f)); }));
  write(ss, '概况', head, data, ['', FMT.int, FMT.int, FMT.int, FMT.int, FMT.pct].concat(METRIC_FMT),
    { title: '商品状态（' + today() + '）' + (prev ? '，上次记录 ' + prev.date + ' 不能投放 ' + prev.notEligible + ' 个' : '') + (s.outOfStock ? '，缺货 ' + s.outOfStock + ' 个' : '') });
}

function writeIssues(ss, s, prev) {
  var head = ['严重程度', '问题', '属性', '影响商品数', '新问题', '影响地区'].concat(METRIC_HEAD).concat(['问题代码', '说明链接']);
  var data = s.issueList.map(function (x) {
    var isNew = prev && !prev.issues[x.key] ? '新' : (prev && x.products > prev.issues[x.key] ? '+' + (x.products - prev.issues[x.key]) : '');
    return [cnSev(x.sev), x.text, x.attr, x.products, isNew, Object.keys(x.regions).slice(0, 15).join(',')].concat(metricCells(x)).concat([x.code, x.doc]);
  });
  write(ss, '问题汇总', head, data, ['', '', '', FMT.int, '', ''].concat(METRIC_FMT).concat(['', '']),
    { widths: [70, 360, 120, 90, 60, 160], colors: { col: 0, fn: function (v) { return v === '错误' ? '#fde2e1' : v === '警告' ? '#fff1d6' : null; } } });
}
function cnSev(v) { return SEV_CN[v] !== undefined ? SEV_CN[v] : v; }

function writeProducts(ss, products) {
  var list = products.filter(function (p) { return p.status !== 'ELIGIBLE' || p.issues.length; })
    .sort(function (a, b) { return (b.status === 'NOT_ELIGIBLE') - (a.status === 'NOT_ELIGIBLE') || b.cost - a.cost || b.impr - a.impr; });
  var head = ['商品 ID', '标题', '品牌', '商品类型', 'Feed 标签', '状态', '库存', '价格', '问题'].concat(METRIC_HEAD).concat(['Merchant Center ID']);
  var data = list.map(function (p) {
    return [p.id, p.title, p.brand, p.type, p.feed, STATUS_CN[p.status] || p.status, AVAIL_CN[p.avail] || p.avail, p.price === '' ? '' : r2(p.price) + ' ' + p.currency,
      p.issues.map(function (i) { return '[' + cnSev(i.sev) + '] ' + i.text + (i.attr ? '（' + i.attr + '）' : ''); }).join('\n')].concat(metricCells(p)).concat([p.mc]);
  });
  write(ss, '问题商品', head, data, ['@', '', '', '', '', '', '', '', ''].concat(METRIC_FMT).concat(['@']),
    { max: CONFIG.MAX_ROWS, widths: [140, 280, 100, 140, 80, 80, 60, 90, 420],
      colors: { col: 5, fn: function (v) { return v === '不能投放' ? '#fde2e1' : v === '受限' ? '#fff1d6' : null; } } });
}

function writeGroups(ss, products) {
  function by(field) {
    var m = {};
    products.forEach(function (p) {
      var k = p[field] || '（空）';
      var x = m[k] || (m[k] = zero({ k: k, total: 0, bad: 0, limited: 0 }));
      x.total++; if (p.status === 'NOT_ELIGIBLE') x.bad++; if (p.status === 'ELIGIBLE_LIMITED') x.limited++;
      addMetrics(x, p);
    });
    return values(m).filter(function (x) { return x.bad || x.limited; }).sort(function (a, b) { return b.bad - a.bad; }).slice(0, 200);
  }
  var head = ['分组', '名称', '商品数', '不能投放', '受限', '不能投放比例', '近期花费', '近期转化'];
  var data = [];
  [['品牌', 'brand'], ['商品类型', 'type'], ['Feed 标签', 'feed']].forEach(function (d) {
    by(d[1]).forEach(function (x) { data.push([d[0], x.k, x.total, x.bad, x.limited, div(x.bad, x.total), x.cost, x.conv]); });
  });
  write(ss, '按品牌和类型', head, data, ['', '', FMT.int, FMT.int, FMT.int, FMT.pct, FMT.money, FMT.dec], { empty: '没有问题集中的分组' });
}

var HIST_HEAD = ['日期', '商品总数', '可投放', '受限', '不能投放', '不能投放比例', '缺货', '问题种类'];
function writeHistory(ss, s) {
  var sh = ensureSheet(ss, '每日记录', HIST_HEAD);
  upsertDay(sh, today(), [[today(), s.total, s.eligible, s.limited, s.notEligible, div(s.notEligible, s.total), s.outOfStock, s.issueList.length]], CONFIG.KEEP_DAYS);
  sh.getRange(2, 6, Math.max(1, sh.getLastRow() - 1), 1).setNumberFormat(FMT.pct);
  if (sh.getLastRow() > 2) {
    sh.getCharts().forEach(function (c) { sh.removeChart(c); });
    sh.insertChart(sh.newChart().asLineChart().addRange(sh.getRange(1, 1, sh.getLastRow(), 1)).addRange(sh.getRange(1, 3, sh.getLastRow(), 3))
      .setOption('title', '商品状态趋势').setPosition(2, 10, 0, 0).build());
  }
  if (!isPreview()) saveSnapshot(ss, s);
}

function buildActions(s, prev, products) {
  var A = [];
  if (prev && s.notEligible > prev.notEligible) A.push([s.notEligible - prev.notEligible >= CONFIG.ALERT_INCREASE ? '高' : '中', '趋势', '全部商品',
    '不能投放的商品增加了 ' + (s.notEligible - prev.notEligible) + ' 个', prev.date + '：' + prev.notEligible + ' → 今天：' + s.notEligible, '看「问题汇总」里标为「新」或「+」的问题']);
  s.issueList.filter(function (x) { return x.sev === 'ERROR'; }).slice(0, 10).forEach(function (x) {
    A.push([x.cost > 0 || x.products >= 50 ? '高' : '中', '错误', x.text + (x.attr ? '（' + x.attr + '）' : ''), '影响 ' + x.products + ' 个商品，这些商品不能投放',
      '近期花费 ' + r2(x.cost) + '，转化 ' + r2(x.conv), adviceFor(x)]);
  });
  s.issueList.filter(function (x) { return x.sev !== 'ERROR' && x.products >= Math.max(10, s.total * 0.05); }).slice(0, 8).forEach(function (x) {
    A.push(['中', '警告', x.text + (x.attr ? '（' + x.attr + '）' : ''), '影响 ' + x.products + ' 个商品，可能限制展示', '近期花费 ' + r2(x.cost), adviceFor(x)]);
  });
  var costly = products.filter(function (p) { return p.status === 'NOT_ELIGIBLE' && p.conv > 0; }).sort(function (a, b) { return b.value - a.value; });
  if (costly.length) A.push(['高', '商品', costly.length + ' 个有转化的商品', '最近带来过转化，现在不能投放', '例如：' + costly.slice(0, 5).map(function (p) { return p.id; }).join('、'),
    '这些商品最值得马上修，见「问题商品」表前几行']);
  if (s.outOfStock && s.outOfStock / Math.max(1, s.total) >= 0.2) A.push(['中', '库存', '全部商品', s.outOfStock + ' 个商品缺货（' + pct(s.outOfStock / s.total) + '）', '',
    '缺货商品不会展示。确认 Feed 的库存同步是否正常，长期缺货的商品可以从 Feed 里移除']);
  return A;
}

function adviceFor(x) {
  var a = (x.attr + ' ' + x.text + ' ' + x.code).toLowerCase();
  if (/price|价格/.test(a)) return '检查 Feed 价格和落地页价格是否一致（含币种、税费、促销价），价格不一致是最常见的拒登原因';
  if (/availability|库存|stock/.test(a)) return '检查 Feed 库存和落地页是否一致，确认库存同步频率';
  if (/image|图片/.test(a)) return '检查图片是否能打开、是否有水印或促销文字、尺寸是否达标';
  if (/gtin|mpn|identifier|brand/.test(a)) return '补全 GTIN/品牌/MPN；自有品牌没有 GTIN 的，把 identifier_exists 设为 no';
  if (/shipping|运费|tax|税/.test(a)) return '在 Merchant Center 里检查对应国家的运费和税费设置';
  if (/landing|link|url|网址|crawl|抓取/.test(a)) return '检查商品链接能否打开、是否被 robots.txt 拦截、是否跳转';
  if (/policy|政策|prohibited|restricted/.test(a)) return '这是政策问题，打开说明链接确认原因，必要时申请复审';
  if (/title|description|标题|说明/.test(a)) return '检查标题和描述是否过长、是否包含促销文字或大写字母过多';
  return '打开「问题汇总」里的说明链接查看修复方法；Feed 规则批量出错时优先修规则';
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
