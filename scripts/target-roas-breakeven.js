/**
 * 目标 ROAS / CPA 与盈亏平衡 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：用你的毛利率算出「盈亏平衡 ROAS / CPA」和「想赚多少钱该设多少目标」，然后：
 *   1. 逐个广告系列判断现在是赚钱还是亏钱，估算利润；
 *   2. 检查出价策略里设置的目标 ROAS / CPA 是否低于盈亏平衡（目标设错，Google 会按亏钱的标准去投）；
 *   3. 把关键字按 CPA 分成五档：很赚、赚、接近保本、亏、严重亏；
 *   4. 如果设了月度营收（或询盘）目标，算出每天需要多少花费、点击、转化，并和最近的实际值对比。
 * 支持跨境电商（按 ROAS）和外贸询盘（按 CPA，考虑询盘成交率和订单金额），支持含增值税的转化价值。
 *
 * 思路参考 jack.tm 的 Break-even ROI & Required KPI 表格和关键字 CPA 分层脚本，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-target-roas-breakeven-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 业务类型：'ECOM' 跨境电商（转化价值 = 订单金额）或 'LEAD' 外贸询盘（转化 = 询盘）
  BUSINESS: 'ECOM',

  // 毛利率（0–1）：扣除商品成本、头程/尾程物流、平台和支付手续费、退货损耗后，还剩多少。例如 0.4
  MARGIN: 0.4,
  // 转化价值是否含增值税（欧洲、英国常见）。含 20% 增值税填 0.2，不含填 0
  VAT_RATE: 0,
  // 平均折扣（如果转化价值是折扣前的价格），没有填 0
  DISCOUNT: 0,
  // 扣除广告费后，你希望保留的利润占营收的比例。例如 0.1 = 10%
  TARGET_PROFIT_SHARE: 0.1,

  // 仅外贸询盘（LEAD）：询盘成交率、平均订单金额（账户币种）
  LEAD_TO_DEAL: 0.05,
  DEAL_VALUE: 5000,

  // 月度目标（可选）：电商填营收目标，询盘填询盘数目标。0 = 不计算
  MONTHLY_TARGET: 0,

  // 只看名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',
  // 统计最近多少天
  DAYS: 60
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var BID_CN = { MAXIMIZE_CONVERSION_VALUE: '尽可能提高转化价值', MAXIMIZE_CONVERSIONS: '尽可能提高转化次数', TARGET_ROAS: '目标广告支出回报率', TARGET_CPA: '目标每次转化费用',
  MANUAL_CPC: '人工点击付费', ENHANCED_CPC: '智能点击付费', TARGET_SPEND: '尽可能争取更多点击次数', TARGET_IMPRESSION_SHARE: '目标展示份额', MANUAL_CPM: '人工每千次展示费用', TARGET_CPM: '目标每千次展示费用', MANUAL_CPV: '人工每次观看费用' };


function main() {
  var ss = openSpreadsheet('盈亏平衡与目标');
  var lead = CONFIG.BUSINESS === 'LEAD';
  var be = breakeven(lead);
  log('信息', '开始', '版本 ' + VERSION + '，' + (lead ? '询盘：盈亏平衡 CPA ' + r2(be.cpa) + '，目标 CPA ' + r2(be.targetCpa) : '电商：盈亏平衡 ROAS ' + r2(be.roas) + '，目标 ROAS ' + r2(be.targetRoas)));
  if (be.error) log('错误', '设置', be.error);

  var camps = safe('广告系列', fetchCampaigns) || [];
  camps.forEach(function (c) { judge(c, be, lead); });
  var total = camps.reduce(function (t, c) { return addMetrics(t, c); }, zero({}));
  judge(total, be, lead);
  var kws = safe('关键字', fetchKeywords) || [];
  kws.forEach(function (k) { tier(k, be, lead, div(total.value, total.conv)); });

  safe('盈亏平衡', function () { writeBreakeven(ss, be, total, lead); });
  var req = CONFIG.MONTHLY_TARGET ? safe('目标对比', function () { return required(ss, be, total, lead); }) : null;
  var A = buildActions(camps, kws, total, be, req, lead);
  safe('广告系列', function () { writeCampaigns(ss, camps, lead); });
  safe('关键字分层', function () { writeKeywords(ss, kws, lead); });
  safe('行动清单', function () { writeActions(ss, A, '所有广告系列都在盈利'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    mail('[盈亏平衡] ' + AdsApp.currentAccount().getName() + '：估算利润 ' + r2(total.profit), (lead ? '盈亏平衡 CPA ' + r2(be.cpa) : '盈亏平衡 ROAS ' + r2(be.roas)) + '。主要发现：',
      [['优先级', '类别', '对象', '发现', '数据']].concat(A.slice(0, 15).map(function (x) { return x.slice(0, 5); })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '目标 ROAS / CPA 与盈亏平衡', VERSION, [
      ['业务类型', lead ? '外贸询盘：每个询盘的价值 = 成交率 × 订单金额 × 毛利率' : '跨境电商：按转化价值（订单金额）计算'],
      ['盈亏平衡', lead ? 'CPA 低于 ' + r2(be.cpa) + ' 才不亏' : 'ROAS 高于 ' + r2(be.roas) + '（' + pct(be.roas) + '）才不亏'],
      ['建议目标', lead ? '目标 CPA ' + r2(be.targetCpa) + '（保留 ' + pct(CONFIG.TARGET_PROFIT_SHARE) + ' 利润）' : '目标 ROAS ' + r2(be.targetRoas) + '（保留 ' + pct(CONFIG.TARGET_PROFIT_SHARE) + ' 利润）'],
      ['', ''],
      ['行动清单', '亏钱的广告系列、目标设错的出价策略、严重亏损的关键字'],
      ['盈亏平衡', '计算过程和账户整体的利润'],
      ['广告系列', '每个系列的实际效果、估算利润、出价策略和当前目标、建议目标'],
      ['关键字分层', '按 CPA（或 ROAS）把关键字分成五档'],
      ['目标对比', '设置了 MONTHLY_TARGET 时：为了达到月目标，每天需要的花费、点击、转化，和最近实际值对比'],
      ['注意', '利润是估算值：按设置的统一毛利率计算，没有考虑退款、复购和品牌词带来的自然转化。毛利差别大的商品，建议用「商品分层标签」脚本按商品设置毛利']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '盈亏平衡', '广告系列', '关键字分层', '目标对比', '运行日志']);
}


// ======================= 计算 =======================

function breakeven(lead) {
  var m = num(CONFIG.MARGIN), vat = num(CONFIG.VAT_RATE), d = num(CONFIG.DISCOUNT), p = num(CONFIG.TARGET_PROFIT_SHARE);
  var be = { margin: m, vat: vat, discount: d, profitShare: p };
  if (!(m > 0 && m < 1)) be.error = 'MARGIN 要在 0 和 1 之间，例如 0.4';
  // 每 1 元转化价值能带来多少毛利（扣除增值税和折扣后）
  be.grossPerValue = (1 - d) / (1 + vat) * m;
  be.netPerValue = (1 - d) / (1 + vat);
  if (lead) {
    be.leadValue = num(CONFIG.LEAD_TO_DEAL) * num(CONFIG.DEAL_VALUE) * be.netPerValue; // 每个询盘带来的营收
    be.cpa = be.leadValue * m;                 // 盈亏平衡 CPA
    be.targetCpa = be.leadValue * Math.max(0, m - p);
  } else {
    be.roas = be.grossPerValue ? 1 / be.grossPerValue : '';
    var room = (1 - d) / (1 + vat) * (m - p);
    be.targetRoas = room > 0 ? 1 / room : '';
    if (room <= 0) be.error = 'TARGET_PROFIT_SHARE 不能大于等于毛利率';
  }
  return be;
}

function judge(c, be, lead) {
  derived(c);
  if (lead) {
    c.estValue = c.conv * be.leadValue;
    c.profit = c.conv * be.cpa - c.cost;
    c.status = !c.cost ? '' : !c.conv ? '亏损（没有询盘）' : c.cpa <= be.targetCpa ? '盈利' : c.cpa <= be.cpa ? '微利' : c.cpa <= be.cpa * 1.5 ? '亏损' : '严重亏损';
  } else {
    c.profit = c.value * be.grossPerValue - c.cost;
    c.status = !c.cost ? '' : !c.value ? '亏损（没有转化价值）' : c.roas >= be.targetRoas ? '盈利' : c.roas >= be.roas ? '微利' : c.roas >= be.roas * 0.67 ? '亏损' : '严重亏损';
  }
}

function fetchCampaigns() {
  var map = {};
  var sel = 'campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, ' +
    'campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros';
  var rows = tryQuery('广告系列（含目标）', 'SELECT ' + sel + ', metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE ' +
    range(CONFIG.DAYS) + ' AND campaign.status = "ENABLED" AND metrics.cost_micros > 0' + nameFilter());
  if (!rows) rows = runQuery('SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value FROM campaign WHERE ' + range(CONFIG.DAYS) + ' AND campaign.status = "ENABLED" AND metrics.cost_micros > 0' + nameFilter());
  rows.forEach(function (r) {
    var id = String(g(r, 'campaign.id'));
    var c = map[id] || (map[id] = zero({ id: id, name: String(g(r, 'campaign.name')), type: String(g(r, 'campaign.advertisingChannelType')),
      bidding: String(g(r, 'campaign.biddingStrategyType')), portfolio: !!g(r, 'campaign.biddingStrategy'),
      tRoas: num(g(r, 'campaign.targetRoas.targetRoas')) || num(g(r, 'campaign.maximizeConversionValue.targetRoas')) || '',
      tCpa: (num(g(r, 'campaign.targetCpa.targetCpaMicros')) || num(g(r, 'campaign.maximizeConversions.targetCpaMicros'))) / 1e6 || '' }));
    addMetrics(c, metricsOf(r));
  });
  return values(map).sort(function (a, b) { return b.cost - a.cost; });
}

function fetchKeywords() {
  var rows = tryQuery('关键字', 'SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks, ' +
    'metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.search_impression_share FROM keyword_view WHERE ' + range(CONFIG.DAYS) +
    ' AND metrics.cost_micros > 0 AND campaign.status = "ENABLED"' + nameFilter()) || [];
  return rows.map(function (r) {
    var k = zero({ campaign: String(g(r, 'campaign.name')), group: String(g(r, 'adGroup.name')), text: String(g(r, 'adGroupCriterion.keyword.text')),
      match: String(g(r, 'adGroupCriterion.keyword.matchType')), is: g(r, 'metrics.searchImpressionShare') === '' ? '' : num(g(r, 'metrics.searchImpressionShare')) });
    return addMetrics(k, metricsOf(r));
  }).sort(function (a, b) { return b.cost - a.cost; });
}

// 关键字五档：按「盈亏平衡 CPA」的比例（电商用 每次转化的毛利 作为盈亏平衡 CPA）
var TIERS = ['很赚', '赚', '接近保本', '亏', '严重亏'];
function tier(k, be, lead, aov) {
  derived(k);
  // 盈亏平衡 CPA：询盘 = 每个询盘的毛利；电商 = 这个关键字的客单价（没有转化时用账户客单价）× 毛利率
  var beCpa = lead ? be.cpa : ((k.conv ? k.value / k.conv : aov) || 0) * be.grossPerValue;
  k.note = '';
  if (!k.conv) {
    k.ratio = '';
    k.tier = beCpa && k.cost >= beCpa ? '严重亏' : '';
    k.note = beCpa && k.cost >= beCpa ? '没有转化，花费已超过一次转化的盈亏平衡成本' : '没有转化，数据还不够';
    return;
  }
  k.ratio = beCpa ? k.cpa / beCpa : '';
  k.tier = k.ratio === '' ? '' : k.ratio <= 0.5 ? '很赚' : k.ratio <= 0.8 ? '赚' : k.ratio <= 1 ? '接近保本' : k.ratio <= 1.5 ? '亏' : '严重亏';
}


// ======================= 输出 =======================

function writeBreakeven(ss, be, t, lead) {
  var rows = lead ? [
    ['输入', '毛利率', be.margin], ['', '询盘成交率', num(CONFIG.LEAD_TO_DEAL)], ['', '平均订单金额', num(CONFIG.DEAL_VALUE)], ['', '增值税率', be.vat], ['', '希望保留的利润比例', be.profitShare],
    ['计算', '每个询盘带来的营收', be.leadValue], ['', '盈亏平衡 CPA（每个询盘最多花多少）', be.cpa], ['', '建议目标 CPA', be.targetCpa],
    ['账户实际（最近 ' + CONFIG.DAYS + ' 天）', '花费', t.cost], ['', '询盘（转化）', t.conv], ['', '实际 CPA', t.cpa], ['', '估算利润', t.profit], ['', '状态', t.status]
  ] : [
    ['输入', '毛利率', be.margin], ['', '增值税率（转化价值含税时）', be.vat], ['', '平均折扣', be.discount], ['', '希望保留的利润比例', be.profitShare],
    ['计算', '每 1 元转化价值的毛利', be.grossPerValue], ['', '盈亏平衡 ROAS', be.roas], ['', '建议目标 ROAS（Google Ads 里填百分比）', be.targetRoas],
    ['账户实际（最近 ' + CONFIG.DAYS + ' 天）', '花费', t.cost], ['', '转化价值', t.value], ['', '实际 ROAS', t.roas], ['', '估算毛利 − 广告费', t.profit], ['', '状态', t.status]
  ];
  var sh = write(ss, '盈亏平衡', ['分类', '项目', '数值'], rows.map(function (r) { return [r[0], r[1], r[2] === undefined ? '' : r[2]]; }), null, { widths: [180, 320, 160] });
  rows.forEach(function (r, i) {
    var f = /率|比例|折扣/.test(r[1]) ? FMT.pct : /ROAS/.test(r[1]) ? '0.00' : /询盘（转化）/.test(r[1]) ? FMT.dec : FMT.money;
    if (typeof r[2] === 'number') sh.getRange(i + 2, 3).setNumberFormat(f);
  });
}

function writeCampaigns(ss, camps, lead) {
  var head = ['广告系列', '类型', '出价策略', '当前目标 ROAS', '当前目标 CPA'].concat(METRIC_HEAD).concat(['估算利润', '状态', '目标检查']);
  write(ss, '广告系列', head, camps.map(function (c) {
    return [c.name, c.type, (BID_CN[c.bidding] || c.bidding) + (c.portfolio ? '（组合策略）' : ''), c.tRoas, c.tCpa].concat(metricCells(c)).concat([c.profit, c.status, c.targetCheck || '']);
  }), ['', '', '', '0%', FMT.money].concat(METRIC_FMT).concat([FMT.money, '', '']),
  { widths: [220, 110, 180], colors: { col: 15, fn: statusColor } });
}
function statusColor(v) { return /严重/.test(v) ? '#fbd3cf' : /亏/.test(v) ? '#fde2e1' : v === '微利' ? '#fff1d6' : v === '盈利' ? '#e3f4e8' : null; }

function writeKeywords(ss, kws, lead) {
  var head = ['档位', '广告系列', '广告组', '关键字', '匹配方式'].concat(METRIC_HEAD).concat(['CPA / 盈亏平衡 CPA', '展示份额', '建议']);
  var tip = { '很赚': '提高出价或预算，争取更多展示份额', '赚': '保持', '接近保本': '观察，必要时略降出价', '亏': '降低出价，检查搜索词和落地页', '严重亏': '大幅降低出价或暂停；先看搜索字词是否不相关' };
  write(ss, '关键字分层', head, kws.slice(0, 5000).map(function (k) {
    return [k.tier || '数据不足', k.campaign, k.group, k.text, k.match].concat(metricCells(k)).concat([k.ratio, k.is, tip[k.tier] || k.note]);
  }), ['', '', '', '', ''].concat(METRIC_FMT).concat([FMT.ratio, FMT.pct, '']), { empty: '没有关键字数据（只统计搜索广告关键字）',
    colors: { col: 0, fn: function (v) { return v === '很赚' ? '#bfe5c9' : v === '赚' ? '#e3f4e8' : v === '接近保本' ? '#fff1d6' : v === '亏' ? '#fde2e1' : v === '严重亏' ? '#fbd3cf' : null; } } });
}

// 目标对比：为了完成月目标，每天需要多少
function required(ss, be, t, lead) {
  var p = today().split('-'), daysInMonth = new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate();
  var d = CONFIG.DAYS, act = { cost: t.cost / d, clicks: t.clicks / d, conv: t.conv / d, value: t.value / d };
  act.cpc = div(act.cost, act.clicks); act.cvr = div(act.conv, act.clicks); act.aov = div(act.value, act.conv); act.roas = div(act.value, act.cost); act.cpa = div(act.cost, act.conv);
  var reqd = {};
  if (lead) {
    reqd.conv = CONFIG.MONTHLY_TARGET / daysInMonth;
    reqd.cpa = be.targetCpa; reqd.cost = reqd.conv * reqd.cpa;
    reqd.clicks = act.cvr ? reqd.conv / act.cvr : ''; reqd.cpc = reqd.clicks ? reqd.cost / reqd.clicks : ''; reqd.cvr = act.cvr;
  } else {
    reqd.value = CONFIG.MONTHLY_TARGET / daysInMonth;
    reqd.roas = be.targetRoas; reqd.cost = reqd.roas ? reqd.value / reqd.roas : '';
    reqd.conv = act.aov ? reqd.value / act.aov : ''; reqd.aov = act.aov;
    reqd.clicks = act.cvr && reqd.conv ? reqd.conv / act.cvr : ''; reqd.cpc = reqd.clicks ? reqd.cost / reqd.clicks : ''; reqd.cvr = act.cvr;
  }
  var items = lead ? [['每天询盘', 'conv', FMT.dec], ['目标 CPA', 'cpa', FMT.money], ['每天花费', 'cost', FMT.money], ['每天点击', 'clicks', FMT.int], ['平均点击费用', 'cpc', FMT.money], ['转化率', 'cvr', FMT.pct]]
    : [['每天营收', 'value', FMT.money], ['ROAS', 'roas', '0.00'], ['每天花费', 'cost', FMT.money], ['每天订单', 'conv', FMT.dec], ['客单价', 'aov', FMT.money], ['每天点击', 'clicks', FMT.int], ['平均点击费用', 'cpc', FMT.money], ['转化率', 'cvr', FMT.pct]];
  var rows = items.map(function (it) { var a = act[it[1]], r = reqd[it[1]]; return [it[0], r, a, r !== '' && a !== '' && r ? a / r - 1 : '']; });
  var sh = write(ss, '目标对比', ['指标', '需要（每天）', '最近 ' + d + ' 天实际（日均）', '实际 vs 需要'], rows, null,
    { title: '月目标 ' + CONFIG.MONTHLY_TARGET + (lead ? ' 个询盘' : ' 营收') + '，本月 ' + daysInMonth + ' 天。「需要」按建议目标' + (lead ? ' CPA' : ' ROAS') + '和最近的转化率、客单价计算' });
  items.forEach(function (it, i) { sh.getRange(i + 3, 2, 1, 2).setNumberFormat(it[2]); });
  sh.getRange(3, 4, items.length, 1).setNumberFormat('+0%;-0%;0%');
  return { reqd: reqd, act: act };
}

function buildActions(camps, kws, t, be, req, lead) {
  var A = [];
  if (be.error) A.push(['高', '设置', '—', be.error, '', '修改设置后重新运行']);
  A.push([t.status && /亏/.test(t.status) ? '高' : '低', '账户', '全部广告系列', '账户整体：' + (t.status || '无数据'), (lead ? '实际 CPA ' + r2(t.cpa) + '，盈亏平衡 ' + r2(be.cpa) : '实际 ROAS ' + r2(t.roas) + '，盈亏平衡 ' + r2(be.roas)) + '，估算利润 ' + r2(t.profit),
    lead ? '建议目标 CPA ' + r2(be.targetCpa) : '建议目标 ROAS ' + pct(be.targetRoas) + '（在 Google Ads 里填 ' + Math.round(num(be.targetRoas) * 100) + '%）']);
  camps.filter(function (c) { return /亏/.test(c.status); }).slice(0, 10).forEach(function (c) {
    A.push([/严重/.test(c.status) ? '高' : '中', '广告系列', c.name, c.status, '花费 ' + r2(c.cost) + '，' + (lead ? 'CPA ' + r2(c.cpa) : 'ROAS ' + r2(c.roas)) + '，估算利润 ' + r2(c.profit),
      c.type === 'SEARCH' ? '先看「关键字分层」里严重亏的关键字和搜索字词；再考虑提高目标或降低预算' : '提高目标 ' + (lead ? 'CPA 的严格程度（调低目标 CPA）' : 'ROAS') + '，或降低预算']);
  });
  camps.forEach(function (c) {
    if (!lead && c.tRoas && be.roas && c.tRoas < be.roas) {
      c.targetCheck = '目标 ROAS ' + pct(c.tRoas) + ' 低于盈亏平衡 ' + pct(be.roas);
      A.push(['高', '出价目标', c.name, '目标 ROAS 设得比盈亏平衡还低', '当前 ' + pct(c.tRoas) + '，盈亏平衡 ' + pct(be.roas), 'Google 会按这个目标去投，达到目标也是亏钱的。逐步提高到 ' + pct(be.targetRoas) + '（每次 10–20%，避免流量骤降）']);
    } else if (lead && c.tCpa && be.cpa && c.tCpa > be.cpa) {
      c.targetCheck = '目标 CPA ' + r2(c.tCpa) + ' 高于盈亏平衡 ' + r2(be.cpa);
      A.push(['高', '出价目标', c.name, '目标 CPA 设得比盈亏平衡还高', '当前 ' + r2(c.tCpa) + '，盈亏平衡 ' + r2(be.cpa), '逐步降低到 ' + r2(be.targetCpa) + '（每次 10–20%）']);
    } else if (c.tRoas || c.tCpa) c.targetCheck = '目标设置合理';
    else if (/MAXIMIZE/.test(c.bidding)) c.targetCheck = '没有设置目标：' + (lead ? '建议设目标 CPA ' + r2(be.targetCpa) : '建议设目标 ROAS ' + pct(be.targetRoas));
  });
  var bad = kws.filter(function (k) { return k.tier === '严重亏'; });
  if (bad.length) A.push(['中', '关键字', bad.length + ' 个关键字', '严重亏损', '合计花费 ' + r2(bad.reduce(function (s, k) { return s + k.cost; }, 0)), '见「关键字分层」，降低出价或暂停；可以配合搜索字词守卫脚本找出具体浪费的搜索词']);
  var great = kws.filter(function (k) { return k.tier === '很赚' && k.is !== '' && k.is < 0.5; });
  if (great.length) A.push(['中', '关键字', great.length + ' 个关键字', '很赚钱但展示份额不到 50%', '例如：' + great.slice(0, 5).map(function (k) { return k.text; }).join('、'), '提高出价或预算，这些词多拿一次展示就是多一份利润']);
  if (req) {
    var gap = req.reqd.cost && req.act.cost ? req.act.cost / req.reqd.cost - 1 : '';
    if (gap !== '') A.push(['中', '月目标', '全部广告系列', '按建议目标完成月目标，每天需要花 ' + r2(req.reqd.cost), '最近日均花费 ' + r2(req.act.cost) + '（' + (gap >= 0 ? '+' : '') + Math.round(gap * 100) + '%）',
      gap < -0.2 ? '花费明显不够：在效率达标的系列上加预算，或者放宽目标' : gap > 0.2 ? '花费超出需要：可以收紧目标' + (lead ? ' CPA' : ' ROAS') + '提高利润' : '节奏基本合适']);
  }
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
