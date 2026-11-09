/**
 * 自适应搜索广告（RSA）质量检查 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：逐个检查在投的自适应搜索广告：
 *   1. 广告效力（Ad Strength）为「差」或「一般」的广告；
 *   2. 标题不到 15 个、说明不到 4 个；标题太短浪费位置；
 *   3. 固定（Pin）过多，限制了 Google 的组合；
 *   4. 重复或几乎重复的标题；
 *   5. 标题里没有出现广告组的主要关键字（影响广告相关性和质量得分）；
 *   6. 没有填显示路径；被拒登或受限；
 *   7. 表现标签为「低」的标题和说明（建议替换）；
 *   8. 没有 RSA 的广告组、RSA 太多的广告组。
 *
 * 思路参考 Tibbe van Asten 的 RSA Quality Overview（只导出广告效力），代码为重新编写并扩展了检查项。
 *
 * 教程：https://berightdigital.com/google-ads-rsa-quality-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 只检查名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 效果数据天数
  DAYS: 30,
  // 标题少于这么多字符算「太短」（英文标题最多 30 个字符）
  SHORT_HEADLINE: 15,
  // 固定位置的标题超过这么多个就提醒
  MAX_PINNED_HEADLINES: 3,
  // 表现为「低」的素材，展示至少这么多次才提醒替换
  LOW_ASSET_MIN_IMPRESSIONS: 1000,
  // 每个广告组检查前几个关键字是否出现在标题里
  TOP_KEYWORDS: 3
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var STRENGTH_CN = { EXCELLENT: '极佳', GOOD: '良好', AVERAGE: '一般', POOR: '差', PENDING: '待定', NO_ADS: '无广告', UNKNOWN: '', UNSPECIFIED: '' };
var LABEL_CN = { BEST: '最佳', GOOD: '良好', LOW: '低', LEARNING: '学习中', PENDING: '待定', UNKNOWN: '', UNSPECIFIED: '' };
var PIN_CN = { HEADLINE_1: '标题 1', HEADLINE_2: '标题 2', HEADLINE_3: '标题 3', DESCRIPTION_1: '说明 1', DESCRIPTION_2: '说明 2' };
var STOP = ['a', 'an', 'the', 'and', 'or', 'for', 'of', 'in', 'on', 'to', 'with', 'de', 'la', 'le', 'el', 'der', 'die', 'das', 'und', 'für', 'pour', 'para'];


function main() {
  var ss = openSpreadsheet('RSA 质量检查');
  log('信息', '开始', '版本 ' + VERSION);

  var ads = safe('读取广告', fetchAds) || [];
  var groups = safe('读取广告组', fetchGroups) || {};
  var kws = safe('读取关键字', fetchKeywords) || {};
  var assets = safe('素材表现', fetchAssets) || [];
  log('信息', '数据', ads.length + ' 个 RSA，' + Object.keys(groups).length + ' 个广告组，' + assets.length + ' 个素材记录');

  ads.forEach(function (a) { checkAd(a, kws[a.groupId] || []); });
  safe('广告检查', function () { writeAds(ss, ads); });
  safe('素材表现', function () { writeAssets(ss, assets); });
  var gl = safe('广告组', function () { return writeGroups(ss, groups, ads); }) || [];
  var A = buildActions(ads, assets, gl);
  safe('行动清单', function () { writeActions(ss, A, '所有 RSA 都符合检查标准'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    var poor = ads.filter(function (a) { return a.strength === 'POOR' || a.strength === 'AVERAGE'; }).length;
    mail('[RSA 检查] ' + AdsApp.currentAccount().getName() + '：' + poor + ' 个广告效力为「差/一般」',
      ads.length + ' 个在投 RSA 中，' + poor + ' 个广告效力为「差」或「一般」，' + ads.filter(function (a) { return a.issues.length; }).length + ' 个有可以改进的地方。',
      [['优先级', '类别', '对象', '发现']].concat(A.slice(0, 20).map(function (x) { return [x[0], x[1], x[2], x[3]]; })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, 'RSA 质量检查', VERSION, [
      ['检查范围', '在投广告系列、在投广告组里的在投自适应搜索广告；效果数据为最近 ' + CONFIG.DAYS + ' 天'],
      ['', ''],
      ['行动清单', '先看这里：广告效力差、没有 RSA 的广告组、花钱最多但素材不足的广告'],
      ['广告检查', '每个 RSA 一行：广告效力、标题/说明数量、固定数量、重复标题、关键字覆盖、问题和建议'],
      ['素材表现', '每个标题和说明的表现标签；「低」的建议替换'],
      ['广告组', '每个广告组有几个 RSA、最好的广告效力'],
      ['注意', '广告效力是 Google 对素材数量和多样性的评分，不直接决定排名，但「差」的广告通常展示受限。改广告前先看转化数据，表现好的广告不要为了提高广告效力而大改']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '广告检查', '素材表现', '广告组', '运行日志']);
}


// ======================= 读取数据 =======================

var EN = ' AND campaign.status = "ENABLED" AND ad_group.status = "ENABLED" AND campaign.advertising_channel_type = "SEARCH"';

function fetchAds() {
  var q = 'SELECT campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad_strength, ad_group_ad.action_items, ' +
    'ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ' +
    'ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.ad.final_urls, ' +
    'ad_group_ad.policy_summary.approval_status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM ad_group_ad WHERE ' + range(CONFIG.DAYS) + ' AND ad_group_ad.status = "ENABLED" AND ad_group_ad.ad.type = "RESPONSIVE_SEARCH_AD"' + EN + nameFilter();
  var rows = tryQuery('广告（含效果）', q);
  // 最近没有展示的广告不会出现在带日期的查询里，再查一次不带日期的
  var base = runQuery(q.replace(/, metrics\.[^F]*FROM/, ' FROM').replace('WHERE ' + range(CONFIG.DAYS) + ' AND', 'WHERE'));
  var map = {};
  base.concat(rows || []).forEach(function (r) {
    var key = g(r, 'adGroup.id') + '~' + g(r, 'adGroupAd.ad.id');
    var rsa = g(r, 'adGroupAd.ad.responsiveSearchAd') || {};
    if (!map[key]) map[key] = zero({ key: key, campaign: String(g(r, 'campaign.name')), group: String(g(r, 'adGroup.name')), groupId: String(g(r, 'adGroup.id')),
      id: String(g(r, 'adGroupAd.ad.id')), strength: String(g(r, 'adGroupAd.adStrength') || ''), actions: g(r, 'adGroupAd.actionItems') || [],
      headlines: (rsa.headlines || []).map(asset), descriptions: (rsa.descriptions || []).map(asset), path1: String(rsa.path1 || ''), path2: String(rsa.path2 || ''),
      url: String((g(r, 'adGroupAd.ad.finalUrls') || [])[0] || ''), approval: String(g(r, 'adGroupAd.policySummary.approvalStatus') || '') });
    if (r.metrics) addMetrics(map[key], metricsOf(r));
  });
  return values(map);
}
function asset(x) { return { text: String(x.text || ''), pin: String(x.pinnedField || '') }; }

function fetchGroups() {
  var map = {};
  runQuery('SELECT campaign.name, ad_group.id, ad_group.name FROM ad_group WHERE ad_group.type = "SEARCH_STANDARD"' + EN + nameFilter()).forEach(function (r) {
    map[String(g(r, 'adGroup.id'))] = { campaign: String(g(r, 'campaign.name')), name: String(g(r, 'adGroup.name')) };
  });
  return map;
}

function fetchKeywords() {
  var map = {};
  (tryQuery('关键字', 'SELECT ad_group.id, ad_group_criterion.keyword.text, metrics.impressions FROM keyword_view WHERE ' + range(CONFIG.DAYS) +
    ' AND ad_group_criterion.status = "ENABLED" AND ad_group_criterion.negative = FALSE' + EN + nameFilter()) || []).forEach(function (r) {
    var id = String(g(r, 'adGroup.id'));
    (map[id] = map[id] || []).push({ text: String(g(r, 'adGroupCriterion.keyword.text')), impr: num(g(r, 'metrics.impressions')) });
  });
  Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return b.impr - a.impr; }); map[k] = map[k].slice(0, CONFIG.TOP_KEYWORDS); });
  return map;
}

function fetchAssets() {
  var rows = tryQuery('素材表现', 'SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, ' +
    'ad_group_ad_asset_view.pinned_field, asset.text_asset.text, metrics.impressions, metrics.clicks, metrics.conversions ' +
    'FROM ad_group_ad_asset_view WHERE ' + range(CONFIG.DAYS) + ' AND ad_group_ad_asset_view.enabled = TRUE AND ad_group_ad.status = "ENABLED"' + EN + nameFilter()) || [];
  return rows.map(function (r) {
    return { campaign: String(g(r, 'campaign.name')), group: String(g(r, 'adGroup.name')), ad: String(g(r, 'adGroupAd.ad.id')),
      type: String(g(r, 'adGroupAdAssetView.fieldType')), label: String(g(r, 'adGroupAdAssetView.performanceLabel') || ''),
      pin: String(g(r, 'adGroupAdAssetView.pinnedField') || ''), text: String(g(r, 'asset.textAsset.text')),
      impr: num(g(r, 'metrics.impressions')), clicks: num(g(r, 'metrics.clicks')), conv: num(g(r, 'metrics.conversions')) };
  }).filter(function (a) { return a.type === 'HEADLINE' || a.type === 'DESCRIPTION'; });
}


// ======================= 检查 =======================

function norm(s) { return String(s || '').toLowerCase().replace(/\{[^:}]*:([^}]*)\}/g, '$1').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function words(s) { return norm(s).split(' ').filter(function (w) { return w && STOP.indexOf(w) < 0; }).map(function (w) { return w.length > 3 && /s$/.test(w) ? w.slice(0, -1) : w; }); }

function checkAd(a, topKw) {
  var issues = [], fixes = [], hl = a.headlines, ds = a.descriptions;
  a.nH = hl.length; a.nD = ds.length;
  a.pinnedH = hl.filter(function (h) { return h.pin; }).length;
  a.pinnedD = ds.filter(function (d) { return d.pin; }).length;
  a.shortH = hl.filter(function (h) { return h.text.length < CONFIG.SHORT_HEADLINE; }).length;
  a.dki = hl.filter(function (h) { return /\{keyword:/i.test(h.text); }).length;
  a.level = '低';

  if (a.strength === 'POOR') { issues.push('广告效力：差'); a.level = '高'; }
  else if (a.strength === 'AVERAGE') { issues.push('广告效力：一般'); a.level = '中'; }
  if (a.nH < 15) { issues.push('标题只有 ' + a.nH + ' 个'); fixes.push('补到 15 个标题，覆盖卖点、价格/优惠、物流（如免运费、发货时效）、品牌、信任信息（评价、售后）'); if (a.nH < 8 && a.level === '低') a.level = '中'; }
  if (a.nD < 4) { issues.push('说明只有 ' + a.nD + ' 个'); fixes.push('补到 4 个说明，每个尽量写满 90 个字符'); }
  if (a.shortH >= 5) { issues.push(a.shortH + ' 个标题少于 ' + CONFIG.SHORT_HEADLINE + ' 个字符'); fixes.push('短标题浪费位置，可以加上具体的数字、型号或卖点'); }
  if (a.pinnedH > CONFIG.MAX_PINNED_HEADLINES) { issues.push('固定了 ' + a.pinnedH + ' 个标题'); fixes.push('固定会减少 Google 可以测试的组合，只固定确实必须出现的（如品牌、合规文字）'); if (a.level === '低') a.level = '中'; }
  var pinPos = {}; hl.forEach(function (h) { if (h.pin) pinPos[h.pin] = (pinPos[h.pin] || 0) + 1; });
  if (pinPos.HEADLINE_1 && pinPos.HEADLINE_2 && pinPos.HEADLINE_3 && Object.keys(pinPos).every(function (p) { return pinPos[p] === 1; })) {
    issues.push('标题 1/2/3 都只固定了一个标题，广告等于固定死了'); fixes.push('每个固定位置至少放 2–3 个可选标题'); a.level = a.level === '高' ? '高' : '中';
  }
  var dup = duplicates(hl);
  if (dup.length) { issues.push('重复或几乎重复的标题：' + dup.slice(0, 3).join('；')); fixes.push('重复标题会降低广告效力，改成不同角度的卖点'); }
  if (topKw.length) {
    var covered = topKw.filter(function (k) { var kw = words(k.text); return hl.some(function (h) { var hw = words(h.text); return kw.every(function (w) { return hw.indexOf(w) >= 0; }); }); });
    a.kwCover = covered.length + '/' + topKw.length;
    if (!covered.length) { issues.push('标题里没有出现主要关键字：' + topKw.map(function (k) { return k.text; }).join('、')); fixes.push('至少 2–3 个标题直接包含主要关键字，提升广告相关性'); if (a.level === '低') a.level = '中'; }
  } else a.kwCover = '';
  if (!a.path1) { issues.push('没有填显示路径'); fixes.push('填写显示路径（例如 /Boots/Waterproof），让网址也体现关键字'); }
  if (a.approval === 'DISAPPROVED') { issues.push('已拒登'); a.level = '高'; fixes.push('查看拒登原因并修改'); }
  else if (a.approval === 'APPROVED_LIMITED' || a.approval === 'AREA_OF_INTEREST_ONLY') issues.push('受限批准');
  if ((a.actions || []).length) issues.push('Google 建议：' + a.actions.slice(0, 2).join('；'));
  a.issues = issues; a.fixes = fixes;
  if (!issues.length) a.level = '';
}

function duplicates(hl) {
  var out = [], ns = hl.map(function (h) { return norm(h.text); });
  for (var i = 0; i < ns.length; i++) for (var j = i + 1; j < ns.length; j++) {
    if (!ns[i] || !ns[j]) continue;
    var a = words(ns[i]).sort().join(' '), b = words(ns[j]).sort().join(' ');
    var shorter = Math.min(ns[i].length, ns[j].length), longer = Math.max(ns[i].length, ns[j].length);
    var contains = ns[j].indexOf(ns[i]) >= 0 || ns[i].indexOf(ns[j]) >= 0;
    // 完全相同、只是词序不同、或者一个只比另一个多一两个字符（例如多了感叹号）
    if (ns[i] === ns[j] || a === b || (contains && shorter / longer >= 0.8)) out.push(hl[i].text + ' ≈ ' + hl[j].text);
  }
  return out;
}


// ======================= 输出 =======================

function writeAds(ss, ads) {
  var rank = { '高': 0, '中': 1, '低': 2, '': 3 };
  ads.sort(function (a, b) { return rank[a.level] - rank[b.level] || b.cost - a.cost; });
  var head = ['优先级', '广告系列', '广告组', '广告 ID', '广告效力', '标题数', '说明数', '固定标题', '短标题', '动态关键字', '关键字覆盖', '显示路径', '审核']
    .concat(METRIC_HEAD).concat(['问题', '建议', '标题', '最终网址']);
  var data = ads.map(function (a) {
    return [a.level, a.campaign, a.group, a.id, STRENGTH_CN[a.strength] !== undefined ? STRENGTH_CN[a.strength] : a.strength, a.nH, a.nD, a.pinnedH, a.shortH, a.dki, a.kwCover,
      [a.path1, a.path2].filter(String).join('/'), a.approval].concat(metricCells(a)).concat([a.issues.join('\n'), a.fixes.join('\n'),
      a.headlines.map(function (h) { return h.text + (h.pin ? ' 📌' + (PIN_CN[h.pin] || h.pin) : ''); }).join('\n'), a.url]);
  });
  write(ss, '广告检查', head, data, ['', '', '', '@', '', FMT.int, FMT.int, FMT.int, FMT.int, FMT.int, '@', '', ''].concat(METRIC_FMT).concat(['', '', '', '']),
    { widths: [60, 180, 180, 110, 70], colors: { col: 0, fn: levelColor } });
}

function writeAssets(ss, assets) {
  var rank = { LOW: 0, LEARNING: 2, GOOD: 3, BEST: 4 };
  assets.sort(function (a, b) { return ((rank[a.label] !== undefined ? rank[a.label] : 1) - (rank[b.label] !== undefined ? rank[b.label] : 1)) || b.impr - a.impr; });
  write(ss, '素材表现', ['广告系列', '广告组', '广告 ID', '类型', '文字', '字数', '固定位置', '表现', '展示', '点击', '点击率', '转化', '建议'],
    assets.map(function (a) {
      return [a.campaign, a.group, a.ad, a.type === 'HEADLINE' ? '标题' : '说明', a.text, a.text.length, PIN_CN[a.pin] || '', LABEL_CN[a.label] !== undefined ? LABEL_CN[a.label] : a.label,
        a.impr, a.clicks, div(a.clicks, a.impr), a.conv, a.label === 'LOW' && a.impr >= CONFIG.LOW_ASSET_MIN_IMPRESSIONS ? '建议替换' : ''];
    }), ['', '', '@', '', '', FMT.int, '', '', FMT.int, FMT.int, FMT.pct, FMT.dec, ''],
    { max: 30000, colors: { col: 7, fn: function (v) { return v === '低' ? '#fde2e1' : v === '最佳' ? '#e3f4e8' : null; } } });
}

function writeGroups(ss, groups, ads) {
  var by = {};
  ads.forEach(function (a) { (by[a.groupId] = by[a.groupId] || []).push(a); });
  var order = { EXCELLENT: 4, GOOD: 3, AVERAGE: 2, POOR: 1 };
  var list = Object.keys(groups).map(function (id) {
    var l = by[id] || [], best = '';
    l.forEach(function (a) { if ((order[a.strength] || 0) > (order[best] || 0)) best = a.strength; });
    var cost = l.reduce(function (s, a) { return s + a.cost; }, 0);
    return { id: id, campaign: groups[id].campaign, name: groups[id].name, n: l.length, best: best, cost: cost,
      note: !l.length ? '没有在投的 RSA' : l.length > 3 ? '超过 3 个 RSA，数据会被分散' : (order[best] || 0) < 3 ? '没有效力达到「良好」的广告' : '' };
  }).sort(function (a, b) { return (b.note ? 1 : 0) - (a.note ? 1 : 0) || b.cost - a.cost; });
  write(ss, '广告组', ['广告系列', '广告组', 'RSA 数量', '最好的广告效力', '近期花费', '问题'],
    list.map(function (x) { return [x.campaign, x.name, x.n, STRENGTH_CN[x.best] || '', x.cost, x.note]; }), ['', '', FMT.int, '', FMT.money, ''],
    { colors: { col: 5, fn: function (v) { return v ? '#fff1d6' : null; } } });
  return list;
}

function buildActions(ads, assets, gl) {
  var A = [];
  var none = gl.filter(function (x) { return x.n === 0; });
  if (none.length) A.push(['高', '广告组', none.length + ' 个广告组', '没有在投的 RSA', '例如：' + none.slice(0, 5).map(function (x) { return x.campaign + ' / ' + x.name; }).join('、'), '每个搜索广告组至少要有 1 个在投的 RSA，否则不会展示']);
  var poor = ads.filter(function (a) { return a.strength === 'POOR'; }).sort(function (a, b) { return b.cost - a.cost; });
  if (poor.length) A.push(['高', '广告效力', poor.length + ' 个广告', '广告效力为「差」', '花费合计 ' + r2(poor.reduce(function (s, a) { return s + a.cost; }, 0)), '补足标题和说明、减少固定、去掉重复标题；见「广告检查」表的建议列']);
  ads.filter(function (a) { return a.level === '高' || a.level === '中'; }).sort(function (a, b) { return b.cost - a.cost; }).slice(0, 15).forEach(function (a) {
    A.push([a.level, '广告', a.campaign + ' / ' + a.group + '（广告 ' + a.id + '）', a.issues.slice(0, 3).join('；'), '花费 ' + r2(a.cost) + '，转化 ' + r2(a.conv), a.fixes.slice(0, 2).join('；')]);
  });
  var low = assets.filter(function (x) { return x.label === 'LOW' && x.impr >= CONFIG.LOW_ASSET_MIN_IMPRESSIONS; });
  if (low.length) A.push(['中', '素材', low.length + ' 个标题/说明', '表现为「低」', '例如：' + low.slice(0, 4).map(function (x) { return '「' + x.text + '」'; }).join('、'), '用新的卖点替换，不要一次全部替换，每个广告每次换 2–3 个']);
  var noKw = ads.filter(function (a) { return a.kwCover && a.kwCover.indexOf('0/') === 0; });
  if (noKw.length) A.push(['中', '相关性', noKw.length + ' 个广告', '标题里没有出现主要关键字', '', '在标题里直接写出主要关键字，能提升广告相关性和质量得分，可以配合质量得分追踪脚本观察变化']);
  var many = gl.filter(function (x) { return x.n > 3; });
  if (many.length) A.push(['低', '广告组', many.length + ' 个广告组', '超过 3 个在投 RSA', '', '每个广告组 1–2 个 RSA 就够了，太多会分散数据，暂停效果差的']);
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
