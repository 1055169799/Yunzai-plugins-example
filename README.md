# Pixiv / B站 Cookie 登录插件

## 插件简介

这是 Yunzai-Bot 的一个辅助登录插件，用于把登录后的 Cookie 自动写入 `sakura-plugin`：

- **Pixiv**：在服务器桌面打开 Chrome，由用户手动登录并完成 reCAPTCHA，插件读取浏览器 Cookie 后写入 `sakura-plugin/config/pixiv.yaml`。
- **B站**：生成 B站登录二维码，用户用 B站手机客户端扫码并确认，插件轮询登录结果，将 Cookie 写入 `sakura-plugin/config/bilicookie.yaml`。

插件不保存账号密码，只保存登录后的 Cookie。

## 存放位置

```text
Yunzai-Bot/plugins/example/cookie-login.js
```

如果同时上传了说明文件，则说明文件位于：

```text
Yunzai-Bot/plugins/example/cookie-login.README.md
```

## 命令

### Pixiv

```text
#pixiv登录
#p站登录
```

仅 Bot 主人可用。

流程：

1. 插件在服务器桌面打开 Chrome；
2. 用户手动输入 Pixiv 账号密码并完成 reCAPTCHA；
3. 登录成功跳转到 `pixiv.net` 后，插件读取包含 HttpOnly Cookie 的完整登录态；
4. 自动写入 `sakura-plugin/config/pixiv.yaml`。

### B站

```text
#bili登录
#b站登录
#bili扫码登录
#b站扫码登录
```

所有人可用。

流程：

1. 插件申请 B站登录二维码，并截取二维码区域发送到当前私聊/群聊；
2. 用户使用 B站手机客户端扫码，并在手机上点击“确认登录”；
3. 插件轮询登录状态；
4. 登录成功后解析 `SESSDATA`、`bili_jct`、`DedeUserID` 等 Cookie；
5. 自动写入 `sakura-plugin/config/bilicookie.yaml`。

## 依赖

- Yunzai-Bot / TRSS-Yunzai
- `sakura-plugin`
- `puppeteer`
- `axios`
- `yaml`

Pixiv 浏览器登录需要服务器有可交互的桌面会话，否则无法打开 Chrome 登录窗口。

## 安全说明

- Cookie 等同于账号登录态，请勿把 `pixiv.yaml`、`bilicookie.yaml` 发给他人；
- B站扫码命令所有人可用，会覆盖 Bot 全局的 B站 Cookie，请只在可信群聊/私聊中开放；
- 插件不会保存账号密码。
