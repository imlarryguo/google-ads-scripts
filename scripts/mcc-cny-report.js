/**
 * 多账户人民币汇总报表 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：在经理账户（MCC）里运行，把所有子账户（不同币种：美元、欧元、英镑、港币……）的花费、转化、转化价值
 * 统一换算成人民币，每天生成一份汇总：
 *   1. 昨天、最近 7 天（环比）、本月（预测月底）、最近 30 天，每个账户一行，最后一行合计；
 *   2. 可以给每个账户设人民币月预算，预测月底是否超支；
 *   3. 自动发现：昨天突然停止花费的账户（可能是付款失败）、花费暴涨的账户、连续 7 天没有转化的账户；
 *   4. 每天记录一行，方便财务对账和做月报。
 * 汇率每天自动更新（免费汇率接口），也可以填写固定汇率（例如公司财务规定的月度汇率）。
 *
 * 毕瑞出海原创脚本。
 *
 * 教程：https://berightdigital.com/google-ads-mcc-cny-report-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每天的汇总发到这些邮箱（留空 = 不发）。多个用英文逗号分隔
  EMAIL: '',

  // 要汇总的账户 ID（留空 = 经理账户下的全部账户，最多 50 个）
  ACCOUNT_IDS: [],
  // 只汇总名称包含这段文字的账户（留空 = 不限）
  ACCOUNT_NAME_CONTAINS: '',

  // 固定汇率：1 单位外币 = 多少人民币。填了的币种用固定汇率，没填的用每天自动获取的汇率
  // 例：{ USD: 7.10, EUR: 7.75 }
  FIXED_RATES: {},
  // 自动汇率获取失败时用的备用汇率（请定期更新）
  FALLBACK_RATES: { USD: 7.1, EUR: 7.8, GBP: 9.1, HKD: 0.91, JPY: 0.047, AUD: 4.7, CAD: 5.1, SGD: 5.3, TWD: 0.22, KRW: 0.0051, INR: 0.083, AED: 1.93, MYR: 1.6, CNY: 1 },

  // 每个账户的人民币月预算（可选），例：{ '123-456-7890': 50000 }
  MONTHLY_BUDGET_CNY: {},

  // 花费比最近 7 天日均高这么多 → 提醒
  SPIKE_PCT: 80,
  // 每日记录保留多少天
  KEEP_DAYS: 400
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';


function main() {
  var ss = openSpreadsheet('多账户人民币汇总');
  log('信息', '开始', '版本 ' + VERSION);
  var rates = safe('汇率', function () { return getRates(ss); }) || { rates: CONFIG.FALLBACK_RATES, source: '备用汇率' };
  var accounts = listAccounts();
  log('信息', '账户', accounts.length + ' 个账户');

  var results = [];
  accounts.forEach(function (a) {
    if (timeLeft() < 3 * 60 * 1000) { log('提示', '时间', '接近运行时间上限，跳过 ' + a.name); return; }
    var r = safe('读取 ' + a.name, function () { return readAccount(a, rates); });
    if (r) results.push(r);
  });
  results.sort(function (a, b) { return b.mtd.cost - a.mtd.cost; });
  var total = sumAll(results);

  safe('汇总', function () { writeSummary(ss, results, total, rates); });
  safe('每日记录', function () { history(ss, results); });
  var A = buildActions(results);
  safe('行动清单', function () { writeActions(ss, A, '所有账户正常'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    var rows = [['账户', '昨天花费', '昨天转化', '近 7 天花费', '环比', '本月花费', '预测月底']].concat(results.map(function (r) {
      return [r.name, Math.round(r.yday.cost), r2(r.yday.conv), Math.round(r.d7.cost), sgn(r.d7.change), Math.round(r.mtd.cost), Math.round(r.forecast)];
    })).concat([['合计', Math.round(total.yday.cost), r2(total.yday.conv), Math.round(total.d7.cost), sgn(total.d7.change), Math.round(total.mtd.cost), Math.round(total.forecast)]]);
    mail('[Google Ads 日报] 昨天花费 ¥' + Math.round(total.yday.cost).toLocaleString() + '，本月 ¥' + Math.round(total.mtd.cost).toLocaleString(),
      dayStr(-1) + ' 共 ' + results.length + ' 个账户（单位：人民币）。' + (A.filter(function (x) { return x[0] === '高'; }).length ? '\n需要注意：' + A.filter(function (x) { return x[0] === '高'; }).map(function (x) { return x[2] + '：' + x[3]; }).join('；') : ''), rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '多账户人民币汇总报表', VERSION, [
      ['汇率来源', rates.source + '（固定汇率优先）'],
      ['金额单位', '人民币；原币金额见「汇总」表的原币列'],
      ['', ''],
      ['行动清单', '昨天停止花费、花费暴涨、7 天没有转化、预计超出月预算的账户'],
      ['汇总', '每个账户一行：昨天、最近 7 天、本月、最近 30 天'],
      ['每日记录', '每天每个账户一行（人民币），可以用数据透视表做月报'],
      ['汇率', '本次使用的汇率'],
      ['注意', '需要在经理账户（MCC）里运行；在普通账户里运行时只汇总当前账户。Google Ads 的花费数据在当天会继续更新，昨天的数据第二天上午基本稳定']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '汇总', '每日记录', '汇率', '运行日志']);
}


// ======================= 汇率 =======================

function getRates(ss) {
  var rates = {}, source = '备用汇率';
  try {
    var resp = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/CNY', { muteHttpExceptions: true });
    var j = JSON.parse(resp.getContentText());
    if (j && j.rates) {
      // 接口返回的是 1 人民币 = 多少外币，换成 1 外币 = 多少人民币
      Object.keys(j.rates).forEach(function (c) { if (j.rates[c]) rates[c] = 1 / j.rates[c]; });
      source = '自动汇率（open.er-api.com，' + String(j.time_last_update_utc || '').slice(0, 16) + '）';
    }
  } catch (e) { log('提示', '汇率', '自动汇率获取失败，使用备用汇率：' + e.message); }
  Object.keys(CONFIG.FALLBACK_RATES).forEach(function (c) { if (!rates[c]) rates[c] = CONFIG.FALLBACK_RATES[c]; });
  Object.keys(CONFIG.FIXED_RATES).forEach(function (c) { rates[c] = CONFIG.FIXED_RATES[c]; });
  rates.CNY = 1;
  return { rates: rates, source: source };
}


// ======================= 账户 =======================

function listAccounts() {
  var out = [];
  try {
    if (typeof AdsManagerApp !== 'undefined' && AdsManagerApp.accounts) {
      var sel = AdsManagerApp.accounts();
      if (CONFIG.ACCOUNT_IDS.length) sel = sel.withIds(CONFIG.ACCOUNT_IDS);
      var it = sel.get(), kw = String(CONFIG.ACCOUNT_NAME_CONTAINS || '').toLowerCase();
      while (it.hasNext() && out.length < 50) {
        var a = it.next();
        if (kw && String(a.getName()).toLowerCase().indexOf(kw) < 0) continue;
        out.push({ obj: a, id: a.getCustomerId(), name: a.getName() });
      }
    }
  } catch (e) { log('提示', '账户', '不是经理账户，或读取子账户失败，只汇总当前账户：' + e.message); out = []; }
  if (!out.length) { var c = AdsApp.currentAccount(); out.push({ obj: null, id: c.getCustomerId(), name: c.getName() }); }
  return out;
}

function readAccount(a, rates) {
  if (a.obj) AdsManagerApp.select(a.obj);
  var acct = AdsApp.currentAccount(), cur = acct.getCurrencyCode ? acct.getCurrencyCode() : 'USD';
  var rate = rates.rates[cur];
  if (!rate) { log('提示', a.name, '没有 ' + cur + ' 的汇率，按 1 计算'); rate = 1; }
  var t = today(), p = t.split('-');
  var monthStart = t.slice(0, 8) + '01';
  var lastMonthStart = new Date(Date.UTC(+p[0], +p[1] - 2, 1)).toISOString().slice(0, 10);
  var from = lastMonthStart < dayStr(-60) ? lastMonthStart : dayStr(-60);
  var rows = runQuery('SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM customer WHERE ' + between(from, dayStr(-1)));
  var days = {};
  rows.forEach(function (r) { var d = String(g(r, 'segments.date')); addMetrics(days[d] || (days[d] = zero({})), metricsOf(r)); });
  function sum(f, to) { var s = zero({}); Object.keys(days).forEach(function (d) { if (d >= f && d <= to) addMetrics(s, days[d]); }); ['cost', 'value'].forEach(function (k) { s[k + 'Orig'] = s[k]; s[k] = s[k] * rate; }); return derived(s); }
  var yday = sum(dayStr(-1), dayStr(-1)), prevDay = sum(dayStr(-2), dayStr(-2));
  var d7 = sum(dayStr(-7), dayStr(-1)), p7 = sum(dayStr(-14), dayStr(-8));
  d7.change = p7.cost ? d7.cost / p7.cost - 1 : '';
  var mtd = sum(monthStart, dayStr(-1));
  // 上月同期（同样的天数）
  var dayOfMonth = +p[2], lmEnd = new Date(Date.UTC(+p[0], +p[1] - 2, Math.max(1, dayOfMonth - 1))).toISOString().slice(0, 10);
  var lm = dayOfMonth > 1 ? sum(lastMonthStart, lmEnd) : zero({});
  mtd.change = lm.cost ? mtd.cost / lm.cost - 1 : '';
  var d30 = sum(dayStr(-30), dayStr(-1));
  var daysInMonth = new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate();
  var forecast = mtd.cost + (d7.cost / 7) * (daysInMonth - dayOfMonth + 1);
  var budget = num(CONFIG.MONTHLY_BUDGET_CNY[a.id]);
  var zeroDays = 0; for (var i = 1; i <= 7; i++) { var dd = days[dayStr(-i)]; if (!dd || !dd.conv) zeroDays++; else break; }
  return { id: a.id, name: a.name, currency: cur, rate: rate, yday: yday, prevDay: prevDay, d7: d7, mtd: mtd, d30: d30, forecast: forecast, budget: budget, noConvDays: zeroDays };
}

function sumAll(list) {
  var t = { yday: zero({}), d7: zero({}), p7c: 0, mtd: zero({}), d30: zero({}), forecast: 0 };
  list.forEach(function (r) { addMetrics(t.yday, r.yday); addMetrics(t.d7, r.d7); addMetrics(t.mtd, r.mtd); addMetrics(t.d30, r.d30); t.forecast += r.forecast; t.p7c += r.d7.change === '' ? r.d7.cost : r.d7.cost / (1 + r.d7.change); });
  ['yday', 'd7', 'mtd', 'd30'].forEach(function (k) { derived(t[k]); });
  t.d7.change = t.p7c ? t.d7.cost / t.p7c - 1 : '';
  return t;
}
function sgn(x) { return x === '' ? '—' : (x >= 0 ? '+' : '') + Math.round(x * 100) + '%'; }


// ======================= 输出 =======================

function writeSummary(ss, list, t, rates) {
  var head = ['账户', '账户 ID', '币种', '汇率', '昨天 花费（原币）', '昨天 花费', '昨天 转化', '昨天 ROAS', '近 7 天 花费', '7 天环比', '近 7 天 转化', '近 7 天 CPA', '近 7 天 ROAS',
              '本月 花费', '上月同期对比', '本月 转化', '本月 转化价值', '预测月底', '月预算', '预计用掉', '近 30 天 花费', '近 30 天 转化', '近 30 天 ROAS'];
  var data = list.map(function (r) {
    return [r.name, r.id, r.currency, r.rate, r.yday.costOrig, r.yday.cost, r.yday.conv, r.yday.roas, r.d7.cost, r.d7.change, r.d7.conv, r.d7.cpa, r.d7.roas,
            r.mtd.cost, r.mtd.change, r.mtd.conv, r.mtd.value, r.forecast, r.budget || '', r.budget ? r.forecast / r.budget : '', r.d30.cost, r.d30.conv, r.d30.roas];
  });
  data.push(['合计', '', 'CNY', '', '', t.yday.cost, t.yday.conv, t.yday.roas, t.d7.cost, t.d7.change, t.d7.conv, t.d7.cpa, t.d7.roas, t.mtd.cost, '', t.mtd.conv, t.mtd.value, t.forecast, '', '', t.d30.cost, t.d30.conv, t.d30.roas]);
  var sh = write(ss, '汇总', head, data, ['', '@', '', '0.0000', FMT.money, FMT.money, FMT.dec, FMT.ratio, FMT.money, '+0%;-0%;0%', FMT.dec, FMT.money, FMT.ratio,
    FMT.money, '+0%;-0%;0%', FMT.dec, FMT.money, FMT.money, FMT.money, FMT.pct, FMT.money, FMT.dec, FMT.ratio], { title: '金额单位：人民币（' + dayStr(-1) + '，汇率：' + rates.source + '）' });
  sh.getRange(data.length + 2, 1, 1, head.length).setFontWeight('bold').setBackground('#eef1f5');
  var fx = Object.keys(rates.rates).filter(function (c) { return list.some(function (r) { return r.currency === c; }) || ['USD', 'EUR', 'GBP', 'HKD'].indexOf(c) >= 0; }).sort();
  write(ss, '汇率', ['币种', '1 单位 = 人民币', '来源'], fx.map(function (c) { return [c, rates.rates[c], CONFIG.FIXED_RATES[c] ? '固定汇率' : rates.source]; }), ['', '0.0000', '']);
}

var HIST_HEAD = ['日期', '账户', '账户 ID', '币种', '汇率', '花费（原币）', '花费（人民币）', '点击', '转化', '转化价值（人民币）'];
function history(ss, list) {
  var sh = ensureSheet(ss, '每日记录', HIST_HEAD), d = dayStr(-1);
  upsertDay(sh, d, list.map(function (r) { return [d, r.name, r.id, r.currency, r.rate, r.yday.costOrig, r.yday.cost, r.yday.clicks, r.yday.conv, r.yday.value]; }), CONFIG.KEEP_DAYS);
}

function buildActions(list) {
  var A = [];
  list.forEach(function (r) {
    var avg7 = r.d7.cost / 7;
    if (!r.yday.cost && avg7 > 0) A.push(['高', '停止花费', r.name + '（' + r.id + '）', '昨天没有任何花费，最近 7 天日均 ¥' + Math.round(avg7), '', '检查付款方式和账单（最常见）、账户是否被暂停、广告是否被拒']);
    else if (avg7 && r.yday.cost > avg7 * (1 + CONFIG.SPIKE_PCT / 100) && r.yday.cost - avg7 > 100) A.push(['中', '花费暴涨', r.name + '（' + r.id + '）', '昨天花费比 7 天日均高 ' + Math.round((r.yday.cost / avg7 - 1) * 100) + '%', '昨天 ¥' + Math.round(r.yday.cost) + '，日均 ¥' + Math.round(avg7), '检查最近的预算、出价和目标改动']);
    if (r.noConvDays >= 7 && r.d7.cost > 0) A.push(['高', '没有转化', r.name + '（' + r.id + '）', '连续 7 天没有转化', '近 7 天花费 ¥' + Math.round(r.d7.cost), '检查转化跟踪是否正常（可以在这个账户里运行「账户异常监控」脚本）']);
    if (r.budget && r.forecast > r.budget * 1.1) A.push(['中', '月预算', r.name + '（' + r.id + '）', '预计月底超出月预算 ' + Math.round((r.forecast / r.budget - 1) * 100) + '%', '月预算 ¥' + Math.round(r.budget) + '，预测 ¥' + Math.round(r.forecast), '降低日预算，或者在这个账户里用「预算节奏」脚本按月控制']);
    else if (r.budget && r.forecast < r.budget * 0.8) A.push(['低', '月预算', r.name + '（' + r.id + '）', '预计月底只用掉月预算的 ' + pct(r.forecast / r.budget), '', '如果效果好，可以提高日预算']);
  });
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
