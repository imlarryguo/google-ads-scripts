# Google Ads 脚本库（毕瑞出海中文版）

19 个免费的 Google Ads 脚本，中文界面、中文报表，专为外贸企业和跨境电商账户编写。每个脚本的详细教程见 [berightdigital.com/google-ads-scripts](https://berightdigital.com/google-ads-scripts/)。

| 脚本 | 文件 | 解决什么问题 | 教程 |
|---|---|---|---|
| PMax 健康检查 | [pmax-health-check-v2.js](scripts/pmax-health-check-v2.js) | PMax 渠道拆分、素材、商品、搜索词当前表现 | [中文教程](https://berightdigital.com/pmax-script-tutorial/) |
| PMax 趋势与增量洞察 | [pmax-insights.js](scripts/pmax-insights.js) | PMax 是否抢了搜索广告、品牌流量占比、素材标签历史 | [中文教程](https://berightdigital.com/google-ads-pmax-insights-script/) |
| 搜索字词守卫 | [search-term-guard.js](scripts/search-term-guard.js) | 浪费字词、高 CPC、意外字词、N-gram，自动生成否定建议 | [中文教程](https://berightdigital.com/google-ads-search-term-guard-script/) |
| DSA / AI Max 流量分流 | [dsa-ai-max-traffic.js](scripts/dsa-ai-max-traffic.js) | 防止 DSA 和 AI Max 抢走完全匹配关键字的流量 | [中文教程](https://berightdigital.com/google-ads-dsa-ai-max-traffic-script/) |
| RSA 广告质量检查 | [rsa-quality.js](scripts/rsa-quality.js) | 广告效力、固定、重复标题、关键字覆盖、低效素材 | [中文教程](https://berightdigital.com/google-ads-rsa-quality-script/) |
| 质量得分追踪 | [quality-score-tracker.js](scripts/quality-score-tracker.js) | 每天记录质量得分三个组成部分，找出掉分关键字 | [中文教程](https://berightdigital.com/quality-score-tracker-script/) |
| Merchant Center 健康检查 | [merchant-center-health.js](scripts/merchant-center-health.js) | 拒登和受限商品、问题原因、影响转化的问题商品 | [中文教程](https://berightdigital.com/google-ads-merchant-center-health-script/) |
| 商品表现分层标签 | [product-tiers.js](scripts/product-tiers.js) | 英雄/潜力/吸金/僵尸商品分层，写入 custom_label | [中文教程](https://berightdigital.com/google-ads-product-tiers-script/) |
| 落地页与缺货检查 | [landing-page-checker.js](scripts/landing-page-checker.js) | 404、跳转首页、缺货页面，可自动暂停和恢复广告 | [中文教程](https://berightdigital.com/google-ads-landing-page-checker-script/) |
| 账户变更提醒 | [change-alerts-v2.js](scripts/change-alerts-v2.js) | 陌生人改动、自动应用的建议、高风险改动提醒 | [中文教程](https://berightdigital.com/google-ads-change-history-alerts/) |
| 账户异常监控 | [anomaly-monitor.js](scripts/anomaly-monitor.js) | 零展示、花费暴涨、转化跟踪失效每小时提醒 | [中文教程](https://berightdigital.com/google-ads-anomaly-alert-script/) |
| 预算节奏与调整 | [budget-pacing.js](scripts/budget-pacing.js) | 按月预算控制花费，预测超支，给出预算分配建议 | [中文教程](https://berightdigital.com/google-ads-budget-pacing-script/) |
| 盈亏平衡与目标 ROAS/CPA | [target-roas-breakeven.js](scripts/target-roas-breakeven.js) | 按毛利算目标，判断每个系列赚钱还是亏钱 | [中文教程](https://berightdigital.com/google-ads-target-roas-breakeven-script/) |
| 时段与星期分析 | [dayparting.js](scripts/dayparting.js) | 星期 × 小时热力图，自动换算目标市场当地时间 | [中文教程](https://berightdigital.com/google-ads-dayparting-script/) |
| 展示位置清理 | [placement-cleanup.js](scripts/placement-cleanup.js) | 游戏 App、儿童频道、垃圾网站排除列表 | [中文教程](https://berightdigital.com/google-ads-placement-cleanup-script/) |
| 国家地区与语言分析 | [geo-language.js](scripts/geo-language.js) | 花钱不转化的国家、定位外流量、语言设置 | [中文教程](https://berightdigital.com/google-ads-geo-language-script/) |
| 海外节假日与大促排期 | [holiday-budget.js](scripts/holiday-budget.js) | 黑五、圣诞、斋月、Prime Day 提醒和自动预算 | [中文教程](https://berightdigital.com/google-ads-holiday-budget-script/) |
| 多账户人民币汇总报表 | [mcc-cny-report.js](scripts/mcc-cny-report.js) | 经理账户多币种自动换算人民币日报 | [中文教程](https://berightdigital.com/google-ads-mcc-cny-report-script/) |
| 询盘质量与离线转化检查 | [offline-conversion-check.js](scripts/offline-conversion-check.js) | 转化设置、离线导入状态、询盘质量漏斗 | [中文教程](https://berightdigital.com/google-ads-offline-conversion-check-script/) |

## 使用方法

1. 打开 Google Ads → 工具 → 批量操作 → 脚本 → 新建脚本。
2. 把 `scripts/` 里对应文件的全部内容粘贴进去。
3. 修改开头 `CONFIG` 里的设置，授权，点「预览」。第一次运行会自动新建 Google 表格，网址在日志里，填回 `SPREADSHEET_URL`。
4. 设置运行频率。

默认只读取数据；需要修改账户的功能（自动加否定、自动暂停广告、自动调整预算）都要在设置里手动打开。

## 说明

- 部分脚本参考了 Mike Rhodes、Nils Rooijmans、Martin Roettgerding、Tibbe van Asten、Frederick Vallaeys、Francesco Cifardi、jack.tm、smarter ecommerce 等作者公开的思路，代码为重新编写。
- 脚本按「原样」提供，使用前请先在账户里预览确认。
- 问题反馈：在 Issues 里提交，附上表格「运行日志」里的错误行。
