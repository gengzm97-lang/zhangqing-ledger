# 账清 · GPT 业务记账

一款利润优先的个人记账 PWA，支持 GPT Plus、5x、20x 业务流水、客户充值习惯、个人支出，以及电脑与安卓手机自动同步。

## 在线使用

- [打开账清网页版](https://gengzm97-lang.github.io/zhangqing-ledger/)

## 功能

- 逐笔记录收入、成本和利润
- GPT Plus / 5x / 20x 项目利润统计
- 成品号 / 代充分类
- 客户来源、复购周期和回访提醒
- 个人支出独立账本
- 安卓 PWA 安装与离线使用
- Supabase 邮箱登录和多设备同步
- JSON 完整备份与 CSV 导出

## 数据与隐私

默认数据仅保存在浏览器。启用云同步后，账本保存到用户自行配置的 Supabase 项目，并通过邮箱登录和数据库 RLS 隔离。

仓库不包含任何真实订单、客户、个人支出、密码或私有密钥。前端只能配置 Supabase Publishable / anon key，绝不能使用 `service_role` key。

## 部署

数据库和手机安装步骤见 [PWA 云同步部署说明](PWA云同步部署说明.md)，数据库初始化脚本见 [supabase-setup.sql](supabase-setup.sql)。

