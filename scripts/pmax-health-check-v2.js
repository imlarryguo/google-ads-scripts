/**
 * PMax 体检脚本 v2.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：把效果最大化广告（Performance Max）的数据导出到 Google 表格，
 *       自动计算 ROAS、CPA，按渠道 / 商品 / 素材 / 搜索字词拆开分析，
 *       并生成一份「行动清单」，告诉你先改哪里。
 *
 * 思路参考 Mike Rhodes 的免费 PMax 脚本 v28，代码为重新编写：
 *   - 不再依赖模板表格，工作表自动创建；
 *   - 使用 Google Ads API 的 PMax 渠道报告（segments.ad_network_type）；
 *   - 新增素材级效果、搜索字词、行动清单、邮件通知；
 *   - 每一部分单独运行，某一个报告出错不会影响其他报告。
 *
 * 使用方法和每个工作表的解读，见：https://berightdigital.com/pmax-script-tutorial/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建一份，网址会打印在「日志」里，
  // 把它复制回这里，之后每次运行都会更新同一份表格。
  SPREADSHEET_URL: '',

  // 只分析名称包含这段文字的 PMax 广告系列。留空 = 全部 PMax 广告系列。
  CAMPAIGN_NAME_CONTAINS: '',

  // 时间范围（天，截至昨天）
  DAYS: 30,          // 大部分报告的时间范围
  LONG_DAYS: 180,    // 商品长期表现
  ZOMBIE_DAYS: 365,  // 僵尸商品（有展示、零点击）的判断范围

  // 你的盈亏线。盈亏平衡 ROAS = 1 ÷ 毛利率（扣除商品成本、运费、手续费后）。
  // 不会算可以用 https://berightdigital.com/tools/roas-calculator/
  BREAKEVEN_ROAS: 2.5,
  TARGET_ROAS: 3.5,

  // 花费超过这个金额仍然没有转化，就标记为「花钱无转化」。建议设为你可接受的单次转化费用。
  WASTE_COST: 50,

  // 僵尸商品：展示次数至少多少才列出（过滤掉几乎没展示的商品）
  ZOMBIE_MIN_IMPRESSIONS: 100,

  // 每个表最多写入多少行（防止账户太大时超时）
  MAX_ROWS: 5000,

  // 运行完成后把行动清单摘要发到这个邮箱。留空 = 不发邮件。多个邮箱用英文逗号分隔。
  EMAIL: ''
};
// ======================= 设置结束，下面的代码一般不需要改 =======================


var VERSION = 'v2.0';
var RUN_LOG = [];
var FMT = { money: '#,##0.00', int: '#,##0', pct: '0.00%', ratio: '0.00', dec: '#,##0.00' };

var CHANNEL_CN = {
  SEARCH: '搜索', SEARCH_PARTNERS: '搜索网络合作伙伴', CONTENT: '展示广告网络', DISPLAY: '展示广告网络',
  YOUTUBE: 'YouTube', YOUTUBE_SEARCH: 'YouTube', YOUTUBE_WATCH: 'YouTube', GMAIL: 'Gmail',
  DISCOVER: 'Discover', MAPS: '地图', GOOGLE_TV: 'Google TV', MIXED: '跨网络（未拆分）',
  CROSS_NETWORK: '跨网络（未拆分）', UNKNOWN: '未知', UNSPECIFIED: '未指定'
};
var LABEL_CN = { BEST: '最佳', GOOD: '良好', LOW: '较差', LEARNING: '学习中', PENDING: '待定', UNKNOWN: '未知', UNSPECIFIED: '' };
var STRENGTH_CN = { EXCELLENT: '极佳', GOOD: '良好', AVERAGE: '一般', POOR: '差', PENDING: '待定', NO_ADS: '无广告', UNKNOWN: '未知', UNSPECIFIED: '' };
var STATUS_CN = { ENABLED: '已启用', PAUSED: '已暂停', REMOVED: '已移除', ELIGIBLE: '符合条件', LIMITED: '受限', NOT_ELIGIBLE: '不符合条件', PENDING: '审核中', UNKNOWN: '未知', UNSPECIFIED: '' };
var FIELD_CN = {
  HEADLINE: '标题', LONG_HEADLINE: '长标题', DESCRIPTION: '说明', BUSINESS_NAME: '商家名称',
  MARKETING_IMAGE: '横向图片', SQUARE_MARKETING_IMAGE: '方形图片', PORTRAIT_MARKETING_IMAGE: '纵向图片',
  TALL_PORTRAIT_MARKETING_IMAGE: '竖长图片', LOGO: '徽标', LANDSCAPE_LOGO: '横向徽标', YOUTUBE_VIDEO: 'YouTube 视频',
  CALL_TO_ACTION_SELECTION: '行动号召', MEDIA_BUNDLE: '媒体包', SITELINK: '附加链接', CALLOUT: '宣传信息',
  STRUCTURED_SNIPPET: '结构化摘要', PRICE: '价格', PROMOTION: '促销', CALL: '电话', LEAD_FORM: '潜在客户表单'
};


function main() {
  var started = new Date();
  var acct = AdsApp.currentAccount();
  log('信息', '开始', '账户：' + acct.getName() + '（' + acct.getCustomerId() + '），版本 ' + VERSION);

  var ss = openSpreadsheet(acct);
  var R = {}; // 每个报告的结果，供行动清单使用

  var pS = '商品_近' + CONFIG.DAYS + '天', pL = '商品_近' + CONFIG.LONG_DAYS + '天';
  R.camps    = safeSheet(ss, '广告系列概览', function () { return reportCampaigns(ss); });
  R.channels = safeSheet(ss, '渠道拆分',     function () { return reportChannels(ss); });
  R.daily    = safeSheet(ss, '每日趋势',     function () { return reportDaily(ss); });
  R.ags      = safeSheet(ss, '素材资源组',   function () { return reportAssetGroups(ss); });
  R.assets   = safeSheet(ss, '素材明细',     function () { return reportAssets(ss); });
  R.prods    = safeSheet(ss, pS,             function () { return reportProducts(ss, CONFIG.DAYS, pS); });
  R.prodsL   = safeSheet(ss, pL,             function () { return reportProducts(ss, CONFIG.LONG_DAYS, pL); });
  R.zombies  = safeSheet(ss, '僵尸商品',     function () { return reportZombies(ss); });
  R.terms    = safeSheet(ss, '搜索字词',     function () { return reportSearchTerms(ss); });

  var actions = safe('行动清单', function () { return buildActions(ss, R); }) || [];
  safe('使用说明', function () { writeGuide(ss, acct, started); });

  log('信息', '完成', '用时 ' + Math.round((new Date() - started) / 1000) + ' 秒，表格：' + ss.getUrl());
  writeLog(ss);
  orderSheets(ss);
  if (CONFIG.EMAIL) safe('邮件', function () { sendEmail(acct, ss, actions, R.camps); });
}


// ======================= 各个报告 =======================

function reportCampaigns(ss) {
  var q = 'SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, ' +
          'campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
          'metrics.conversions, metrics.conversions_value ' +
          'FROM campaign WHERE ' + range(CONFIG.DAYS) + pmaxFilter() + ' AND campaign.status != "REMOVED"';
  var list = runQuery(q).map(function (r) {
    var m = metricsOf(r);
    m.id = g(r, 'campaign.id'); m.name = g(r, 'campaign.name');
    m.status = g(r, 'campaign.status'); m.bidding = g(r, 'campaign.biddingStrategyType');
    m.budget = money(g(r, 'campaignBudget.amountMicros'));
    return m;
  });
  list.sort(byCost);
  var header = ['广告系列', '状态', '出价策略', '日预算', '费用', '展示', '点击', '点击率', '平均点击费用',
                '转化', '转化价值', 'ROAS', '单次转化费用', '判断'];
  var data = list.map(function (c) {
    return [c.name, cn(STATUS_CN, c.status), c.bidding, c.budget, c.cost, c.impr, c.clicks, div(c.clicks, c.impr),
            div(c.cost, c.clicks), c.conv, c.value, div(c.value, c.cost), div(c.cost, c.conv), judge(c)];
  });
  var tot = sumMetrics(list);
  data.push(['合计', '', '', '', tot.cost, tot.impr, tot.clicks, div(tot.clicks, tot.impr), div(tot.cost, tot.clicks),
             tot.conv, tot.value, div(tot.value, tot.cost), div(tot.cost, tot.conv), judge(tot)]);
  var sh = write(ss, '广告系列概览', header, data,
    ['', '', '', FMT.money, FMT.money, FMT.int, FMT.int, FMT.pct, FMT.money, FMT.dec, FMT.money, FMT.ratio, FMT.money, '']);
  colorJudge(sh, data, 14);
  log('信息', '广告系列概览', list.length + ' 个 PMax 广告系列');
  return { list: list, total: tot };
}

function reportChannels(ss) {
  var base = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
             'FROM campaign WHERE ' + range(CONFIG.DAYS) + pmaxFilter() + ' AND campaign.status != "REMOVED"';
  var rows, withProduct = true;
  try {
    rows = runQuery('SELECT campaign.name, segments.ad_network_type, segments.ad_using_product_data, ' + base);
  } catch (e) {
    withProduct = false;
    log('提示', '渠道拆分', '不支持「是否使用商品数据」细分，改为只按渠道拆分：' + e.message);
    rows = runQuery('SELECT campaign.name, segments.ad_network_type, ' + base);
  }

  var map = {};
  rows.forEach(function (r) {
    var ch = cn(CHANNEL_CN, g(r, 'segments.adNetworkType'));
    if (withProduct) ch += String(g(r, 'segments.adUsingProductData')) === 'true' ? '（商品广告）' : '';
    var key = g(r, 'campaign.name') + '||' + ch;
    if (!map[key]) map[key] = zero({ campaign: g(r, 'campaign.name'), channel: ch });
    addMetrics(map[key], metricsOf(r));
  });
  var list = values(map);

  // 每个广告系列的费用合计，用于计算占比；同时汇总全账户
  var campCost = {}, acctMap = {};
  list.forEach(function (x) {
    campCost[x.campaign] = (campCost[x.campaign] || 0) + x.cost;
    if (!acctMap[x.channel]) acctMap[x.channel] = zero({ campaign: '全部 PMax 合计', channel: x.channel });
    addMetrics(acctMap[x.channel], x);
  });
  var acctList = values(acctMap), acctCost = 0;
  acctList.forEach(function (x) { acctCost += x.cost; });
  campCost['全部 PMax 合计'] = acctCost;
  acctList.sort(byCost);
  list.sort(function (a, b) { return a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : b.cost - a.cost; });

  var unsplit = list.length > 0 && list.every(function (x) { return x.channel.indexOf('跨网络') === 0; });
  if (unsplit) log('提示', '渠道拆分', '当前只返回「跨网络」汇总，渠道明细不可用（渠道数据从 2025 年 6 月起才有）。');

  var header = ['广告系列', '渠道', '费用', '费用占比', '展示', '点击', '点击率', '转化', '转化价值', 'ROAS', '单次转化费用', '判断'];
  var all = acctList.concat(list);
  var data = all.map(function (x) {
    return [x.campaign, x.channel, x.cost, div(x.cost, campCost[x.campaign]), x.impr, x.clicks, div(x.clicks, x.impr),
            x.conv, x.value, div(x.value, x.cost), div(x.cost, x.conv), judge(x)];
  });
  var sh = write(ss, '渠道拆分', header, data,
    ['', '', FMT.money, FMT.pct, FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.money, FMT.ratio, FMT.money, '']);
  colorJudge(sh, data, 12);
  if (acctList.length) sh.getRange(2, 1, acctList.length, header.length).setFontWeight('bold');
  return { list: list, account: acctList, campCost: campCost, unsplit: unsplit };
}

function reportDaily(ss) {
  var q = 'SELECT segments.date, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
          'metrics.conversions, metrics.conversions_value FROM campaign WHERE ' + range(CONFIG.DAYS) + pmaxFilter() +
          ' AND campaign.status != "REMOVED" ORDER BY segments.date';
  var list = runQuery(q).map(function (r) {
    var m = metricsOf(r); m.date = g(r, 'segments.date'); m.name = g(r, 'campaign.name'); return m;
  });
  var header = ['日期', '广告系列', '费用', '展示', '点击', '转化', '转化价值', 'ROAS'];
  var data = list.map(function (d) { return [d.date, d.name, d.cost, d.impr, d.clicks, d.conv, d.value, div(d.value, d.cost)]; });
  write(ss, '每日趋势', header, data, ['', '', FMT.money, FMT.int, FMT.int, FMT.dec, FMT.money, FMT.ratio]);
  return list;
}

function reportAssetGroups(ss) {
  var q = 'SELECT campaign.name, asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength, ' +
          'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
          'FROM asset_group WHERE ' + range(CONFIG.DAYS) + pmaxFilter() + ' AND asset_group.status != "REMOVED"';
  var list = runQuery(q).map(function (r) {
    var m = metricsOf(r);
    m.campaign = g(r, 'campaign.name'); m.id = g(r, 'assetGroup.id'); m.name = g(r, 'assetGroup.name');
    m.status = g(r, 'assetGroup.status'); m.strength = g(r, 'assetGroup.adStrength');
    return m;
  });
  list.sort(byCost);
  var header = ['广告系列', '素材资源组', '状态', '广告效力', '费用', '展示', '点击', '点击率', '转化', '转化价值', 'ROAS', '单次转化费用', '判断'];
  var data = list.map(function (a) {
    return [a.campaign, a.name, cn(STATUS_CN, a.status), cn(STRENGTH_CN, a.strength), a.cost, a.impr, a.clicks,
            div(a.clicks, a.impr), a.conv, a.value, div(a.value, a.cost), div(a.cost, a.conv), judge(a)];
  });
  var sh = write(ss, '素材资源组', header, data,
    ['', '', '', '', FMT.money, FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.money, FMT.ratio, FMT.money, '']);
  colorJudge(sh, data, 13);
  return list;
}

function reportAssets(ss) {
  var attrs = 'campaign.name, asset_group.name, asset_group_asset.field_type, asset_group_asset.status, ' +
              'asset_group_asset.performance_label, asset.id, asset.type, asset.name, asset.text_asset.text, ' +
              'asset.youtube_video_asset.youtube_video_title, asset.youtube_video_asset.youtube_video_id, ' +
              'asset.image_asset.full_size.url';
  var where = ' FROM asset_group_asset WHERE campaign.advertising_channel_type = "PERFORMANCE_MAX"' + nameFilter() +
              ' AND campaign.status != "REMOVED" AND asset_group.status != "REMOVED" AND asset_group_asset.status != "REMOVED"';
  var metricsSel = ', metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';

  // 依次尝试：素材级效果 + 投放状态 → 素材级效果 → 只要素材属性（老版本 API）
  var attempts = [
    { sel: attrs + ', asset_group_asset.primary_status' + metricsSel, w: where + ' AND ' + range(CONFIG.DAYS), metrics: true, ps: true },
    { sel: attrs + metricsSel, w: where + ' AND ' + range(CONFIG.DAYS), metrics: true, ps: false },
    { sel: attrs, w: where, metrics: false, ps: false }
  ];
  var rows = null, used = null;
  for (var i = 0; i < attempts.length && rows === null; i++) {
    try { rows = runQuery('SELECT ' + attempts[i].sel + attempts[i].w); used = attempts[i]; }
    catch (e) { log('提示', '素材明细', '第 ' + (i + 1) + ' 种查询不可用，改用简化查询：' + e.message); }
  }
  if (rows === null) throw new Error('素材查询全部失败');

  var list = rows.map(function (r) {
    var m = used.metrics ? metricsOf(r) : zero({});
    m.campaign = g(r, 'campaign.name'); m.group = g(r, 'assetGroup.name');
    m.field = g(r, 'assetGroupAsset.fieldType'); m.label = g(r, 'assetGroupAsset.performanceLabel');
    m.primary = used.ps ? g(r, 'assetGroupAsset.primaryStatus') : '';
    m.type = g(r, 'asset.type'); m.assetId = g(r, 'asset.id');
    m.content = g(r, 'asset.textAsset.text') || g(r, 'asset.youtubeVideoAsset.youtubeVideoTitle') || g(r, 'asset.name') || '';
    var yt = g(r, 'asset.youtubeVideoAsset.youtubeVideoId');
    m.link = yt ? 'https://www.youtube.com/watch?v=' + yt : (g(r, 'asset.imageAsset.fullSize.url') || '');
    return m;
  });
  list.sort(function (a, b) {
    return a.campaign + a.group < b.campaign + b.group ? -1 : a.campaign + a.group > b.campaign + b.group ? 1 : b.cost - a.cost;
  });
  var header = ['广告系列', '素材资源组', '素材位置', '素材类型', '内容 / 标题', '链接', '效果评级', '投放状态',
                '费用', '展示', '点击', '点击率', '转化', '转化价值', 'ROAS', '素材 ID'];
  var data = list.map(function (a) {
    return [a.campaign, a.group, cn(FIELD_CN, a.field), a.type, String(a.content).slice(0, 300), a.link,
            cn(LABEL_CN, a.label), cn(STATUS_CN, a.primary), used.metrics ? a.cost : '', used.metrics ? a.impr : '',
            used.metrics ? a.clicks : '', used.metrics ? div(a.clicks, a.impr) : '', used.metrics ? a.conv : '',
            used.metrics ? a.value : '', used.metrics ? div(a.value, a.cost) : '', String(a.assetId)];
  });
  write(ss, '素材明细', header, cap(data, '素材明细'),
    ['', '', '', '', '', '', '', '', FMT.money, FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.money, FMT.ratio, '@']);
  if (!used.metrics) log('提示', '素材明细', '当前 API 版本没有素材级效果数据，只导出了素材属性和评级。');
  return { list: list, hasMetrics: used.metrics };
}

function reportProducts(ss, days, sheetName) {
  var q = 'SELECT segments.product_item_id, segments.product_title, segments.product_custom_attribute0, ' +
          'segments.product_custom_attribute1, segments.product_custom_attribute2, segments.product_custom_attribute3, ' +
          'segments.product_custom_attribute4, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
          'metrics.conversions, metrics.conversions_value FROM shopping_performance_view WHERE ' + range(days) + pmaxFilter();
  var map = {};
  runQuery(q).forEach(function (r) {
    var id = String(g(r, 'segments.productItemId') || '');
    if (!map[id]) map[id] = zero({
      id: id, title: g(r, 'segments.productTitle') || '',
      c0: g(r, 'segments.productCustomAttribute0') || '', c1: g(r, 'segments.productCustomAttribute1') || '',
      c2: g(r, 'segments.productCustomAttribute2') || '', c3: g(r, 'segments.productCustomAttribute3') || '',
      c4: g(r, 'segments.productCustomAttribute4') || ''
    });
    addMetrics(map[id], metricsOf(r));
  });
  var list = values(map);
  list.forEach(function (p) { p.cls = productClass(p); });
  list.sort(byCost);

  var header = ['商品 ID', '商品标题', '自定义标签0', '自定义标签1', '自定义标签2', '自定义标签3', '自定义标签4',
                '费用', '展示', '点击', '点击率', '转化', '转化价值', 'ROAS', '单次转化费用', '分类'];
  var data = list.map(function (p) {
    return [p.id, p.title, p.c0, p.c1, p.c2, p.c3, p.c4, p.cost, p.impr, p.clicks, div(p.clicks, p.impr),
            p.conv, p.value, div(p.value, p.cost), div(p.cost, p.conv), p.cls];
  });
  data = cap(data, sheetName);
  var sh = write(ss, sheetName, header, data,
    ['@', '', '', '', '', '', '', FMT.money, FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.money, FMT.ratio, FMT.money, '']);
  colorJudge(sh, data, 16);
  log('信息', sheetName, list.length + ' 个商品');
  return list;
}

function reportZombies(ss) {
  var q = 'SELECT segments.product_item_id, segments.product_title, segments.product_custom_attribute0, ' +
          'metrics.impressions, metrics.clicks, metrics.cost_micros FROM shopping_performance_view WHERE ' +
          range(CONFIG.ZOMBIE_DAYS) + pmaxFilter() + ' AND metrics.clicks = 0 AND metrics.impressions >= ' +
          Number(CONFIG.ZOMBIE_MIN_IMPRESSIONS) + ' ORDER BY metrics.impressions DESC';
  var map = {};
  runQuery(q).forEach(function (r) {
    var id = String(g(r, 'segments.productItemId') || '');
    if (!map[id]) map[id] = zero({ id: id, title: g(r, 'segments.productTitle') || '', c0: g(r, 'segments.productCustomAttribute0') || '' });
    addMetrics(map[id], metricsOf(r));
  });
  var list = values(map).filter(function (z) { return z.clicks === 0; });
  list.sort(function (a, b) { return b.impr - a.impr; });
  var header = ['商品 ID', '商品标题', '自定义标签0', '展示（近' + CONFIG.ZOMBIE_DAYS + '天）', '点击', '建议'];
  var data = list.map(function (z) {
    return [z.id, z.title, z.c0, z.impr, z.clicks, '检查标题、主图和价格；或用自定义标签单独分组测试'];
  });
  write(ss, '僵尸商品', header, cap(data, '僵尸商品'), ['@', '', '', FMT.int, FMT.int, '']);
  log('信息', '僵尸商品', list.length + ' 个');
  return list;
}

function reportSearchTerms(ss) {
  var q = 'SELECT campaign.name, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, ' +
          'metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign_search_term_view WHERE ' +
          range(CONFIG.DAYS) + pmaxFilter() + ' AND campaign.status != "REMOVED" AND metrics.impressions > 0 ' +
          'ORDER BY metrics.cost_micros DESC LIMIT ' + Number(CONFIG.MAX_ROWS);
  var list = runQuery(q).map(function (r) {
    var m = metricsOf(r); m.campaign = g(r, 'campaign.name'); m.term = g(r, 'campaignSearchTermView.searchTerm') || '';
    return m;
  });
  var header = ['广告系列', '搜索字词', '费用', '展示', '点击', '点击率', '转化', '转化价值', 'ROAS', '建议'];
  var data = list.map(function (t) {
    var tip = (t.cost >= CONFIG.WASTE_COST && t.conv === 0) ? '否定关键字候选（先确认不是品牌词或核心词）' :
              (t.conv > 0 && t.cost > 0 && t.value / t.cost >= CONFIG.TARGET_ROAS) ? '表现好，可以考虑在搜索广告里单独投放' : '';
    return [t.campaign, t.term, t.cost, t.impr, t.clicks, div(t.clicks, t.impr), t.conv, t.value, div(t.value, t.cost), tip];
  });
  write(ss, '搜索字词', header, data, ['', '', FMT.money, FMT.int, FMT.int, FMT.pct, FMT.dec, FMT.money, FMT.ratio, '']);
  log('信息', '搜索字词', list.length + ' 个搜索字词');
  return list;
}


// ======================= 行动清单 =======================

function buildActions(ss, R) {
  var A = []; // [优先级, 类别, 对象, 发现, 数据, 建议]
  var be = CONFIG.BREAKEVEN_ROAS, tg = CONFIG.TARGET_ROAS, waste = CONFIG.WASTE_COST;

  if (R.camps) {
    R.camps.list.forEach(function (c) {
      var roas = c.cost > 0 ? c.value / c.cost : 0;
      if (c.cost >= waste && roas < be)
        A.push(['高', '广告系列', c.name, 'ROAS 低于盈亏平衡线', 'ROAS ' + r2(roas) + '，盈亏线 ' + be + '，费用 ' + r2(c.cost),
                '先看「渠道拆分」和「商品」表找出亏损来源；价值出价可适当提高目标 ROAS，或把亏损商品移出这个广告系列']);
      else if (c.cost >= waste && roas >= tg)
        A.push(['中', '广告系列', c.name, 'ROAS 高于目标', 'ROAS ' + r2(roas) + '，目标 ' + tg,
                '如果预算经常花完，可以每次加 15%–20% 预算，加完观察 5–7 天']);
    });
  }

  if (R.channels && !R.channels.unsplit) {
    R.channels.list.forEach(function (x) {
      var share = R.channels.campCost[x.campaign] ? x.cost / R.channels.campCost[x.campaign] : 0;
      var roas = x.cost > 0 ? x.value / x.cost : 0;
      if (share >= 0.2 && x.cost >= waste && roas < be)
        A.push(['中', '渠道', x.campaign + ' / ' + x.channel, '花费占比高但 ROAS 低于盈亏线',
                '占广告系列费用 ' + Math.round(share * 100) + '%，ROAS ' + r2(roas),
                x.channel.indexOf('YouTube') >= 0 ? '检查视频素材：没有上传视频时系统会自动生成，质量往往较差，建议上传自己的竖版和横版视频' :
                x.channel.indexOf('展示') >= 0 ? '检查图片素材质量，查看「投放位置」报告并在账户层级排除低质量网站和应用' :
                '查看「搜索字词」表，把不相关的搜索加为否定关键字']);
    });
  } else if (R.channels && R.channels.unsplit) {
    A.push(['低', '渠道', '全部', '渠道明细不可用', '只返回跨网络汇总', '渠道数据从 2025 年 6 月起才有；时间范围选得太早或 API 版本较旧时会出现这种情况']);
  }

  var prods = R.prods || [];
  prods.filter(function (p) { return p.cls === '花钱无转化'; }).slice(0, 10).forEach(function (p) {
    A.push(['高', '商品', label(p), '花钱无转化', '费用 ' + r2(p.cost) + '，点击 ' + p.clicks,
            '检查价格、库存和落地页；确认不是新品后，用自定义标签把它移到单独的素材资源组或排除']);
  });
  prods.filter(function (p) { return p.cls === '亏损'; }).slice(0, 10).forEach(function (p) {
    A.push(['中', '商品', label(p), 'ROAS 低于盈亏平衡线', 'ROAS ' + r2(p.value / p.cost) + '，费用 ' + r2(p.cost),
            '检查毛利是否太低、价格是否有竞争力；可以按毛利给商品打自定义标签，分组设置不同目标']);
  });
  prods.filter(function (p) { return p.cls === '达标' && p.conv >= 2; })
       .sort(function (a, b) { return b.value / b.cost - a.value / a.cost; }).slice(0, 5).forEach(function (p) {
    A.push(['中', '商品', label(p), '表现好的商品', 'ROAS ' + r2(p.value / p.cost) + '，转化 ' + r2(p.conv),
            '考虑单独建素材资源组，配专属图片和文案，争取更多曝光']);
  });

  if (R.zombies && R.zombies.length) {
    var zi = 0; R.zombies.forEach(function (z) { zi += z.impr; });
    A.push(['中', '商品', R.zombies.length + ' 个僵尸商品', '近 ' + CONFIG.ZOMBIE_DAYS + ' 天有展示、零点击',
            '合计展示 ' + zi, '见「僵尸商品」表：优化标题前几个词、主图和价格；长期无点击的考虑下架或单独分组']);
  }

  (R.ags || []).forEach(function (a) {
    if (a.strength === 'POOR' || a.strength === 'AVERAGE')
      A.push([a.strength === 'POOR' ? '高' : '中', '素材资源组', a.campaign + ' / ' + a.name, '广告效力' + cn(STRENGTH_CN, a.strength),
              '费用 ' + r2(a.cost), '补齐标题、长标题、说明、横版/方形/纵向图片和视频，标题之间不要重复']);
  });

  if (R.assets) {
    var low = {}, bad = [];
    R.assets.list.forEach(function (x) {
      var k = x.campaign + ' / ' + x.group;
      if (x.label === 'LOW') low[k] = (low[k] || 0) + 1;
      if (x.primary === 'NOT_ELIGIBLE' || x.primary === 'LIMITED') bad.push(x);
    });
    Object.keys(low).forEach(function (k) {
      A.push(['低', '素材', k, low[k] + ' 个素材评级为「较差」', '', '保留至少 3–4 个同类型素材后，替换评级较差的素材']);
    });
    bad.slice(0, 20).forEach(function (x) {
      A.push(['高', '素材', x.campaign + ' / ' + x.group + ' / ' + cn(FIELD_CN, x.field), '素材' + cn(STATUS_CN, x.primary),
              String(x.content).slice(0, 60), '在 Google Ads 素材列表里查看受限原因（常见为政策审核），修改或替换']);
    });
  }

  if (R.terms) {
    var w = R.terms.filter(function (t) { return t.cost >= waste && t.conv === 0; });
    if (w.length) {
      var wc = 0; w.forEach(function (t) { wc += t.cost; });
      A.push(['中', '搜索字词', w.length + ' 个搜索字词', '花钱无转化', '合计费用 ' + r2(wc) + '，如：' +
              w.slice(0, 5).map(function (t) { return t.term; }).join('、'),
              '见「搜索字词」表，确认不相关后加为 PMax 否定关键字（只作用于搜索和购物流量）']);
    }
  }

  if (!prods.length) A.push(['低', '商品', '全部', '没有商品数据', '', '如果是零售 PMax，检查 Merchant Center 是否已关联、商品是否已获批']);

  var rank = { '高': 0, '中': 1, '低': 2 };
  A.sort(function (a, b) { return rank[a[0]] - rank[b[0]]; });
  if (!A.length) A.push(['—', '—', '—', '没有发现需要处理的问题', '', '继续按周检查']);

  var header = ['优先级', '类别', '对象', '发现', '数据', '建议'];
  var sh = write(ss, '行动清单', header, A, null);
  var bg = A.map(function (a) { return [a[0] === '高' ? '#fde2e1' : a[0] === '中' ? '#fff1d6' : '#eef1f5']; });
  sh.getRange(2, 1, A.length, 1).setBackgrounds(bg);
  sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 200); sh.setColumnWidth(5, 260); sh.setColumnWidth(6, 420);
  sh.getRange(2, 1, A.length, header.length).setWrap(true).setVerticalAlignment('top');
  log('信息', '行动清单', A.length + ' 条');
  return A;
}


// ======================= 说明、日志、邮件 =======================

function writeGuide(ss, acct, started) {
  var rows = [
    ['PMax 体检报告（' + VERSION + '）', ''],
    ['账户', acct.getName() + '（' + acct.getCustomerId() + '）'],
    ['运行时间', Utilities.formatDate(started, acct.getTimeZone(), 'yyyy-MM-dd HH:mm')],
    ['时间范围', '近 ' + CONFIG.DAYS + ' 天（截至昨天）；商品长期 ' + CONFIG.LONG_DAYS + ' 天；僵尸商品 ' + CONFIG.ZOMBIE_DAYS + ' 天'],
    ['盈亏平衡 ROAS / 目标 ROAS', CONFIG.BREAKEVEN_ROAS + ' / ' + CONFIG.TARGET_ROAS],
    ['花钱无转化的标准', '费用 ≥ ' + CONFIG.WASTE_COST + ' 且转化 = 0'],
    ['', ''],
    ['工作表', '看什么'],
    ['行动清单', '按优先级列出需要处理的问题，先看这里'],
    ['广告系列概览', '每个 PMax 广告系列的费用、转化、ROAS 和判断'],
    ['渠道拆分', '费用花在搜索、YouTube、展示、Gmail、Discover、地图的比例和各自的 ROAS'],
    ['每日趋势', '每天的费用、转化价值和 ROAS，用来看波动和学习期'],
    ['素材资源组', '每个素材资源组的广告效力和效果'],
    ['素材明细', '每个标题、图片、视频的评级、投放状态和效果'],
    ['商品_近' + CONFIG.DAYS + '天 / 商品_近' + CONFIG.LONG_DAYS + '天', '每个商品的效果和分类：花钱无转化 / 亏损 / 保本到目标之间 / 达标 / 数据不足 / 无点击'],
    ['僵尸商品', '长期有展示、零点击的商品'],
    ['搜索字词', 'PMax 触发的搜索字词和效果，标出否定关键字候选'],
    ['运行日志', '每一步是否成功，出错时看这里'],
    ['', ''],
    ['判断规则', 'ROAS < 盈亏线 = 亏损；盈亏线 ≤ ROAS < 目标 = 保本到目标之间；ROAS ≥ 目标 = 达标'],
    ['注意', '转化按点击日期统计，最近几天的数据会陆续补上；转化价值以 Google Ads 回传为准，不含退货'],
    ['教程', 'https://berightdigital.com/pmax-script-tutorial/']
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

function sendEmail(acct, ss, actions, camps) {
  var lines = ['PMax 体检报告：' + acct.getName(), ''];
  if (camps && camps.total) {
    var t = camps.total;
    lines.push('近 ' + CONFIG.DAYS + ' 天：费用 ' + r2(t.cost) + '，转化价值 ' + r2(t.value) + '，ROAS ' + r2(t.cost ? t.value / t.cost : 0) +
               '（盈亏线 ' + CONFIG.BREAKEVEN_ROAS + '，目标 ' + CONFIG.TARGET_ROAS + '）', '');
  }
  lines.push('优先处理：');
  actions.filter(function (a) { return a[0] === '高'; }).slice(0, 15).forEach(function (a) {
    lines.push('· [' + a[1] + '] ' + a[2] + '：' + a[3] + '（' + a[4] + '）');
  });
  lines.push('', '完整报告：' + ss.getUrl());
  MailApp.sendEmail(CONFIG.EMAIL, 'PMax 体检报告 - ' + acct.getName(), lines.join('\n'));
  log('信息', '邮件', '已发送到 ' + CONFIG.EMAIL);
}


// ======================= 工具函数 =======================

function openSpreadsheet(acct) {
  if (CONFIG.SPREADSHEET_URL) return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  var ss = SpreadsheetApp.create('PMax 体检报告 - ' + acct.getName());
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

// 运行一个报告；出错时把原因写进同名工作表，其他报告继续运行
function safeSheet(ss, name, fn) {
  try { return fn(); }
  catch (e) {
    var msg = (e && e.message) ? e.message : String(e);
    log('错误', name, msg);
    try {
      var sh = ss.getSheetByName(name) || ss.insertSheet(name);
      sh.clear();
      sh.getRange(1, 1, 3, 1).setValues([['这个报告本次没有生成'], ['原因：' + msg],
        ['常见原因：账户的 Google Ads API 版本暂不支持这个报告，或者这个时间范围没有数据。其他报告不受影响。']]);
    } catch (e2) { /* 忽略写表错误 */ }
    return null;
  }
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

function nameFilter() {
  var s = String(CONFIG.CAMPAIGN_NAME_CONTAINS || '').replace(/["\\%]/g, '');
  return s ? ' AND campaign.name LIKE "%' + s + '%"' : '';
}
function pmaxFilter() { return ' AND campaign.advertising_channel_type = "PERFORMANCE_MAX"' + nameFilter(); }

// 按点号路径取值，例如 g(row, 'metrics.costMicros')
function g(obj, path) {
  var parts = path.split('.'), cur = obj;
  for (var i = 0; i < parts.length; i++) { if (cur === null || cur === undefined) return ''; cur = cur[parts[i]]; }
  return cur === undefined || cur === null ? '' : cur;
}
function num(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function money(micros) { return num(micros) / 1e6; }
function div(a, b) { return b ? a / b : ''; }
function r2(x) { return Math.round(num(x) * 100) / 100; }
function cn(map, v) { return v === '' || v === undefined ? '' : (map[v] !== undefined ? map[v] : String(v)); }
function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
function byCost(a, b) { return b.cost - a.cost; }
function label(p) { return (p.title || '(无标题)').slice(0, 60) + '（' + p.id + '）'; }

function metricsOf(r) {
  return { impr: num(g(r, 'metrics.impressions')), clicks: num(g(r, 'metrics.clicks')), cost: money(g(r, 'metrics.costMicros')),
           conv: num(g(r, 'metrics.conversions')), value: num(g(r, 'metrics.conversionsValue')) };
}
function zero(o) { o.impr = 0; o.clicks = 0; o.cost = 0; o.conv = 0; o.value = 0; return o; }
function addMetrics(t, m) { t.impr += m.impr; t.clicks += m.clicks; t.cost += m.cost; t.conv += m.conv; t.value += m.value; return t; }
function sumMetrics(list) { var t = zero({}); list.forEach(function (x) { addMetrics(t, x); }); return t; }

function judge(x) {
  if (x.cost <= 0) return '';
  if (x.conv === 0) return x.cost >= CONFIG.WASTE_COST ? '花钱无转化' : '数据不足';
  var roas = x.value / x.cost;
  if (roas < CONFIG.BREAKEVEN_ROAS) return '亏损';
  if (roas < CONFIG.TARGET_ROAS) return '保本到目标之间';
  return '达标';
}
function productClass(p) {
  if (p.cost <= 0) return p.impr > 0 && p.clicks === 0 ? '无点击' : '';
  return judge(p);
}

function cap(data, name) {
  if (data.length > CONFIG.MAX_ROWS) {
    log('提示', name, '共 ' + data.length + ' 行，只写入费用最高的 ' + CONFIG.MAX_ROWS + ' 行（可在 MAX_ROWS 调整）');
    return data.slice(0, CONFIG.MAX_ROWS);
  }
  return data;
}

function write(ss, name, header, data, formats) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var body = data.length ? data.map(cleanRow) : [header.map(function (_, i) { return i === 0 ? '（没有数据）' : ''; })];
  // 先设格式再写值，商品 ID 等文本列才不会被转成数字
  if (formats && data.length) {
    formats.forEach(function (f, i) { if (f) sh.getRange(2, i + 1, data.length, 1).setNumberFormat(f); });
  }
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#173a52').setFontColor('#ffffff');
  sh.getRange(2, 1, body.length, header.length).setValues(body);
  sh.setFrozenRows(1);
  return sh;
}

// 以 = + - @ 开头的文字（例如搜索字词「+ size shoes」）会被表格当成公式，前面加 ' 保持为文字
function cleanRow(row) {
  return row.map(function (v) {
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
    return v === undefined || v === null ? '' : v;
  });
}

function colorJudge(sh, data, col) {
  if (!data.length) return;
  var colors = { '亏损': '#fde2e1', '花钱无转化': '#fde2e1', '保本到目标之间': '#fff1d6', '达标': '#e3f4e8' };
  sh.getRange(2, col, data.length, 1).setBackgrounds(data.map(function (r) { return [colors[r[col - 1]] || null]; }));
}

function orderSheets(ss) {
  var order = ['使用说明', '行动清单', '广告系列概览', '渠道拆分', '每日趋势', '素材资源组', '素材明细',
               '商品_近' + CONFIG.DAYS + '天', '商品_近' + CONFIG.LONG_DAYS + '天', '僵尸商品', '搜索字词', '运行日志'];
  order.forEach(function (n, i) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  ['Sheet1', '工作表1', 'Sheet 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  var first = ss.getSheetByName('行动清单');
  if (first) ss.setActiveSheet(first);
}
