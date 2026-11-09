/**
 * 展示位置清理 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：检查展示广告、视频、Demand Gen（以及 PMax 的展示数据）投放到了哪些网站、App 和 YouTube 频道，找出
 *   1. 游戏类 App（误点和刷量的重灾区）；
 *   2. 儿童内容频道和视频；
 *   3. 可疑网站（廉价域名后缀、VPN、盗版、星座、歌词等低质量流量）；
 *   4. 点击率异常高但没有转化的位置（误点、无效点击）；
 *   5. 花了钱没有转化的位置；
 * 生成可以直接粘贴的排除列表；网站类排除可选自动加入共享排除列表。
 *
 * 思路参考 Vincent van Pareren 的 Display Placement Excluder（v1 和 v2.2，其中 v2.2 已经因为 Google 的改动不能排除 App），
 * 以及常见的 Demand Gen 排除列表，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-placement-cleanup-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 有新的排除建议时发邮件（留空 = 不发）
  EMAIL: '',

  // 只看名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 分析最近多少天
  DAYS: 30,
  // 花费 ≥ 这个金额且没有转化 → 建议排除（0 = 用账户平均每次转化费用）
  WASTE_COST: 0,
  // 点击率 ≥ 所在系列平均的这么多倍（且 ≥ 5%、点击 ≥ 20）且没有转化 → 疑似误点
  CTR_MULTIPLIER: 3,

  // 名称或网址包含这些词的 App 算游戏类
  GAME_WORDS: ['game', 'games', 'puzzle', 'casino', 'slot', 'slots', 'solitaire', 'sudoku', 'bubble', 'candy', 'merge', 'idle', 'tycoon',
    'craft', 'racing', 'shooter', 'zombie', 'coloring', 'jigsaw', 'mahjong', 'bingo', 'poker', 'word', 'trivia', 'arcade', 'simulator', 'quiz', 'tiles'],
  // 名称包含这些词的 YouTube 频道 / 视频算儿童内容
  KIDS_WORDS: ['kids', 'kid', 'children', 'nursery', 'toddler', 'baby', 'cartoon', 'cartoons', 'toys', 'lullaby', 'abc song', 'for kids'],
  // 可疑网站：域名后缀和关键词
  BAD_TLDS: ['.xyz', '.top', '.icu', '.club', '.buzz', '.click', '.fun', '.live', '.online', '.site', '.monster', '.rest', '.cyou', '.sbs'],
  BAD_SITE_WORDS: ['vpn', 'proxy', 'torrent', 'free-movie', 'freemovie', 'lyrics', 'horoscope', 'astrology', 'wallpaper', 'apk', 'mod-apk', 'cheat', 'coupon'],

  // 不要排除的位置（白名单，包含即可），例如自己的网站、合作媒体
  KEEP: [],

  // 把网站类排除自动加入这个共享排除列表（留空 = 只给建议）。
  // 列表需要先在「工具 → 共享库 → 排除的展示位置列表」里建好，并关联到广告系列或账户
  AUTO_EXCLUDE_LIST: ''
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var TYPE_CN = { WEBSITE: '网站', MOBILE_APPLICATION: 'App', YOUTUBE_CHANNEL: 'YouTube 频道', YOUTUBE_VIDEO: 'YouTube 视频', MOBILE_APP_CATEGORY: 'App 类别', GOOGLE_PRODUCTS: 'Google 产品' };


function main() {
  var ss = openSpreadsheet('展示位置清理');
  log('信息', '开始', '版本 ' + VERSION + '，最近 ' + CONFIG.DAYS + ' 天');

  var ref = safe('参考 CPA', referenceCpa) || 0;
  var waste = CONFIG.WASTE_COST || ref || 20;
  log('信息', '标准', '花费 ≥ ' + r2(waste) + ' 且没有转化的位置建议排除');

  var places = safe('展示位置', fetchPlacements) || [];
  var pmax = safe('PMax 展示位置', fetchPmax) || [];
  log('信息', '位置', places.length + ' 个展示位置（展示/视频/Demand Gen），PMax ' + pmax.length + ' 个');

  var campCtr = {};
  places.forEach(function (p) { var c = campCtr[p.campaign] || (campCtr[p.campaign] = { i: 0, c: 0 }); c.i += p.impr; c.c += p.clicks; });
  places.concat(pmax).forEach(function (p) { flag(p, campCtr[p.campaign], waste); });

  var all = places.concat(pmax);
  var sugg = merge(all);
  safe('排除建议', function () { writeSuggestions(ss, sugg); });
  safe('全部位置', function () { writeAll(ss, places, '全部位置'); });
  safe('PMax 位置', function () { writeAll(ss, pmax, 'PMax 位置'); });
  if (CONFIG.AUTO_EXCLUDE_LIST) safe('自动排除', function () { autoExclude(sugg); });
  safe('行动清单', function () { writeActions(ss, buildActions(places, pmax, sugg), '没有发现明显的低质量位置'); });

  var fresh = safe('提醒去重', function () { return newOnes(ss, sugg); }) || [];
  if (CONFIG.EMAIL && fresh.length) safe('邮件', function () {
    mail('[展示位置清理] ' + AdsApp.currentAccount().getName() + '：' + fresh.length + ' 个新的排除建议', '最近 ' + CONFIG.DAYS + ' 天发现的低质量展示位置：',
      [['原因', '类型', '位置', '费用', '点击', '转化']].concat(fresh.slice(0, 40).map(function (s) { return [s.reasons.join('、'), TYPE_CN[s.type] || s.type, s.name, s.cost, s.clicks, s.conv]; })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '展示位置清理', VERSION, [
      ['范围', '展示广告、视频、Demand Gen 的展示位置；PMax 只有展示次数数据（Google 不提供 PMax 位置的点击和费用）'],
      ['排除标准', '游戏 App、儿童内容、可疑网站、点击率异常高且无转化、花费 ≥ ' + r2(waste) + ' 且无转化'],
      ['', ''],
      ['行动清单', '先看这里：浪费最多的位置类型和具体位置'],
      ['排除建议', '「排除值」列可以直接复制，粘贴到 Google Ads 的「内容 → 排除项」或共享排除列表'],
      ['全部位置 / PMax 位置', '所有位置的明细和标签'],
      ['注意', 'PMax 的展示位置只能通过账户层面的排除列表排除；Google 已不允许一次性排除所有 App，游戏类 App 需要逐个排除，脚本会帮你列出来']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '排除建议', '全部位置', 'PMax 位置', '运行日志']);
}


// ======================= 读取数据 =======================

function referenceCpa() {
  var rows = tryQuery('参考 CPA', 'SELECT metrics.cost_micros, metrics.conversions FROM customer WHERE ' + range(CONFIG.DAYS)) || [];
  var c = 0, v = 0; rows.forEach(function (r) { c += money(g(r, 'metrics.costMicros')); v += num(g(r, 'metrics.conversions')); });
  return v >= 1 ? c / v : 0;
}

function fetchPlacements() {
  var q = 'SELECT campaign.name, campaign.advertising_channel_type, group_placement_view.placement, group_placement_view.placement_type, ' +
    'group_placement_view.display_name, group_placement_view.target_url, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM group_placement_view WHERE ' + range(CONFIG.DAYS) + ' AND metrics.impressions > 0' + nameFilter();
  var rows = runQuery(q), map = {};
  rows.forEach(function (r) {
    var pl = String(g(r, 'groupPlacementView.placement')), camp = String(g(r, 'campaign.name'));
    var key = camp + '|' + pl;
    var x = map[key] || (map[key] = zero({ source: CH[String(g(r, 'campaign.advertisingChannelType'))] || String(g(r, 'campaign.advertisingChannelType')), campaign: camp, placement: pl,
      type: String(g(r, 'groupPlacementView.placementType')), name: String(g(r, 'groupPlacementView.displayName') || pl), url: String(g(r, 'groupPlacementView.targetUrl') || '') }));
    addMetrics(x, metricsOf(r));
  });
  return values(map);
}
var CH = { DISPLAY: '展示', VIDEO: '视频', DEMAND_GEN: 'Demand Gen', DISCOVERY: 'Demand Gen', PERFORMANCE_MAX: 'PMax' };

function fetchPmax() {
  var rows = tryQuery('PMax 展示位置', 'SELECT campaign.name, performance_max_placement_view.placement, performance_max_placement_view.placement_type, ' +
    'performance_max_placement_view.display_name, performance_max_placement_view.target_url, metrics.impressions FROM performance_max_placement_view WHERE ' + range(CONFIG.DAYS) + nameFilter());
  if (!rows) return [];
  var map = {};
  rows.forEach(function (r) {
    var pl = String(g(r, 'performanceMaxPlacementView.placement')), camp = String(g(r, 'campaign.name'));
    var x = map[camp + '|' + pl] || (map[camp + '|' + pl] = zero({ source: 'PMax', campaign: camp, placement: pl, type: String(g(r, 'performanceMaxPlacementView.placementType')),
      name: String(g(r, 'performanceMaxPlacementView.displayName') || pl), url: String(g(r, 'performanceMaxPlacementView.targetUrl') || ''), pmax: true }));
    x.impr += num(g(r, 'metrics.impressions'));
  });
  return values(map);
}


// ======================= 判断 =======================

function hasWord(text, words) {
  var t = String(text || '').toLowerCase();
  for (var i = 0; i < words.length; i++) {
    var w = String(words[i]).toLowerCase();
    if (!w) continue;
    // 英文单词按单词边界匹配，避免 "word" 命中 "wordpress"、"kid" 命中 "kidney"
    var re = new RegExp('(^|[^a-z])' + w.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '($|[^a-z])');
    if (re.test(t)) return w;
  }
  return '';
}

function flag(p, cc, waste) {
  p.reasons = [];
  var text = (p.name + ' ' + p.placement + ' ' + p.url).toLowerCase();
  if (CONFIG.KEEP.some(function (k) { return k && text.indexOf(String(k).toLowerCase()) >= 0; })) { p.keep = true; return; }
  if (p.type === 'MOBILE_APPLICATION') {
    var gw = hasWord(text.replace(/[._-]/g, ' '), CONFIG.GAME_WORDS);
    if (gw) p.reasons.push('游戏 App（' + gw + '）');
  }
  if (p.type === 'YOUTUBE_CHANNEL' || p.type === 'YOUTUBE_VIDEO') {
    var kw = hasWord(text, CONFIG.KIDS_WORDS);
    if (kw) p.reasons.push('儿童内容（' + kw + '）');
  }
  if (p.type === 'WEBSITE') {
    var host = (p.placement.match(/^(?:https?:\/\/)?([^\/]+)/i) || ['', p.placement])[1].toLowerCase();
    var tld = CONFIG.BAD_TLDS.filter(function (t) { return host.slice(-t.length) === t; })[0];
    if (tld) p.reasons.push('可疑域名后缀（' + tld + '）');
    var sw = CONFIG.BAD_SITE_WORDS.filter(function (w) { return host.indexOf(w) >= 0; })[0];
    if (sw) p.reasons.push('低质量网站（' + sw + '）');
  }
  if (!p.pmax) {
    var ctr = div(p.clicks, p.impr), avg = cc && cc.i ? cc.c / cc.i : 0;
    if (p.clicks >= 20 && p.conv < 0.5 && ctr !== '' && ctr >= 0.05 && avg && ctr >= avg * CONFIG.CTR_MULTIPLIER) p.reasons.push('点击率异常高（' + pct(ctr) + '，系列平均 ' + pct(avg) + '）且没有转化');
    if (p.cost >= waste && p.conv < 0.5) p.reasons.push('花费 ' + r2(p.cost) + ' 没有转化');
  }
}

// 同一个位置可能出现在多个系列里，排除建议按位置合并
function merge(all) {
  var map = {};
  all.forEach(function (p) {
    if (p.keep || !p.reasons.length) return;
    var x = map[p.placement] || (map[p.placement] = zero({ placement: p.placement, type: p.type, name: p.name, url: p.url, reasons: [], camps: {}, pmaxImpr: 0 }));
    p.reasons.forEach(function (r) { var base = r.split('（')[0]; if (!x.reasons.some(function (y) { return y.split('（')[0] === base; })) x.reasons.push(r); });
    x.camps[p.campaign] = 1;
    if (p.pmax) x.pmaxImpr += p.impr; else addMetrics(x, p);
  });
  return values(map).map(function (x) {
    x.value2 = exclusionValue(x);
    x.level = x.cost >= 1 && x.conv < 0.5 ? '高' : '中';
    return x;
  }).sort(function (a, b) { return b.cost - a.cost || b.pmaxImpr - a.pmaxImpr; });
}

// Google Ads 排除项里可以直接粘贴的值
function exclusionValue(x) {
  if (x.type === 'WEBSITE') return x.placement.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (x.type === 'YOUTUBE_CHANNEL') return 'youtube.com/channel/' + x.placement;
  if (x.type === 'YOUTUBE_VIDEO') return 'youtube.com/watch?v=' + x.placement;
  return x.placement; // App：mobileapp::... 格式
}


// ======================= 输出 =======================

function writeSuggestions(ss, sugg) {
  write(ss, '排除建议', ['优先级', '类型', '名称', '排除值', '原因', '费用', '点击', '转化', 'PMax 展示', '出现在哪些广告系列'],
    sugg.map(function (s) { return [s.level, TYPE_CN[s.type] || s.type, s.name, s.value2, s.reasons.join('；'), s.cost, s.clicks, s.conv, s.pmaxImpr || '', Object.keys(s.camps).join('、')]; }),
    ['', '', '', '', '', FMT.money, FMT.int, FMT.dec, FMT.int, ''], { empty: '没有排除建议', widths: [60, 90, 240, 280, 320], colors: { col: 0, fn: levelColor } });
}

function writeAll(ss, list, name) {
  list.sort(function (a, b) { return b.cost - a.cost || b.impr - a.impr; });
  var pm = name === 'PMax 位置';
  var head = ['来源', '广告系列', '类型', '名称', '位置'].concat(pm ? ['展示'] : METRIC_HEAD).concat(['标签']);
  write(ss, name, head, list.map(function (p) {
    return [p.source, p.campaign, TYPE_CN[p.type] || p.type, p.name, p.placement].concat(pm ? [p.impr] : metricCells(p)).concat([p.keep ? '白名单' : p.reasons.join('；')]);
  }), ['', '', '', '', ''].concat(pm ? [FMT.int] : METRIC_FMT).concat(['']), { max: 30000, empty: pm ? '没有 PMax 展示位置数据' : '没有展示位置数据' });
}

function autoExclude(sugg) {
  var it = AdsApp.excludedPlacementLists().withCondition("Name = '" + CONFIG.AUTO_EXCLUDE_LIST.replace(/'/g, '') + "'").get();
  if (!it.hasNext()) { log('错误', '自动排除', '找不到排除列表「' + CONFIG.AUTO_EXCLUDE_LIST + '」'); return; }
  var list = it.next(), sites = sugg.filter(function (s) { return s.type === 'WEBSITE'; }).map(function (s) { return s.value2; });
  if (sites.length) list.addExcludedPlacements(sites);
  log('信息', '自动排除', (isPreview() ? '（预览模式不会真的添加）' : '') + '加入 ' + sites.length + ' 个网站；App 和 YouTube 请按「排除建议」手动添加');
}

function buildActions(places, pmax, sugg) {
  var A = [], total = places.reduce(function (s, p) { return s + p.cost; }, 0);
  function group(prefix, level, advice) {
    var l = sugg.filter(function (s) { return s.reasons.some(function (r) { return r.indexOf(prefix) === 0; }); });
    if (!l.length) return;
    var cost = l.reduce(function (s, x) { return s + x.cost; }, 0), im = l.reduce(function (s, x) { return s + x.pmaxImpr; }, 0);
    A.push([level, prefix, l.length + ' 个位置', '花费 ' + r2(cost) + (total ? '（占展示类花费 ' + pct(cost / total) + '）' : '') + (im ? '，PMax 展示 ' + im + ' 次' : ''),
      '例如：' + l.slice(0, 4).map(function (x) { return x.name; }).join('、'), advice]);
  }
  group('游戏 App', '高', '复制「排除建议」里的 App 排除值，加到账户层面的排除列表（PMax 也会生效）');
  group('儿童内容', '高', '加到排除列表；同时在「内容适宜性」设置里排除「面向儿童的内容」');
  group('可疑域名后缀', '中', '加到共享排除列表；也可以在 AUTO_EXCLUDE_LIST 里填列表名让脚本自动添加');
  group('低质量网站', '中', '同上');
  group('点击率异常高', '高', '疑似误点或无效点击：排除，并在「设置 → 无效点击」里查看是否已经被 Google 退款');
  group('花费', '中', '花了钱没有转化，排除或降低这些位置的出价');
  if (pmax.length) {
    var apps = pmax.filter(function (p) { return p.type === 'MOBILE_APPLICATION'; }).reduce(function (s, p) { return s + p.impr; }, 0);
    var all = pmax.reduce(function (s, p) { return s + p.impr; }, 0);
    if (all && apps / all >= 0.3) A.push(['中', 'PMax', '全部 PMax', 'PMax 展示位置里 ' + pct(apps / all) + ' 的展示来自 App', '', 'PMax 的 App 展示往往质量不高；把游戏 App 加到账户层面排除列表']);
  }
  return A;
}

function newOnes(ss, sugg) {
  var sh = ss.getSheetByName('_已提醒') || ss.insertSheet('_已提醒');
  var n = sh.getLastRow(), seen = {};
  if (n) sh.getRange(1, 1, n, 1).getValues().forEach(function (r) { seen[String(r[0])] = 1; });
  var fresh = sugg.filter(function (s) { return !seen[s.placement]; });
  if (fresh.length && !isPreview()) sh.getRange(n + 1, 1, fresh.length, 1).setNumberFormat('@').setValues(fresh.map(function (s) { return [s.placement]; }));
  sh.hideSheet();
  return fresh;
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
