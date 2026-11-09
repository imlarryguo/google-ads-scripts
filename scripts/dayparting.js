/**
 * 时段与星期分析 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：按「星期 × 小时」分析最近 90 天的花费和转化，生成热力图，找出转化效率特别高和特别低的时段，
 * 并换算成目标市场的当地时间（例如账户用北京时间，客户在美国东部）。给出投放时间和出价调整建议。
 *
 * 外贸和跨境账户特别需要：账户时区通常是国内时间，客户却在另一个时区，直接看账户报告很容易看错时段。
 *
 * 教程：https://berightdigital.com/google-ads-dayparting-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 只分析名称包含 / 不包含这段文字的广告系列（留空 = 不限）。不同市场的系列建议分开分析
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 分析最近多少天（至少 60 天，数据太少分时段会很不稳定）
  DAYS: 90,
  // 目标市场的时区（IANA 名称），留空 = 只用账户时区
  // 例：'America/New_York' 美国东部、'America/Los_Angeles' 美国西部、'Europe/Berlin' 德国、'Europe/London' 英国、'Australia/Sydney' 澳洲
  TARGET_TIMEZONE: '',

  // 效率按什么判断：'ROAS'（电商）或 'CPA'（询盘）。留空 = 有转化价值就用 ROAS
  METRIC: '',
  // 一个时段至少有这么多次点击，才给出建议
  MIN_CLICKS: 50,
  // 效率低于平均的这个比例 → 建议降低出价或不投放；高于这个倍数 → 建议提高
  LOW_INDEX: 0.6,
  HIGH_INDEX: 1.3
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var DOW = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
var DOW_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];


function main() {
  var ss = openSpreadsheet('时段分析');
  log('信息', '开始', '版本 ' + VERSION + '，最近 ' + CONFIG.DAYS + ' 天');

  var data = safe('读取数据', fetch);
  if (!data) { writeLog(ss); return; }
  var useRoas = CONFIG.METRIC ? CONFIG.METRIC === 'ROAS' : data.total.value > 0;
  var shift = safe('时差', offsetHours) || 0;
  log('信息', '时区', CONFIG.TARGET_TIMEZONE ? '目标市场 ' + CONFIG.TARGET_TIMEZONE + '，比账户时区' + (shift >= 0 ? '晚 ' : '早 ') + Math.abs(shift) + ' 小时' : '只用账户时区');

  var avg = useRoas ? div(data.total.value, data.total.cost) : div(data.total.cost, data.total.conv);
  function idx(m) {
    if (!m.cost) return '';
    if (useRoas) return avg ? div(m.value, m.cost) / avg : '';
    return m.conv ? avg / (m.cost / m.conv) : 0;
  }

  safe('热力图', function () { heatmap(ss, data, idx, shift, useRoas); });
  var hours = safe('小时汇总', function () { return byHour(ss, data, idx, shift); }) || [];
  var days = safe('星期汇总', function () { return byDay(ss, data, idx); }) || [];
  safe('广告系列', function () { byCampaign(ss, data, idx); });
  var A = buildActions(data, hours, days, idx, shift, useRoas);
  safe('行动清单', function () { writeActions(ss, A, '各时段效率差别不大，不需要调整投放时间'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    mail('[时段分析] ' + AdsApp.currentAccount().getName(), '最近 ' + CONFIG.DAYS + ' 天的时段分析结果：',
      [['优先级', '类别', '对象', '发现', '数据']].concat(A.slice(0, 15).map(function (x) { return x.slice(0, 5); })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '时段与星期分析', VERSION, [
      ['效率指标', useRoas ? 'ROAS：时段 ROAS ÷ 整体 ROAS' : 'CPA：整体 CPA ÷ 时段 CPA'],
      ['效率指数', '1 = 和整体平均一样；0.5 = 只有平均效率的一半；1.5 = 比平均高 50%'],
      ['时区', CONFIG.TARGET_TIMEZONE ? '表格同时显示账户时间和目标市场时间（' + CONFIG.TARGET_TIMEZONE + '）。设置投放时间时 Google Ads 使用账户时区' : '账户时区'],
      ['', ''],
      ['行动清单', '效率特别低和特别高的时段，以及调整建议'],
      ['热力图', '星期 × 小时的效率指数，红色低、绿色高；点击太少的格子显示为灰色'],
      ['小时汇总 / 星期汇总', '按小时和按星期合计的效果'],
      ['广告系列', '每个广告系列按时段（凌晨/上午/下午/晚上）的效果'],
      ['注意', '使用智能出价（tCPA、tROAS、尽可能提高转化等）时，投放时间的出价调整不起作用（只有设为「不投放」生效），Google 会自动按时段出价；这时这份报告主要用来检查是否有明显浪费的时段']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '热力图', '小时汇总', '星期汇总', '广告系列', '运行日志']);
}


// ======================= 数据 =======================

function fetch() {
  var rows = runQuery('SELECT campaign.name, segments.day_of_week, segments.hour, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM campaign WHERE ' + range(CONFIG.DAYS) + ' AND metrics.impressions > 0' + nameFilter());
  var grid = [], camps = {}, total = zero({});
  for (var d = 0; d < 7; d++) { grid.push([]); for (var h = 0; h < 24; h++) grid[d].push(zero({})); }
  rows.forEach(function (r) {
    var d = DOW.indexOf(String(g(r, 'segments.dayOfWeek'))), h = num(g(r, 'segments.hour'));
    if (d < 0) return;
    var m = metricsOf(r), c = String(g(r, 'campaign.name'));
    addMetrics(grid[d][h], m); addMetrics(total, m);
    var cc = camps[c] || (camps[c] = { total: zero({}), parts: [zero({}), zero({}), zero({}), zero({})] });
    addMetrics(cc.total, m); addMetrics(cc.parts[Math.floor(h / 6)], m);
  });
  log('信息', '数据', rows.length + ' 行，花费 ' + r2(total.cost) + '，转化 ' + r2(total.conv));
  return { grid: grid, camps: camps, total: total };
}

// 目标市场时间 - 账户时间（小时）
function offsetHours() {
  if (!CONFIG.TARGET_TIMEZONE) return 0;
  var now = new Date();
  function off(zone) { var z = Utilities.formatDate(now, zone, 'Z'); var s = z.charAt(0) === '-' ? -1 : 1; return s * (Number(z.substr(1, 2)) + Number(z.substr(3, 2)) / 60); }
  return off(CONFIG.TARGET_TIMEZONE) - off(tz());
}
function localHour(h, shift) { return ((h + shift) % 24 + 24) % 24; }
function hourLabel(h) { var x = Math.floor(h), mm = Math.round((h - x) * 60); return (x < 10 ? '0' : '') + x + ':' + (mm < 10 ? '0' : '') + mm; }


// ======================= 输出 =======================

function color(v, clicks) {
  if (v === '' || clicks < CONFIG.MIN_CLICKS / 4) return '#eef1f5';
  if (v < 0.4) return '#f4a6a0'; if (v < CONFIG.LOW_INDEX) return '#fbd3cf'; if (v < 0.9) return '#fdeeec';
  if (v <= 1.1) return '#ffffff'; if (v <= CONFIG.HIGH_INDEX) return '#e3f4e8'; if (v <= 1.8) return '#bfe5c9'; return '#8fd1a2';
}

function heatmap(ss, data, idx, shift, useRoas) {
  var sh = ss.getSheetByName('热力图') || ss.insertSheet('热力图');
  sh.clear();
  var head = ['星期 \\ 小时（账户时间）'];
  for (var h = 0; h < 24; h++) head.push(String(h));
  var rows = [head], bgs = [head.map(function () { return HEAD_BG; })];
  if (shift) rows.push(['目标市场时间'].concat(head.slice(1).map(function (_, h2) { return hourLabel(localHour(h2, shift)); })));
  if (shift) bgs.push(head.map(function () { return '#d9e2ea'; }));
  for (var d = 0; d < 7; d++) {
    var row = [DOW_CN[d]], bg = ['#ffffff'];
    for (var hh = 0; hh < 24; hh++) { var m = data.grid[d][hh], v = idx(m); row.push(v === '' ? '' : Math.round(v * 100) / 100); bg.push(color(v, m.clicks)); }
    rows.push(row); bgs.push(bg);
  }
  sh.getRange(1, 1).setValue('效率指数（' + (useRoas ? 'ROAS' : 'CPA') + '，1 = 平均）');
  sh.getRange(2, 1, rows.length, 25).setValues(rows.map(cleanRow)).setBackgrounds(bgs);
  sh.getRange(2, 1, 1, 25).setFontColor('#ffffff').setFontWeight('bold');
  // 第二张：转化数
  var r0 = rows.length + 4;
  sh.getRange(r0 - 1, 1).setValue('转化数');
  var conv = [head];
  for (var d2 = 0; d2 < 7; d2++) conv.push([DOW_CN[d2]].concat(data.grid[d2].map(function (m) { return Math.round(m.conv * 10) / 10; })));
  sh.getRange(r0, 1, conv.length, 25).setValues(conv);
  // 第三张：花费
  var r1 = r0 + conv.length + 2;
  sh.getRange(r1 - 1, 1).setValue('花费');
  var cost = [head];
  for (var d3 = 0; d3 < 7; d3++) cost.push([DOW_CN[d3]].concat(data.grid[d3].map(function (m) { return Math.round(m.cost); })));
  sh.getRange(r1, 1, cost.length, 25).setValues(cost);
  sh.setColumnWidth(1, 150);
  for (var c = 2; c <= 25; c++) sh.setColumnWidth(c, 52);
}

function byHour(ss, data, idx, shift) {
  var out = [];
  for (var h = 0; h < 24; h++) {
    var m = zero({}); for (var d = 0; d < 7; d++) addMetrics(m, data.grid[d][h]);
    out.push({ h: h, m: m, idx: idx(m) });
  }
  write(ss, '小时汇总', ['账户时间', '目标市场时间'].concat(METRIC_HEAD).concat(['转化率', '效率指数']),
    out.map(function (x) { return [hourLabel(x.h), shift ? hourLabel(localHour(x.h, shift)) : ''].concat(metricCells(x.m)).concat([x.m.cvr, x.idx]); }),
    ['@', '@'].concat(METRIC_FMT).concat([FMT.pct, FMT.ratio]), { colors: { col: 12, fn: function (v, r) { return color(v, r[3]); } } });
  return out;
}

function byDay(ss, data, idx) {
  var out = [];
  for (var d = 0; d < 7; d++) { var m = zero({}); data.grid[d].forEach(function (x) { addMetrics(m, x); }); out.push({ d: d, m: m, idx: idx(m) }); }
  write(ss, '星期汇总', ['星期'].concat(METRIC_HEAD).concat(['转化率', '效率指数']),
    out.map(function (x) { return [DOW_CN[x.d]].concat(metricCells(x.m)).concat([x.m.cvr, x.idx]); }),
    [''].concat(METRIC_FMT).concat([FMT.pct, FMT.ratio]), { colors: { col: 11, fn: function (v, r) { return color(v, r[2]); } } });
  return out;
}

function byCampaign(ss, data, idx) {
  var parts = ['0–6 点', '6–12 点', '12–18 点', '18–24 点'];
  var head = ['广告系列', '费用', '转化'];
  parts.forEach(function (p) { head.push(p + ' 费用', p + ' 转化', p + ' 效率'); });
  var rows = Object.keys(data.camps).map(function (c) {
    var x = data.camps[c], row = [c, x.total.cost, x.total.conv];
    x.parts.forEach(function (m) { row.push(m.cost, m.conv, idx(m)); });
    return row;
  }).sort(function (a, b) { return b[1] - a[1]; });
  var fm = ['', FMT.money, FMT.dec]; parts.forEach(function () { fm.push(FMT.money, FMT.dec, FMT.ratio); });
  write(ss, '广告系列', head, rows, fm, { title: '时段按账户时间划分' });
}

function buildActions(data, hours, days, idx, shift, useRoas) {
  var A = [];
  // 连续的低效时段合并成一段
  var blocks = [], cur = null;
  hours.forEach(function (x) {
    var low = x.m.clicks >= CONFIG.MIN_CLICKS / 4 && x.idx !== '' && x.idx < CONFIG.LOW_INDEX;
    if (low) { if (!cur) { cur = { from: x.h, to: x.h, m: zero({}) }; blocks.push(cur); } cur.to = x.h; addMetrics(cur.m, x.m); }
    else cur = null;
  });
  blocks.filter(function (b) { return b.m.clicks >= CONFIG.MIN_CLICKS; }).forEach(function (b) {
    var e = idx(b.m), share = div(b.m.cost, data.total.cost);
    A.push([e < 0.4 && share >= 0.05 ? '高' : '中', '低效时段', hourLabel(b.from) + '–' + hourLabel(b.to + 1) + '（账户时间）' + (shift ? '，目标市场 ' + hourLabel(localHour(b.from, shift)) + '–' + hourLabel(localHour(b.to + 1, shift)) : ''),
      '效率只有平均的 ' + pct(e), '花费 ' + r2(b.m.cost) + '（' + pct(share) + '），转化 ' + r2(b.m.conv),
      e < 0.3 ? '考虑在这个时段不投放（智能出价下这是唯一有效的时段设置）' : '手动出价时把这个时段的出价调低 ' + Math.round((1 - e) * 50) + '% 左右；智能出价时观察即可']);
  });
  hours.filter(function (x) { return x.m.clicks >= CONFIG.MIN_CLICKS && x.idx !== '' && x.idx > CONFIG.HIGH_INDEX; }).slice(0, 6).forEach(function (x) {
    A.push(['低', '高效时段', hourLabel(x.h) + '（账户时间）' + (shift ? '，目标市场 ' + hourLabel(localHour(x.h, shift)) : ''), '效率是平均的 ' + pct(x.idx), '转化 ' + r2(x.m.conv),
      '手动出价时可以提高这个时段的出价；确保这个时段预算不会提前花完（预算不足时广告会在一天的后半段停止）']);
  });
  days.forEach(function (x) {
    if (x.m.clicks < CONFIG.MIN_CLICKS || x.idx === '') return;
    if (x.idx < CONFIG.LOW_INDEX) A.push(['中', '低效星期', DOW_CN[x.d], '效率只有平均的 ' + pct(x.idx), '花费 ' + r2(x.m.cost) + '，转化 ' + r2(x.m.conv), 'B2B 询盘账户周末效率通常较低，可以考虑周末降低出价或预算']);
    else if (x.idx > CONFIG.HIGH_INDEX) A.push(['低', '高效星期', DOW_CN[x.d], '效率是平均的 ' + pct(x.idx), '转化 ' + r2(x.m.conv), '这一天可以给更多预算']);
  });
  if (data.total.conv < 50) A.push(['低', '说明', '—', '最近 ' + CONFIG.DAYS + ' 天只有 ' + r2(data.total.conv) + ' 次转化', '', '转化太少时分时段的结果波动很大，建议拉长 DAYS 或只看星期汇总']);
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
