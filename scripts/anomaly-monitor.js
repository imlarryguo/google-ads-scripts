/**
 * 账户异常监控 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：建议每小时运行一次，及早发现这些情况并发邮件：
 *   1. 账户或广告系列突然没有展示（付款失败、广告被拒、预算花完、被暂停）；
 *   2. 今天的花费、点击、展示比过去 4 周同一天同一时段明显偏高或偏低；
 *   3. 某个转化操作连续两天没有转化（转化代码掉了、表单坏了、网站改版）；
 *   4. 转化率突然下降（落地页、结账、表单出问题）；
 *   5. 被拒登的广告数量增加；有预算的广告系列昨天零展示。
 *
 * 思路参考 Optmyzr 的零展示提醒脚本和 Francesco Cifardi 的转化异常检测脚本，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-anomaly-alert-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 提醒邮箱（建议填写，这个脚本的价值就在于及时提醒）。多个用英文逗号分隔。
  EMAIL: '',

  // 只看名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // Google 的分小时数据通常有延迟，只比较这么多小时以前的数据
  DATA_DELAY_HOURS: 3,
  // 连续多少小时没有展示就提醒（会考虑过去同时段是否本来就有展示，例如夜间不投放就不会误报）
  ZERO_HOURS: 4,

  // 今天到目前为止，和过去 4 周同一天同一时段平均值相比：
  SPEND_SPIKE_PCT: 80,   // 花费高出 80% 以上 → 提醒
  DROP_PCT: 50,          // 展示或点击低了 50% 以上 → 提醒
  MIN_BASELINE_COST: 20, // 基准花费低于这个值时不判断（数据太少容易误报）

  // 转化操作：过去 28 天平均每天至少有这么多次转化，最近 2 天却是 0 → 提醒
  CONV_ACTION_MIN_DAILY: 1,
  // 转化率：昨天比过去 28 天下降这么多（且昨天点击 ≥ 50）→ 提醒
  CVR_DROP_PCT: 50,

  // 同一个问题多少小时内不重复提醒
  REALERT_HOURS: 12,
  // 告警记录保留多少天
  KEEP_DAYS: 90
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';


function main() {
  var ss = openSpreadsheet('账户异常监控');
  var now = new Date();
  var hour = Number(Utilities.formatDate(now, tz(), 'HH'));
  var upto = hour - CONFIG.DATA_DELAY_HOURS; // 比较 0 点到 upto-1 点（完整小时）
  log('信息', '开始', '版本 ' + VERSION + '，当前 ' + hour + ' 点，比较到 ' + (upto - 1) + ' 点的数据');

  var checks = [];   // [检查项, 状态, 说明]
  var alerts = [];   // {level, type, object, finding, data, advice, key}

  safe('分时段对比', function () { hourlyChecks(upto, checks, alerts); });
  safe('转化操作', function () { conversionChecks(ss, checks, alerts); });
  safe('转化率', function () { cvrCheck(checks, alerts); });
  safe('零展示广告系列', function () { zeroCampaigns(checks, alerts); });
  safe('拒登广告', function () { disapprovals(ss, checks, alerts); });

  var fresh = safe('去重', function () { return dedupe(ss, alerts); }) || alerts;
  safe('当前状态', function () {
    write(ss, '当前状态', ['检查项', '状态', '说明'], checks, null,
      { title: '最近一次检查：' + Utilities.formatDate(now, tz(), 'yyyy-MM-dd HH:mm'), widths: [220, 90, 700], wrap: true,
        colors: { col: 1, fn: function (v) { return v === '异常' ? '#fde2e1' : v === '注意' ? '#fff1d6' : v === '正常' ? '#e3f4e8' : null; } } });
  });
  safe('告警记录', function () { history(ss, alerts, fresh); });
  safe('行动清单', function () {
    writeActions(ss, alerts.map(function (a) { return [a.level, a.type, a.object, a.finding, a.data, a.advice]; }), '所有检查项正常');
  });

  if (CONFIG.EMAIL && fresh.length) safe('邮件', function () {
    var rows = [['级别', '类型', '对象', '发现', '数据', '建议']].concat(fresh.map(function (a) { return [a.level, a.type, a.object, a.finding, a.data, a.advice]; }));
    var hi = fresh.filter(function (a) { return a.level === '高'; }).length;
    mail('[账户异常] ' + AdsApp.currentAccount().getName() + '：' + fresh.length + ' 项' + (hi ? '（' + hi + ' 项严重）' : ''),
      '检查时间 ' + Utilities.formatDate(now, tz(), 'yyyy-MM-dd HH:mm') + '。以下是新发现的异常：', rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '账户异常监控', VERSION, [
      ['运行频率', '建议设为「每小时」'],
      ['对比方法', '今天 0 点到 ' + (upto - 1) + ' 点，对比过去 4 周同一天（同为星期' + '一二三四五六日'.charAt(Number(Utilities.formatDate(new Date(), tz(), 'u')) - 1) + '）同一时段的平均值'],
      ['零展示', '连续 ' + CONFIG.ZERO_HOURS + ' 小时没有展示，而过去同时段平常有展示'],
      ['转化操作', '过去 28 天日均 ≥ ' + CONFIG.CONV_ACTION_MIN_DAILY + ' 次、最近 2 天为 0'],
      ['重复提醒', '同一个问题 ' + CONFIG.REALERT_HOURS + ' 小时内只提醒一次'],
      ['', ''],
      ['当前状态', '每一项检查的结果'],
      ['行动清单', '本次发现的所有异常和处理建议'],
      ['告警记录', '历史告警，方便回看问题从什么时候开始'],
      ['注意', '转化数据通常有延迟（尤其是离线导入和跨设备转化），当天的转化下降不单独提醒，只看最近两天和转化操作层面']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '当前状态', '转化操作', '告警记录', '运行日志']);
}


// ======================= 1. 分时段对比（今天 vs 过去 4 周同一天） =======================

function hourlyChecks(upto, checks, alerts) {
  if (upto < 1) { checks.push(['今天的花费节奏', '跳过', '今天的完整数据还不够（数据延迟 ' + CONFIG.DATA_DELAY_HOURS + ' 小时），稍后再比较']); }
  var dates = [today(), dayStr(-7), dayStr(-14), dayStr(-21), dayStr(-28)];
  var rows = runQuery('SELECT campaign.name, segments.date, segments.hour, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions ' +
    'FROM campaign WHERE ' + between(dayStr(-28), today()) + ' AND campaign.status = "ENABLED"' + nameFilter());
  var acc = {}, camp = {};
  dates.forEach(function (d) { acc[d] = []; for (var h = 0; h < 24; h++) acc[d].push(zero({})); });
  rows.forEach(function (r) {
    var d = String(g(r, 'segments.date')); if (!acc[d]) return;
    var h = num(g(r, 'segments.hour')), m = metricsOf(r);
    addMetrics(acc[d][h], m);
    var name = String(g(r, 'campaign.name'));
    var c = camp[name] || (camp[name] = {});
    if (!c[d]) { c[d] = []; for (var k = 0; k < 24; k++) c[d].push(zero({})); }
    addMetrics(c[d][h], m);
  });

  // 零展示：最近 ZERO_HOURS 个完整小时
  var zFrom = Math.max(0, upto - CONFIG.ZERO_HOURS);
  if (upto >= CONFIG.ZERO_HOURS) {
    var nowImpr = sumHours(acc[today()], zFrom, upto).impr;
    var baseImpr = avg(dates.slice(1).map(function (d) { return sumHours(acc[d], zFrom, upto).impr; }));
    if (nowImpr === 0 && baseImpr >= 20) {
      checks.push(['账户展示', '异常', zFrom + '–' + (upto - 1) + ' 点没有任何展示，过去同时段平均 ' + Math.round(baseImpr) + ' 次']);
      alerts.push({ level: '高', type: '零展示', object: '整个账户', finding: '最近 ' + CONFIG.ZERO_HOURS + ' 小时没有展示', data: '过去同时段平均 ' + Math.round(baseImpr) + ' 次展示',
        advice: '依次检查：付款方式和账单（最常见）、账户是否被暂停、广告是否被拒、预算和投放时间设置', key: 'zero-account' });
    } else checks.push(['账户展示', '正常', zFrom + '–' + (upto - 1) + ' 点展示 ' + nowImpr + ' 次（过去同时段平均 ' + Math.round(baseImpr) + '）']);

    Object.keys(camp).forEach(function (name) {
      var c = camp[name];
      var n = c[today()] ? sumHours(c[today()], zFrom, upto).impr : 0;
      var b = avg(dates.slice(1).map(function (d) { return c[d] ? sumHours(c[d], zFrom, upto).impr : 0; }));
      if (n === 0 && b >= 50 && nowImpr > 0) alerts.push({ level: '高', type: '零展示', object: name, finding: '这个广告系列最近 ' + CONFIG.ZERO_HOURS + ' 小时没有展示', data: '过去同时段平均 ' + Math.round(b) + ' 次',
        advice: '检查预算是否已经花完、广告是否被拒、出价或投放时间是否被改过（可以配合「账户变更提醒」脚本查谁改了什么）', key: 'zero-' + name });
    });
  }

  // 今天到目前为止 vs 基准
  if (upto >= 1) {
    var t = sumHours(acc[today()], 0, upto);
    var base = zero({});
    var bs = dates.slice(1).map(function (d) { return sumHours(acc[d], 0, upto); });
    ['impr', 'clicks', 'cost', 'conv'].forEach(function (k) { base[k] = avg(bs.map(function (x) { return x[k]; })); });
    var note = '0–' + (upto - 1) + ' 点：花费 ' + r2(t.cost) + '（基准 ' + r2(base.cost) + '），点击 ' + t.clicks + '（基准 ' + Math.round(base.clicks) + '），展示 ' + t.impr + '（基准 ' + Math.round(base.impr) + '）';
    if (base.cost < CONFIG.MIN_BASELINE_COST) { checks.push(['今天的花费节奏', '跳过', '基准花费太低，不做判断。' + note]); return; }
    var status = '正常';
    if (t.cost > base.cost * (1 + CONFIG.SPEND_SPIKE_PCT / 100)) {
      status = '异常';
      alerts.push({ level: '高', type: '花费激增', object: '整个账户', finding: '今天到目前的花费比平常高 ' + Math.round((t.cost / base.cost - 1) * 100) + '%', data: note,
        advice: '看「广告系列」层面是哪个系列花得多；检查最近是否改了预算、出价策略、目标 CPA/ROAS，或开启了新的匹配方式', key: 'spike-account' });
      Object.keys(camp).forEach(function (name) {
        var c = camp[name]; if (!c[today()]) return;
        var ct = sumHours(c[today()], 0, upto).cost;
        var cb = avg(dates.slice(1).map(function (d) { return c[d] ? sumHours(c[d], 0, upto).cost : 0; }));
        if (ct > Math.max(cb * (1 + CONFIG.SPEND_SPIKE_PCT / 100), cb + CONFIG.MIN_BASELINE_COST)) alerts.push({ level: '中', type: '花费激增', object: name,
          finding: '这个系列今天花得比平常多', data: '今天 ' + r2(ct) + '，平常 ' + r2(cb), advice: '检查这个系列的搜索字词和出价设置', key: 'spike-' + name });
      });
    }
    if (base.impr >= 100 && t.impr < base.impr * (1 - CONFIG.DROP_PCT / 100)) {
      status = '异常';
      alerts.push({ level: '高', type: '流量下降', object: '整个账户', finding: '今天的展示比平常少 ' + Math.round((1 - t.impr / base.impr) * 100) + '%', data: note,
        advice: '检查是否有广告系列被暂停、广告被拒、预算被调低，或者付款出了问题', key: 'drop-impr' });
    } else if (base.clicks >= 20 && t.clicks < base.clicks * (1 - CONFIG.DROP_PCT / 100)) {
      if (status === '正常') status = '注意';
      alerts.push({ level: '中', type: '点击下降', object: '整个账户', finding: '今天的点击比平常少 ' + Math.round((1 - t.clicks / base.clicks) * 100) + '%', data: note,
        advice: '展示正常而点击少，通常是排名下降（竞争对手加价、出价被调低）或广告变了', key: 'drop-clicks' });
    }
    checks.push(['今天的花费节奏', status, note]);
  }
}

function sumHours(arr, from, to) {
  var t = zero({}); if (!arr) return t;
  for (var h = from; h < to && h < 24; h++) addMetrics(t, arr[h]);
  return t;
}
function avg(list) { return list.length ? list.reduce(function (s, x) { return s + x; }, 0) / list.length : 0; }


// ======================= 2. 转化操作 =======================

function conversionChecks(ss, checks, alerts) {
  var rows = runQuery('SELECT segments.conversion_action_name, segments.date, metrics.all_conversions FROM customer WHERE ' + range(30));
  var map = {};
  rows.forEach(function (r) {
    var n = String(g(r, 'segments.conversionActionName') || '（未命名）');
    var x = map[n] || (map[n] = { recent: 0, base: 0, last: '' });
    var d = String(g(r, 'segments.date')), v = num(g(r, 'metrics.allConversions'));
    if (d >= dayStr(-2)) x.recent += v; else x.base += v;
    if (v > 0 && d > x.last) x.last = d;
  });
  var data = [], bad = 0;
  Object.keys(map).forEach(function (n) {
    var x = map[n], daily = x.base / 28;
    var status = daily >= CONFIG.CONV_ACTION_MIN_DAILY && x.recent === 0 ? '异常' : '正常';
    if (status === '异常') {
      bad++;
      alerts.push({ level: '高', type: '转化跟踪', object: '转化操作：' + n, finding: '最近 2 天没有转化，平常每天约 ' + r2(daily) + ' 次', data: '最后一次有转化：' + (x.last || '30 天内没有'),
        advice: '用 Tag Assistant 检查网站上的转化代码；确认表单、结账页、感谢页能正常打开；如果是离线导入，检查导入任务是否失败', key: 'conv-' + n });
    }
    data.push([n, status, r2(daily), x.recent, x.last]);
  });
  data.sort(function (a, b) { return b[2] - a[2]; });
  write(ss, '转化操作', ['转化操作', '状态', '过去 28 天日均', '最近 2 天', '最后一次有转化'], data, null,
    { colors: { col: 1, fn: function (v) { return v === '异常' ? '#fde2e1' : '#e3f4e8'; } } });
  checks.push(['转化操作', bad ? '异常' : '正常', bad ? bad + ' 个转化操作最近 2 天没有转化，见「转化操作」表' : Object.keys(map).length + ' 个转化操作都正常']);
}


// ======================= 3. 转化率 =======================

function cvrCheck(checks, alerts) {
  var rows = runQuery('SELECT segments.date, metrics.clicks, metrics.conversions FROM customer WHERE ' + range(29));
  var y = { c: 0, v: 0 }, b = { c: 0, v: 0 };
  rows.forEach(function (r) {
    var d = String(g(r, 'segments.date'));
    var t = d === dayStr(-1) ? y : b;
    t.c += num(g(r, 'metrics.clicks')); t.v += num(g(r, 'metrics.conversions'));
  });
  var cy = div(y.v, y.c), cb = div(b.v, b.c);
  if (y.c < 50 || !cb) { checks.push(['昨天的转化率', '跳过', '点击太少或没有历史转化，不做判断']); return; }
  var drop = 1 - cy / cb;
  if (drop >= CONFIG.CVR_DROP_PCT / 100) {
    checks.push(['昨天的转化率', '异常', '昨天 ' + pct(cy) + '，过去 28 天 ' + pct(cb)]);
    alerts.push({ level: '高', type: '转化率下降', object: '整个账户', finding: '昨天的转化率比平常低 ' + Math.round(drop * 100) + '%', data: '昨天 ' + pct(cy) + '（' + y.c + ' 次点击），平常 ' + pct(cb),
      advice: '先确认转化跟踪正常（见「转化操作」），再检查落地页、价格、库存、结账或表单是否出问题', key: 'cvr' });
  } else checks.push(['昨天的转化率', '正常', '昨天 ' + pct(cy) + '，过去 28 天 ' + pct(cb)]);
}


// ======================= 4. 有预算但昨天零展示的广告系列 =======================

function zeroCampaigns(checks, alerts) {
  var rows = runQuery('SELECT campaign.name, segments.date, metrics.impressions FROM campaign WHERE ' + range(8) +
    ' AND campaign.status = "ENABLED" AND campaign.serving_status = "SERVING"' + nameFilter());
  var map = {};
  rows.forEach(function (r) {
    var n = String(g(r, 'campaign.name')), d = String(g(r, 'segments.date')), v = num(g(r, 'metrics.impressions'));
    var x = map[n] || (map[n] = { y: 0, before: 0 });
    if (d === dayStr(-1)) x.y += v; else x.before += v;
  });
  var n = 0;
  Object.keys(map).forEach(function (name) {
    var x = map[name];
    if (x.y === 0 && x.before >= 70) {
      n++;
      alerts.push({ level: '高', type: '零展示', object: name, finding: '昨天整天没有展示', data: '前 7 天共 ' + x.before + ' 次展示',
        advice: '检查广告和素材是否被拒、预算是否被改为极低、出价策略目标是否设得过高', key: 'zero-yday-' + name });
    }
  });
  checks.push(['昨天零展示的广告系列', n ? '异常' : '正常', n ? n + ' 个在投广告系列昨天零展示' : '没有']);
}


// ======================= 5. 拒登广告 =======================

function disapprovals(ss, checks, alerts) {
  var rows = tryQuery('拒登广告', 'SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status FROM ad_group_ad ' +
    'WHERE ad_group_ad.status = "ENABLED" AND ad_group.status = "ENABLED" AND campaign.status = "ENABLED" AND ad_group_ad.policy_summary.approval_status IN ("DISAPPROVED", "AREA_OF_INTEREST_ONLY", "APPROVED_LIMITED")' + nameFilter());
  if (!rows) { checks.push(['拒登广告', '跳过', '查询失败']); return; }
  var dis = rows.filter(function (r) { return g(r, 'adGroupAd.policySummary.approvalStatus') === 'DISAPPROVED'; });
  var lim = rows.length - dis.length;
  var prev = num(stateGet(ss, 'disapproved'));
  if (!isPreview()) stateSet(ss, 'disapproved', dis.length);
  var camps = {}; dis.forEach(function (r) { camps[g(r, 'campaign.name')] = (camps[g(r, 'campaign.name')] || 0) + 1; });
  var top = Object.keys(camps).sort(function (a, b) { return camps[b] - camps[a]; }).slice(0, 5).map(function (k) { return k + '（' + camps[k] + '）'; }).join('、');
  if (dis.length > prev) {
    alerts.push({ level: dis.length - prev >= 5 ? '高' : '中', type: '广告拒登', object: top || '—', finding: '被拒登的广告增加了 ' + (dis.length - prev) + ' 个', data: '当前 ' + dis.length + ' 个被拒登，' + lim + ' 个受限',
      advice: '到「广告」页面筛选「状态：已拒登」查看原因；常见原因：目标网址无法访问、商标、违规内容、目的地不符', key: 'dis-' + dis.length });
    checks.push(['拒登广告', '异常', '当前 ' + dis.length + ' 个（上次检查 ' + prev + ' 个），受限 ' + lim + ' 个']);
  } else checks.push(['拒登广告', dis.length ? '注意' : '正常', '当前 ' + dis.length + ' 个被拒登，' + lim + ' 个受限']);
}


// ======================= 去重和记录 =======================

function dedupe(ss, alerts) {
  var sh = ss.getSheetByName('_提醒时间') || ss.insertSheet('_提醒时间');
  var n = sh.getLastRow(), v = n ? sh.getRange(1, 1, n, 2).getValues() : [], last = {};
  v.forEach(function (r) { last[String(r[0])] = Number(r[1]); });
  var nowMs = Date.now(), fresh = [];
  alerts.forEach(function (a) {
    if (last[a.key] && nowMs - last[a.key] < CONFIG.REALERT_HOURS * 36e5) return;
    fresh.push(a); last[a.key] = nowMs;
  });
  if (!isPreview()) {
    var keep = Object.keys(last).filter(function (k) { return nowMs - last[k] < 7 * 864e5; }).map(function (k) { return [k, last[k]]; });
    sh.clear();
    if (keep.length) { sh.getRange(1, 1, keep.length, 1).setNumberFormat('@'); sh.getRange(1, 1, keep.length, 2).setValues(keep); }
  }
  sh.hideSheet();
  return fresh;
}

var HIST_HEAD = ['日期', '时间', '级别', '类型', '对象', '发现', '数据', '是否发送提醒'];
function history(ss, alerts, fresh) {
  if (!alerts.length) return;
  var sh = ensureSheet(ss, '告警记录', HIST_HEAD);
  var t = Utilities.formatDate(new Date(), tz(), 'HH:mm');
  var rows = alerts.map(function (a) { return [today(), t, a.level, a.type, a.object, a.finding, a.data, fresh.indexOf(a) >= 0 ? '是' : '（已提醒过）']; });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 2).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, HIST_HEAD.length).setValues(rows.map(cleanRow));
  upsertDay(sh, '0000-00-00', [], CONFIG.KEEP_DAYS);
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
