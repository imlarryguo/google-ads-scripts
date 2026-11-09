/**
 * 搜索字词守卫 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：检查搜索广告和效果最大化（PMax）广告系列的搜索字词，找出
 *   1. 花了钱没转化的字词（按目标 CPA 或账户平均 CPA 判断）；
 *   2. 点击费用明显偏高的字词；
 *   3. 和触发关键字一个词都对不上的「意外字词」；
 *   4. 反复出现在浪费字词里的词组（N-gram 分析），适合加词组否定；
 *   5. 外贸/跨境常见的无效意图词：招聘、免费、DIY、二手、竞品平台、B2B/B2C 意图不符等；
 * 并生成去重后的「否定关键字建议」，可选自动加入共享否定关键字列表。
 *
 * 思路参考 Nils Rooijmans（PMax 无转化字词提醒、否定关键字建议）、
 * Francesco Cifardi（高 CPC 字词监控）、Andrew Boyd（意外搜索字词）的脚本，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-search-term-guard-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 有新的否定建议时发邮件（留空 = 不发）。多个邮箱用英文逗号分隔。
  EMAIL: '',

  // 只分析名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 分析最近多少天的数据（截至昨天）
  DAYS: 30,

  // 业务类型：'B2C'（跨境零售，想排除批发/工厂类搜索）或 'B2B'（外贸询盘，想排除零售/个人类搜索）
  BUSINESS: 'B2C',

  // 浪费字词判断：花费 ≥ 参考 CPA × 这个倍数，且转化 < 0.5，就算浪费
  // 参考 CPA：填了 TARGET_CPA 就用它，否则用账户近期平均每次转化费用
  TARGET_CPA: 0,
  WASTE_CPA_MULTIPLIER: 1,
  // 同时至少要有这么多次点击（避免一次误点就被判定）
  MIN_CLICKS: 10,

  // 高 CPC：平均点击费用 > 所在广告系列平均 CPC × 这个倍数（且点击 ≥ 3）
  HIGH_CPC_MULTIPLIER: 2,
  // 或者直接设一个上限（账户币种，0 = 不用）
  HIGH_CPC_ABS: 0,

  // N-gram：同一个词组出现在至少几个搜索字词里、合计花费 ≥ 参考 CPA，且没有转化，就建议加词组否定
  NGRAM_MIN_TERMS: 3,

  // 品牌词（这些词出现时不提否定建议），例如 ['yourbrand', 'your brand']
  BRAND_TERMS: [],
  // 你确定不想否定的词（白名单）
  KEEP_TERMS: [],
  // 额外的无效意图词（会和内置词表合并）
  EXTRA_BAD_WORDS: [],

  // 自动把「浪费字词」以完全匹配加入这个共享否定关键字列表（留空 = 只给建议，不改账户）
  // 列表需要先在「工具 → 共享库 → 排除关键字列表」里建好，并关联到广告系列
  AUTO_ADD_TO_LIST: '',

  // 每封邮件最多列出多少条
  EMAIL_MAX_ROWS: 40
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';

// 内置无效意图词（多语言）。命中后只是「建议」，请结合业务判断。
var BAD_WORDS_COMMON = [
  'free', 'gratis', 'kostenlos', 'gratuit', 'gratuito',
  'job', 'jobs', 'career', 'careers', 'salary', 'hiring', 'vacancy', 'internship', 'resume', 'empleo', 'trabajo', 'stellenangebot',
  'diy', 'how to make', 'tutorial', 'pdf', 'download', 'template', 'meaning', 'definition', 'wiki', 'reddit', 'youtube',
  'used', 'second hand', 'secondhand', 'repair', 'manual', 'login', 'customer service', 'phone number', 'coupon code'
];
var BAD_WORDS_B2C = ['wholesale', 'bulk', 'manufacturer', 'manufacturers', 'factory', 'supplier', 'suppliers', 'oem', 'odm', 'distributor', 'alibaba', 'made in china'];
var BAD_WORDS_B2B = ['near me', 'for sale', 'single', 'one piece', 'cheap', 'amazon', 'ebay', 'walmart', 'temu', 'shein', 'aliexpress', 'etsy', 'review', 'reviews', 'coupon'];
var STOP_WORDS = ['a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'to', 'with', 'by', 'at', 'from', 'my', 'me',
  'de', 'la', 'le', 'les', 'el', 'los', 'las', 'del', 'des', 'du', 'et', 'y', 'en', 'para', 'pour', 'con', 'avec',
  'der', 'die', 'das', 'und', 'für', 'mit', 'von', 'il', 'di', 'e', 'per'];


function main() {
  var ss = openSpreadsheet('搜索字词守卫');
  log('信息', '开始', '版本 ' + VERSION + '，分析最近 ' + CONFIG.DAYS + ' 天，业务类型 ' + CONFIG.BUSINESS);

  var ref = referenceCpa();
  log('信息', '参考 CPA', CONFIG.TARGET_CPA ? '使用设置的目标 CPA ' + ref : '使用账户近期平均每次转化费用 ' + r2(ref));
  var wasteCost = ref > 0 ? ref * CONFIG.WASTE_CPA_MULTIPLIER : 0;

  var search = safe('搜索广告字词', fetchSearchTerms) || [];
  var pmax = safe('PMax 字词', fetchPmaxTerms) || [];
  log('信息', '字词', '搜索广告 ' + search.length + ' 个，PMax ' + pmax.length + ' 个');

  var negs = safe('已有否定关键字', fetchNegatives) || { set: {}, n: 0 };
  log('信息', '否定关键字', '读取到 ' + negs.n + ' 个已有否定关键字（广告系列、广告组、共享列表）');

  var campCpc = {};
  search.forEach(function (t) { var c = campCpc[t.campaign] || (campCpc[t.campaign] = { cost: 0, clicks: 0 }); c.cost += t.cost; c.clicks += t.clicks; });

  var badWords = BAD_WORDS_COMMON.concat(CONFIG.BUSINESS === 'B2B' ? BAD_WORDS_B2B : BAD_WORDS_B2C).concat(CONFIG.EXTRA_BAD_WORDS || []);
  var all = search.concat(pmax);
  all.forEach(function (t) {
    t.norm = normalize(t.term);
    t.protected = hasAny(t.norm, CONFIG.BRAND_TERMS) || hasAny(t.norm, CONFIG.KEEP_TERMS);
    t.negated = !!negs.set[t.norm];
    t.flags = [];
    if (!t.protected && t.conv < 0.5 && t.clicks >= CONFIG.MIN_CLICKS && (wasteCost ? t.cost >= wasteCost : t.cost > 0))
      t.flags.push('浪费');
    var cc = campCpc[t.campaign];
    var avg = cc && cc.clicks ? cc.cost / cc.clicks : 0;
    t.cpc = t.clicks ? t.cost / t.clicks : 0;
    if (t.clicks >= 3 && ((CONFIG.HIGH_CPC_ABS && t.cpc > CONFIG.HIGH_CPC_ABS) || (avg && t.cpc > avg * CONFIG.HIGH_CPC_MULTIPLIER)))
      t.flags.push('高CPC');
    if (t.keyword && !t.protected && !overlap(t.term, t.keyword)) t.flags.push('意外');
    var bw = badWords.filter(function (w) { return containsWord(t.norm, normalize(w)); });
    if (bw.length && !t.protected) { t.flags.push('无效意图'); t.badWords = bw; }
    t.avgCpc = avg;
  });

  var grams = safe('N-gram 分析', function () { return ngrams(all, wasteCost); }) || [];
  var sugg = buildSuggestions(all, grams, negs);
  log('信息', '建议', '否定关键字建议 ' + sugg.length + ' 条');

  safe('否定关键字建议', function () { writeSuggestions(ss, sugg); });
  safe('搜索广告字词', function () { writeTerms(ss, '搜索广告字词', search, true); });
  safe('PMax 字词', function () { writeTerms(ss, 'PMax 字词', pmax, false); });
  safe('N-gram', function () { writeGrams(ss, grams); });
  safe('行动清单', function () { writeActions(ss, buildActions(all, grams, sugg, ref), '近期搜索字词没有发现明显浪费'); });
  if (CONFIG.AUTO_ADD_TO_LIST) safe('自动加否定', function () { autoAdd(sugg); });

  var fresh = safe('提醒去重', function () { return newOnes(ss, sugg); }) || [];
  if (CONFIG.EMAIL && fresh.length) safe('邮件', function () {
    var rows = [['优先级', '否定词', '匹配', '原因', '费用', '点击', '来源']].concat(fresh.slice(0, CONFIG.EMAIL_MAX_ROWS).map(function (s) {
      return [s.level, s.text, s.match, s.reason, s.cost, s.clicks, s.source];
    }));
    mail('[搜索字词守卫] ' + AdsApp.currentAccount().getName() + '：' + fresh.length + ' 条新的否定建议',
         '最近 ' + CONFIG.DAYS + ' 天的搜索字词里发现 ' + fresh.length + ' 条新的否定关键字建议。确认后加到否定关键字列表即可。', rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '搜索字词守卫', VERSION, [
      ['数据范围', '最近 ' + CONFIG.DAYS + ' 天（截至昨天），搜索广告 + 效果最大化广告系列'],
      ['参考 CPA', r2(ref) + (CONFIG.TARGET_CPA ? '（设置的目标 CPA）' : '（账户平均每次转化费用）')],
      ['浪费字词标准', '花费 ≥ ' + r2(wasteCost) + '、点击 ≥ ' + CONFIG.MIN_CLICKS + '、转化 < 0.5'],
      ['业务类型', CONFIG.BUSINESS + (CONFIG.BUSINESS === 'B2B' ? '：零售/个人意图的搜索会被标为无效意图' : '：批发/工厂意图的搜索会被标为无效意图')],
      ['', ''],
      ['行动清单', '先看这里：最该处理的浪费字词、词组和高 CPC 字词'],
      ['否定关键字建议', '去重后的建议（已经否定过的不会重复出现），可以直接复制「否定词」列粘贴到否定关键字列表'],
      ['搜索广告字词 / PMax 字词', '所有字词的明细和标签：浪费、高CPC、意外、无效意图'],
      ['N-gram', '把搜索字词拆成 1–3 个词的词组再汇总，找出反复出现在浪费字词里的词'],
      ['注意', 'PMax 的字词数据可能不完整（Google 只提供部分数据）；否定前请确认不会误伤正常流量']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '否定关键字建议', '搜索广告字词', 'PMax 字词', 'N-gram', '运行日志']);
}


// ======================= 读取数据 =======================

function referenceCpa() {
  if (CONFIG.TARGET_CPA) return CONFIG.TARGET_CPA;
  var rows = tryQuery('参考 CPA', 'SELECT metrics.cost_micros, metrics.conversions FROM customer WHERE ' + range(CONFIG.DAYS)) || [];
  var cost = 0, conv = 0;
  rows.forEach(function (r) { cost += money(g(r, 'metrics.costMicros')); conv += num(g(r, 'metrics.conversions')); });
  return conv >= 1 ? cost / conv : 0;
}

function fetchSearchTerms() {
  var base = 'SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, ' +
    'segments.keyword.info.text, segments.keyword.info.match_type, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM search_term_view WHERE ' + range(CONFIG.DAYS) + ' AND campaign.advertising_channel_type = "SEARCH" AND metrics.impressions > 0' + nameFilter();
  var rows = tryQuery('搜索广告字词', base);
  if (!rows) rows = runQuery(base.replace('segments.keyword.info.text, segments.keyword.info.match_type, ', ''));
  var map = {};
  rows.forEach(function (r) {
    var term = String(g(r, 'searchTermView.searchTerm'));
    var kw = String(g(r, 'segments.keyword.info.text'));
    var key = g(r, 'campaign.name') + '|' + g(r, 'adGroup.name') + '|' + term + '|' + kw;
    if (!map[key]) map[key] = zero({ source: '搜索', term: term, campaign: String(g(r, 'campaign.name')), group: String(g(r, 'adGroup.name')),
      keyword: kw, match: String(g(r, 'segments.keyword.info.matchType')), status: String(g(r, 'searchTermView.status')) });
    addMetrics(map[key], metricsOf(r));
  });
  // 已经被排除的字词不再分析
  return values(map).filter(function (t) { return t.status !== 'EXCLUDED' && t.status !== 'ADDED_EXCLUDED'; });
}

// PMax 字词：优先使用 campaign_search_term_view（有费用数据）；不支持时退回到「搜索字词洞察」类别
function fetchPmaxTerms() {
  var q = 'SELECT campaign.name, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, ' +
    'metrics.conversions, metrics.conversions_value FROM campaign_search_term_view WHERE ' + range(CONFIG.DAYS) +
    ' AND campaign.advertising_channel_type = "PERFORMANCE_MAX" AND metrics.impressions > 0' + nameFilter();
  var rows = tryQuery('PMax 字词', q);
  var map = {};
  if (rows) {
    rows.forEach(function (r) {
      var term = String(g(r, 'campaignSearchTermView.searchTerm'));
      var key = g(r, 'campaign.name') + '|' + term;
      if (!map[key]) map[key] = zero({ source: 'PMax', term: term, campaign: String(g(r, 'campaign.name')), group: '', keyword: '', match: '' });
      addMetrics(map[key], metricsOf(r));
    });
    return values(map);
  }
  log('提示', 'PMax 字词', '改用「搜索字词洞察」类别（没有费用数据，只能看点击和转化）');
  var camps = tryQuery('PMax 广告系列', 'SELECT campaign.id, campaign.name FROM campaign WHERE campaign.advertising_channel_type = "PERFORMANCE_MAX" AND campaign.status = "ENABLED"' + nameFilter()) || [];
  camps.forEach(function (c) {
    if (timeLeft() < 5 * 60 * 1000) return;
    var ins = tryQuery('搜索字词洞察', 'SELECT campaign_search_term_insight.category_label, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
      'FROM campaign_search_term_insight WHERE ' + range(CONFIG.DAYS) + ' AND campaign_search_term_insight.campaign_id = "' + g(c, 'campaign.id') + '"') || [];
    ins.forEach(function (r) {
      var label = String(g(r, 'campaignSearchTermInsight.categoryLabel') || '（未分类）');
      var key = g(c, 'campaign.name') + '|' + label;
      if (!map[key]) map[key] = zero({ source: 'PMax 类别', term: label, campaign: String(g(c, 'campaign.name')), group: '', keyword: '', match: '' });
      addMetrics(map[key], metricsOf(r));
    });
  });
  return values(map);
}

// 已有否定关键字：广告系列、广告组、共享列表
function fetchNegatives() {
  var set = {}, n = 0;
  function add(t) { var k = normalize(t); if (k && !set[k]) { set[k] = 1; n++; } }
  (tryQuery('广告系列否定', 'SELECT campaign_criterion.keyword.text FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = "KEYWORD"') || [])
    .forEach(function (r) { add(g(r, 'campaignCriterion.keyword.text')); });
  (tryQuery('广告组否定', 'SELECT ad_group_criterion.keyword.text FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = "KEYWORD" AND ad_group_criterion.status != "REMOVED"') || [])
    .forEach(function (r) { add(g(r, 'adGroupCriterion.keyword.text')); });
  (tryQuery('共享否定列表', 'SELECT shared_criterion.keyword.text FROM shared_criterion WHERE shared_criterion.type = "KEYWORD"') || [])
    .forEach(function (r) { add(g(r, 'sharedCriterion.keyword.text')); });
  return { set: set, n: n };
}


// ======================= 文字处理 =======================

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\[\]"+]/g, ' ').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function stem(w) {
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
function tokens(s) {
  return normalize(s).split(' ').filter(function (w) { return w && STOP_WORDS.indexOf(w) < 0; }).map(stem);
}
// 搜索字词和关键字至少有一个词相同（忽略单复数和常见虚词）
function overlap(term, kw) {
  var a = tokens(term), b = tokens(kw);
  if (!a.length || !b.length) return true;
  for (var i = 0; i < a.length; i++) {
    for (var j = 0; j < b.length; j++) {
      if (a[i] === b[j]) return true;
      // 拼写相近：一个词是另一个词的开头（例如 sneaker / sneakers、tshirt / tshirts）
      if (a[i].length >= 4 && b[j].length >= 4 && (a[i].indexOf(b[j]) === 0 || b[j].indexOf(a[i]) === 0)) return true;
    }
  }
  return false;
}
function containsWord(norm, w) {
  if (!w) return false;
  return (' ' + norm + ' ').indexOf(' ' + w + ' ') >= 0;
}
function hasAny(norm, list) {
  return (list || []).some(function (w) { w = normalize(w); return w && norm.indexOf(w) >= 0; });
}

function ngrams(all, wasteCost) {
  var map = {};
  all.forEach(function (t) {
    if (t.source === 'PMax 类别') return;
    var w = normalize(t.term).split(' ').filter(String), seen = {};
    for (var n = 1; n <= 3; n++) {
      for (var i = 0; i + n <= w.length; i++) {
        var gram = w.slice(i, i + n).join(' ');
        if (seen[gram]) continue;
        if (n === 1 && (STOP_WORDS.indexOf(gram) >= 0 || gram.length < 3)) continue;
        seen[gram] = 1;
        var x = map[gram] || (map[gram] = zero({ gram: gram, n: n, terms: 0, protected: false }));
        x.terms++; addMetrics(x, t);
        if (t.protected) x.protected = true;
      }
    }
  });
  var minCost = wasteCost || 0;
  return values(map).filter(function (x) { return x.terms >= 2; }).map(function (x) {
    x.waste = !x.protected && x.terms >= CONFIG.NGRAM_MIN_TERMS && x.conv < 0.5 && x.cost > 0 && x.cost >= minCost;
    return x;
  }).sort(function (a, b) { return b.cost - a.cost; });
}


// ======================= 建议与输出 =======================

function buildSuggestions(all, grams, negs) {
  var out = {}, rank = { '高': 0, '中': 1, '低': 2 };
  function add(text, match, level, reason, m, source, campaign) {
    var key = normalize(text);
    if (!key || negs.set[key]) return;
    var cur = out[key];
    if (cur && rank[cur.level] <= rank[level]) { if (cur.reason.indexOf(reason) < 0) cur.reason += '；' + reason; return; }
    out[key] = { text: match === '完全' ? '[' + key + ']' : match === '词组' ? '"' + key + '"' : key, key: key, match: match, level: level,
                 reason: reason, cost: m.cost, clicks: m.clicks, conv: m.conv, source: source, campaign: campaign || '' };
  }
  all.forEach(function (t) {
    if (t.protected || t.negated || t.source === 'PMax 类别') return;
    if (t.flags.indexOf('浪费') >= 0) add(t.term, '完全', '高', '花费 ' + r2(t.cost) + '，没有转化', t, t.source, t.campaign);
    else if (t.flags.indexOf('无效意图') >= 0 && t.conv < 0.5 && t.cost > 0) add(t.term, '完全', '中', '包含无效意图词：' + t.badWords.join('、'), t, t.source, t.campaign);
    else if (t.flags.indexOf('意外') >= 0 && t.conv < 0.5 && t.clicks >= 3) add(t.term, '完全', '低', '和触发关键字「' + t.keyword + '」没有共同的词', t, t.source, t.campaign);
  });
  grams.forEach(function (x) {
    if (x.waste) add(x.gram, '词组', '中', '出现在 ' + x.terms + ' 个字词里，合计花费 ' + r2(x.cost) + '，没有转化', x, 'N-gram', '');
  });
  return values(out).sort(function (a, b) { return rank[a.level] - rank[b.level] || b.cost - a.cost; });
}

function writeSuggestions(ss, sugg) {
  write(ss, '否定关键字建议', ['优先级', '否定词', '匹配方式', '原因', '费用', '点击', '转化', '来源', '广告系列'],
    sugg.map(function (s) { return [s.level, s.text, s.match, s.reason, s.cost, s.clicks, s.conv, s.source, s.campaign]; }),
    ['', '', '', '', FMT.money, FMT.int, FMT.dec, '', ''],
    { widths: [70, 260, 80, 380, 90, 70, 70, 80, 220], colors: { col: 0, fn: levelColor }, empty: '没有新的否定建议' });
}

function writeTerms(ss, name, list, isSearch) {
  list.sort(function (a, b) { return b.cost - a.cost; });
  var head = (isSearch ? ['广告系列', '广告组', '搜索字词', '触发关键字', '匹配方式'] : ['广告系列', '搜索字词 / 类别']).concat(METRIC_HEAD).concat(['标签', '说明']);
  var fm = (isSearch ? ['', '', '', '', ''] : ['', '']).concat(METRIC_FMT).concat(['', '']);
  var data = list.map(function (t) {
    var base = isSearch ? [t.campaign, t.group, t.term, t.keyword, t.match] : [t.campaign, t.term];
    var note = [];
    if (t.negated) note.push('已否定');
    if (t.protected) note.push('品牌词/白名单');
    if (t.flags.indexOf('高CPC') >= 0) note.push('CPC ' + r2(t.cpc) + '，系列平均 ' + r2(t.avgCpc));
    if (t.badWords) note.push('命中：' + t.badWords.join('、'));
    return base.concat(metricCells(t)).concat([t.flags.join('、'), note.join('；')]);
  });
  var flagCol = head.indexOf('标签');
  write(ss, name, head, data, fm, { max: 20000, colors: { col: flagCol, fn: function (v) { return /浪费/.test(v) ? '#fde2e1' : v ? '#fff1d6' : null; } } });
}

function writeGrams(ss, grams) {
  write(ss, 'N-gram', ['词组', '词数', '出现在几个字词里'].concat(METRIC_HEAD).concat(['建议']),
    grams.slice(0, 5000).map(function (x) { return [x.gram, x.n, x.terms].concat(metricCells(x)).concat([x.waste ? '建议加词组否定' : (x.protected ? '品牌词/白名单' : '')]); }),
    ['', FMT.int, FMT.int].concat(METRIC_FMT).concat(['']),
    { colors: { col: 12, fn: function (v) { return v === '建议加词组否定' ? '#fde2e1' : null; } } });
}

function buildActions(all, grams, sugg, ref) {
  var A = [];
  var wasted = all.filter(function (t) { return t.flags.indexOf('浪费') >= 0 && !t.negated; });
  var wCost = wasted.reduce(function (s, t) { return s + t.cost; }, 0);
  var total = all.reduce(function (s, t) { return s + (t.source === 'PMax 类别' ? 0 : t.cost); }, 0);
  if (wasted.length) A.push(['高', '汇总', '全部字词', wasted.length + ' 个字词花了钱没有转化', '合计 ' + r2(wCost) + '（占字词总花费 ' + pct(div(wCost, total)) + '）',
    '见「否定关键字建议」，确认后以完全匹配加入否定列表']);
  wasted.sort(function (a, b) { return b.cost - a.cost; }).slice(0, 15).forEach(function (t) {
    A.push(['高', t.source + '字词', t.campaign + (t.group ? ' / ' + t.group : '') + ' / ' + t.term, '花费 ' + r2(t.cost) + '，' + t.clicks + ' 次点击，没有转化',
      t.keyword ? '触发关键字：' + t.keyword : '', '加完全匹配否定；如果是重要词，先检查落地页和报价是否匹配这个搜索']);
  });
  grams.filter(function (x) { return x.waste; }).slice(0, 10).forEach(function (x) {
    A.push(['中', '词组', '“' + x.gram + '”', '出现在 ' + x.terms + ' 个字词里都没有转化', '合计花费 ' + r2(x.cost) + '，' + x.clicks + ' 次点击', '考虑加词组否定 "' + x.gram + '"（会挡住所有包含这个词组的搜索，先确认不会误伤）']);
  });
  all.filter(function (t) { return t.flags.indexOf('高CPC') >= 0; }).sort(function (a, b) { return b.cost - a.cost; }).slice(0, 10).forEach(function (t) {
    A.push(['中', '高 CPC', t.campaign + ' / ' + t.term, '点击费用 ' + r2(t.cpc) + '，是系列平均的 ' + r2(div(t.cpc, t.avgCpc)) + ' 倍', '转化 ' + r2(t.conv) + '，费用 ' + r2(t.cost),
      t.conv >= 1 ? '有转化，可以单独建完全匹配关键字控制出价' : '没有转化的话建议否定，或降低对应关键字出价']);
  });
  var unexp = all.filter(function (t) { return t.flags.indexOf('意外') >= 0; });
  if (unexp.length) {
    var uc = unexp.reduce(function (s, t) { return s + t.cost; }, 0);
    A.push(['中', '匹配', '搜索广告', unexp.length + ' 个字词和触发关键字没有共同的词', '合计花费 ' + r2(uc), '通常来自广泛匹配或 AI Max。检查「搜索广告字词」表里标为「意外」的字词，相关的加为关键字，不相关的否定']);
  }
  var bad = all.filter(function (t) { return t.flags.indexOf('无效意图') >= 0 && t.conv < 0.5; });
  if (bad.length) A.push(['中', '意图', '全部字词', bad.length + ' 个字词包含无效意图词', '例如：' + bad.slice(0, 5).map(function (t) { return t.term; }).join('、'),
    CONFIG.BUSINESS === 'B2B' ? '外贸询盘账户建议否定零售、个人、电商平台类搜索' : '跨境零售账户建议否定批发、工厂、供应商类搜索']);
  if (!ref) A.push(['低', '说明', '—', '账户近期没有转化，无法计算参考 CPA', '', '请在设置里填 TARGET_CPA，否则「浪费字词」只按点击数判断']);
  return A;
}

// 只提醒以前没有提醒过的建议
function newOnes(ss, sugg) {
  var sh = ss.getSheetByName('_已提醒') || ss.insertSheet('_已提醒');
  var seen = {}, n = sh.getLastRow();
  if (n) sh.getRange(1, 1, n, 1).getValues().forEach(function (r) { seen[String(r[0])] = 1; });
  var fresh = sugg.filter(function (s) { return !seen[s.key]; });
  if (fresh.length && !isPreview()) sh.getRange(n + 1, 1, fresh.length, 1).setNumberFormat('@').setValues(fresh.map(function (s) { return [s.key]; }));
  sh.hideSheet();
  return fresh;
}

function autoAdd(sugg) {
  var it = AdsApp.negativeKeywordLists().withCondition("Name = '" + CONFIG.AUTO_ADD_TO_LIST.replace(/'/g, '') + "'").get();
  if (!it.hasNext()) { log('错误', '自动加否定', '找不到共享否定列表「' + CONFIG.AUTO_ADD_TO_LIST + '」'); return; }
  var list = it.next(), n = 0;
  sugg.filter(function (s) { return s.match === '完全' && s.level === '高'; }).forEach(function (s) { list.addNegativeKeyword('[' + s.key + ']'); n++; });
  log('信息', '自动加否定', (isPreview() ? '（预览模式不会真的添加）' : '') + '加入「' + CONFIG.AUTO_ADD_TO_LIST + '」' + n + ' 个完全匹配否定');
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
