/**
 * DSA / AI Max 流量分流 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：防止动态搜索广告（DSA）和开启了 AI Max 的搜索广告系列，抢走你已经用「完全匹配」精细投放的搜索词。
 *   1. 找出 DSA / AI Max 广告系列里，和其他系列完全匹配关键字一模一样的搜索词，对比两边的 CPA 和 ROAS；
 *   2. 生成「否定关键字计划」：把这些完全匹配关键字作为完全匹配否定加到 DSA / AI Max 系列里；
 *   3. 原关键字被暂停或删除后，自动把对应的否定删掉，让流量回到 DSA / AI Max（原版脚本没有这个功能）；
 *   4. 默认只生成计划不修改账户，确认后把 APPLY_CHANGES 改成 true 才会执行。
 *
 * 注意：Google 已宣布 DSA 将升级为 AI Max，2027 年 1 月起不能新建 DSA 广告系列，2027 年 2 月起自动迁移。
 * 这个脚本同时支持 DSA 和 AI Max，迁移前后都能用。
 *
 * 思路参考 Tibbe van Asten 的「Exclude Exact in DSA」脚本（2019，最后更新 2022），代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-dsa-ai-max-traffic-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 完全匹配关键字来自哪些广告系列（名称包含这段文字；留空 = 所有非 DSA 的搜索广告系列）
  SOURCE_CAMPAIGN_CONTAINS: '',
  // 要加否定的目标广告系列：自动包含所有 DSA 和开启了 AI Max 的系列；也可以再按名称加上，例如 'Broad'
  TARGET_CAMPAIGN_CONTAINS: '',
  // 是否把开启了 AI Max 的系列当作目标
  INCLUDE_AI_MAX: true,

  // 'OVERLAP_ONLY' = 只否定实际发生了重叠的搜索词（推荐，否定列表不会太长）
  // 'ALL_EXACT'    = 把来源系列的所有完全匹配关键字都加为否定（和原版脚本一样）
  MODE: 'OVERLAP_ONLY',

  // 分析最近多少天的搜索词
  DAYS: 30,

  // true = 真的添加 / 删除否定关键字；false = 只生成计划（默认）
  APPLY_CHANGES: false,
  // 原关键字被暂停或删除后，是否自动删除脚本之前加的否定
  CLEAN_UP: true,
  // 每次最多添加多少个否定（防止误操作）
  MAX_CHANGES: 500,
  // 目标系列在这个搜索词上明显比完全匹配关键字效果好（CPA 低 20% 以上）时，不加否定
  SKIP_IF_TARGET_BETTER: true
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';


function main() {
  var ss = openSpreadsheet('DSA AI Max 分流');
  log('信息', '开始', '版本 ' + VERSION + '，模式 ' + CONFIG.MODE + (CONFIG.APPLY_CHANGES ? '，会修改账户' : '，只生成计划'));

  var camps = safe('广告系列', fetchCampaigns) || {};
  var targets = values(camps).filter(function (c) { return c.target; });
  log('信息', '目标', targets.length + ' 个目标广告系列：' + targets.map(function (c) { return c.name + '（' + c.kind + '）'; }).join('、'));

  var exact = safe('完全匹配关键字', function () { return fetchExact(camps); }) || {};
  log('信息', '关键字', Object.keys(exact).length + ' 个完全匹配关键字');

  var terms = safe('搜索词', function () { return fetchTerms(camps); }) || [];
  var overlaps = terms.filter(function (t) { return exact[t.norm] && exact[t.norm].campaignId !== t.campaignId; });
  log('信息', '重叠', overlaps.length + ' 个搜索词和其他系列的完全匹配关键字重叠');

  var existing = safe('已有否定', function () { return fetchNegatives(targets); }) || {};
  var tracked = readTracked(ss);
  var plan = buildPlan(targets, exact, overlaps, existing, tracked);

  safe('重叠搜索词', function () { writeOverlaps(ss, overlaps, exact); });
  safe('目标广告系列', function () { writeTargets(ss, targets, terms); });
  var done = { added: 0, removed: 0 };
  if (CONFIG.APPLY_CHANGES) done = safe('执行', function () { return apply(ss, plan, tracked); }) || done;
  safe('否定计划', function () { writePlan(ss, plan); });
  var A = buildActions(overlaps, plan, targets, done);
  safe('行动清单', function () { writeActions(ss, A, '没有发现流量重叠'); });

  if (CONFIG.EMAIL && (overlaps.length || done.added || done.removed)) safe('邮件', function () {
    mail('[DSA/AI Max 分流] ' + AdsApp.currentAccount().getName() + '：' + overlaps.length + ' 个重叠搜索词',
      (CONFIG.APPLY_CHANGES ? '已添加 ' + done.added + ' 个否定，删除 ' + done.removed + ' 个。' : '计划添加 ' + plan.filter(function (p) { return p.action === '添加'; }).length + ' 个否定（未执行）。'),
      [['优先级', '类别', '对象', '发现', '数据']].concat(A.slice(0, 15).map(function (x) { return x.slice(0, 5); })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, 'DSA / AI Max 流量分流', VERSION, [
      ['目标广告系列', targets.map(function (c) { return c.name + '（' + c.kind + '）'; }).join('、') || '（没有找到 DSA 或 AI Max 广告系列）'],
      ['模式', CONFIG.MODE === 'ALL_EXACT' ? '所有完全匹配关键字都加为否定' : '只否定实际重叠的搜索词'],
      ['是否修改账户', CONFIG.APPLY_CHANGES ? '是：会添加/删除否定关键字（每次最多 ' + CONFIG.MAX_CHANGES + ' 个）' : '否：只生成计划'],
      ['', ''],
      ['行动清单', '重叠了多少流量、哪边效果更好、计划添加和删除多少否定'],
      ['重叠搜索词', '在 DSA / AI Max 系列里出现、但其他系列已经有完全匹配关键字的搜索词，两边效果对比'],
      ['否定计划', '每个目标系列要添加、删除、已存在的否定关键字'],
      ['目标广告系列', '被当作目标的系列，以及它们的搜索词里有多少来自 AI Max 扩展'],
      ['注意', 'DSA 将在 2027 年迁移到 AI Max。迁移后 DSA 系列会变成开启了 AI Max 的普通搜索系列，脚本仍然能识别；脚本加的否定会记录在隐藏表里，用于以后自动清理']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '重叠搜索词', '否定计划', '目标广告系列', '运行日志']);
}


// ======================= 读取数据 =======================

function fetchCampaigns() {
  var map = {};
  runQuery('SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = "ENABLED" AND campaign.advertising_channel_type = "SEARCH"').forEach(function (r) {
    var id = String(g(r, 'campaign.id'));
    map[id] = { id: id, name: String(g(r, 'campaign.name')), dsa: false, aiMax: false, target: false, kind: '' };
  });
  (tryQuery('DSA 广告组', 'SELECT campaign.id FROM ad_group WHERE ad_group.type = "SEARCH_DYNAMIC_ADS" AND ad_group.status = "ENABLED" AND campaign.status = "ENABLED"') || [])
    .forEach(function (r) { var c = map[String(g(r, 'campaign.id'))]; if (c) c.dsa = true; });
  if (CONFIG.INCLUDE_AI_MAX) (tryQuery('AI Max', 'SELECT campaign.id FROM campaign WHERE campaign.ai_max_setting.enable_ai_max = TRUE AND campaign.status = "ENABLED"') || [])
    .forEach(function (r) { var c = map[String(g(r, 'campaign.id'))]; if (c) c.aiMax = true; });
  var extra = String(CONFIG.TARGET_CAMPAIGN_CONTAINS || '').toLowerCase();
  values(map).forEach(function (c) {
    var byName = extra && c.name.toLowerCase().indexOf(extra) >= 0;
    c.target = c.dsa || c.aiMax || byName;
    c.kind = [c.dsa ? 'DSA' : '', c.aiMax ? 'AI Max' : '', byName && !c.dsa && !c.aiMax ? '按名称' : ''].filter(String).join(' + ');
  });
  return map;
}

function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function fetchExact(camps) {
  var src = String(CONFIG.SOURCE_CAMPAIGN_CONTAINS || '').toLowerCase(), map = {};
  var perf = {};
  (tryQuery('关键字效果', 'SELECT ad_group_criterion.criterion_id, ad_group.id, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE ' +
    range(CONFIG.DAYS) + ' AND ad_group_criterion.keyword.match_type = "EXACT"') || []).forEach(function (r) {
    addMetrics(perf[g(r, 'adGroup.id') + '~' + g(r, 'adGroupCriterion.criterionId')] = perf[g(r, 'adGroup.id') + '~' + g(r, 'adGroupCriterion.criterionId')] || zero({}), metricsOf(r));
  });
  runQuery('SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text FROM ad_group_criterion ' +
    'WHERE ad_group_criterion.type = "KEYWORD" AND ad_group_criterion.keyword.match_type = "EXACT" AND ad_group_criterion.negative = FALSE ' +
    'AND ad_group_criterion.status = "ENABLED" AND ad_group.status = "ENABLED" AND campaign.status = "ENABLED" AND campaign.advertising_channel_type = "SEARCH"').forEach(function (r) {
    var cid = String(g(r, 'campaign.id')), c = camps[cid];
    if (!c || c.dsa) return;
    if (src && c.name.toLowerCase().indexOf(src) < 0) return;
    if (!src && c.target) return; // 目标系列自己的关键字不作为来源
    var t = norm(g(r, 'adGroupCriterion.keyword.text'));
    var key = g(r, 'adGroup.id') + '~' + g(r, 'adGroupCriterion.criterionId');
    if (!map[t]) map[t] = zero({ text: t, campaignId: cid, campaign: c.name, group: String(g(r, 'adGroup.name')) });
    if (perf[key]) addMetrics(map[t], perf[key]);
  });
  return map;
}

function fetchTerms(camps) {
  var base = 'SELECT campaign.id, campaign.name, ad_group.name, ad_group.type, search_term_view.search_term, search_term_view.status, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';
  var where = ' FROM search_term_view WHERE ' + range(CONFIG.DAYS) + ' AND campaign.advertising_channel_type = "SEARCH" AND campaign.status = "ENABLED"';
  var rows = tryQuery('搜索词（含来源）', base + ', segments.search_term_match_source' + where);
  var hasSource = !!rows;
  if (!rows) rows = runQuery(base + where);
  var map = {};
  rows.forEach(function (r) {
    var cid = String(g(r, 'campaign.id')), c = camps[cid];
    if (!c || !c.target) return;
    var t = norm(g(r, 'searchTermView.searchTerm'));
    var srcType = hasSource ? String(g(r, 'segments.searchTermMatchSource')) : '';
    var key = cid + '|' + t;
    var x = map[key] || (map[key] = zero({ norm: t, campaignId: cid, campaign: c.name, kind: c.kind, sources: {}, dsaGroup: false }));
    addMetrics(x, metricsOf(r));
    if (srcType) x.sources[srcType] = 1;
    if (g(r, 'adGroup.type') === 'SEARCH_DYNAMIC_ADS') x.dsaGroup = true;
  });
  return values(map);
}

function fetchNegatives(targets) {
  var ids = targets.map(function (c) { return c.id; }), out = {};
  if (!ids.length) return out;
  (tryQuery('已有否定', 'SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE ' +
    'AND campaign_criterion.type = "KEYWORD" AND campaign.id IN (' + ids.join(',') + ')') || []).forEach(function (r) {
    if (g(r, 'campaignCriterion.keyword.matchType') !== 'EXACT') return;
    out[g(r, 'campaign.id') + '|' + norm(g(r, 'campaignCriterion.keyword.text'))] = 1;
  });
  return out;
}

function readTracked(ss) {
  var sh = ss.getSheetByName('_脚本添加的否定'), map = {};
  if (!sh || !sh.getLastRow()) return map;
  sh.getRange(1, 1, sh.getLastRow(), 3).getValues().forEach(function (r) { if (r[0]) map[String(r[0]) + '|' + String(r[1])] = { campaignId: String(r[0]), text: String(r[1]), date: String(r[2]) }; });
  return map;
}


// ======================= 计划 =======================

function buildPlan(targets, exact, overlaps, existing, tracked) {
  var plan = [], seen = {};
  function add(c, text, why, m) {
    var k = c.id + '|' + text;
    if (seen[k]) return; seen[k] = 1;
    plan.push({ campaignId: c.id, campaign: c.name, text: text, action: existing[k] ? '已存在' : '添加', why: why, cost: m ? m.cost : '', conv: m ? m.conv : '' });
  }
  var byId = {}; targets.forEach(function (c) { byId[c.id] = c; });
  if (CONFIG.MODE === 'ALL_EXACT') {
    targets.forEach(function (c) { Object.keys(exact).forEach(function (t) { if (exact[t].campaignId !== c.id) add(c, t, '来源系列的完全匹配关键字（' + exact[t].campaign + '）'); }); });
    overlaps.forEach(function (o) { var k = o.campaignId + '|' + o.norm; plan.forEach(function (p) { if (p.campaignId + '|' + p.text === k) { p.cost = o.cost; p.conv = o.conv; p.why = '已经发生重叠；' + p.why; } }); });
  } else {
    overlaps.forEach(function (o) {
      var e = exact[o.norm];
      var targetBetter = o.conv >= 1 && (!e.conv || (o.cost / o.conv) < (e.cost / e.conv) * 0.8);
      if (CONFIG.SKIP_IF_TARGET_BETTER && targetBetter) {
        plan.push({ campaignId: o.campaignId, campaign: o.campaign, text: o.norm, action: '保留', why: '这个搜索词在目标系列里效果更好，先检查完全匹配那边的出价和广告', cost: o.cost, conv: o.conv });
        return;
      }
      add(byId[o.campaignId], o.norm, '和「' + e.campaign + ' / ' + e.group + '」的完全匹配关键字重叠', o);
    });
  }
  // 清理：脚本以前加的否定，如果对应的完全匹配关键字已经不在了，就删除
  if (CONFIG.CLEAN_UP) Object.keys(tracked).forEach(function (k) {
    var t = tracked[k];
    if (!exact[t.text] && byId[t.campaignId] && existing[k]) plan.push({ campaignId: t.campaignId, campaign: byId[t.campaignId].name, text: t.text, action: '删除', why: '原完全匹配关键字已暂停或删除（' + t.date + ' 由脚本添加）', cost: '', conv: '' });
  });
  return plan;
}

function apply(ss, plan, tracked) {
  var done = { added: 0, removed: 0 }, byCamp = {};
  plan.forEach(function (p) { if (p.action === '添加' || p.action === '删除') (byCamp[p.campaignId] = byCamp[p.campaignId] || []).push(p); });
  Object.keys(byCamp).forEach(function (id) {
    var it = AdsApp.campaigns().withIds([Number(id)]).get();
    if (!it.hasNext()) { log('提示', '执行', '找不到广告系列 ' + id); return; }
    var camp = it.next(), list = byCamp[id];
    var removals = {}; list.forEach(function (p) { if (p.action === '删除') removals[p.text] = p; });
    if (Object.keys(removals).length) {
      var nk = camp.negativeKeywords().get();
      while (nk.hasNext()) {
        var n = nk.next(), txt = norm(String(n.getText()).replace(/[\[\]"]/g, ''));
        if (removals[txt] && n.getMatchType() === 'EXACT') { n.remove(); removals[txt].action = '已删除'; delete tracked[id + '|' + txt]; done.removed++; }
      }
    }
    list.forEach(function (p) {
      if (p.action !== '添加') return;
      if (done.added >= CONFIG.MAX_CHANGES) { p.action = '添加（超出单次上限，下次执行）'; return; }
      camp.createNegativeKeyword('[' + p.text + ']'); p.action = '已添加'; done.added++;
      tracked[id + '|' + p.text] = { campaignId: id, text: p.text, date: today() };
    });
  });
  if (!isPreview()) {
    var sh = ss.getSheetByName('_脚本添加的否定') || ss.insertSheet('_脚本添加的否定');
    sh.clear();
    var rows = values(tracked).map(function (t) { return [t.campaignId, t.text, t.date]; });
    if (rows.length) { sh.getRange(1, 1, rows.length, 3).setNumberFormat('@'); sh.getRange(1, 1, rows.length, 3).setValues(rows); }
    sh.hideSheet();
  }
  log('信息', '执行', (isPreview() ? '（预览模式不会真的修改）' : '') + '添加 ' + done.added + ' 个否定，删除 ' + done.removed + ' 个');
  return done;
}


// ======================= 输出 =======================

function writeOverlaps(ss, overlaps, exact) {
  overlaps.sort(function (a, b) { return b.cost - a.cost; });
  var head = ['搜索词', '目标系列', '类型', '来源', '目标系列 点击', '目标系列 费用', '目标系列 转化', '目标系列 CPA', '目标系列 ROAS',
              '完全匹配所在系列 / 广告组', '完全匹配 费用', '完全匹配 转化', '完全匹配 CPA', '完全匹配 ROAS', '哪边更好'];
  write(ss, '重叠搜索词', head, overlaps.map(function (o) {
    var e = derived(exact[o.norm]); derived(o);
    var better = o.conv && e.conv ? (num(o.cpa) < num(e.cpa) * 0.8 ? '目标系列更好' : num(e.cpa) < num(o.cpa) * 0.8 ? '完全匹配更好' : '差不多') : (e.conv ? '完全匹配更好' : o.conv ? '目标系列更好' : '都没有转化');
    return [o.norm, o.campaign, o.kind + (o.dsaGroup ? '（动态广告组）' : ''), Object.keys(o.sources).join(', '), o.clicks, o.cost, o.conv, o.cpa, o.roas,
            e.campaign + ' / ' + e.group, e.cost, e.conv, e.cpa, e.roas, better];
  }), ['', '', '', '', FMT.int, FMT.money, FMT.dec, FMT.money, FMT.ratio, '', FMT.money, FMT.dec, FMT.money, FMT.ratio, ''],
  { empty: '没有发现重叠', colors: { col: 14, fn: function (v) { return v === '完全匹配更好' ? '#e3f4e8' : v === '目标系列更好' ? '#fff1d6' : null; } } });
}

function writePlan(ss, plan) {
  var rank = { '添加': 0, '已添加': 0, '删除': 1, '已删除': 1, '保留': 2, '已存在': 3 };
  plan.sort(function (a, b) { return (rank[a.action] || 0) - (rank[b.action] || 0) || num(b.cost) - num(a.cost); });
  write(ss, '否定计划', ['操作', '目标广告系列', '否定关键字（完全匹配）', '原因', '近期费用', '近期转化'],
    plan.map(function (p) { return [p.action, p.campaign, '[' + p.text + ']', p.why, p.cost, p.conv]; }), ['', '', '', '', FMT.money, FMT.dec],
    { empty: '没有需要添加或删除的否定', title: CONFIG.APPLY_CHANGES ? '已执行（每次最多 ' + CONFIG.MAX_CHANGES + ' 个）' : '只是计划，没有修改账户。确认后把 APPLY_CHANGES 改成 true',
      colors: { col: 0, fn: function (v) { return /添加/.test(v) ? '#e3f4e8' : /删除/.test(v) ? '#fde2e1' : null; } } });
}

function writeTargets(ss, targets, terms) {
  var by = {};
  terms.forEach(function (t) {
    var x = by[t.campaignId] || (by[t.campaignId] = zero({ ai: zero({}), n: 0 }));
    x.n++; addMetrics(x, t);
    if (t.sources.AI_MAX_KEYWORDLESS || t.sources.AI_MAX_BROAD_MATCH) addMetrics(x.ai, t);
  });
  write(ss, '目标广告系列', ['广告系列', '类型', '搜索词数', '费用', '转化', '其中 AI Max 扩展的费用', 'AI Max 扩展占比'],
    targets.map(function (c) { var x = by[c.id] || zero({ ai: zero({}), n: 0 }); return [c.name, c.kind, x.n, x.cost, x.conv, x.ai.cost, div(x.ai.cost, x.cost)]; }),
    ['', '', FMT.int, FMT.money, FMT.dec, FMT.money, FMT.pct], { empty: '没有找到 DSA 或 AI Max 广告系列' });
}

function buildActions(overlaps, plan, targets, done) {
  var A = [];
  if (!targets.length) { A.push(['低', '说明', '—', '没有找到 DSA 或开启 AI Max 的搜索广告系列', '', '如果有广泛匹配系列也想分流，在 TARGET_CAMPAIGN_CONTAINS 填写它的名称']); return A; }
  var cost = overlaps.reduce(function (s, o) { return s + o.cost; }, 0);
  if (overlaps.length) A.push([cost > 0 ? '高' : '中', '重叠', overlaps.length + ' 个搜索词', 'DSA / AI Max 系列抢了已有完全匹配关键字的流量', '这部分花费 ' + r2(cost),
    '这些搜索应该由完全匹配关键字承接：出价、广告和落地页都更精准。见「否定计划」']);
  var worse = overlaps.filter(function (o) { derived(o); return o.cost > 0; }).sort(function (a, b) { return b.cost - a.cost; }).slice(0, 10);
  worse.forEach(function (o) { A.push(['中', '重叠', o.campaign + ' / ' + o.norm, '在 ' + o.kind + ' 系列里花费 ' + r2(o.cost), '转化 ' + r2(o.conv) + '，CPA ' + r2(o.cpa), '加完全匹配否定 [' + o.norm + ']']); });
  var adds = plan.filter(function (p) { return p.action === '添加'; }).length, rems = plan.filter(function (p) { return p.action === '删除'; }).length;
  if (!CONFIG.APPLY_CHANGES && (adds || rems)) A.push(['中', '计划', '否定关键字', '计划添加 ' + adds + ' 个、删除 ' + rems + ' 个否定', '', '确认「否定计划」没问题后，把 APPLY_CHANGES 改成 true 再运行']);
  if (done.added || done.removed) A.push(['低', '已执行', '否定关键字', '添加 ' + done.added + ' 个、删除 ' + done.removed + ' 个', '', '脚本添加的否定记录在隐藏表里，原关键字暂停后会自动删除']);
  var better = overlaps.filter(function (o) { return o.conv >= 2; }).length;
  if (better) A.push(['低', '提示', '—', better + ' 个重叠搜索词在目标系列里也有转化', '', '看「重叠搜索词」的「哪边更好」：如果目标系列明显更好，先检查完全匹配那边的出价和广告，而不是急着否定']);
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
