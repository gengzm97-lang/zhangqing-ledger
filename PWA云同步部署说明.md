# 账清：PWA 与云同步部署

程序已经具备离线安装、邮箱登录、电脑手机自动合并、断网后恢复同步等功能。真正启用需要一个 Supabase 项目和一个 HTTPS 静态网址。

## 一、创建 Supabase 数据库

1. 登录 [Supabase](https://supabase.com/) 并新建项目。
2. 打开项目的 **SQL Editor**。
3. 复制并运行 `supabase-setup.sql` 的全部内容。
4. 在项目 **Connect / API Keys** 中复制：
   - Project URL，格式为 `https://xxxxx.supabase.co`
   - Publishable key；旧项目也可使用 `anon` key
5. 绝对不要使用或泄露 `service_role` key。
6. 网页部署完成后，在 **Authentication → URL Configuration** 中把 Site URL 和 Redirect URL 设置为你的 HTTPS 软件地址，确保注册验证邮件能正确返回软件。

可以将以上两项直接填写到软件“数据管理 → 电脑与手机自动同步”，也可以写进 `cloud-config.js` 后再部署。

## 二、部署为 HTTPS 网页

可使用 GitHub Pages、Cloudflare Pages、Netlify 等静态托管。上传 `gpt-ledger` 文件夹中的全部文件，保持目录结构不变。

GitHub Pages 示例：

1. 新建 GitHub 仓库并上传本文件夹的全部内容。
2. 打开仓库 **Settings → Pages**。
3. 在 **Build and deployment** 中选择从分支部署，选择 `main` 和根目录。
4. 等待 GitHub 给出 `https://用户名.github.io/仓库名/` 地址。

## 三、首次登录与迁移数据

1. 先在电脑旧版“数据管理”中导出完整 JSON 备份。
2. 用新 HTTPS 地址打开软件；必要时先导入这份备份。
3. 进入“数据管理”，填写 Supabase 项目地址和 Publishable / anon key。
4. 注册邮箱账号；如 Supabase 开启邮箱验证，请点击验证邮件。
5. 登录后点击“立即同步”，本机数据会上传云端。
6. 安卓手机打开同一网址，使用同一邮箱登录，数据会自动出现。

## 四、安装到安卓桌面

在安卓 Chrome 打开 HTTPS 地址，点击右上角菜单，选择“添加到主屏幕”或“安装应用”。也可以在软件“数据管理”中点击“安装账清”。

## 同步规则与安全

- 每次新增、编辑或删除后约 1.2 秒自动同步。
- 离线时先写入本机，联网或重新打开时自动合并。
- 不同设备对同一条记录都做了修改时，以更新时间较新的版本为准。
- 删除记录会保留同步标记，避免在另一台设备重新出现。
- 前端仅可使用公开的 Publishable / anon key；数据库通过 RLS 限制每个用户只能访问自己的数据。
- 建议仍定期导出完整 JSON 备份。
