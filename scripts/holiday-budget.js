/**
 * 海外节假日与大促预算排期 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：
 *   1. 内置欧美、中东、日本等市场的节假日和大促日历（黑五、网一、圣诞、节礼日、情人节、母亲节、斋月、Prime Day 等），
 *      第一次运行写入「活动日历」表，之后可以直接在表格里增删改；
 *   2. 提前提醒：未来 45 天内的活动，按倒计时列出要做的事（素材、促销、Merchant Center、预算、季节性调整、物流截止日）；
 *   3. 去年同期对比：自动查询去年同一个活动期间的转化率、花费和 ROAS 变化，作为今年预算倍数的参考；
 *   4. 可选自动调整预算（默认关闭）：活动开始时按倍数提高匹配广告系列的预算，结束后自动恢复原预算。
 *
 * 毕瑞出海原创脚本。
 *
 * 教程：https://berightdigital.com/google-ads-holiday-budget-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 提醒邮箱（留空 = 不发）
  EMAIL: '',

  // 你的目标市场（国家代码），只提醒这些市场的活动。留空 = 所有市场
  MARKETS: ['US', 'GB', 'DE', 'CA', 'AU'],
  // 提前多少天开始提醒
  LOOKAHEAD_DAYS: 45,
  // 在活动前多少天发邮件提醒（可以多个）
  REMIND_DAYS: [21, 7, 2],

  // 是否在活动期间自动提高预算、结束后恢复（默认关闭）
  APPLY_BUDGETS: false,
  // 自动调整时预算最多提高到原来的多少倍（安全上限）
  MAX_MULTIPLIER: 3
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var CAL_HEAD = ['启用', '活动', '市场', '开始', '结束', '预热天数', '预算倍数', '广告系列名称包含', '备注'];
// 内置日历（日期为当地日期；带「约」的是预计日期，请在表格里按官方公布更新）
var DEFAULT_EVENTS = [
  ['是', '黑色星期五', 'US,CA,GB,DE,FR,AU,ES,IT,NL', '2026-11-27', '2026-11-27', 7, 1.8, '', '黑五周：感恩节到网一'],
  ['是', '网络星期一', 'US,CA,GB,DE,AU', '2026-11-30', '2026-11-30', 0, 1.6, '', ''],
  ['是', '圣诞节（下单高峰）', 'US,CA,GB,DE,FR,AU,ES,IT,NL', '2026-12-01', '2026-12-18', 3, 1.3, '', '以美国标准快递截止日（约 12 月 15–18 日）为准，海外仓发货可以延后'],
  ['是', '节礼日 Boxing Day', 'GB,CA,AU,NZ', '2026-12-26', '2026-12-31', 0, 1.4, '', '英联邦国家的年末大促'],
  ['是', '新年促销', 'US,GB,DE,CA,AU', '2027-01-01', '2027-01-03', 0, 1.1, '', ''],
  ['是', '春节（国内工厂停工）', 'ALL', '2027-01-25', '2027-02-20', 0, 1, '', '春节 2027-02-06：提前备货、确认发货时间，避免缺货和延迟发货影响账户'],
  ['是', '情人节', 'US,GB,CA,AU,DE,FR', '2027-02-07', '2027-02-14', 0, 1.3, '', '珠宝、礼品、服饰、美妆'],
  ['是', '斋月（约）', 'AE,SA,EG,MY,ID,TR', '2027-02-08', '2027-03-09', 0, 1.2, '', '日期按月相，约前后 1–2 天；斋月期间晚间流量高'],
  ['是', '开斋节（约）', 'AE,SA,EG,MY,ID,TR', '2027-03-10', '2027-03-12', 7, 1.4, '', '节前一周是送礼和购物高峰'],
  ['是', '英国母亲节', 'GB,IE', '2027-03-07', '2027-03-07', 10, 1.3, '', '英国母亲节是复活节前三周的星期日'],
  ['是', '复活节', 'US,GB,DE,AU,CA,FR,IT,ES,NL', '2027-03-26', '2027-03-29', 7, 1.2, '', ''],
  ['是', '日本黄金周', 'JP', '2027-04-29', '2027-05-05', 3, 1.2, '', ''],
  ['是', '美国/加拿大/澳洲/德国母亲节', 'US,CA,AU,DE,IT,JP', '2027-05-09', '2027-05-09', 14, 1.4, '', '五月第二个星期日'],
  ['是', '美国阵亡将士纪念日促销', 'US', '2027-05-28', '2027-05-31', 0, 1.2, '', ''],
  ['是', '父亲节', 'US,CA,GB', '2027-06-20', '2027-06-20', 14, 1.3, '', '六月第三个星期日'],
  ['是', '美国独立日促销', 'US', '2027-07-02', '2027-07-05', 0, 1.1, '', ''],
  ['是', 'Prime Day（约）', 'US,GB,DE,CA,JP,FR,IT,ES,AU', '2027-07-13', '2027-07-16', 3, 1.3, '', '日期以亚马逊公布为准；独立站可以同期做「反 Prime Day」促销'],
  ['是', '美国返校季', 'US,CA', '2027-07-15', '2027-09-05', 0, 1.15, '', '文具、电子、服饰、背包'],
  ['是', '美国劳动节促销', 'US', '2027-09-03', '2027-09-06', 0, 1.2, '', ''],
  ['是', '排灯节 Diwali（约）', 'IN', '2027-10-29', '2027-10-29', 14, 1.4, '', ''],
  ['是', '万圣节', 'US,CA,GB', '2027-10-15', '2027-10-31', 0, 1.2, '', '服装、装饰、派对用品'],
  ['是', '黑色星期五', 'US,CA,GB,DE,FR,AU,ES,IT,NL', '2027-11-26', '2027-11-26', 7, 1.8, '', ''],
  ['是', '网络星期一', 'US,CA,GB,DE,AU', '2027-11-29', '2027-11-29', 0, 1.6, '', '']
];


function main() {
  var ss = openSpreadsheet('节假日预算排期');
  log('信息', '开始', '版本 ' + VERSION);
  var events = safe('活动日历', function () { return readCalendar(ss); }) || [];
  var t = today();
  var mine = events.filter(function (e) { return e.on && marketMatch(e); });
  log('信息', '日历', events.length + ' 个活动，其中符合你的市场 ' + mine.length + ' 个');

  var upcoming = mine.filter(function (e) { return e.end >= t && daysBetween(t, e.start) <= CONFIG.LOOKAHEAD_DAYS; });
  upcoming.forEach(function (e) { e.lastYear = safe('去年同期 ' + e.name, function () { return lastYear(e); }); });

  var A = [];
  safe('即将到来', function () { writeUpcoming(ss, upcoming, t, A); });
  var changes = CONFIG.APPLY_BUDGETS ? (safe('自动预算', function () { return applyBudgets(ss, mine, t); }) || []) : [];
  if (changes.length) A.unshift(['中', '自动预算', changes.length + ' 个预算', '今天自动调整了预算', changes.slice(0, 5).join('；'), '活动结束后会自动恢复原预算']);
  safe('行动清单', function () { writeActions(ss, A, '未来 ' + CONFIG.LOOKAHEAD_DAYS + ' 天没有目标市场的活动'); });

  var remind = upcoming.filter(function (e) { var d = daysBetween(t, e.warmStart); return CONFIG.REMIND_DAYS.indexOf(d) >= 0 || d === 0; });
  if (CONFIG.EMAIL && (remind.length || changes.length) && stateGet(ss, 'mailed') !== t) safe('邮件', function () {
    if (!isPreview()) stateSet(ss, 'mailed', t);
    mail('[大促提醒] ' + AdsApp.currentAccount().getName() + '：' + remind.map(function (e) { return e.name + '（' + daysBetween(t, e.start) + ' 天后）'; }).join('、'),
      '即将到来的活动和需要准备的事项：', [['优先级', '活动', '时间', '要做的事', '参考']].concat(A.slice(0, 20).map(function (x) { return [x[0], x[2], x[4], x[5], x[3]]; })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '海外节假日与大促预算排期', VERSION, [
      ['目标市场', CONFIG.MARKETS.length ? CONFIG.MARKETS.join('、') : '所有市场'],
      ['自动预算', CONFIG.APPLY_BUDGETS ? '开启：活动期间（含预热天数）把匹配系列的预算乘以倍数，结束后恢复' : '关闭（只提醒）'],
      ['', ''],
      ['活动日历', '可以直接编辑：改日期、加自己的店庆和新品发布、把不需要的活动「启用」改成「否」。市场写国家代码，用英文逗号分隔，ALL 表示所有市场'],
      ['行动清单', '未来 ' + CONFIG.LOOKAHEAD_DAYS + ' 天的活动和倒计时待办'],
      ['即将到来', '每个活动的时间、预算倍数、去年同期表现'],
      ['注意', '带「约」的日期是预计日期（斋月、开斋节、Prime Day、排灯节等），请按官方公布更新；日期按当地日期，和账户时区可能差一天']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '即将到来', '活动日历', '运行日志']);
}


// ======================= 日历 =======================

function readCalendar(ss) {
  var sh = ss.getSheetByName('活动日历');
  if (!sh) {
    sh = ensureSheet(ss, '活动日历', CAL_HEAD);
    sh.getRange(2, 4, DEFAULT_EVENTS.length, 2).setNumberFormat('@');
    sh.getRange(2, 1, DEFAULT_EVENTS.length, CAL_HEAD.length).setValues(DEFAULT_EVENTS);
    log('信息', '日历', '已写入内置日历，可以在「活动日历」表里修改');
  }
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CAL_HEAD.length).getValues().filter(function (r) { return r[1] && r[3]; }).map(function (r) {
    var start = dateStr(r[3]), end = dateStr(r[4] || r[3]), warm = num(r[5]);
    return { on: String(r[0]).trim() !== '否', name: String(r[1]), markets: String(r[2] || 'ALL').toUpperCase().split(/[,，\s]+/).filter(String),
      start: start, end: end < start ? start : end, warm: warm, warmStart: addDays(start, -warm), mult: num(r[6]) || 1, contains: String(r[7] || ''), note: String(r[8] || '') };
  });
}

function marketMatch(e) {
  if (!CONFIG.MARKETS.length || e.markets.indexOf('ALL') >= 0) return true;
  return e.markets.some(function (m) { return CONFIG.MARKETS.indexOf(m) >= 0; });
}

function addDays(ymd, n) { var p = ymd.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 864e5).toISOString().slice(0, 10); }
function daysBetween(a, b) { var pa = a.split('-'), pb = b.split('-'); return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 864e5); }


// ======================= 去年同期 =======================

// 往前推 364 天（52 周），让星期几对齐；活动期间（含预热）对比之前 14 天
function lastYear(e) {
  var s = addDays(e.warmStart, -364), en = addDays(e.end, -364);
  if (daysBetween(en, today()) < 1) return null;
  var before = [addDays(s, -14), addDays(s, -1)];
  var filter = e.contains ? ' AND campaign.name LIKE "%' + clean(e.contains).replace(/%/g, '') + '%"' : '';
  function sum(from, to) {
    var t = zero({});
    (tryQuery('去年同期', 'SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ' + between(from, to) + filter) || [])
      .forEach(function (r) { addMetrics(t, metricsOf(r)); });
    var days = daysBetween(from, to) + 1;
    ['impr', 'clicks', 'cost', 'conv', 'value'].forEach(function (k) { t[k] = t[k] / days; });
    return derived(t);
  }
  var ev = sum(s, en), b = sum(before[0], before[1]);
  if (!b.cost && !ev.cost) return null;
  return { from: s, to: en, ev: ev, before: b,
    costUp: b.cost ? ev.cost / b.cost - 1 : '', convUp: b.conv ? ev.conv / b.conv - 1 : '', cvrUp: b.cvr ? num(ev.cvr) / num(b.cvr) - 1 : '', roasUp: b.roas ? num(ev.roas) / num(b.roas) - 1 : '' };
}


// ======================= 输出 =======================

function todo(e, d) {
  var list = [];
  if (d > 21) list.push('确定促销方案和折扣；准备活动素材（图片、视频、广告标题里的促销信息）');
  if (d <= 21 && d > 7) list.push('上线促销素材资源组和附加信息（宣传信息、价格、促销附加信息）；在 Merchant Center 设置促销（Promotions）；检查库存');
  if (d <= 7 && d > 0) list.push('提高预算（预计倍数 ' + e.mult + '）；智能出价账户如果活动只有 1–7 天且预计转化率明显上升，可以设置「季节性调整」');
  if (d <= 0) list.push('活动进行中：每天检查预算是否提前花完、转化跟踪是否正常、缺货商品是否已暂停');
  if (/圣诞|节礼|Christmas/i.test(e.name)) list.push('在广告和网站写明最后下单日期（物流截止日），截止后推电子礼品卡或海外仓现货');
  if (/春节/.test(e.name)) list.push('提前确认工厂停工和物流停运时间，预估缺货商品；停工期间可以降低缺货商品的预算');
  return list.join('；');
}

function sp(x) { return x === '' ? '' : (x >= 0 ? '+' : '') + pct(x); }

function writeUpcoming(ss, ups, t, A) {
  ups.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  var data = ups.map(function (e) {
    var d = daysBetween(t, e.start), ly = e.lastYear;
    return [e.name, e.markets.join(','), e.warmStart, e.start, e.end, d > 0 ? d + ' 天后' : '进行中', e.mult, e.contains || '（全部）',
      ly ? sp(ly.costUp) : '', ly ? sp(ly.convUp) : '', ly ? sp(ly.cvrUp) : '', ly ? sp(ly.roasUp) : '', todo(e, daysBetween(t, e.warmStart)), e.note];
  });
  write(ss, '即将到来', ['活动', '市场', '预热开始', '开始', '结束', '倒计时', '预算倍数', '广告系列', '去年 花费变化', '去年 转化变化', '去年 转化率变化', '去年 ROAS 变化', '现在该做', '备注'],
    data, ['', '', '@', '@', '@', '', '0.00', '', '', '', '', '', '', ''], { wrap: true, widths: [160, 140, 90, 90, 90, 80, 70, 120, 90, 90, 100, 100, 420, 260],
      empty: '未来 ' + CONFIG.LOOKAHEAD_DAYS + ' 天没有目标市场的活动', title: '去年同期 = 去年同一活动期间日均 vs 活动前 14 天日均（往前推 52 周，星期对齐）' });
  ups.forEach(function (e) {
    var d = daysBetween(t, e.warmStart), ly = e.lastYear;
    var lyText = ly ? '去年同期：转化 ' + sp(ly.convUp) + '，转化率 ' + sp(ly.cvrUp) + '，ROAS ' + sp(ly.roasUp) : '没有去年同期数据';
    A.push([d <= 7 ? '高' : d <= 21 ? '中' : '低', '活动', e.name + '（' + e.markets.slice(0, 4).join(',') + '）', e.start === e.end ? e.start : e.start + ' 至 ' + e.end, d > 0 ? '预热还有 ' + d + ' 天' : '进行中', todo(e, d)]);
    if (ly && ly.cvrUp !== '' && ly.cvrUp >= 0.3) A.push(['中', '去年参考', e.name, lyText, '', '去年活动期间转化率明显上升：预算倍数可以参考转化变化设置，智能出价可以考虑季节性调整']);
    else if (ly && ly.roasUp !== '' && ly.roasUp <= -0.2) A.push(['中', '去年参考', e.name, lyText, '', '去年活动期间 ROAS 下降：竞争加剧时 CPC 会上升，加预算前先确认促销力度和利润']);
  });
}


// ======================= 自动预算 =======================

// 隐藏表 _原预算：预算 ID | 原金额 | 当前生效的活动 | 当前倍数
// 每天按「今天正在进行的活动里最高的倍数」设置预算：原预算 × 倍数；没有活动时恢复原预算。重叠的活动不会叠加相乘。
function applyBudgets(ss, events, t) {
  var sh = ss.getSheetByName('_原预算') || ss.insertSheet('_原预算');
  var saved = {}, n = sh.getLastRow();
  if (n) sh.getRange(1, 1, n, 4).getValues().forEach(function (r) { if (r[0]) saved[String(r[0])] = { amount: num(r[1]), event: String(r[2]), mult: num(r[3]) || 1 }; });
  var changes = [];
  if (stateGet(ss, 'budgetRun') === t) { log('信息', '自动预算', '今天已经处理过，跳过'); return changes; }

  // 今天每个预算应该用的倍数
  var want = {}, info = {};
  events.filter(function (e) { return e.mult > 1 && e.warmStart <= t && e.end >= t; }).forEach(function (e) {
    var q = 'SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros FROM campaign WHERE campaign.status = "ENABLED"' +
      (e.contains ? ' AND campaign.name LIKE "%' + clean(e.contains).replace(/%/g, '') + '%"' : '');
    (tryQuery('预算', q) || []).forEach(function (r) {
      var id = String(g(r, 'campaignBudget.id')), mult = Math.min(e.mult, CONFIG.MAX_MULTIPLIER);
      info[id] = { name: String(g(r, 'campaignBudget.name')), cur: money(g(r, 'campaignBudget.amountMicros')) };
      if (!want[id] || mult > want[id].mult) want[id] = { mult: mult, event: e.name };
    });
  });

  function setBudget(id, amount) {
    var it = AdsApp.budgets().withIds([Number(id)]).get();
    if (!it.hasNext()) return null;
    var b = it.next(); b.setAmount(amount); return b;
  }
  // 1. 恢复：之前提高过、今天没有活动的预算
  Object.keys(saved).forEach(function (id) {
    if (want[id]) return;
    var b = setBudget(id, saved[id].amount);
    if (b) changes.push('恢复「' + b.getName() + '」到 ' + r2(saved[id].amount) + '（' + saved[id].event + ' 已结束）');
    delete saved[id];
  });
  // 2. 提高或调整到今天的倍数（以原预算为基础，不会越调越高）
  Object.keys(want).forEach(function (id) {
    var w = want[id], orig = saved[id] ? saved[id].amount : info[id].cur;
    if (!orig) return;
    if (saved[id] && saved[id].mult === w.mult) { saved[id].event = w.event; return; }
    var nb = Math.round(orig * w.mult * 100) / 100;
    if (setBudget(id, nb)) changes.push('「' + info[id].name + '」' + r2(orig) + ' → ' + r2(nb) + '（' + w.event + '，×' + w.mult + '）');
    saved[id] = { amount: orig, event: w.event, mult: w.mult };
  });

  if (!isPreview()) {
    sh.clear();
    var rows = Object.keys(saved).map(function (id) { return [id, saved[id].amount, saved[id].event, saved[id].mult]; });
    if (rows.length) { sh.getRange(1, 1, rows.length, 4).setNumberFormat('@'); sh.getRange(1, 1, rows.length, 4).setValues(rows); }
    stateSet(ss, 'budgetRun', t);
  }
  sh.hideSheet();
  changes.forEach(function (c) { log('信息', '自动预算', (isPreview() ? '（预览，不会真的修改）' : '') + c); });
  return changes;
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
