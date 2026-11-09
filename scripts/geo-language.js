/**
 * 国家地区与语言表现分析 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：按用户实际所在的国家分析每个广告系列的花费和转化，专门解决外贸和跨境账户常见的几个问题：
 *   1. 哪些国家花了钱没有转化（建议排除或降低出价），哪些国家效果好但花得少（建议单独加预算）；
 *   2. 有多少流量来自「没有定位的国家」——通常是地理位置选项设成了「所在地或感兴趣」，
 *      导致在中国、印度等地「对美国感兴趣」的人也看到了你投美国的广告；
 *   3. 广告系列的语言设置和国家是否匹配（例如投德国却只选了英语）；
 *   4. 每个国家建议的出价调整比例。
 *
 * 毕瑞出海原创脚本。
 *
 * 教程：https://berightdigital.com/google-ads-geo-language-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 每次运行后发摘要邮件（留空 = 不发）
  EMAIL: '',

  // 只看名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 统计最近多少天
  DAYS: 90,
  // 效率按什么判断：'ROAS' 或 'CPA'。留空 = 有转化价值就用 ROAS
  METRIC: '',
  // 一个国家至少花了这么多钱，才给出建议（账户币种）
  MIN_COST: 50,
  // 花费 ≥ 参考 CPA × 这个倍数且没有转化 → 建议排除
  NO_CONV_CPA_MULTIPLIER: 2,
  // 出价调整建议的上下限
  MAX_BID_UP: 0.3,
  MAX_BID_DOWN: 0.5
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
// 常见国家的主要语言（Google Ads 语言代码），用来检查语言设置
var COUNTRY_LANG = { US: ['en'], GB: ['en'], CA: ['en', 'fr'], AU: ['en'], NZ: ['en'], IE: ['en'], DE: ['de'], AT: ['de'], CH: ['de', 'fr', 'it'], FR: ['fr'], BE: ['nl', 'fr'],
  NL: ['nl'], ES: ['es'], MX: ['es'], CO: ['es'], AR: ['es'], CL: ['es'], PE: ['es'], IT: ['it'], PT: ['pt'], BR: ['pt'], PL: ['pl'], SE: ['sv'], NO: ['no'], DK: ['da'], FI: ['fi'],
  JP: ['ja'], KR: ['ko'], TW: ['zh_TW'], HK: ['zh_TW', 'en'], SG: ['en', 'zh_CN'], MY: ['ms', 'en'], TH: ['th'], VN: ['vi'], ID: ['id'], PH: ['en', 'tl'], IN: ['en', 'hi'],
  AE: ['ar', 'en'], SA: ['ar'], IL: ['iw', 'en'], TR: ['tr'], RU: ['ru'], UA: ['uk'], CZ: ['cs'], RO: ['ro'], HU: ['hu'], GR: ['el'], ZA: ['en'], NG: ['en'], EG: ['ar'] };


function main() {
  var ss = openSpreadsheet('国家地区分析');
  log('信息', '开始', '版本 ' + VERSION + '，最近 ' + CONFIG.DAYS + ' 天');

  var camps = safe('广告系列设置', fetchCampaigns) || {};
  var rows = safe('按国家', fetchCountries) || [];
  var names = safe('国家名称', function () { return countryNames(rows, camps); }) || {};
  var total = rows.reduce(function (t, r) { return addMetrics(t, r); }, zero({}));
  var useRoas = CONFIG.METRIC ? CONFIG.METRIC === 'ROAS' : total.value > 0;
  derived(total);
  log('信息', '数据', rows.length + ' 行（广告系列 × 国家），花费 ' + r2(total.cost));

  var byCountry = aggregate(rows, names);
  var A = [];
  safe('国家汇总', function () { writeCountries(ss, byCountry, total, useRoas, A); });
  safe('广告系列 × 国家', function () { writeDetail(ss, rows, names, camps, useRoas, A); });
  safe('定位外流量', function () { outside(ss, rows, names, camps, total, A); });
  safe('语言检查', function () { languages(ss, camps, names, A); });
  safe('行动清单', function () { writeActions(ss, A, '各国家表现正常'); });

  if (CONFIG.EMAIL) safe('邮件', function () {
    mail('[国家地区分析] ' + AdsApp.currentAccount().getName(), '最近 ' + CONFIG.DAYS + ' 天按国家的分析结果：',
      [['优先级', '类别', '对象', '发现', '数据']].concat(A.slice(0, 15).map(function (x) { return x.slice(0, 5); })), ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '国家地区与语言表现分析', VERSION, [
      ['数据口径', '按用户实际所在的国家（user location），不是按用户感兴趣的地点'],
      ['效率指标', useRoas ? 'ROAS' : 'CPA'],
      ['', ''],
      ['行动清单', '先看这里：花钱不转化的国家、效果好但投入少的国家、定位以外的流量、语言设置问题'],
      ['国家汇总', '每个国家的花费、转化、ROAS/CPA、占比和效率指数'],
      ['广告系列 × 国家', '每个广告系列在每个国家的表现和出价调整建议'],
      ['定位外流量', '来自没有定位的国家的流量（通常是「所在地或感兴趣」造成的）'],
      ['语言检查', '每个广告系列的语言设置和定位国家是否匹配'],
      ['注意', '使用智能出价时，地区出价调整只对部分出价策略有效；效果差别很大的国家建议拆成单独的广告系列']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '国家汇总', '广告系列 × 国家', '定位外流量', '语言检查', '运行日志']);
}


// ======================= 读取 =======================

function fetchCampaigns() {
  var map = {};
  (tryQuery('广告系列', 'SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.status = "ENABLED"' + nameFilter()) ||
   runQuery('SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.status = "ENABLED"' + nameFilter())).forEach(function (r) {
    var id = String(g(r, 'campaign.id'));
    map[id] = { id: id, name: String(g(r, 'campaign.name')), type: String(g(r, 'campaign.advertisingChannelType')),
      geoType: String(g(r, 'campaign.geoTargetTypeSetting.positiveGeoTargetType') || ''), locations: [], languages: [] };
  });
  (tryQuery('地区和语言定位', 'SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, ' +
    'campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign_criterion.type IN ("LOCATION", "LANGUAGE") AND campaign.status = "ENABLED"') || []).forEach(function (r) {
    var c = map[String(g(r, 'campaign.id'))]; if (!c || g(r, 'campaignCriterion.negative') === true) return;
    if (g(r, 'campaignCriterion.type') === 'LOCATION') c.locations.push(String(g(r, 'campaignCriterion.location.geoTargetConstant')));
    else c.languages.push(String(g(r, 'campaignCriterion.language.languageConstant')));
  });
  return map;
}

function fetchCountries() {
  var q = 'SELECT campaign.id, campaign.name, user_location_view.country_criterion_id, user_location_view.targeting_location, ' +
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM user_location_view WHERE ' + range(CONFIG.DAYS) + nameFilter();
  var rows = tryQuery('按国家（用户所在地）', q);
  var src = 'user';
  if (!rows) {
    src = 'geo';
    rows = runQuery('SELECT campaign.id, campaign.name, geographic_view.country_criterion_id, geographic_view.location_type, metrics.impressions, metrics.clicks, ' +
      'metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM geographic_view WHERE ' + range(CONFIG.DAYS) + ' AND geographic_view.location_type = "LOCATION_OF_PRESENCE"' + nameFilter());
  }
  var map = {};
  rows.forEach(function (r) {
    var cid = String(g(r, 'campaign.id')), country = String(src === 'user' ? g(r, 'userLocationView.countryCriterionId') : g(r, 'geographicView.countryCriterionId'));
    var key = cid + '|' + country;
    var x = map[key] || (map[key] = zero({ campaignId: cid, campaign: String(g(r, 'campaign.name')), country: country, targeted: src === 'user' ? g(r, 'userLocationView.targetingLocation') : '' }));
    addMetrics(x, metricsOf(r));
  });
  return values(map);
}

function countryNames(rows, camps) {
  var ids = {};
  rows.forEach(function (r) { if (r.country) ids['geoTargetConstants/' + r.country] = 1; });
  values(camps).forEach(function (c) { c.locations.forEach(function (l) { ids[l] = 1; }); });
  var list = Object.keys(ids), out = {};
  for (var i = 0; i < list.length; i += 500) {
    (tryQuery('国家名称', 'SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.canonical_name ' +
      'FROM geo_target_constant WHERE geo_target_constant.resource_name IN ("' + list.slice(i, i + 500).join('","') + '")') || []).forEach(function (r) {
      var gt = r.geoTargetConstant || {};
      out[String(gt.resourceName)] = { name: String(gt.name || ''), code: String(gt.countryCode || ''), type: String(gt.targetType || ''), full: String(gt.canonicalName || '') };
    });
  }
  return out;
}
function cname(names, id) { var n = names['geoTargetConstants/' + id]; return n ? n.name + (n.code ? '（' + n.code + '）' : '') : (id ? 'ID ' + id : '未知'); }
function ccode(names, id) { var n = names['geoTargetConstants/' + id]; return n ? n.code : ''; }


// ======================= 分析 =======================

function aggregate(rows, names) {
  var map = {};
  rows.forEach(function (r) { var x = map[r.country] || (map[r.country] = zero({ country: r.country, name: cname(names, r.country), code: ccode(names, r.country), camps: 0 })); addMetrics(x, r); x.camps++; });
  return values(map).sort(function (a, b) { return b.cost - a.cost; });
}

function index(m, ref, useRoas) {
  derived(m);
  if (!m.cost) return '';
  if (useRoas) return ref.roas ? num(m.roas) / ref.roas : '';
  return m.conv ? (ref.cpa ? ref.cpa / m.cpa : '') : 0;
}

function bidAdvice(ix, m, ref) {
  if (ix === '' || m.cost < CONFIG.MIN_COST) return { pct: '', text: '' };
  if (!m.conv && m.cost >= (ref.cpa || 0) * CONFIG.NO_CONV_CPA_MULTIPLIER) return { pct: -1, text: '花费 ' + r2(m.cost) + ' 没有转化：建议排除' };
  var p = Math.max(-CONFIG.MAX_BID_DOWN, Math.min(CONFIG.MAX_BID_UP, (ix - 1) * 0.5));
  p = Math.round(p * 20) / 20;
  if (Math.abs(p) < 0.1) return { pct: '', text: '' };
  return { pct: p, text: (p > 0 ? '效果好于平均：出价 +' : '效果低于平均：出价 ') + Math.round(p * 100) + '%' };
}

function writeCountries(ss, list, total, useRoas, A) {
  var ref = { roas: num(total.roas), cpa: num(total.cpa) };
  var data = list.map(function (x) {
    var ix = index(x, ref, useRoas), adv = bidAdvice(ix, x, ref);
    x.ix = ix; x.adv = adv;
    return [x.name, x.code].concat(metricCells(x)).concat([div(x.cost, total.cost), div(useRoas ? x.value : x.conv, useRoas ? total.value : total.conv), ix, adv.text]);
  });
  write(ss, '国家汇总', ['国家', '代码'].concat(METRIC_HEAD).concat(['花费占比', useRoas ? '价值占比' : '转化占比', '效率指数', '建议']), data,
    ['', ''].concat(METRIC_FMT).concat([FMT.pct, FMT.pct, FMT.ratio, '']),
    { title: '整体 ' + (useRoas ? 'ROAS ' + r2(total.roas) : 'CPA ' + r2(total.cpa)) + '，效率指数 1 = 平均',
      colors: { col: 13, fn: function (v) { return v === '' ? null : v < 0.6 ? '#fde2e1' : v > 1.3 ? '#e3f4e8' : null; } } });
  var waste = list.filter(function (x) { return x.adv.pct === -1; });
  if (waste.length) A.push(['高', '国家', waste.length + ' 个国家', '花了钱没有转化', waste.slice(0, 6).map(function (x) { return x.name + ' ' + r2(x.cost); }).join('、'),
    '在相关广告系列里排除这些国家，或单独建低预算系列测试']);
  list.filter(function (x) { return x.ix !== '' && x.ix >= 1.3 && x.cost >= CONFIG.MIN_COST && div(x.cost, total.cost) < 0.1; }).slice(0, 5).forEach(function (x) {
    A.push(['中', '国家', x.name, '效率是平均的 ' + pct(x.ix) + '，但只占 ' + pct(div(x.cost, total.cost)) + ' 的花费', (useRoas ? 'ROAS ' + r2(x.roas) : 'CPA ' + r2(x.cpa)) + '，转化 ' + r2(x.conv),
      '把这个国家拆成单独的广告系列并给足预算；准备当地语言的广告和落地页']);
  });
  list.filter(function (x) { return x.ix !== '' && x.ix < 0.6 && x.conv > 0 && div(x.cost, total.cost) >= 0.15; }).forEach(function (x) {
    A.push(['高', '国家', x.name, '花费占比大（' + pct(div(x.cost, total.cost)) + '）但效率只有平均的 ' + pct(x.ix), (useRoas ? 'ROAS ' + r2(x.roas) : 'CPA ' + r2(x.cpa)),
      '这是最大的优化空间：检查这个国家的价格、运费、物流时效、语言和支付方式是否有竞争力']);
  });
}

function writeDetail(ss, rows, names, camps, useRoas, A) {
  var byCamp = {};
  rows.forEach(function (r) { addMetrics(byCamp[r.campaignId] || (byCamp[r.campaignId] = zero({})), r); });
  Object.keys(byCamp).forEach(function (k) { derived(byCamp[k]); });
  rows.sort(function (a, b) { return a.campaign < b.campaign ? -1 : a.campaign > b.campaign ? 1 : b.cost - a.cost; });
  var data = rows.map(function (r) {
    var c = byCamp[r.campaignId], ref = { roas: num(c.roas), cpa: num(c.cpa) };
    var ix = index(r, ref, useRoas), adv = bidAdvice(ix, r, ref);
    return [r.campaign, cname(names, r.country), r.targeted === '' ? '' : (r.targeted ? '是' : '否')].concat(metricCells(r)).concat([div(r.cost, c.cost), ix, adv.pct, adv.text]);
  });
  write(ss, '广告系列 × 国家', ['广告系列', '国家', '在定位范围内'].concat(METRIC_HEAD).concat(['占系列花费', '效率指数（相对本系列）', '建议出价调整', '建议']), data,
    ['', '', ''].concat(METRIC_FMT).concat([FMT.pct, FMT.ratio, '+0%;-0%;0%', '']), { max: 20000 });
}

function outside(ss, rows, names, camps, total, A) {
  var out = rows.filter(function (r) { return r.targeted === false; });
  if (!out.length && rows.length && rows[0].targeted === '') { log('提示', '定位外流量', '账户不支持按用户所在地查询，跳过'); return; }
  var by = {};
  out.forEach(function (r) { var x = by[r.campaignId] || (by[r.campaignId] = zero({ campaign: r.campaign, countries: {} })); addMetrics(x, r); x.countries[cname(names, r.country)] = (x.countries[cname(names, r.country)] || 0) + r.cost; });
  var data = Object.keys(by).map(function (id) {
    var x = by[id], c = camps[id] || {};
    var top = Object.keys(x.countries).sort(function (a, b) { return x.countries[b] - x.countries[a]; }).slice(0, 5).map(function (k) { return k + ' ' + r2(x.countries[k]); }).join('、');
    return [x.campaign, c.geoType === 'PRESENCE_OR_INTEREST' ? '所在地或感兴趣 ⚠' : c.geoType === 'PRESENCE' ? '所在地' : c.geoType, x.cost, x.clicks, x.conv, top];
  }).sort(function (a, b) { return b[2] - a[2]; });
  write(ss, '定位外流量', ['广告系列', '地理位置选项', '定位外花费', '点击', '转化', '主要来自'], data, ['', '', FMT.money, FMT.int, FMT.dec, ''], { empty: '没有定位以外的流量' });
  var cost = out.reduce(function (s, r) { return s + r.cost; }, 0);
  if (cost >= CONFIG.MIN_COST) A.push([div(cost, total.cost) >= 0.05 ? '高' : '中', '定位外流量', data.length + ' 个广告系列', '有 ' + pct(div(cost, total.cost)) + ' 的花费来自没有定位的国家', '合计 ' + r2(cost) + '，例如 ' + (data[0] ? data[0][5] : ''),
    '把广告系列的地理位置选项改为「所在地：位于目标地区或经常前往目标地区的用户」（设置 → 地理位置 → 地理位置选项）']);
  values(camps).filter(function (c) { return c.geoType === 'PRESENCE_OR_INTEREST' && c.type !== 'PERFORMANCE_MAX'; }).slice(0, 1).forEach(function () {
    var n = values(camps).filter(function (c) { return c.geoType === 'PRESENCE_OR_INTEREST'; }).length;
    A.push(['中', '设置', n + ' 个广告系列', '地理位置选项是「所在地或感兴趣」（默认值）', '', '外贸和跨境账户建议改为「所在地」，避免在国内或其他国家「对目标市场感兴趣」的人看到广告']);
  });
}

function languages(ss, camps, names, A) {
  var langNames = {};
  var ids = {}; values(camps).forEach(function (c) { c.languages.forEach(function (l) { ids[l] = 1; }); });
  var list = Object.keys(ids);
  if (list.length) (tryQuery('语言名称', 'SELECT language_constant.resource_name, language_constant.code, language_constant.name FROM language_constant WHERE language_constant.resource_name IN ("' + list.join('","') + '")') || [])
    .forEach(function (r) { var l = r.languageConstant || {}; langNames[String(l.resourceName)] = { code: String(l.code || ''), name: String(l.name || '') }; });
  var data = [], issues = 0;
  values(camps).forEach(function (c) {
    if (c.type === 'PERFORMANCE_MAX' && !c.languages.length) return;
    var codes = c.languages.map(function (l) { return (langNames[l] || {}).code || l.split('/').pop(); });
    var countries = c.locations.map(function (l) { return names[l]; }).filter(function (n) { return n && n.type === 'Country'; });
    var missing = [];
    if (codes.length) countries.forEach(function (n) {
      var need = COUNTRY_LANG[n.code]; if (!need) return;
      if (!need.some(function (lc) { return codes.indexOf(lc) >= 0; })) missing.push(n.name + '（常用语言：' + need.join('/') + '）');
    });
    var note = !codes.length ? '所有语言' : missing.length ? '定位国家的主要语言没有选：' + missing.join('、') : '';
    if (missing.length) issues++;
    data.push([c.name, countries.map(function (n) { return n.name; }).join('、') || (c.locations.length ? c.locations.length + ' 个地区' : '所有地区'),
      codes.map(function (cd) { var x = values(langNames).filter(function (l) { return l.code === cd; })[0]; return x ? x.name : cd; }).join('、') || '所有语言', note]);
  });
  write(ss, '语言检查', ['广告系列', '定位国家', '语言', '问题'], data, null, { colors: { col: 3, fn: function (v) { return /没有选/.test(v) ? '#fff1d6' : null; } } });
  if (issues) A.push(['中', '语言', issues + ' 个广告系列', '语言设置不包含定位国家的主要语言', '见「语言检查」表',
    '语言设置决定广告展示给使用什么语言的用户。投德国只选英语，会错过大部分德语用户；建议加上当地语言，并准备当地语言的广告']);
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
