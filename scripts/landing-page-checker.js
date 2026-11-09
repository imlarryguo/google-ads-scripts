/**
 * 落地页与缺货检查 v1.0（毕瑞出海中文版）
 * ------------------------------------------------------------
 * 作用：检查广告里用到的所有网址，找出
 *   1. 打不开的页面（404、500、超时、证书错误）；
 *   2. 跳转到首页的页面（商品下架后最常见）、跳转到其他域名的页面；
 *   3. 「假 200」页面：能打开，但标题是「页面不存在」；
 *   4. 缺货页面：页面文字或结构化数据显示 Out of stock / Sold out（支持英、德、法、西、意、葡、荷、日等语言）；
 *   5. 打开很慢的页面。
 * 覆盖：搜索广告、关键字最终网址、附加链接、PMax 素材资源组。
 * 可选：自动暂停指向缺货商品页的搜索广告，补货后自动恢复（默认关闭）。
 *
 * 思路参考 Google 官方 Link Checker 和 Clicteq 的缺货暂停脚本，代码为重新编写。
 *
 * 教程：https://berightdigital.com/google-ads-landing-page-checker-script/
 * ------------------------------------------------------------
 */

// ======================= 设置（只需要改这里） =======================
var CONFIG = {
  // Google 表格网址。留空 = 第一次运行时自动新建，网址打印在「日志」里，复制回这里。
  SPREADSHEET_URL: '',
  // 发现问题时发邮件（留空 = 不发）。多个用英文逗号分隔。
  EMAIL: '',

  // 只检查名称包含 / 不包含这段文字的广告系列（留空 = 不限）
  CAMPAIGN_NAME_CONTAINS: '',
  CAMPAIGN_NAME_EXCLUDES: '',

  // 检查哪些网址
  CHECK_ADS: true,
  CHECK_KEYWORDS: true,
  CHECK_SITELINKS: true,
  CHECK_PMAX: true,

  // 每隔多少天把所有网址完整检查一遍。脚本可以每小时运行，每次接着上次的进度检查。
  DAYS_BETWEEN_FULL_CHECKS: 1,
  // 每次运行最多检查多少个网址（Google 每天最多允许约 2 万次网址请求）
  MAX_FETCH_PER_RUN: 600,
  // 打开时间超过多少秒算慢
  SLOW_SECONDS: 4,

  // 缺货判断：页面里出现这些文字就算缺货（不区分大小写）。可以按自己网站的写法增减。
  OUT_OF_STOCK_TEXT: ['out of stock', 'sold out', 'currently unavailable', 'no longer available', 'temporarily unavailable',
    'ausverkauft', 'nicht verfügbar', 'nicht auf lager', 'rupture de stock', 'épuisé', 'agotado', 'sin existencias',
    'esaurito', 'non disponibile', 'esgotado', 'uitverkocht', 'niet op voorraad', '在庫切れ', '売り切れ', '缺货', '已售罄'],
  // 只把网址包含这段文字的页面当作商品页来判断缺货（例如 Shopify 是 '/products/'），留空 = 所有页面都判断
  PRODUCT_URL_PATTERN: '/products/',

  // 自动暂停指向缺货商品页的「搜索广告」，补货后自动恢复（默认关闭，只报告）
  PAUSE_OUT_OF_STOCK_ADS: false,
  // 自动暂停指向打不开页面（4xx/5xx）的搜索广告（默认关闭）
  PAUSE_BROKEN_ADS: false,
  // 暂停时打上的标签（恢复时也靠这个标签找回）
  PAUSE_LABEL: '脚本暂停-落地页'
};
// ======================= 设置结束，下面的代码一般不需要改 =======================

var VERSION = 'v1.0';
var RESULT_HEAD = ['网址', '状态', '问题', 'HTTP 状态码', '最终网址', '跳转次数', '打开秒数', '缺货', '用在哪里', '广告数', '检查时间'];


function main() {
  var ss = openSpreadsheet('落地页检查');
  log('信息', '开始', '版本 ' + VERSION + (isPreview() ? '（预览模式）' : ''));

  var urls = safe('收集网址', collectUrls) || {};
  var list = Object.keys(urls);
  log('信息', '网址', '共 ' + list.length + ' 个不同的网址');

  var old = readResults(ss);
  var cycleStart = cycleDate(ss);
  var todo = list.filter(function (u) { return !old[u] || old[u].checked < cycleStart; });
  // 上次有问题的优先复查
  todo.sort(function (a, b) { return (old[b] && old[b].status !== '正常' ? 1 : 0) - (old[a] && old[a].status !== '正常' ? 1 : 0); });
  log('信息', '进度', '本轮还剩 ' + todo.length + ' 个网址未检查（本轮开始于 ' + cycleStart + '）');

  var checked = 0, now = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm');
  for (var i = 0; i < todo.length && checked < CONFIG.MAX_FETCH_PER_RUN; i++) {
    if (timeLeft() < 4 * 60 * 1000) { log('提示', '进度', '接近运行时间上限，剩下的下次运行继续'); break; }
    var u = todo[i];
    var res = check(u);
    res.checked = now;
    old[u] = res; checked++;
  }
  log('信息', '检查', '本次检查了 ' + checked + ' 个网址');

  // 只保留现在还在用的网址
  var results = list.map(function (u) { var r = old[u] || { status: '待检查', issue: '', checked: '' }; r.url = u; r.where = urls[u]; return r; });
  var remaining = results.filter(function (r) { return !r.checked || r.checked < cycleStart; }).length;
  if (!remaining && !isPreview()) { stateSet(ss, 'cycle', dayStr(0)); }

  safe('检查结果', function () { writeResults(ss, results); });
  var paused = safe('自动暂停/恢复', function () { return pauseResume(results); }) || { paused: 0, resumed: 0 };
  var A = buildActions(results, paused, remaining);
  safe('行动清单', function () { writeActions(ss, A, '所有落地页正常'); });

  var bad = results.filter(function (r) { return r.status === '错误' || r.status === '缺货' || r.status === '警告'; });
  var fresh = safe('提醒去重', function () { return newProblems(ss, bad); }) || [];
  if (CONFIG.EMAIL && fresh.length) safe('邮件', function () {
    var rows = [['状态', '问题', '网址', '用在哪里']].concat(fresh.slice(0, 50).map(function (r) { return [r.status, r.issue, r.url, r.where.places.slice(0, 2).join('；')]; }));
    mail('[落地页检查] ' + AdsApp.currentAccount().getName() + '：' + fresh.length + ' 个新问题', '以下网址有新发现的问题：', rows, ss);
  });

  safe('使用说明', function () {
    writeGuide(ss, '落地页与缺货检查', VERSION, [
      ['检查范围', ['搜索广告', '关键字网址', '附加链接', 'PMax 素材资源组'].filter(function (_, i) { return [CONFIG.CHECK_ADS, CONFIG.CHECK_KEYWORDS, CONFIG.CHECK_SITELINKS, CONFIG.CHECK_PMAX][i]; }).join('、')],
      ['检查进度', '每 ' + CONFIG.DAYS_BETWEEN_FULL_CHECKS + ' 天完整检查一遍，每次最多 ' + CONFIG.MAX_FETCH_PER_RUN + ' 个网址；本轮还剩 ' + remaining + ' 个'],
      ['缺货判断', '网址包含「' + (CONFIG.PRODUCT_URL_PATTERN || '（所有页面）') + '」的页面，出现缺货文字或结构化数据 OutOfStock'],
      ['自动暂停', (CONFIG.PAUSE_OUT_OF_STOCK_ADS ? '缺货：开启' : '缺货：关闭') + '；' + (CONFIG.PAUSE_BROKEN_ADS ? '打不开：开启' : '打不开：关闭') + '（只处理搜索广告，标签「' + CONFIG.PAUSE_LABEL + '」）'],
      ['', ''],
      ['行动清单', '先看这里：打不开、缺货、跳转到首页的网址，按影响的广告数量排序'],
      ['检查结果', '每个网址的检查结果，可以按「状态」筛选'],
      ['注意', '脚本检查的是最终到达网址本身，不含跟踪模板和自定义参数；有的网站会拦截脚本访问（返回 403），这类结果需要人工确认；Shopping 商品的网址请用 Merchant Center 健康检查脚本']
    ]);
  });
  writeLog(ss);
  orderSheets(ss, ['使用说明', '行动清单', '检查结果', '运行日志']);
}


// ======================= 收集网址 =======================

function collectUrls() {
  var map = {};
  function add(url, place, adKey) {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    url = url.replace(/\{[^}]*\}/g, '').replace(/[?&]+$/, '');
    var x = map[url] || (map[url] = { places: [], ads: [] });
    if (x.places.length < 20 && x.places.indexOf(place) < 0) x.places.push(place);
    if (adKey) x.ads.push(adKey);
  }
  var en = ' AND campaign.status = "ENABLED"' + nameFilter();
  if (CONFIG.CHECK_ADS) (tryQuery('广告网址', 'SELECT campaign.name, ad_group.name, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, campaign.advertising_channel_type FROM ad_group_ad ' +
      'WHERE ad_group_ad.status = "ENABLED" AND ad_group.status = "ENABLED"' + en) || []).forEach(function (r) {
    var isSearch = g(r, 'campaign.advertisingChannelType') === 'SEARCH';
    (g(r, 'adGroupAd.ad.finalUrls') || []).forEach(function (u) {
      add(u, '广告：' + g(r, 'campaign.name') + ' / ' + g(r, 'adGroup.name'), isSearch ? g(r, 'adGroup.id') + '~' + g(r, 'adGroupAd.ad.id') : '');
    });
  });
  if (CONFIG.CHECK_KEYWORDS) (tryQuery('关键字网址', 'SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.final_urls FROM ad_group_criterion ' +
      'WHERE ad_group_criterion.status = "ENABLED" AND ad_group_criterion.type = "KEYWORD" AND ad_group.status = "ENABLED"' + en) || []).forEach(function (r) {
    (g(r, 'adGroupCriterion.finalUrls') || []).forEach(function (u) { add(u, '关键字：' + g(r, 'adGroupCriterion.keyword.text') + '（' + g(r, 'campaign.name') + '）'); });
  });
  if (CONFIG.CHECK_SITELINKS) {
    (tryQuery('附加链接', 'SELECT campaign.name, asset.sitelink_asset.link_text, asset.final_urls FROM campaign_asset WHERE campaign_asset.status = "ENABLED" AND asset.type = "SITELINK"' + en) || []).forEach(function (r) {
      (g(r, 'asset.finalUrls') || []).forEach(function (u) { add(u, '附加链接：' + g(r, 'asset.sitelinkAsset.linkText') + '（' + g(r, 'campaign.name') + '）'); });
    });
    (tryQuery('账户附加链接', 'SELECT asset.sitelink_asset.link_text, asset.final_urls FROM customer_asset WHERE customer_asset.status = "ENABLED" AND asset.type = "SITELINK"') || []).forEach(function (r) {
      (g(r, 'asset.finalUrls') || []).forEach(function (u) { add(u, '账户附加链接：' + g(r, 'asset.sitelinkAsset.linkText')); });
    });
  }
  if (CONFIG.CHECK_PMAX) (tryQuery('PMax 网址', 'SELECT campaign.name, asset_group.name, asset_group.final_urls FROM asset_group WHERE asset_group.status = "ENABLED"' + en) || []).forEach(function (r) {
    (g(r, 'assetGroup.finalUrls') || []).forEach(function (u) { add(u, 'PMax：' + g(r, 'campaign.name') + ' / ' + g(r, 'assetGroup.name')); });
  });
  return map;
}


// ======================= 检查一个网址 =======================

function check(url) {
  var r = { status: '正常', issue: '', code: '', final: url, hops: 0, secs: '', stock: '' };
  var cur = url, t0 = Date.now(), resp = null;
  try {
    for (var hop = 0; hop < 6; hop++) {
      resp = UrlFetchApp.fetch(cur, { muteHttpExceptions: true, followRedirects: false, validateHttpsCertificates: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdsLandingPageChecker/1.0)', 'Accept-Language': 'en' } });
      var code = resp.getResponseCode();
      if (code >= 300 && code < 400) {
        var h = resp.getHeaders(), loc = h.Location || h.location;
        if (!loc) break;
        cur = absolute(cur, String(loc)); r.hops++;
        continue;
      }
      break;
    }
  } catch (e) {
    r.status = '错误'; r.issue = '无法打开：' + String(e.message || e).slice(0, 120); r.secs = (Date.now() - t0) / 1000;
    return r;
  }
  r.secs = Math.round((Date.now() - t0) / 100) / 10;
  r.code = resp.getResponseCode(); r.final = cur;
  var issues = [];
  if (r.code >= 400) { r.status = '错误'; issues.push(r.code === 404 || r.code === 410 ? '页面不存在（' + r.code + '）' : r.code === 403 ? '拒绝访问（403，可能是网站拦截了脚本，请人工确认）' : 'HTTP ' + r.code); }
  else if (r.code >= 300) { r.status = '警告'; issues.push('跳转次数过多'); }
  if (r.hops) {
    var a = parse(url), b = parse(cur);
    if (a.host.replace(/^www\./, '') !== b.host.replace(/^www\./, '')) { if (r.status === '正常') r.status = '警告'; issues.push('跳转到其他域名：' + b.host); }
    else if (a.path.length > 1 && (b.path === '/' || b.path === '')) { if (r.status === '正常') r.status = '警告'; issues.push('跳转到了首页（商品或页面可能已下架）'); }
    else if (r.hops >= 2) issues.push('跳转 ' + r.hops + ' 次，建议直接使用最终网址');
  }
  if (r.code === 200) {
    var html = '';
    try { html = resp.getContentText().slice(0, 400000); } catch (e) { html = ''; }
    var title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1].replace(/\s+/g, ' ').trim();
    if (/\b404\b|not found|page not found|nicht gefunden|introuvable|no encontrada|non trovata|niet gevonden|見つかりません|页面不存在|找不到/i.test(title)) {
      r.status = '错误'; issues.push('页面能打开，但标题显示页面不存在：' + title.slice(0, 60));
    }
    var isProduct = !CONFIG.PRODUCT_URL_PATTERN || url.indexOf(CONFIG.PRODUCT_URL_PATTERN) >= 0 || cur.indexOf(CONFIG.PRODUCT_URL_PATTERN) >= 0;
    if (isProduct) {
      r.stock = stockOf(html);
      if (r.stock === '缺货') { if (r.status === '正常') r.status = '缺货'; issues.push('页面显示缺货'); }
    }
  }
  if (r.secs >= CONFIG.SLOW_SECONDS) { issues.push('打开用了 ' + r.secs + ' 秒'); if (r.status === '正常') r.status = '慢'; }
  r.issue = issues.join('；');
  return r;
}

// 先看结构化数据（最准确），再看页面文字
function stockOf(html) {
  if (/"availability"\s*:\s*"(https?:\/\/schema\.org\/)?(InStock|PreOrder|BackOrder|LimitedAvailability)"/i.test(html) ||
      /itemprop=["']availability["'][^>]*(InStock|PreOrder)/i.test(html)) return '有货';
  if (/"availability"\s*:\s*"(https?:\/\/schema\.org\/)?(OutOfStock|SoldOut|Discontinued)"/i.test(html) ||
      /itemprop=["']availability["'][^>]*(OutOfStock|SoldOut)/i.test(html) ||
      /property=["'](og|product):availability["'][^>]*content=["'](out of stock|oos|outofstock)/i.test(html)) return '缺货';
  var text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').toLowerCase();
  for (var i = 0; i < CONFIG.OUT_OF_STOCK_TEXT.length; i++) if (text.indexOf(String(CONFIG.OUT_OF_STOCK_TEXT[i]).toLowerCase()) >= 0) return '缺货';
  return '有货';
}

function parse(u) {
  var m = String(u).match(/^(https?):\/\/([^\/?#]+)([^?#]*)/i) || ['', '', '', ''];
  return { scheme: m[1], host: m[2].toLowerCase(), path: m[3] || '/' };
}
function absolute(base, loc) {
  if (/^https?:\/\//i.test(loc)) return loc;
  var b = parse(base);
  if (loc.indexOf('//') === 0) return b.scheme + ':' + loc;
  if (loc.charAt(0) === '/') return b.scheme + '://' + b.host + loc;
  return b.scheme + '://' + b.host + b.path.replace(/[^\/]*$/, '') + loc;
}


// ======================= 结果、暂停、行动清单 =======================

function cycleDate(ss) {
  var c = stateGet(ss, 'cycle');
  if (!c) return '0000-00-00';
  // 上一轮完成后，过 N 天开始新一轮
  var next = Utilities.formatDate(new Date(new Date(c + 'T12:00:00Z').getTime() + CONFIG.DAYS_BETWEEN_FULL_CHECKS * 864e5), 'UTC', 'yyyy-MM-dd');
  return next <= dayStr(0) ? next : c;
}

function readResults(ss) {
  var sh = ss.getSheetByName('检查结果'), map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, RESULT_HEAD.length).getValues().forEach(function (r) {
    if (!r[0] || r[1] === '待检查') return;
    map[String(r[0])] = { status: r[1], issue: r[2], code: r[3], final: r[4], hops: r[5], secs: r[6], stock: r[7], checked: String(r[10]) };
  });
  return map;
}

function writeResults(ss, results) {
  var rank = { '错误': 0, '缺货': 1, '警告': 2, '慢': 3, '待检查': 4, '正常': 5 };
  results.sort(function (a, b) { return (rank[a.status] - rank[b.status]) || (b.where.ads.length - a.where.ads.length); });
  write(ss, '检查结果', RESULT_HEAD, results.map(function (r) {
    return [r.url, r.status, r.issue, r.code, r.final === r.url ? '' : r.final, r.hops || '', r.secs, r.stock, r.where.places.join('\n'), r.where.ads.length || '', r.checked];
  }), ['', '', '', '', '', '', '0.0', '', '', FMT.int, '@'], { max: 40000, widths: [360, 70, 320, 70, 260, 60, 60, 50, 360],
    colors: { col: 1, fn: function (v) { return v === '错误' ? '#fde2e1' : v === '缺货' || v === '警告' ? '#fff1d6' : v === '正常' ? '#e3f4e8' : null; } } });
}

function pauseResume(results) {
  var out = { paused: 0, resumed: 0 };
  if (!CONFIG.PAUSE_OUT_OF_STOCK_ADS && !CONFIG.PAUSE_BROKEN_ADS) return out;
  ensureLabel(CONFIG.PAUSE_LABEL);
  var badKeys = [], okUrl = {};
  results.forEach(function (r) {
    var shouldPause = (CONFIG.PAUSE_OUT_OF_STOCK_ADS && r.status === '缺货') || (CONFIG.PAUSE_BROKEN_ADS && r.status === '错误' && r.code !== 403 && r.code !== '');
    if (shouldPause) badKeys = badKeys.concat(r.where.ads);
    else if (r.status === '正常' || r.status === '慢') okUrl[r.url] = 1;
  });
  // 暂停
  for (var i = 0; i < badKeys.length; i += 500) {
    var ids = badKeys.slice(i, i + 500).map(function (k) { var p = k.split('~'); return [Number(p[0]), Number(p[1])]; });
    var it = AdsApp.ads().withIds(ids).get();
    while (it.hasNext()) { var ad = it.next(); if (ad.isEnabled()) { ad.pause(); ad.applyLabel(CONFIG.PAUSE_LABEL); out.paused++; } }
  }
  // 恢复：带标签、且网址已经恢复正常的广告
  var it2 = AdsApp.ads().withCondition("LabelNames CONTAINS_ANY ['" + CONFIG.PAUSE_LABEL + "']").get();
  while (it2.hasNext()) {
    var a2 = it2.next(), urls = a2.urls().getFinalUrl ? [a2.urls().getFinalUrl()] : [];
    if (urls.length && okUrl[String(urls[0]).replace(/\{[^}]*\}/g, '').replace(/[?&]+$/, '')]) { a2.enable(); a2.removeLabel(CONFIG.PAUSE_LABEL); out.resumed++; }
  }
  log('信息', '自动暂停/恢复', (isPreview() ? '（预览模式不会真的修改）' : '') + '暂停 ' + out.paused + ' 个广告，恢复 ' + out.resumed + ' 个广告');
  return out;
}

function ensureLabel(name) {
  var it = AdsApp.labels().withCondition("Name = '" + name + "'").get();
  if (!it.hasNext()) AdsApp.createLabel(name, '由落地页检查脚本自动暂停的广告');
}

function buildActions(results, paused, remaining) {
  var A = [];
  function top(status, level, finding, advice) {
    var list = results.filter(function (r) { return r.status === status; }).sort(function (a, b) { return b.where.ads.length - a.where.ads.length; });
    if (!list.length) return;
    A.push([level, status, list.length + ' 个网址', finding, '影响 ' + list.reduce(function (s, r) { return s + r.where.places.length; }, 0) + ' 处广告/关键字/附加链接', advice]);
    list.slice(0, 15).forEach(function (r) { A.push([level, status, r.url, r.issue, r.where.places.slice(0, 3).join('；'), advice]); });
  }
  top('错误', '高', '页面打不开或不存在', '修复页面或把广告网址换成正常的页面；暂时修不好就暂停对应的广告');
  top('缺货', '高', '商品页显示缺货', '暂停对应的广告或换成同类有货商品；也可以打开 PAUSE_OUT_OF_STOCK_ADS 让脚本自动处理');
  top('警告', '中', '跳转到首页或其他域名', '跳到首页说明原页面可能已下架，换成正确的商品/分类页；跨域跳转请确认是否正常');
  top('慢', '低', '页面打开慢', '慢页面会拉低着陆页体验和转化率，优先压缩图片、减少第三方脚本');
  if (paused.paused || paused.resumed) A.push(['中', '自动处理', '—', '暂停 ' + paused.paused + ' 个广告，恢复 ' + paused.resumed + ' 个广告', '', '带标签「' + CONFIG.PAUSE_LABEL + '」的就是脚本处理过的广告']);
  if (remaining) A.push(['低', '进度', '—', '本轮还有 ' + remaining + ' 个网址没检查', '', '把脚本设为每小时运行，会自动接着检查']);
  return A;
}

function newProblems(ss, bad) {
  var sh = ss.getSheetByName('_已提醒') || ss.insertSheet('_已提醒');
  var n = sh.getLastRow(), seen = {};
  if (n) sh.getRange(1, 1, n, 1).getValues().forEach(function (r) { seen[String(r[0])] = 1; });
  var cur = bad.map(function (r) { return r.url + '|' + r.status; });
  var fresh = bad.filter(function (r, i) { return !seen[cur[i]]; });
  if (!isPreview()) {
    sh.clear();
    if (cur.length) { sh.getRange(1, 1, cur.length, 1).setNumberFormat('@'); sh.getRange(1, 1, cur.length, 1).setValues(cur.map(function (k) { return [k]; })); }
  }
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
