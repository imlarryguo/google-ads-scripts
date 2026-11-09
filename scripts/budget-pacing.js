/**
 * 预算节奏与调整 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：
 *   1. 按月预算跟踪花费节奏：本月已花多少、按最近速度月底会花多少、每天应该花多少；
 *   2. 支持按市场/产品线分组设置月预算（按广告系列名称匹配，例如「US」「DE」）；
 *   3. 按转化、转化价值和预算受限情况，给每个广告系列算出建议预算；
 *   4. 超支或花不完时发邮件提醒；可选每天自动按节奏微调预算（默认关闭）。
 *
 * 思路参考 Francesco Cifardi 的 Budget Adjust Report 和常见的「实时预算 / 月度超支」表格脚本，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-budget-pacing-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 提醒邮箱（留空 = 不发）。多个用英文逗号分隔。
  EMAIL: '',
  // true = 每次运行都发邮件；false = 只在超支或花不完时发
  EMAIL_ALWAYS: false,

  // 整个账户的月预算（账户币种，0 = 不设）
  MONTHLY_BUDGET: 0,

  // 分组月预算（可选）：广告系列名称包含 contains 的归入该组。一个系列只归入第一个匹配的组。
  // 例：{ name: '美国市场', contains: 'US', monthly: 3000 }
  GROUPS: [
    // { name: '美国市场', contains: 'US', monthly: 3000 },
    // { name: '欧洲市场', contains: 'EU', monthly: 2000 },
  ],

  // 只看名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 效率判断用的目标（二选一，都填 0 则用账户平均水平作参考）
  TARGET_ROAS: 0,   // 例如 3 表示 300%
  TARGET_CPA: 0,

  // 效果数据统计天数（截至昨天）
  DAYS: 30,
  // 预测月底花费偏离月预算超过这个比例就提醒（10 = ±10%）
  TOLERANCE_PCT: 10,

  // 是否每天自动把分组/账户内的预算按节奏调整（默认关闭，只给建议）
  APPLY_CHANGES: false,
  // 自动调整时，单个预算一次最多调整多少（20 = ±20%）
  MAX_CHANGE_PCT: 20
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';


function main() {
  var ss = openSpreadsheet('预算节奏');
  var cal = calendar();
  log('信息', '开始', '版本 ' + VERSION + '，本月第 ' + cal.day + ' 天，共 ' + cal.days + ' 天，剩余 ' + cal.left + ' 天（含今天）');

  var camps = safe('读取广告系列', fetchCampaigns) || [];
  log('信息', '广告系列', camps.length + ' 个在投广告系列');

  var units = buildUnits(camps);
  units.forEach(function (u) { pace(u, cal); });
  var ref = reference(camps);
  camps.forEach(function (c) { suggest(c, ref); });

  safe('节奏总览', function () { writePacing(ss, units, cal); });
  safe('广告系列预算', function () { writeCampaigns(ss, camps, ref); });
  safe('每日记录', function () { writeHistory(ss, units, cal); });
  var A = buildActions(units, camps, ref, cal);
  safe('行动清单', function () { writeActions(ss, A, '预算节奏正常'); });
  if (CONFIG.APPLY_CHANGES) safe('自动调整', function () { apply(ss, units, cal); });

  var alert = units.some(function (u) { return u.status === '超支风险' || u.status === '花不完' || u.status === '已超预算'; });
  if (CONFIG.EMAIL && (alert || CONFIG.EMAIL_ALWAYS)) safe('邮件', function () {
    var rows = [['状态', '预算', '月预算', '本月已花', '预测月底', '建议每日花费', '当前每日预算']].concat(units.filter(function (u) { return u.monthly; }).map(function (u) {
      return [u.status, u.name, u.monthly, u.mtd, u.forecast, u.neededDaily, u.dailyBudget];
    }));
    mail('[预算节奏] ' + AdsApp.currentAccount().getName() + '：' + (alert ? '有预算需要调整' : '每日报告'),
      '本月第 ' + cal.day + '/' + cal.days + ' 天。按最近 7 天的花费速度预测月底花费，和月预算对比如下。', rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '预算节奏与调整', VERSION, [
      ['月预算', CONFIG.MONTHLY_BUDGET ? '账户 ' + CONFIG.MONTHLY_BUDGET : '（未设置账户月预算）'],
      ['分组', CONFIG.GROUPS.length ? CONFIG.GROUPS.map(function (x) { return x.name + '（包含 ' + x.contains + '，月预算 ' + x.monthly + '）'; }).join('；') : '（未设置）'],
      ['预测方法', '月底花费 = 本月到昨天的花费 + 最近 7 天日均花费 × 剩余天数（含今天）'],
      ['建议每日花费', '(月预算 − 本月到昨天的花费) ÷ 剩余天数'],
      ['自动调整', CONFIG.APPLY_CHANGES ? '开启：每天一次，单个预算最多调整 ±' + CONFIG.MAX_CHANGE_PCT + '%' : '关闭（只给建议）'],
      ['', ''],
      ['行动清单', '先看这里：超支风险、花不完、预算受限但效果好的广告系列'],
      ['节奏总览', '账户和每个分组的月预算、已花、预测、建议每日花费'],
      ['广告系列预算', '每个广告系列的日预算、使用率、预算造成的展示份额损失、效果和建议预算'],
      ['每日记录', '每天一行的花费节奏记录，用来回看'],
      ['注意', 'Google 单日最多可能花到日预算的 2 倍，但一个月内不会超过「日预算 × 30.4」。共享预算按预算本身计算一次，不会重复计算']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '节奏总览', '广告系列预算', '每日记录', '运行日志']);
}


// ======================= 日期 =======================

function calendar() {
  var t = today(), p = t.split('-');
  var y = +p[0], mo = +p[1], d = +p[2];
  var days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  var start = p[0] + '-' + p[1] + '-01';
  return { today: t, day: d, days: days, left: days - d + 1, start: start, yesterday: dayStr(-1), firstDay: d === 1 };
}


// ======================= 读取数据 =======================

function fetchCampaigns() {
  var sel = 'campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, ' +
    'campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared';
  var where = ' FROM campaign WHERE campaign.status = "ENABLED" AND campaign.serving_status != "ENDED"' + nameFilter();
  var base = runQuery('SELECT ' + sel + where);
  var map = {};
  base.forEach(function (r) {
    var id = String(g(r, 'campaign.id'));
    map[id] = zero({ id: id, name: String(g(r, 'campaign.name')), type: String(g(r, 'campaign.advertisingChannelType')),
      bidding: String(g(r, 'campaign.biddingStrategyType')), budgetRes: String(g(r, 'campaignBudget.resourceName')),
      budgetName: String(g(r, 'campaignBudget.name')), daily: money(g(r, 'campaignBudget.amountMicros')),
      shared: g(r, 'campaignBudget.explicitlyShared') === true || g(r, 'campaignBudget.explicitlyShared') === 'true',
      mtd: 0, todayCost: 0, last7: 0, lostBudget: '', is: '' });
  });

  // 效果数据（最近 N 天）
  var perf = tryQuery('效果数据', 'SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, ' +
    'metrics.search_budget_lost_impression_share, metrics.search_impression_share' + where + ' AND ' + range(CONFIG.DAYS));
  if (!perf) perf = runQuery('SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value' + where + ' AND ' + range(CONFIG.DAYS));
  perf.forEach(function (r) {
    var c = map[String(g(r, 'campaign.id'))]; if (!c) return;
    addMetrics(c, metricsOf(r));
    var lb = g(r, 'metrics.searchBudgetLostImpressionShare'), is = g(r, 'metrics.searchImpressionShare');
    if (lb !== '') c.lostBudget = num(lb);
    if (is !== '') c.is = num(is);
  });

  // 本月花费、今天花费、最近 7 天
  runQuery('SELECT campaign.id, segments.date, metrics.cost_micros' + where + ' AND ' + between(dayStr(-7) < monthStart() ? dayStr(-7) : monthStart(), today()))
    .forEach(function (r) {
      var c = map[String(g(r, 'campaign.id'))]; if (!c) return;
      var d = String(g(r, 'segments.date')), cost = money(g(r, 'metrics.costMicros'));
      if (d >= monthStart()) c.mtd += cost;
      if (d === today()) c.todayCost += cost;
      if (d >= dayStr(-7) && d <= dayStr(-1)) c.last7 += cost;
    });
  return values(map);
}
function monthStart() { return today().slice(0, 8) + '01'; }


// ======================= 节奏计算 =======================

// 预算单位：账户整体 + 每个分组。共享预算只算一次。
function buildUnits(camps) {
  camps.forEach(function (c) {
    c.group = '';
    for (var i = 0; i < CONFIG.GROUPS.length; i++) {
      var gr = CONFIG.GROUPS[i];
      if (gr.contains && c.name.toLowerCase().indexOf(String(gr.contains).toLowerCase()) >= 0) { c.group = gr.name; break; }
    }
  });
  var units = [{ name: '整个账户', monthly: num(CONFIG.MONTHLY_BUDGET), camps: camps }];
  CONFIG.GROUPS.forEach(function (gr) {
    units.push({ name: gr.name, monthly: num(gr.monthly), camps: camps.filter(function (c) { return c.group === gr.name; }) });
  });
  var rest = camps.filter(function (c) { return !c.group; });
  if (CONFIG.GROUPS.length && rest.length) units.push({ name: '（未分组）', monthly: 0, camps: rest });
  return units;
}

function pace(u, cal) {
  var budgets = {};
  u.mtd = 0; u.todayCost = 0; u.last7 = 0;
  u.camps.forEach(function (c) {
    u.mtd += c.mtd; u.todayCost += c.todayCost; u.last7 += c.last7;
    budgets[c.budgetRes || c.id] = c.daily;
  });
  u.dailyBudget = values(budgets).reduce(function (s, x) { return s + x; }, 0);
  u.beforeToday = u.mtd - u.todayCost;
  u.avg7 = u.last7 / 7;
  // 月初前几天最近 7 天包含上个月，仍然代表最近的花费速度
  u.forecast = u.beforeToday + u.avg7 * cal.left;
  u.capForecast = u.beforeToday + u.dailyBudget * cal.left; // 按当前日预算全部花完
  if (u.monthly) {
    u.neededDaily = Math.max(0, (u.monthly - u.beforeToday) / cal.left);
    u.ratio = u.forecast / u.monthly;
    var tol = CONFIG.TOLERANCE_PCT / 100;
    u.status = u.beforeToday >= u.monthly ? '已超预算' : u.ratio > 1 + tol ? '超支风险' : u.ratio < 1 - tol ? (u.capForecast < u.monthly * (1 - tol) ? '日预算不够' : '花不完') : '正常';
    u.factor = u.dailyBudget ? u.neededDaily / u.dailyBudget : '';
  } else {
    u.neededDaily = ''; u.ratio = ''; u.status = '未设月预算'; u.factor = '';
  }
}

function reference(camps) {
  var t = zero({});
  camps.forEach(function (c) { addMetrics(t, c); });
  return { roas: CONFIG.TARGET_ROAS || div(t.value, t.cost), cpa: CONFIG.TARGET_CPA || div(t.cost, t.conv),
           useRoas: !!CONFIG.TARGET_ROAS || (!CONFIG.TARGET_CPA && t.value > 0), total: t };
}

// 单个广告系列的效率建议
function suggest(c, ref) {
  derived(c);
  c.util = c.daily ? (c.last7 / 7) / c.daily : '';
  c.shareConv = div(c.conv, ref.total.conv);
  c.shareValue = div(c.value, ref.total.value);
  var good, bad;
  if (ref.useRoas && ref.roas) { good = c.roas !== '' && c.roas >= ref.roas; bad = c.cost > 0 && (c.roas === '' || c.roas < ref.roas * 0.7); }
  else if (ref.cpa) { good = c.cpa !== '' && c.cpa <= ref.cpa; bad = c.cost > 0 && (c.cpa === '' || c.cpa > ref.cpa * 1.3); }
  var limited = (c.lostBudget !== '' && c.lostBudget >= 0.1) || (c.util !== '' && c.util >= 0.95);
  c.advice = ''; c.newDaily = c.daily;
  if (good && limited) { c.advice = '效果好且受预算限制：建议增加预算'; c.newDaily = c.daily * 1.2; }
  else if (bad && c.conv < 1 && c.cost > (ref.cpa || 0) * 2) { c.advice = '花了较多钱但几乎没有转化：建议降低预算或检查投放'; c.newDaily = c.daily * 0.7; }
  else if (bad) { c.advice = '效率低于目标：建议降低预算，把钱给效果好的系列'; c.newDaily = c.daily * 0.8; }
  else if (c.util !== '' && c.util < 0.5 && c.daily > 0) { c.advice = '预算只用了一半不到：提高预算没有用，先看出价、关键字或素材'; }
  else if (good) { c.advice = '效果达标，预算充足'; }
  if (c.shared) { c.advice = (c.advice ? c.advice + '（' : '（') + '共享预算「' + c.budgetName + '」，请在预算层面统一调整）'; c.newDaily = c.daily; }
}


// ======================= 输出 =======================

function writePacing(ss, units, cal) {
  var head = ['预算', '状态', '月预算', '本月已花（含今天）', '今天已花', '最近 7 天日均', '预测月底花费', '预测 / 月预算',
              '建议每日花费', '当前每日预算合计', '建议调整比例', '广告系列数'];
  var data = units.map(function (u) {
    return [u.name, u.status, u.monthly || '', u.mtd, u.todayCost, u.avg7, u.forecast, u.ratio, u.neededDaily, u.dailyBudget,
            u.factor === '' ? '' : u.factor - 1, u.camps.length];
  });
  write(ss, '节奏总览', head, data, ['', '', FMT.money, FMT.money, FMT.money, FMT.money, FMT.money, FMT.pct, FMT.money, FMT.money, '+0%;-0%;0%', FMT.int],
    { title: '本月第 ' + cal.day + ' / ' + cal.days + ' 天，剩余 ' + cal.left + ' 天（含今天）',
      widths: [160, 100], colors: { col: 1, fn: function (v) { return /超|不够/.test(v) ? '#fde2e1' : v === '花不完' ? '#fff1d6' : v === '正常' ? '#e3f4e8' : null; } } });
}

function writeCampaigns(ss, camps, ref) {
  camps.sort(function (a, b) { return b.cost - a.cost; });
  var head = ['广告系列', '类型', '分组', '预算名称', '共享预算', '日预算', '最近 7 天日均', '预算使用率', '因预算损失的展示份额', '本月已花']
    .concat(METRIC_HEAD).concat(['转化占比', '转化价值占比', '按转化占比分配', '按价值占比分配', '建议日预算', '建议']);
  var totalDaily = 0, seen = {};
  camps.forEach(function (c) { if (!seen[c.budgetRes]) { seen[c.budgetRes] = 1; totalDaily += c.daily; } });
  var data = camps.map(function (c) {
    return [c.name, c.type, c.group, c.budgetName, c.shared ? '是' : '', c.daily, c.last7 / 7, c.util, c.lostBudget, c.mtd]
      .concat(metricCells(c)).concat([c.shareConv, c.shareValue,
        c.shareConv === '' ? '' : totalDaily * c.shareConv, c.shareValue === '' ? '' : totalDaily * c.shareValue, c.newDaily, c.advice]);
  });
  write(ss, '广告系列预算', head, data,
    ['', '', '', '', '', FMT.money, FMT.money, FMT.pct, FMT.pct, FMT.money].concat(METRIC_FMT).concat([FMT.pct, FMT.pct, FMT.money, FMT.money, FMT.money, '']),
    { colors: { col: head.length - 1, fn: function (v) { return /增加/.test(v) ? '#e3f4e8' : /降低/.test(v) ? '#fde2e1' : /没有用/.test(v) ? '#fff1d6' : null; } } });
}

var HIST_HEAD = ['日期', '预算', '月预算', '本月已花', '最近 7 天日均', '预测月底', '状态'];
function writeHistory(ss, units, cal) {
  var sh = ensureSheet(ss, '每日记录', HIST_HEAD);
  upsertDay(sh, cal.today, units.map(function (u) { return [cal.today, u.name, u.monthly || '', u.mtd, u.avg7, u.forecast, u.status]; }), 400);
}

function buildActions(units, camps, ref, cal) {
  var A = [];
  units.forEach(function (u) {
    if (!u.monthly) return;
    var d = '月预算 ' + r2(u.monthly) + '，已花 ' + r2(u.mtd) + '，预测月底 ' + r2(u.forecast) + '（' + pct(u.ratio) + '）';
    if (u.status === '已超预算') A.push(['高', '预算', u.name, '本月花费已经超过月预算', d, '暂停或大幅降低这一组的预算，或者确认是否追加预算']);
    else if (u.status === '超支风险') A.push(['高', '预算', u.name, '按最近速度月底会超支', d, '把每日花费控制在 ' + r2(u.neededDaily) + ' 左右（当前日预算合计 ' + r2(u.dailyBudget) + '），优先降低效率低的系列']);
    else if (u.status === '日预算不够') A.push(['中', '预算', u.name, '当前日预算全部花完也用不完月预算', d, '日预算合计至少提高到 ' + r2(u.neededDaily) + '，加给「广告系列预算」表里效果好且受预算限制的系列']);
    else if (u.status === '花不完') A.push(['中', '预算', u.name, '按最近速度月底花不完', d, '日预算够用但实际花不出去，通常是出价太保守、关键字太少或素材受限，先查投放而不是加预算']);
  });
  camps.filter(function (c) { return /增加/.test(c.advice); }).slice(0, 10).forEach(function (c) {
    A.push(['中', '广告系列', c.name, '效果好但受预算限制', '因预算损失展示份额 ' + pct(c.lostBudget) + '，ROAS ' + r2(c.roas) + '，CPA ' + r2(c.cpa), c.shared ? '共享预算「' + c.budgetName + '」：在预算层面提高，或把这个系列移到单独预算' : '日预算从 ' + r2(c.daily) + ' 提高到约 ' + r2(c.newDaily)]);
  });
  camps.filter(function (c) { return /降低/.test(c.advice); }).sort(function (a, b) { return b.cost - a.cost; }).slice(0, 10).forEach(function (c) {
    A.push([c.conv < 1 ? '高' : '中', '广告系列', c.name, c.advice.split('：')[0], '花费 ' + r2(c.cost) + '，转化 ' + r2(c.conv) + '，ROAS ' + r2(c.roas), c.shared ? '共享预算「' + c.budgetName + '」：建议把这个系列移出共享预算单独控制' : '日预算从 ' + r2(c.daily) + ' 降到约 ' + r2(c.newDaily)]);
  });
  if (!CONFIG.MONTHLY_BUDGET && !CONFIG.GROUPS.length) A.push(['低', '说明', '—', '还没有设置月预算', '', '在设置里填 MONTHLY_BUDGET 或 GROUPS，才能计算花费节奏']);
  return A;
}

// 自动调整：每天最多一次，按节奏比例缩放非共享预算
function apply(ss, units, cal) {
  if (stateGet(ss, 'applied') === cal.today) { log('信息', '自动调整', '今天已经调整过，跳过'); return; }
  var max = CONFIG.MAX_CHANGE_PCT / 100, n = 0;
  units.filter(function (u) { return u.monthly && u.factor !== '' && u.name !== '（未分组）'; }).forEach(function (u) {
    // 有分组时只调整分组，不再按账户整体调整，避免同一个预算被调两次
    if (u.name === '整个账户' && CONFIG.GROUPS.length) return;
    var f = Math.min(1 + max, Math.max(1 - max, u.factor));
    if (Math.abs(f - 1) < 0.03) return;
    u.camps.forEach(function (c) {
      if (c.shared || !c.daily) return;
      var id = c.budgetRes.split('/').pop();
      var it = AdsApp.budgets().withIds([Number(id)]).get();
      if (!it.hasNext()) return;
      var nb = Math.round(c.daily * f * 100) / 100;
      it.next().setAmount(nb); n++;
      log('信息', '自动调整', c.name + '：' + r2(c.daily) + ' → ' + r2(nb));
    });
  });
  if (!isPreview()) stateSet(ss, 'applied', cal.today);
  log('信息', '自动调整', (isPreview() ? '（预览模式不会真的修改）' : '') + '调整了 ' + n + ' 个预算');
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
