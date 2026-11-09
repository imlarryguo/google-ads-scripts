/**
 * 质量得分追踪与诊断脚本 v2.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：每天记录搜索广告关键字的质量得分和三个组成部分
 *       （预期点击率、广告相关性、着陆页体验），
 *       画出账户质量得分的变化趋势，找出得分下降和拖后腿的关键字，
 *       按花费排出优化优先级，并生成「行动清单」。
 *
 * 思路参考 Martin Roettgerding / Tibbe van Asten 的 Quality Score Tracker v3，代码为重新编写：
 *   - 使用 GAQL（AdsApp.search），不再使用旧版 AWQL 报告；
 *   - 记录三个组成部分，并按花费加权，而不只是展示加权；
 *   - 不依赖外部模板表格，不向任何第三方发送数据；
 *   - 新增关键字诊断、广告组汇总、得分变化提醒、行动清单、邮件通知；
 *   - 第一次运行时尝试回填过去的历史得分（账户支持时）。
 *
 * 使用方法和每个工作表的解读：https://berightdigital.com/quality-score-tracker-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',

  // 只分析名称包含这段文字的搜索广告系列（留空 = 全部）
  CAMPAIGN_NAME_CONTAINS: '',
  // 排除名称包含这段文字的广告系列（留空 = 不排除），例如 'Brand'
  CAMPAIGN_NAME_EXCLUDES: '',

  // 展示、点击、费用等效果数据的时间范围（天，截至昨天）。质量得分本身是当前值，不受影响。
  DAYS: 30,

  // true = 只统计 Google 搜索，不含搜索网络合作伙伴（质量得分只反映 Google 搜索）
  GOOGLE_SEARCH_ONLY: true,

  // 质量得分 ≤ 这个值算「低分」
  LOW_QS: 4,
  // 质量得分比上一次记录下降至少这么多分，就提醒
  DROP_ALERT: 2,
  // 优先级计算的目标分数：优先级 = 费用 × (目标分数 − 当前分数)
  TARGET_QS: 7,

  // 是否保存每个关键字每天的得分（数据量大时可以关掉，只保留每日汇总）
  SAVE_KEYWORD_HISTORY: true,
  // 关键字历史保留多少天，超过的自动删除，避免表格超过 1000 万格的上限
  KEYWORD_HISTORY_DAYS: 120,

  // 第一次运行时回填过去多少天的账户汇总（0 = 不回填）。需要账户支持历史质量得分数据。
  BACKFILL_DAYS: 90,

  // 「关键字诊断」最多写入多少行（按优先级排序）
  MAX_ROWS: 5000,

  // 有下降提醒时发邮件到这个地址（留空 = 不发）。多个邮箱用英文逗号分隔。
  EMAIL: '',
  // true = 每次运行都发邮件；false = 只在有得分下降时发
  EMAIL_ALWAYS: false
};
// ======================= 设置结束，下面的代码一般不需要改 =======================


var VERSION = 'v2.0';
var RUN_LOG = [];
var FMT = { money: '#,##0.00', int: '#,##0', pct: '0.0%', qs: '0.00', dec: '#,##0.00' };
var COMP_CN = { ABOVE_AVERAGE: '高于平均', AVERAGE: '平均', BELOW_AVERAGE: '低于平均', UNKNOWN: '', UNSPECIFIED: '' };
var MATCH_CN = { EXACT: '完全匹配', PHRASE: '词组匹配', BROAD: '广泛匹配' };
var COMPS = [
  { key: 'ctr', name: '预期点击率' },
  { key: 'rel', name: '广告相关性' },
  { key: 'lp',  name: '着陆页体验' }
];
var TIPS = {
  ctr: '预期点击率低：标题里放入关键字和具体卖点，补齐附加信息；用否定关键字和更窄的匹配去掉不相关的搜索',
  rel: '广告相关性低：把主题不同的关键字拆到不同广告组，让每组广告的标题直接使用组内关键字',
  lp:  '着陆页体验低：让关键字落到对应的商品或分类页，检查手机端速度、首屏内容和价格运费信息'
};


function main() {
  var started = new Date();
  var acct = AdsApp.currentAccount();
  var tz = acct.getTimeZone();
  var today = Utilities.formatDate(started, tz, 'yyyy-MM-dd');
  log('信息', '开始', '账户：' + acct.getName() + '（' + acct.getCustomerId() + '），版本 ' + VERSION + '，日期 ' + today);

  var ss = openSpreadsheet(acct);

  // 1. 读取当前所有关键字的质量得分和效果数据
  var kws = fetchKeywords();
  log('信息', '关键字', kws.length + ' 个有展示的搜索关键字，其中 ' +
      kws.filter(function (k) { return k.qs > 0; }).length + ' 个有质量得分');

  // 2. 和上一期对比
  var base = safe('读取对比基准', function () { return loadBaseline(ss, today); }) || { date: '', map: {} };
  kws.forEach(function (k) {
    var b = base.map[k.key];
    k.prevQs = b ? b.qs : '';
    k.change = (b && b.qs > 0 && k.qs > 0) ? k.qs - b.qs : '';
  });

  // 3. 汇总
  var summary = summarize(kws);

  // 4. 写各个工作表
  safe('关键字诊断',   function () { writeDiagnosis(ss, kws); });
  var ags = safe('广告组汇总', function () { return writeGroups(ss, kws, 'ag'); }) || [];
  safe('广告系列汇总', function () { writeGroups(ss, kws, 'camp'); });
  safe('得分变化',     function () { writeChanges(ss, kws, base.date); });
  safe('历史回填',     function () { backfill(ss, today); });
  safe('每日汇总',     function () { appendDaily(ss, today, summary); });
  if (CONFIG.SAVE_KEYWORD_HISTORY) safe('关键字历史', function () { appendKeywordHistory(ss, today, kws); });
  safe('保存快照',     function () { saveSnapshot(ss, today, kws); });
  safe('仪表盘',       function () { writeDashboard(ss, today, summary, base.date); });
  var actions = safe('行动清单', function () { return buildActions(ss, kws, summary, ags, base.date); }) || [];
  safe('使用说明',     function () { writeGuide(ss, acct, started); });

  log('信息', '完成', '用时 ' + Math.round((new Date() - started) / 1000) + ' 秒，表格：' + ss.getUrl());
  writeLog(ss);
  orderSheets(ss);

  var drops = kws.filter(function (k) { return k.change !== '' && k.change <= -CONFIG.DROP_ALERT; }).length;
  if (CONFIG.EMAIL && (CONFIG.EMAIL_ALWAYS || drops > 0)) {
    safe('邮件', function () { sendEmail(acct, ss, today, summary, actions, drops); });
  }
}


// ======================= 读取数据 =======================

function fetchKeywords() {
  var sel = 'SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ' +
    'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' +
    'ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ' +
    'ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';
  var where = ' FROM keyword_view WHERE ' + range(CONFIG.DAYS) +
    ' AND campaign.advertising_channel_type = "SEARCH" AND campaign.status = "ENABLED" AND ad_group.status = "ENABLED"' +
    ' AND ad_group_criterion.status = "ENABLED" AND ad_group_criterion.negative = FALSE' + nameFilters();

  var rows;
  if (CONFIG.GOOGLE_SEARCH_ONLY) {
    try {
      rows = runQuery(sel + ', segments.ad_network_type' + where + ' AND segments.ad_network_type = "SEARCH"');
    } catch (e) {
      log('提示', '关键字', '按网络筛选失败，改为包含所有搜索网络：' + e.message);
      rows = runQuery(sel + where);
    }
  } else {
    rows = runQuery(sel + where);
  }

  var map = {};
  rows.forEach(function (r) {
    var key = g(r, 'adGroup.id') + '~' + g(r, 'adGroupCriterion.criterionId');
    if (!map[key]) {
      var qi = 'adGroupCriterion.qualityInfo.';
      map[key] = zero({
        key: key, campaign: g(r, 'campaign.name'), group: g(r, 'adGroup.name'),
        text: g(r, 'adGroupCriterion.keyword.text'), match: g(r, 'adGroupCriterion.keyword.matchType'),
        qs: num(g(r, qi + 'qualityScore')),
        ctr: g(r, qi + 'searchPredictedCtr'), rel: g(r, qi + 'creativeQualityScore'), lp: g(r, qi + 'postClickQualityScore')
      });
    }
    addMetrics(map[key], metricsOf(r));
  });
  var list = values(map);
  list.forEach(function (k) {
    k.weak = COMPS.filter(function (c) { return k[c.key] === 'BELOW_AVERAGE'; }).map(function (c) { return c.key; });
    k.priority = k.qs > 0 ? k.cost * Math.max(0, CONFIG.TARGET_QS - k.qs) : 0;
  });
  return list;
}

function summarize(kws) {
  var s = { kw: 0, kwQs: 0, impr: 0, cost: 0, clicks: 0, conv: 0, value: 0,
            sumQs: 0, imprQs: 0, imprW: 0, costQs: 0, costW: 0,
            lowCost: 0, noQsCost: 0, dist: {}, comp: {} };
  for (var q = 1; q <= 10; q++) s.dist[q] = { n: 0, impr: 0, cost: 0 };
  s.dist['无'] = { n: 0, impr: 0, cost: 0 };
  COMPS.forEach(function (c) { s.comp[c.key] = { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, imprAll: 0 }; });

  kws.forEach(function (k) {
    s.kw++; s.impr += k.impr; s.cost += k.cost; s.clicks += k.clicks; s.conv += k.conv; s.value += k.value;
    var d = s.dist[k.qs > 0 ? k.qs : '无']; d.n++; d.impr += k.impr; d.cost += k.cost;
    if (k.qs > 0) {
      s.kwQs++; s.sumQs += k.qs;
      s.imprQs += k.qs * k.impr; s.imprW += k.impr;
      s.costQs += k.qs * k.cost; s.costW += k.cost;
      if (k.qs <= CONFIG.LOW_QS) s.lowCost += k.cost;
      COMPS.forEach(function (c) {
        var v = k[c.key];
        if (s.comp[c.key][v] !== undefined) { s.comp[c.key][v] += k.impr; s.comp[c.key].imprAll += k.impr; }
      });
    } else {
      s.noQsCost += k.cost;
    }
  });
  s.avgQs = s.kwQs ? s.sumQs / s.kwQs : '';
  s.imprWQs = s.imprW ? s.imprQs / s.imprW : '';
  s.costWQs = s.costW ? s.costQs / s.costW : '';
  s.lowShare = s.costW ? s.lowCost / s.costW : '';
  COMPS.forEach(function (c) {
    var x = s.comp[c.key];
    x.belowShare = x.imprAll ? x.BELOW_AVERAGE / x.imprAll : '';
    x.aboveShare = x.imprAll ? x.ABOVE_AVERAGE / x.imprAll : '';
  });
  return s;
}


// ======================= 写入报告 =======================

function writeDiagnosis(ss, kws) {
  var list = kws.slice().sort(function (a, b) { return b.priority - a.priority || b.cost - a.cost; });
  var header = ['广告系列', '广告组', '关键字', '匹配方式', '质量得分', '上次得分', '变化', '预期点击率', '广告相关性',
                '着陆页体验', '展示', '点击', '点击率', '费用', '转化', '转化价值', 'ROAS', '优先级分数', '建议'];
  var data = list.map(function (k) {
    return [k.campaign, k.group, k.text, cn(MATCH_CN, k.match), k.qs || '无', k.prevQs === '' ? '' : (k.prevQs || '无'),
            k.change, cn(COMP_CN, k.ctr), cn(COMP_CN, k.rel), cn(COMP_CN, k.lp), k.impr, k.clicks, div(k.clicks, k.impr),
            k.cost, k.conv, k.value, div(k.value, k.cost), k.priority, adviceFor(k)];
  });
  data = cap(data, '关键字诊断');
  var sh = write(ss, '关键字诊断', header, data,
    ['', '', '', '', '', '', '+0;-0;0', '', '', '', FMT.int, FMT.int, FMT.pct, FMT.money, FMT.dec, FMT.money, FMT.qs, FMT.int, '']);
  if (data.length) {
    sh.getRange(2, 5, data.length, 1).setBackgrounds(data.map(function (r) { return [qsColor(r[4])]; }));
    [8, 9, 10].forEach(function (col) {
      sh.getRange(2, col, data.length, 1).setBackgrounds(data.map(function (r) {
        return [r[col - 1] === '低于平均' ? '#fde2e1' : r[col - 1] === '高于平均' ? '#e3f4e8' : null];
      }));
    });
  }
}

function adviceFor(k) {
  if (!(k.qs > 0)) return k.cost > 0 ? '暂无质量得分（数据不足），先看转化和费用' : '';
  if (!k.weak.length) return k.qs <= CONFIG.LOW_QS ? '三项都不低于平均但总分偏低，整体提升广告和着陆页' : '';
  return k.weak.map(function (w) { return TIPS[w]; }).join('；');
}

function writeGroups(ss, kws, level) {
  var name = level === 'ag' ? '广告组汇总' : '广告系列汇总';
  var map = {};
  kws.forEach(function (k) {
    var key = level === 'ag' ? k.campaign + '||' + k.group : k.campaign;
    if (!map[key]) map[key] = zero({ campaign: k.campaign, group: level === 'ag' ? k.group : '', n: 0, nQs: 0,
      qsCost: 0, wCost: 0, qsImpr: 0, wImpr: 0, low: 0, lowCost: 0, below: { ctr: 0, rel: 0, lp: 0 } });
    var m = map[key];
    addMetrics(m, k); m.n++;
    if (k.qs > 0) {
      m.nQs++; m.qsCost += k.qs * k.cost; m.wCost += k.cost; m.qsImpr += k.qs * k.impr; m.wImpr += k.impr;
      if (k.qs <= CONFIG.LOW_QS) { m.low++; m.lowCost += k.cost; }
      k.weak.forEach(function (w) { m.below[w] += k.cost || 0.0001; });
    }
  });
  var list = values(map);
  list.forEach(function (m) {
    m.costWQs = m.wCost ? m.qsCost / m.wCost : (m.wImpr ? m.qsImpr / m.wImpr : '');
    m.lowShare = m.wCost ? m.lowCost / m.wCost : '';
    var top = COMPS.slice().sort(function (a, b) { return m.below[b.key] - m.below[a.key]; })[0];
    m.mainWeak = m.below[top.key] > 0 ? top.key : '';
  });
  list.sort(function (a, b) { return b.lowCost - a.lowCost || b.cost - a.cost; });

  var header = (level === 'ag' ? ['广告系列', '广告组'] : ['广告系列']).concat(
    ['关键字数', '有得分的关键字', '费用加权质量得分', '展示加权质量得分', '低分关键字数', '低分关键字费用占比',
     '最常见的短板', '费用', '展示', '点击', '转化', '转化价值', 'ROAS']);
  var data = list.map(function (m) {
    var row = level === 'ag' ? [m.campaign, m.group] : [m.campaign];
    return row.concat([m.n, m.nQs, m.costWQs, div(m.qsImpr, m.wImpr), m.low, m.lowShare,
      m.mainWeak ? compName(m.mainWeak) : '', m.cost, m.impr, m.clicks, m.conv, m.value, div(m.value, m.cost)]);
  });
  var off = level === 'ag' ? 2 : 1;
  var fm = (level === 'ag' ? ['', ''] : ['']).concat([FMT.int, FMT.int, FMT.qs, FMT.qs, FMT.int, FMT.pct, '',
    FMT.money, FMT.int, FMT.int, FMT.dec, FMT.money, FMT.qs]);
  var sh = write(ss, name, header, data, fm);
  if (data.length) sh.getRange(2, off + 3, data.length, 1).setBackgrounds(data.map(function (r) { return [qsColor(r[off + 2])]; }));
  return list;
}

function writeChanges(ss, kws, baseDate) {
  var list = kws.filter(function (k) { return k.change !== '' && k.change !== 0; })
                .sort(function (a, b) { return a.change - b.change || b.cost - a.cost; });
  var header = ['广告系列', '广告组', '关键字', '上次得分', '当前得分', '变化', '预期点击率', '广告相关性', '着陆页体验', '近期费用'];
  var data = list.map(function (k) {
    return [k.campaign, k.group, k.text, k.prevQs, k.qs, k.change, cn(COMP_CN, k.ctr), cn(COMP_CN, k.rel), cn(COMP_CN, k.lp), k.cost];
  });
  var sh = write(ss, '得分变化', header, data, ['', '', '', '', '', '+0;-0;0', '', '', '', FMT.money]);
  if (data.length) {
    sh.getRange(2, 6, data.length, 1).setBackgrounds(data.map(function (r) { return [r[5] < 0 ? '#fde2e1' : '#e3f4e8']; }));
  }
  if (!baseDate) log('提示', '得分变化', '第一次运行，还没有可对比的记录，明天起会显示变化。');
  else log('信息', '得分变化', '对比基准日期 ' + baseDate + '，变化的关键字 ' + list.length + ' 个');
}

// 每日汇总：一天一行，同一天重复运行会覆盖当天
var DAILY_HEADER = ['日期', '关键字数', '有得分的关键字', '平均质量得分', '展示加权质量得分', '费用加权质量得分', '低分关键字费用占比',
  '预期点击率低于平均（展示占比）', '广告相关性低于平均（展示占比）', '着陆页体验低于平均（展示占比）',
  'QS1', 'QS2', 'QS3', 'QS4', 'QS5', 'QS6', 'QS7', 'QS8', 'QS9', 'QS10', '展示', '费用', '来源'];

function appendDaily(ss, today, s) {
  var sh = ensureSheet(ss, '每日汇总', DAILY_HEADER);
  var row = [today, s.kw, s.kwQs, s.avgQs, s.imprWQs, s.costWQs, s.lowShare,
    s.comp.ctr.belowShare, s.comp.rel.belowShare, s.comp.lp.belowShare];
  for (var q = 1; q <= 10; q++) row.push(s.dist[q].n);
  row.push(s.impr, s.cost, '每日记录');
  upsertByDate(sh, today, [row]);
  var n = sh.getLastRow() - 1;
  sh.getRange(2, 4, n, 3).setNumberFormat(FMT.qs);
  sh.getRange(2, 7, n, 4).setNumberFormat(FMT.pct);
  sh.getRange(2, 21, n, 1).setNumberFormat(FMT.int);
  sh.getRange(2, 22, n, 1).setNumberFormat(FMT.money);
}

// 第一次运行时，尝试用历史质量得分数据回填过去 N 天的账户汇总
function backfill(ss, today) {
  if (!CONFIG.BACKFILL_DAYS) return;
  var sh = ss.getSheetByName('每日汇总');
  if (sh && sh.getLastRow() > 1) return; // 已经有记录，不需要回填
  var where = ' FROM keyword_view WHERE ' + range(CONFIG.BACKFILL_DAYS) +
    ' AND campaign.advertising_channel_type = "SEARCH" AND campaign.status = "ENABLED" AND ad_group.status = "ENABLED"' +
    ' AND ad_group_criterion.status = "ENABLED" AND ad_group_criterion.negative = FALSE' + nameFilters();
  var rows, weighted = true;
  try {
    rows = runQuery('SELECT segments.date, ad_group_criterion.criterion_id, metrics.historical_quality_score, metrics.impressions, metrics.cost_micros' + where);
  } catch (e) {
    try {
      weighted = false;
      rows = runQuery('SELECT segments.date, ad_group_criterion.criterion_id, metrics.historical_quality_score' + where);
    } catch (e2) {
      log('提示', '历史回填', '账户不支持历史质量得分查询，跳过回填（不影响每天的记录）：' + e2.message);
      return;
    }
  }
  var days = {};
  rows.forEach(function (r) {
    var q = num(g(r, 'metrics.historicalQualityScore')); if (!(q > 0)) return;
    var d = g(r, 'segments.date'); if (!d || d >= today) return;
    var x = days[d] || (days[d] = { n: 0, sum: 0, iq: 0, iw: 0, cq: 0, cw: 0, dist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], impr: 0, cost: 0 });
    var im = weighted ? num(g(r, 'metrics.impressions')) : 0, co = weighted ? money(g(r, 'metrics.costMicros')) : 0;
    x.n++; x.sum += q; x.iq += q * im; x.iw += im; x.cq += q * co; x.cw += co; x.dist[Math.round(q)]++; x.impr += im; x.cost += co;
  });
  var dates = Object.keys(days).sort();
  if (!dates.length) { log('提示', '历史回填', '没有查到历史质量得分数据，跳过回填'); return; }
  sh = ensureSheet(ss, '每日汇总', DAILY_HEADER);
  var out = dates.map(function (d) {
    var x = days[d];
    var row = [d, x.n, x.n, x.sum / x.n, x.iw ? x.iq / x.iw : '', x.cw ? x.cq / x.cw : '', '', '', '', ''];
    for (var q = 1; q <= 10; q++) row.push(x.dist[q]);
    row.push(weighted ? x.impr : '', weighted ? x.cost : '', '历史回填');
    return row;
  });
  sh.getRange(2, 1, out.length, 1).setNumberFormat('@');
  sh.getRange(2, 1, out.length, DAILY_HEADER.length).setValues(out.map(cleanRow));
  log('信息', '历史回填', '回填了 ' + dates.length + ' 天的账户汇总（' + dates[0] + ' 至 ' + dates[dates.length - 1] + '）');
}

var KH_HEADER = ['日期', '关键字键', '广告系列', '广告组', '关键字', '匹配方式', '质量得分', '预期点击率', '广告相关性', '着陆页体验', '展示', '费用'];

function appendKeywordHistory(ss, today, kws) {
  var sh = ensureSheet(ss, '关键字历史', KH_HEADER);
  var rows = kws.map(function (k) {
    return [today, k.key, k.campaign, k.group, k.text, cn(MATCH_CN, k.match), k.qs || '', cn(COMP_CN, k.ctr),
            cn(COMP_CN, k.rel), cn(COMP_CN, k.lp), k.impr, k.cost];
  });
  upsertByDate(sh, today, rows);

  // 删除超过保留天数的旧记录（记录按日期从早到晚排列）
  var last = sh.getLastRow();
  if (last > 1 && CONFIG.KEYWORD_HISTORY_DAYS > 0) {
    var cutoff = shiftDate(today, -CONFIG.KEYWORD_HISTORY_DAYS);
    var dates = sh.getRange(2, 1, last - 1, 1).getValues();
    var n = 0; while (n < dates.length && dateStr(dates[n][0]) < cutoff) n++;
    if (n > 0) { sh.deleteRows(2, n); log('信息', '关键字历史', '删除了 ' + n + ' 行早于 ' + cutoff + ' 的记录'); }
  }
  var cells = (sh.getLastRow()) * KH_HEADER.length;
  if (cells > 8000000) log('提示', '关键字历史', '表格已接近 1000 万格上限（约 ' + cells + ' 格），建议调小 KEYWORD_HISTORY_DAYS');
}

// 快照：用来和下一次运行对比。同一天重复运行时，对比基准仍然是前一天的记录。
function loadBaseline(ss, today) {
  var cur = readSnapshot(ss.getSheetByName('_快照'));
  if (cur && cur.date && cur.date < today) return cur;
  var prev = readSnapshot(ss.getSheetByName('_快照_上一期'));
  return prev || { date: '', map: {} };
}

function saveSnapshot(ss, today, kws) {
  var cur = ss.getSheetByName('_快照');
  var curDate = cur && cur.getLastRow() > 1 ? dateStr(cur.getRange(2, 1).getValue()) : '';
  if (cur && curDate && curDate < today) {
    var old = ss.getSheetByName('_快照_上一期');
    if (old) ss.deleteSheet(old);
    cur.setName('_快照_上一期');
    cur = null;
  }
  var sh = cur || ss.insertSheet('_快照');
  sh.clear();
  var rows = [['日期', '关键字键', '质量得分']].concat(kws.map(function (k) { return [today, k.key, k.qs || '']; }));
  sh.getRange(1, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(1, 2, rows.length, 1).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  ['_快照', '_快照_上一期'].forEach(function (n) { var s = ss.getSheetByName(n); if (s) s.hideSheet(); });
}

function readSnapshot(sh) {
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var map = {};
  v.forEach(function (r) { map[String(r[1])] = { qs: num(r[2]) }; });
  return { date: dateStr(v[0][0]), map: map };
}

function writeDashboard(ss, today, s, baseDate) {
  var sh = ss.getSheetByName('仪表盘') || ss.insertSheet('仪表盘');
  sh.clear();
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });

  var prev = previousDaily(ss, today);
  var kpi = [
    ['质量得分仪表盘', '', '', ''],
    ['日期', today, '对比', prev ? prev.date : '（暂无）'],
    ['', '', '', ''],
    ['指标', '当前', '上一期', '变化'],
    ['费用加权质量得分', s.costWQs, prev ? prev.costWQs : '', prev && s.costWQs !== '' && prev.costWQs !== '' ? s.costWQs - prev.costWQs : ''],
    ['展示加权质量得分', s.imprWQs, prev ? prev.imprWQs : '', prev && s.imprWQs !== '' && prev.imprWQs !== '' ? s.imprWQs - prev.imprWQs : ''],
    ['平均质量得分（不加权）', s.avgQs, prev ? prev.avgQs : '', prev && s.avgQs !== '' && prev.avgQs !== '' ? s.avgQs - prev.avgQs : ''],
    ['低分关键字费用占比（QS ≤ ' + CONFIG.LOW_QS + '）', s.lowShare, prev ? prev.lowShare : '', ''],
    ['有展示的关键字 / 有得分的关键字', s.kw + ' / ' + s.kwQs, '', ''],
    ['近 ' + CONFIG.DAYS + ' 天费用', s.cost, '', '']
  ];
  sh.getRange(1, 1, kpi.length, 4).setValues(kpi.map(cleanRow));
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(4, 1, 1, 4).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.getRange(5, 2, 3, 3).setNumberFormat(FMT.qs);
  sh.getRange(8, 2, 1, 2).setNumberFormat(FMT.pct);
  sh.getRange(10, 2).setNumberFormat(FMT.money);

  // 得分分布
  var r0 = 12;
  var dist = [['质量得分', '关键字数', '展示占比', '费用占比']];
  for (var q = 1; q <= 10; q++) dist.push([String(q), s.dist[q].n, div(s.dist[q].impr, s.impr), div(s.dist[q].cost, s.cost)]);
  dist.push(['无得分', s.dist['无'].n, div(s.dist['无'].impr, s.impr), div(s.dist['无'].cost, s.cost)]);
  sh.getRange(r0, 1, dist.length, 4).setValues(dist);
  sh.getRange(r0, 1, 1, 4).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.getRange(r0 + 1, 3, dist.length - 1, 2).setNumberFormat(FMT.pct);

  // 三个组成部分
  var c0 = r0 + dist.length + 1;
  var comp = [['组成部分', '低于平均（展示占比）', '平均', '高于平均']];
  COMPS.forEach(function (c) {
    var x = s.comp[c.key];
    comp.push([c.name, x.belowShare, x.imprAll ? x.AVERAGE / x.imprAll : '', x.aboveShare]);
  });
  sh.getRange(c0, 1, comp.length, 4).setValues(comp);
  sh.getRange(c0, 1, 1, 4).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.getRange(c0 + 1, 2, comp.length - 1, 3).setNumberFormat(FMT.pct);
  sh.setColumnWidth(1, 280); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 140); sh.setColumnWidth(4, 140);

  // 图表：得分分布（费用占比）、组成部分、每日趋势
  sh.insertChart(sh.newChart().asColumnChart()
    .addRange(sh.getRange(r0, 1, 11, 1)).addRange(sh.getRange(r0, 4, 11, 1))
    .setOption('title', '各质量得分的费用占比').setOption('legend', { position: 'none' })
    .setPosition(1, 6, 0, 0).build());
  sh.insertChart(sh.newChart().asBarChart().setStacked()
    .addRange(sh.getRange(c0, 1, comp.length, 4))
    .setOption('title', '三个组成部分（按展示占比）').setOption('colors', ['#c62828', '#9aa3ad', '#2e7d32'])
    .setPosition(20, 6, 0, 0).build());
  var daily = ss.getSheetByName('每日汇总');
  if (daily && daily.getLastRow() > 2) {
    sh.insertChart(sh.newChart().asLineChart()
      .addRange(daily.getRange(1, 1, daily.getLastRow(), 1)).addRange(daily.getRange(1, 5, daily.getLastRow(), 2))
      .setOption('title', '加权质量得分趋势').setOption('vAxis', { minValue: 1, maxValue: 10 })
      .setPosition(39, 6, 0, 0).build());
  }
}

// 找到今天之前最近的一条每日汇总。dailyOnly = true 时跳过「历史回填」的记录（口径不同，不用于下降提醒）
function previousDaily(ss, today, dailyOnly) {
  var sh = ss.getSheetByName('每日汇总');
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, DAILY_HEADER.length).getValues();
  for (var i = v.length - 1; i >= 0; i--) {
    var d = dateStr(v[i][0]);
    if (dailyOnly && v[i][DAILY_HEADER.length - 1] === '历史回填') continue;
    if (d && d < today) return { date: d, avgQs: v[i][3], imprWQs: v[i][4], costWQs: v[i][5], lowShare: v[i][6] };
  }
  return null;
}


// ======================= 行动清单 =======================

function buildActions(ss, kws, s, ags, baseDate) {
  var A = []; // [优先级, 类别, 对象, 发现, 数据, 建议]
  var prev = previousDaily(ss, todayOf(ss), true);

  if (prev && s.costWQs !== '' && prev.costWQs !== '' && s.costWQs - prev.costWQs <= -0.3) {
    A.push(['高', '账户', '全部搜索广告', '费用加权质量得分下降', r2(prev.costWQs) + ' → ' + r2(s.costWQs) + '（对比 ' + prev.date + '）',
            '查看「得分变化」表，看下降集中在哪些广告组；同时检查最近是否改过广告、落地页或网站']);
  }

  var drops = kws.filter(function (k) { return k.change !== '' && k.change <= -CONFIG.DROP_ALERT; })
                 .sort(function (a, b) { return b.cost - a.cost; });
  drops.slice(0, 20).forEach(function (k) {
    A.push(['高', '关键字', k.campaign + ' / ' + k.group + ' / ' + k.text, '质量得分下降 ' + Math.abs(k.change) + ' 分',
            k.prevQs + ' → ' + k.qs + '，费用 ' + r2(k.cost),
            k.weak.length ? adviceFor(k) : '检查这个关键字对应的广告和着陆页最近是否有改动']);
  });
  if (drops.length > 20) A.push(['高', '关键字', '另外 ' + (drops.length - 20) + ' 个关键字', '质量得分下降', '', '见「得分变化」表']);

  var listed = {}; drops.slice(0, 20).forEach(function (k) { listed[k.key] = 1; });
  kws.filter(function (k) { return k.qs > 0 && k.qs <= CONFIG.LOW_QS && k.cost > 0 && !listed[k.key]; })
     .sort(function (a, b) { return b.priority - a.priority; }).slice(0, 15).forEach(function (k) {
    A.push(['高', '关键字', k.campaign + ' / ' + k.group + ' / ' + k.text, '低分关键字花费较多',
            '质量得分 ' + k.qs + '，费用 ' + r2(k.cost), adviceFor(k) || '整体提升广告和着陆页']);
  });

  (ags || []).filter(function (m) { return m.lowShare !== '' && m.lowShare >= 0.5 && m.cost > 0; })
    .slice(0, 15).forEach(function (m) {
      A.push(['中', '广告组', m.campaign + ' / ' + m.group, '一半以上的费用花在低分关键字上',
              '低分费用占比 ' + Math.round(m.lowShare * 100) + '%，最常见短板：' + (m.mainWeak ? compName(m.mainWeak) : '—'),
              m.mainWeak ? TIPS[m.mainWeak] : '检查广告组里的关键字主题是否一致']);
    });

  var worst = COMPS.slice().sort(function (a, b) { return num(s.comp[b.key].belowShare) - num(s.comp[a.key].belowShare); })[0];
  if (worst && num(s.comp[worst.key].belowShare) >= 0.25) {
    A.push(['中', '账户', '全部搜索广告', '账户最大的短板是「' + worst.name + '」',
            Math.round(s.comp[worst.key].belowShare * 100) + '% 的展示来自这一项低于平均的关键字', TIPS[worst.key]]);
  }

  if (s.cost > 0 && s.noQsCost / s.cost >= 0.2) {
    A.push(['低', '账户', '全部搜索广告', '较多费用花在没有质量得分的关键字上', '占费用 ' + Math.round(s.noQsCost / s.cost * 100) + '%',
            '通常是新关键字或搜索量太少，先按转化和 ROAS 判断，积累数据后才会有得分']);
  }
  if (!baseDate) A.push(['低', '说明', '—', '第一次运行', '', '建议设置为每天运行一次，从明天起可以看到得分变化']);

  var rank = { '高': 0, '中': 1, '低': 2 };
  A.sort(function (a, b) { return rank[a[0]] - rank[b[0]]; });
  if (!A.length) A.push(['—', '—', '—', '没有发现需要处理的问题', '', '继续每天记录']);

  var header = ['优先级', '类别', '对象', '发现', '数据', '建议'];
  var sh = write(ss, '行动清单', header, A, null);
  sh.getRange(2, 1, A.length, 1).setBackgrounds(A.map(function (a) {
    return [a[0] === '高' ? '#fde2e1' : a[0] === '中' ? '#fff1d6' : '#eef1f5'];
  }));
  sh.setColumnWidth(3, 300); sh.setColumnWidth(4, 220); sh.setColumnWidth(5, 240); sh.setColumnWidth(6, 440);
  sh.getRange(2, 1, A.length, header.length).setWrap(true).setVerticalAlignment('top');
  return A;
}


// ======================= 说明、日志、邮件 =======================

function writeGuide(ss, acct, started) {
  var rows = [
    ['质量得分追踪与诊断（' + VERSION + '）', ''],
    ['账户', acct.getName() + '（' + acct.getCustomerId() + '）'],
    ['运行时间', Utilities.formatDate(started, acct.getTimeZone(), 'yyyy-MM-dd HH:mm')],
    ['效果数据时间范围', '近 ' + CONFIG.DAYS + ' 天（截至昨天）；质量得分为运行当天的当前值'],
    ['网络', CONFIG.GOOGLE_SEARCH_ONLY ? '只含 Google 搜索' : '含搜索网络合作伙伴'],
    ['低分标准', '质量得分 ≤ ' + CONFIG.LOW_QS],
    ['', ''],
    ['工作表', '看什么'],
    ['行动清单', '按优先级列出需要处理的问题，先看这里'],
    ['仪表盘', '加权质量得分、得分分布、三个组成部分和趋势图'],
    ['关键字诊断', '每个关键字的得分、三个组成部分、效果和建议，按优先级分数排序'],
    ['广告组汇总 / 广告系列汇总', '每个广告组和广告系列的加权得分、低分费用占比和最常见的短板'],
    ['得分变化', '和上一次记录相比，得分上升或下降的关键字'],
    ['每日汇总', '每天一行的账户汇总，用来看长期趋势'],
    ['关键字历史', '每个关键字每天的得分（可在设置里关闭），超过保留天数自动删除'],
    ['运行日志', '每一步是否成功，出错时看这里'],
    ['', ''],
    ['费用加权质量得分', '按每个关键字的费用加权平均，最能反映「花出去的钱」处在什么质量水平'],
    ['优先级分数', '费用 × (目标分数 ' + CONFIG.TARGET_QS + ' − 当前分数)，花钱多、得分低的关键字排在前面'],
    ['注意', '质量得分是诊断工具，不直接参与竞价；判断关键字好坏最终还要看转化和 ROAS'],
    ['教程', 'https://berightdigital.com/quality-score-tracker-script/']
  ];
  var sh = ss.getSheetByName('使用说明') || ss.insertSheet('使用说明');
  sh.clear();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(8, 1, 1, 2).setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.setColumnWidth(1, 240); sh.setColumnWidth(2, 640);
}

function writeLog(ss) {
  var sh = ss.getSheetByName('运行日志') || ss.insertSheet('运行日志');
  sh.clear();
  var rows = [['时间', '级别', '步骤', '内容']].concat(RUN_LOG);
  sh.getRange(1, 1, rows.length, 4).setValues(rows);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setColumnWidth(4, 700);
}

function sendEmail(acct, ss, today, s, actions, drops) {
  var lines = ['质量得分报告：' + acct.getName() + '（' + today + '）', '',
    '费用加权质量得分：' + r2(s.costWQs) + '；展示加权：' + r2(s.imprWQs) + '；低分关键字费用占比：' +
    (s.lowShare === '' ? '—' : Math.round(s.lowShare * 100) + '%'),
    '质量得分下降 ' + CONFIG.DROP_ALERT + ' 分以上的关键字：' + drops + ' 个', '', '优先处理：'];
  actions.filter(function (a) { return a[0] === '高'; }).slice(0, 15).forEach(function (a) {
    lines.push('· [' + a[1] + '] ' + a[2] + '：' + a[3] + '（' + a[4] + '）');
  });
  lines.push('', '完整报告：' + ss.getUrl());
  MailApp.sendEmail(CONFIG.EMAIL, '质量得分报告 - ' + acct.getName() + ' - ' + today, lines.join('\n'));
  log('信息', '邮件', '已发送到 ' + CONFIG.EMAIL);
}


// ======================= 工具函数 =======================

function openSpreadsheet(acct) {
  if (CONFIG.SPREADSHEET_URL) return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  var ss = SpreadsheetApp.create('质量得分追踪 - ' + acct.getName());
  log('提示', '表格', '已新建表格，请把这个网址填到 SPREADSHEET_URL：' + ss.getUrl());
  Logger.log('★ 新建的表格：' + ss.getUrl());
  return ss;
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

function range(days) {
  var tz = AdsApp.currentAccount().getTimeZone(), DAY = 864e5;
  var end = new Date(Date.now() - DAY), start = new Date(Date.now() - Number(days) * DAY);
  return ' segments.date BETWEEN "' + Utilities.formatDate(start, tz, 'yyyy-MM-dd') + '" AND "' +
         Utilities.formatDate(end, tz, 'yyyy-MM-dd') + '" ';
}

function clean(s) { return String(s || '').replace(/["\\%]/g, ''); }
function nameFilters() {
  var inc = clean(CONFIG.CAMPAIGN_NAME_CONTAINS), exc = clean(CONFIG.CAMPAIGN_NAME_EXCLUDES);
  return (inc ? ' AND campaign.name LIKE "%' + inc + '%"' : '') + (exc ? ' AND campaign.name NOT LIKE "%' + exc + '%"' : '');
}

function todayOf(ss) {
  return Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
}
function shiftDate(ymd, days) {
  var p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + days * 864e5);
  return d.toISOString().slice(0, 10);
}
// 表格里的日期可能被读成 Date 对象，统一转成 yyyy-MM-dd 文字
function dateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

// 按日期写入：先删除表里同一天的旧记录（同一天重复运行），再追加到末尾
function upsertByDate(sh, date, rows) {
  var last = sh.getLastRow();
  if (last > 1) {
    var v = sh.getRange(2, 1, last - 1, 1).getValues();
    var first = -1, count = 0;
    for (var i = v.length - 1; i >= 0; i--) {
      if (dateStr(v[i][0]) === date) { first = i; count++; } else if (count) break;
    }
    if (count) sh.deleteRows(first + 2, count);
  }
  if (!rows.length) return;
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows.map(cleanRow));
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

function g(obj, path) {
  var parts = path.split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return ''; cur = cur[parts[i]]; }
  return cur === undefined || cur === null ? '' : cur;
}
function num(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function money(micros) { return num(micros) / 1e6; }
function div(a, b) { return b ? a / b : ''; }
function r2(x) { return x === '' ? '—' : Math.round(num(x) * 100) / 100; }
function cn(map, v) { return v === '' || v === undefined ? '' : (map[v] !== undefined ? map[v] : String(v)); }
function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
function compName(key) { for (var i = 0; i < COMPS.length; i++) if (COMPS[i].key === key) return COMPS[i].name; return ''; }
function qsColor(q) { q = Number(q); return !(q > 0) ? null : q <= CONFIG.LOW_QS ? '#fde2e1' : q <= 6 ? '#fff1d6' : '#e3f4e8'; }

function metricsOf(r) {
  return { impr: num(g(r, 'metrics.impressions')), clicks: num(g(r, 'metrics.clicks')), cost: money(g(r, 'metrics.costMicros')),
           conv: num(g(r, 'metrics.conversions')), value: num(g(r, 'metrics.conversionsValue')) };
}
function zero(o) { o.impr = 0; o.clicks = 0; o.cost = 0; o.conv = 0; o.value = 0; return o; }
function addMetrics(t, m) { t.impr += m.impr; t.clicks += m.clicks; t.cost += m.cost; t.conv += m.conv; t.value += m.value; return t; }

function cap(data, name) {
  if (data.length > CONFIG.MAX_ROWS) {
    log('提示', name, '共 ' + data.length + ' 行，只写入优先级最高的 ' + CONFIG.MAX_ROWS + ' 行');
    return data.slice(0, CONFIG.MAX_ROWS);
  }
  return data;
}

function write(ss, name, header, data, formats) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var body = data.length ? data.map(cleanRow) : [header.map(function (_, i) { return i === 0 ? '（没有数据）' : ''; })];
  if (formats && data.length) {
    formats.forEach(function (f, i) { if (f) sh.getRange(2, i + 1, data.length, 1).setNumberFormat(f); });
  }
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.getRange(2, 1, body.length, header.length).setValues(body);
  sh.setFrozenRows(1);
  return sh;
}

// 以 = + - @ 开头的文字（例如关键字「+running shoes」）会被当成公式，前面加 ' 保持为文字
function cleanRow(row) {
  return row.map(function (v) {
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
    return v === undefined || v === null ? '' : v;
  });
}

function orderSheets(ss) {
  var order = ['使用说明', '行动清单', '仪表盘', '关键字诊断', '广告组汇总', '广告系列汇总', '得分变化',
               '每日汇总', '关键字历史', '运行日志'];
  order.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  // 快照表只给脚本对比用，保持隐藏（激活隐藏的表会让它显示出来，所以不参与排序）
  ['_快照', '_快照_上一期'].forEach(function (n) { var s = ss.getSheetByName(n); if (s) s.hideSheet(); });
  ['Sheet1', '工作表1', 'Sheet 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  var first = ss.getSheetByName('行动清单');
  if (first) ss.setActiveSheet(first);
}
