/**
 * PMax 趋势与增量洞察 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：回答效果最大化（PMax）广告系列最难回答的几个问题：
 *   1. PMax 带来的是新增转化，还是抢了搜索和购物广告的转化？（按周看各渠道趋势，PMax 上线前后对比）
 *   2. PMax 的搜索流量里有多少是品牌词？（品牌词转化本来就会来，占比太高说明 PMax 在「吃」品牌流量）
 *   3. PMax 搜到了哪些转化好、但搜索广告里还没有的关键字？（可以加到搜索广告精细控制）
 *   4. 每个素材资源组每天的表现，以及素材表现标签（最佳/良好/低）的历史变化。
 *
 * 和「PMax 健康检查」脚本互补：健康检查看当前状态（渠道拆分、素材、商品），这个脚本看变化趋势。
 * 思路参考 jack.tm 的 PMax 增量脚本和 PMax V3/V4 看板、smec 的 PMax Brand Traffic Analyzer、
 * Frederick Vallaeys 的 PMax 搜索词与类别脚本、Francesco Cifardi 的素材资源组跟踪脚本，以及 Mike Rhodes 的付费 PMax 脚本，
 * 代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-pmax-insights-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 品牌词（用来区分 PMax 的品牌流量），例如 ['trailpeak', 'trail peak']
  BRAND_TERMS: [],

  // 渠道趋势看多少周
  WEEKS: 52,
  // PMax 上线前后各比较多少周
  COMPARE_WEEKS: 8,
  // 搜索词机会：PMax 里转化至少这么多次、且搜索广告里还没有这个关键字
  OPPORTUNITY_MIN_CONV: 2,
  // 搜索词和素材数据的天数
  DAYS: 30,
  // 素材标签历史保留多少天
  KEEP_DAYS: 180
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var CH_CN = { PERFORMANCE_MAX: 'PMax', SEARCH: '搜索', SHOPPING: '购物', DISPLAY: '展示', VIDEO: '视频', DEMAND_GEN: 'Demand Gen', DISCOVERY: 'Demand Gen', MULTI_CHANNEL: '应用', LOCAL: '本地', SMART: '智能', HOTEL: '酒店', LOCAL_SERVICES: '本地服务' };
var LABEL_SCORE = { BEST: 3, GOOD: 2, LOW: 1, LEARNING: 0, PENDING: 0, UNKNOWN: 0, UNSPECIFIED: 0 };
var LABEL_CN = { BEST: '最佳', GOOD: '良好', LOW: '低', LEARNING: '学习中', PENDING: '待定', UNKNOWN: '', UNSPECIFIED: '' };


function main() {
  var ss = openSpreadsheet('PMax 趋势与增量洞察');
  log('信息', '开始', '版本 ' + VERSION);
  var A = [];

  var weekly = safe('渠道趋势', function () { return channelTrend(ss); });
  if (weekly) safe('增量对比', function () { incrementality(ss, weekly, A); });
  safe('品牌流量', function () { brandShare(ss, A); });
  safe('搜索词机会', function () { opportunities(ss, A); });
  safe('素材资源组', function () { assetGroups(ss, A); });
  safe('素材标签历史', function () { labelHistory(ss, A); });
  safe('行动清单', function () { writeActions(ss, A, '没有发现需要处理的问题'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    mail('[PMax 洞察] ' + AdsApp.currentAccount().getName(), 'PMax 趋势与增量洞察已更新，主要发现：',
      [['优先级', '类别', '发现', '数据']].concat(A.slice(0, 15).map(function (x) { return [x[0], x[1], x[3], x[4]]; })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, 'PMax 趋势与增量洞察', VERSION, [
      ['品牌词', CONFIG.BRAND_TERMS.length ? CONFIG.BRAND_TERMS.join('、') : '（未设置：品牌流量分析需要先填 BRAND_TERMS）'],
      ['', ''],
      ['行动清单', '先看这里：PMax 是否抢了其他渠道、品牌流量占比、可以加到搜索广告的关键字、表现变差的素材'],
      ['渠道周趋势', '最近 ' + CONFIG.WEEKS + ' 周，每周各渠道（PMax、搜索、购物等）的花费、转化、转化价值'],
      ['增量对比', 'PMax 上线前 ' + CONFIG.COMPARE_WEEKS + ' 周和最近 ' + CONFIG.COMPARE_WEEKS + ' 周对比：账户总转化增加了多少，其中多少来自 PMax，其他渠道减少了多少'],
      ['品牌流量', 'PMax 搜索流量里品牌词的占比，按广告系列和按周'],
      ['搜索词机会', 'PMax 里有转化、但搜索广告里还没有的搜索词'],
      ['素材资源组趋势', '每个素材资源组最近 ' + CONFIG.DAYS + ' 天每天的表现'],
      ['素材标签历史', '每天记录一次素材的表现标签（Google 不保存历史，所以要从第一次运行开始积累）'],
      ['建议频率', '每天运行一次']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '增量对比', '渠道周趋势', '品牌流量', '搜索词机会', '素材资源组趋势', '素材标签历史', '运行日志']);
}


// ======================= 1. 渠道周趋势 =======================

function weekStart(d) {
  var t = new Date(d + 'T12:00:00Z'), w = t.getUTCDay() || 7;
  return new Date(t.getTime() - (w - 1) * 864e5).toISOString().slice(0, 10);
}

function channelTrend(ss) {
  var days = CONFIG.WEEKS * 7;
  var rows = runQuery('SELECT campaign.advertising_channel_type, segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks ' +
    'FROM campaign WHERE ' + range(days) + ' AND metrics.impressions > 0');
  var weeks = {}, chans = {}, firstPmax = '';
  rows.forEach(function (r) {
    var ch = String(g(r, 'campaign.advertisingChannelType')), d = String(g(r, 'segments.date')), w = weekStart(d);
    var m = metricsOf(r);
    chans[ch] = 1;
    var x = weeks[w] || (weeks[w] = {});
    addMetrics(x[ch] || (x[ch] = zero({})), m);
    addMetrics(x._all || (x._all = zero({})), m);
    if (ch === 'PERFORMANCE_MAX' && m.cost > 0 && (!firstPmax || d < firstPmax)) firstPmax = d;
  });
  var chList = Object.keys(chans).sort(function (a, b) { return (a === 'PERFORMANCE_MAX' ? -1 : 0) - (b === 'PERFORMANCE_MAX' ? -1 : 0) || a.localeCompare(b); });
  var wList = Object.keys(weeks).sort();
  // 最后一周如果不完整就去掉（截至昨天）
  if (wList.length && weekStart(dayStr(-1)) === wList[wList.length - 1] && Utilities.formatDate(new Date(Date.now() - 864e5), tz(), 'u') !== '7') wList.pop();

  var head = ['周（周一）', '总花费', '总转化', '总转化价值', 'PMax 花费占比', 'PMax 转化占比'];
  chList.forEach(function (c) { var n = CH_CN[c] || c; head.push(n + ' 花费', n + ' 转化', n + ' 转化价值'); });
  var data = wList.map(function (w) {
    var x = weeks[w], all = x._all, pm = x.PERFORMANCE_MAX || zero({});
    var row = [w, all.cost, all.conv, all.value, div(pm.cost, all.cost), div(pm.conv, all.conv)];
    chList.forEach(function (c) { var y = x[c] || zero({}); row.push(y.cost, y.conv, y.value); });
    return row;
  });
  var fm = ['@', FMT.money, FMT.dec, FMT.money, FMT.pct, FMT.pct];
  chList.forEach(function () { fm.push(FMT.money, FMT.dec, FMT.money); });
  var sh = write(ss, '渠道周趋势', head, data, fm, { title: 'PMax 第一次有花费：' + (firstPmax || '最近 ' + CONFIG.WEEKS + ' 周内没有 PMax') });
  if (data.length > 2) {
    sh.getCharts().forEach(function (c) { sh.removeChart(c); });
    var b = sh.newChart().asLineChart().addRange(sh.getRange(2, 1, data.length + 1, 1));
    chList.forEach(function (c, i) { b = b.addRange(sh.getRange(2, 8 + i * 3, data.length + 1, 1)); });
    sh.insertChart(b.setOption('title', '各渠道每周转化').setPosition(4, head.length + 2, 0, 0).build());
  }
  log('信息', '渠道趋势', wList.length + ' 周，' + chList.length + ' 个渠道，PMax 首次花费 ' + (firstPmax || '无'));
  return { weeks: weeks, wList: wList, chList: chList, firstPmax: firstPmax };
}


// ======================= 2. 增量对比 =======================

function incrementality(ss, t, A) {
  var n = CONFIG.COMPARE_WEEKS, rows = [], note = '';
  var launchW = t.firstPmax ? weekStart(t.firstPmax) : '';
  var before = [], after = t.wList.slice(-n);
  if (launchW && t.wList.indexOf(launchW) >= n) {
    before = t.wList.filter(function (w) { return w < launchW; }).slice(-n);
    note = 'PMax 上线前 ' + before.length + ' 周（' + before[0] + ' 起） vs 最近 ' + after.length + ' 周';
  } else {
    // PMax 上线早于统计范围：用最早的 n 周对比最近 n 周
    before = t.wList.slice(0, n);
    note = (t.firstPmax ? 'PMax 上线早于统计范围，' : '') + '最早 ' + before.length + ' 周（' + (before[0] || '') + ' 起） vs 最近 ' + after.length + ' 周';
  }
  if (!before.length || !after.length || before[0] === after[0]) { log('提示', '增量对比', '数据不足，至少需要 ' + 2 * n + ' 周'); return; }
  function sum(ws, ch) { var s = zero({}); ws.forEach(function (w) { var x = t.weeks[w][ch]; if (x) addMetrics(s, x); }); return s; }
  var chans = ['_all'].concat(t.chList);
  var res = {};
  chans.forEach(function (c) {
    var a = sum(before, c), b = sum(after, c);
    res[c] = { a: a, b: b };
    rows.push([c === '_all' ? '账户合计' : (CH_CN[c] || c), a.cost / before.length, b.cost / after.length, a.conv / before.length, b.conv / after.length,
      (b.conv / after.length) - (a.conv / before.length), a.value / before.length, b.value / after.length, (b.value / after.length) - (a.value / before.length),
      div(a.value, a.cost), div(b.value, b.cost)]);
  });
  write(ss, '增量对比', ['渠道', '之前 周均花费', '最近 周均花费', '之前 周均转化', '最近 周均转化', '转化变化', '之前 周均价值', '最近 周均价值', '价值变化', '之前 ROAS', '最近 ROAS'], rows,
    ['', FMT.money, FMT.money, FMT.dec, FMT.dec, '+#,##0.0;-#,##0.0', FMT.money, FMT.money, '+#,##0;-#,##0', FMT.ratio, FMT.ratio], { title: note + '（数值为周平均）' });

  // 判断：PMax 新增的价值 vs 其他渠道减少的价值
  var pm = res.PERFORMANCE_MAX;
  if (!pm) return;
  var pmGain = pm.b.value / after.length - pm.a.value / before.length;
  var otherChange = 0;
  t.chList.forEach(function (c) { if (c !== 'PERFORMANCE_MAX') otherChange += res[c].b.value / after.length - res[c].a.value / before.length; });
  var total = res._all.b.value / after.length - res._all.a.value / before.length;
  var key = pmGain > 0 ? div(total, pmGain) : '';
  var data = 'PMax 周均价值 +' + r2(pmGain) + '，其他渠道 ' + (otherChange >= 0 ? '+' : '') + r2(otherChange) + '，账户合计 ' + (total >= 0 ? '+' : '') + r2(total);
  if (pmGain > 0 && otherChange < -0.5 * pmGain) A.push(['高', '增量', 'PMax vs 其他渠道', 'PMax 增长的大部分价值是从其他渠道转移过来的（只有 ' + pct(key) + ' 是净增长）', data,
    '检查 PMax 是否在吃品牌词（见「品牌流量」）；给 PMax 加品牌排除，或者把转化好的搜索词加到搜索广告里用完全匹配控制']);
  else if (pmGain > 0) A.push(['低', '增量', 'PMax vs 其他渠道', 'PMax 增长基本是净增长（' + pct(key) + '）', data, '对比周期内季节性也会影响结果，建议结合同比数据判断']);
  else if (pmGain < 0) A.push(['中', '增量', 'PMax', 'PMax 最近的转化价值比之前少', data, '检查 PMax 的预算、目标 ROAS 和素材是否有变化（可以配合 PMax 健康检查脚本）']);
}


// ======================= 3. 品牌流量 =======================

function isBrand(t) {
  t = String(t || '').toLowerCase();
  return CONFIG.BRAND_TERMS.some(function (b) { return b && t.indexOf(String(b).toLowerCase()) >= 0; });
}

function brandShare(ss, A) {
  if (!CONFIG.BRAND_TERMS.length) { log('提示', '品牌流量', '没有设置 BRAND_TERMS，跳过'); return; }
  var rows = tryQuery('PMax 搜索词', 'SELECT campaign.name, campaign_search_term_view.search_term, segments.week, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM campaign_search_term_view WHERE ' + range(12 * 7) + ' AND campaign.advertising_channel_type = "PERFORMANCE_MAX"');
  var src = 'term';
  if (!rows) {
    src = 'insight';
    rows = [];
    (tryQuery('PMax 广告系列', 'SELECT campaign.id, campaign.name FROM campaign WHERE campaign.advertising_channel_type = "PERFORMANCE_MAX" AND campaign.status = "ENABLED"') || []).forEach(function (c) {
      (tryQuery('搜索字词洞察', 'SELECT campaign_search_term_insight.category_label, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign_search_term_insight WHERE ' +
        range(CONFIG.DAYS) + ' AND campaign_search_term_insight.campaign_id = "' + g(c, 'campaign.id') + '"') || []).forEach(function (r) {
        rows.push({ campaign: c.campaign, campaignSearchTermView: { searchTerm: g(r, 'campaignSearchTermInsight.categoryLabel') }, metrics: r.metrics, segments: { week: '' } });
      });
    });
  }
  var camp = {}, week = {};
  rows.forEach(function (r) {
    var b = isBrand(g(r, 'campaignSearchTermView.searchTerm')) ? 'brand' : 'non';
    var m = metricsOf(r), c = String(g(r, 'campaign.name')), w = String(g(r, 'segments.week'));
    var x = camp[c] || (camp[c] = { brand: zero({}), non: zero({}) }); addMetrics(x[b], m);
    if (w) { var y = week[w] || (week[w] = { brand: zero({}), non: zero({}) }); addMetrics(y[b], m); }
  });
  var head = ['范围', '品牌 点击', '非品牌 点击', '品牌点击占比', '品牌 转化', '非品牌 转化', '品牌转化占比', '品牌 转化价值', '非品牌 转化价值', '品牌价值占比'];
  function line(name, x) {
    var tc = x.brand.clicks + x.non.clicks, tv = x.brand.conv + x.non.conv, tval = x.brand.value + x.non.value;
    return [name, x.brand.clicks, x.non.clicks, div(x.brand.clicks, tc), x.brand.conv, x.non.conv, div(x.brand.conv, tv), x.brand.value, x.non.value, div(x.brand.value, tval)];
  }
  var tot = { brand: zero({}), non: zero({}) };
  Object.keys(camp).forEach(function (c) { addMetrics(tot.brand, camp[c].brand); addMetrics(tot.non, camp[c].non); });
  var data = [line('全部 PMax', tot)].concat(Object.keys(camp).map(function (c) { return line(c, camp[c]); }))
    .concat(Object.keys(week).sort().map(function (w) { return line('周 ' + w, week[w]); }));
  write(ss, '品牌流量', head, data, ['', FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.dec, FMT.pct, FMT.money, FMT.money, FMT.pct],
    { title: src === 'term' ? 'PMax 搜索词，最近 12 周' : '「搜索字词洞察」类别（账户不支持搜索词明细，按类别名称判断），最近 ' + CONFIG.DAYS + ' 天' });
  var share = div(tot.brand.conv, tot.brand.conv + tot.non.conv);
  if (share !== '' && share >= 0.3) A.push([share >= 0.5 ? '高' : '中', '品牌流量', '全部 PMax', 'PMax 搜索转化里 ' + pct(share) + ' 来自品牌词',
    '品牌转化 ' + r2(tot.brand.conv) + '，非品牌 ' + r2(tot.non.conv), '品牌搜索本来就会转化，PMax 的 ROAS 被品牌词抬高了。建议在 PMax 里排除品牌词（品牌排除列表），品牌词交给单独的搜索广告系列']);
}


// ======================= 4. 搜索词机会 =======================

function opportunities(ss, A) {
  var rows = tryQuery('PMax 搜索词', 'SELECT campaign.name, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM campaign_search_term_view WHERE ' + range(CONFIG.DAYS) + ' AND campaign.advertising_channel_type = "PERFORMANCE_MAX"');
  if (!rows) { log('提示', '搜索词机会', '账户不支持 PMax 搜索词明细，跳过'); return; }
  var kw = {};
  (tryQuery('搜索关键字', 'SELECT ad_group_criterion.keyword.text FROM ad_group_criterion WHERE ad_group_criterion.type = "KEYWORD" AND ad_group_criterion.status = "ENABLED" ' +
    'AND ad_group_criterion.negative = FALSE AND campaign.advertising_channel_type = "SEARCH" AND campaign.status = "ENABLED"') || []).forEach(function (r) {
    kw[String(g(r, 'adGroupCriterion.keyword.text')).toLowerCase().trim()] = 1;
  });
  var map = {};
  rows.forEach(function (r) {
    var t = String(g(r, 'campaignSearchTermView.searchTerm')).toLowerCase().trim();
    var x = map[t] || (map[t] = zero({ term: t, camps: {} }));
    addMetrics(x, metricsOf(r)); x.camps[g(r, 'campaign.name')] = 1;
  });
  var list = values(map).filter(function (x) { return x.conv >= CONFIG.OPPORTUNITY_MIN_CONV && !kw[x.term]; })
    .sort(function (a, b) { return b.value - a.value || b.conv - a.conv; });
  write(ss, '搜索词机会', ['搜索词', '是品牌词', 'PMax 广告系列'].concat(METRIC_HEAD).concat(['建议']),
    list.map(function (x) { return [x.term, isBrand(x.term) ? '是' : '', Object.keys(x.camps).join('、')].concat(metricCells(x)).concat([isBrand(x.term) ? '品牌词：确认搜索广告里有品牌系列' : '加到搜索广告，用完全匹配和单独出价控制']); }),
    ['', '', ''].concat(METRIC_FMT).concat(['']), { empty: '没有发现新的高转化搜索词' });
  var nb = list.filter(function (x) { return !isBrand(x.term); });
  if (nb.length) A.push(['中', '搜索词机会', nb.length + ' 个搜索词', 'PMax 里有转化、但搜索广告里还没有', '例如：' + nb.slice(0, 5).map(function (x) { return x.term; }).join('、'),
    '把这些词以完全匹配加到搜索广告：出价和落地页都可以单独控制，搜索广告的优先级也高于 PMax']);
}


// ======================= 5. 素材资源组每日表现 =======================

function assetGroups(ss, A) {
  var rows = runQuery('SELECT campaign.name, asset_group.name, asset_group.ad_strength, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM asset_group WHERE ' + range(CONFIG.DAYS) + ' AND asset_group.status = "ENABLED" AND campaign.status = "ENABLED"');
  var data = [], tot = {};
  rows.forEach(function (r) {
    var m = metricsOf(r), key = g(r, 'campaign.name') + ' / ' + g(r, 'assetGroup.name');
    data.push([String(g(r, 'segments.date')), String(g(r, 'campaign.name')), String(g(r, 'assetGroup.name')), String(g(r, 'assetGroup.adStrength'))].concat(metricCells(m)));
    var x = tot[key] || (tot[key] = { first: zero({}), last: zero({}) });
    addMetrics(String(g(r, 'segments.date')) >= dayStr(-Math.floor(CONFIG.DAYS / 2)) ? x.last : x.first, m);
  });
  data.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; });
  write(ss, '素材资源组趋势', ['日期', '广告系列', '素材资源组', '广告效力'].concat(METRIC_HEAD), data, ['@', '', '', ''].concat(METRIC_FMT));
  Object.keys(tot).forEach(function (k) {
    var a = derived(tot[k].first), b = derived(tot[k].last);
    if (a.conv >= 5 && b.cost > 0 && b.roas !== '' && a.roas !== '' && b.roas < a.roas * 0.6)
      A.push(['中', '素材资源组', k, '后半段 ROAS 比前半段下降 ' + Math.round((1 - b.roas / a.roas) * 100) + '%', '前 ' + r2(a.roas) + ' → 后 ' + r2(b.roas), '检查最近是否换了素材、改了最终网址或商品组，看「素材标签历史」哪些素材变成了「低」']);
  });
}


// ======================= 6. 素材标签历史 =======================

var LH_HEAD = ['日期', '广告系列', '素材资源组', '素材类型', '素材', '表现标签', '分数'];
function labelHistory(ss, A) {
  var rows = runQuery('SELECT campaign.name, asset_group.name, asset_group_asset.field_type, asset_group_asset.performance_label, asset.id, asset.name, asset.type, ' +
    'asset.text_asset.text, asset.youtube_video_asset.youtube_video_title FROM asset_group_asset WHERE asset_group_asset.status = "ENABLED" ' +
    'AND asset_group.status = "ENABLED" AND campaign.status = "ENABLED" AND campaign.advertising_channel_type = "PERFORMANCE_MAX"');
  var t = today();
  var out = rows.map(function (r) {
    var label = String(g(r, 'assetGroupAsset.performanceLabel') || '');
    var name = g(r, 'asset.textAsset.text') || g(r, 'asset.youtubeVideoAsset.youtubeVideoTitle') || g(r, 'asset.name') || ('ID ' + g(r, 'asset.id'));
    return [t, String(g(r, 'campaign.name')), String(g(r, 'assetGroup.name')), String(g(r, 'assetGroupAsset.fieldType')), String(name), LABEL_CN[label] !== undefined ? LABEL_CN[label] : label, LABEL_SCORE[label] || 0];
  });
  var sh = ensureSheet(ss, '素材标签历史', LH_HEAD);
  // 找出上一次记录的标签，用来判断哪些素材变成了「低」
  var prev = {}, last = sh.getLastRow();
  if (last > 1) {
    var v = sh.getRange(2, 1, last - 1, LH_HEAD.length).getValues(), pd = '';
    v.forEach(function (r) { var d = dateStr(r[0]); if (d < t && d > pd) pd = d; });
    v.forEach(function (r) { if (dateStr(r[0]) === pd) prev[r[1] + '|' + r[2] + '|' + r[3] + '|' + r[4]] = r[5]; });
  }
  upsertDay(sh, t, out, CONFIG.KEEP_DAYS);
  var dropped = out.filter(function (r) { var p = prev[r[1] + '|' + r[2] + '|' + r[3] + '|' + r[4]]; return r[5] === '低' && p && p !== '低'; });
  if (dropped.length) A.push(['中', '素材', dropped.length + ' 个素材', '表现标签变成了「低」', '例如：' + dropped.slice(0, 4).map(function (r) { return r[2] + '：' + String(r[4]).slice(0, 30); }).join('；'),
    '先观察几天；持续为「低」的素材替换成新的角度（不同卖点、不同画面），每次只换一部分']);
  var lows = out.filter(function (r) { return r[5] === '低'; }).length;
  log('信息', '素材标签', out.length + ' 个素材，其中「低」' + lows + ' 个' + (Object.keys(prev).length ? '' : '（第一次记录，之后才能比较变化）'));
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
