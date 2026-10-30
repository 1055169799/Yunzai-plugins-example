/**
 * Pixiv / B站 Cookie 登录插件
 *
 * 存放位置：
 *   Yunzai-Bot/plugins/example/cookie-login.js
 *
 * 功能：
 *   - #pixiv登录 / #p站登录
 *     在服务器桌面打开 Chrome，由用户手动完成 Pixiv 登录和 reCAPTCHA，
 *     插件抓取浏览器 cookie 并写入 sakura-plugin/config/pixiv.yaml。
 *   - #bili登录 / #b站登录 / #bili扫码登录 / #b站扫码登录
 *     生成 B站登录二维码，用户用 B站手机客户端扫码确认，
 *     插件轮询登录状态并把 cookie 写入 sakura-plugin/config/bilicookie.yaml。
 *
 * 说明：
 *   - B站扫码命令所有人可用；
 *   - Pixiv 浏览器登录仅 Bot 主人可用；
 *   - 不保存账号密码，只保存登录后的 cookie；
 *   - 需要 sakura-plugin、puppeteer、axios、yaml。
 */

import fs from "node:fs"
import path from "node:path"
import axios from "axios"
import YAML from "yaml"
import puppeteer from "puppeteer"
import plugin from "../../lib/plugins/plugin.js"
import { segment } from "oicq"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36"

const CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
const QR_SCAN_TIMEOUT = 3 * 60 * 1000
const PIXIV_LOGIN_TIMEOUT = 5 * 60 * 1000

const busy = new Set()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pluginConfigPath(name) {
  return path.join(process.cwd(), "plugins", "sakura-plugin", "config", name)
}

function readYaml(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件：${file}`)
  }
  return YAML.parse(fs.readFileSync(file, "utf8")) || {}
}

function writeYaml(file, data) {
  fs.writeFileSync(file, YAML.stringify(data), "utf8")
}

/** 将 sakura-plugin 的 cookie 写回配置，保留同一文件里的其他配置。 */
function saveSakuraCookie(fileName, cookie) {
  const file = pluginConfigPath(fileName)
  const data = readYaml(file)
  data.cookie = cookie
  writeYaml(file, data)
}

function proxyConfig(proxy) {
  if (!proxy) return false

  let value = String(proxy).trim()
  const lower = value.toLowerCase()
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    value = `http://${value}`
  }

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`代理配置格式错误：${proxy}`)
  }

  const protocol = url.protocol === "https:" ? "https" : "http"
  const port = Number(url.port || (protocol === "https" ? 443 : 80))
  if (!url.hostname || !port) {
    throw new Error(`代理配置缺少主机名或端口：${proxy}`)
  }

  const result = { host: url.hostname, port, protocol }
  if (url.username) {
    result.auth = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    }
  }
  return result
}

function browserProxyArg(proxy) {
  if (!proxy) return null
  let value = String(proxy).trim()
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  return `--proxy-server=${value}`
}

function cookieString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ")
}

function biliCookieFromUrl(url) {
  const parsed = new URL(url)
  const names = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3"]
  const parts = []
  for (const name of names) {
    const value = parsed.searchParams.get(name)
    if (value) parts.push(`${name}=${value}`)
  }
  return parts.join("; ")
}

/** B站扫码成功时，cookie 主要放在响应的 Set-Cookie 头里。 */
function biliCookieFromResponse(data, headers) {
  const cookies = new Map()

  // 兼容部分接口把 cookie 放在 data.url 查询参数里的情况
  if (data?.url) {
    try {
      const parsed = new URL(data.url)
      for (const name of [
        "SESSDATA",
        "bili_jct",
        "DedeUserID",
        "DedeUserID__ckMd5",
        "sid",
        "buvid3",
      ]) {
        const value = parsed.searchParams.get(name)
        if (value) cookies.set(name, value)
      }
    } catch {}
  }

  // 新接口通常通过 Set-Cookie 下发
  const raw = headers?.["set-cookie"]
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const line of list) {
    const first = String(line).split(";")[0]
    const index = first.indexOf("=")
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (name && value) cookies.set(name, value)
  }

  const names = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
  ]
  return names
    .filter(name => cookies.get(name))
    .map(name => `${name}=${cookies.get(name)}`)
    .join("; ")
}

async function launchBrowser({ headless = true, proxy } = {}) {
  const options = {
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }
  if (fs.existsSync(CHROME_PATH)) options.executablePath = CHROME_PATH

  const proxyArg = browserProxyArg(proxy)
  if (proxyArg) options.args.push(proxyArg)

  if (!headless) {
    options.defaultViewport = null
    options.args.push("--start-maximized")
  }

  return puppeteer.launch(options)
}

async function validatePixivCookie(cookie, proxy) {
  try {
    const response = await axios.get("https://www.pixiv.net/settings/profile", {
      headers: {
        Cookie: cookie,
        "User-Agent": USER_AGENT,
        Referer: "https://www.pixiv.net/",
      },
      proxy: proxyConfig(proxy),
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    return {
      ok: response.status === 200 && !response.headers.location,
      status: response.status,
    }
  } catch (error) {
    return { ok: false, status: error.response?.status, error: error.message }
  }
}

async function validateBiliCookie(cookie) {
  const response = await axios.get(
    "https://api.bilibili.com/x/web-interface/nav",
    {
      headers: {
        Cookie: cookie,
        "User-Agent": USER_AGENT,
        Referer: "https://www.bilibili.com/",
      },
      timeout: 20000,
    },
  )
  const data = response.data
  if (data?.code !== 0 || !data?.data?.isLogin) {
    throw new Error(`B站 Cookie 验证失败：${data?.message || data?.code || "未登录"}`)
  }
  return data.data
}

/** 只截取二维码区域，并返回页面实际使用的 qrcode_key。 */
async function renderBiliQrImage(qrUrl) {
  const browser = await launchBrowser({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 500, height: 500, deviceScaleFactor: 2 })

    // 关键：qrcode/generate 返回的 url 会重定向到 passport 登录页，
    // 登录页会自己生成一个新的 qrcode_key。必须以页面实际轮询的 key 为准。
    let actualKey = null
    page.on("request", request => {
      try {
        const url = new URL(request.url())
        if (url.pathname.includes("/qrcode/poll")) {
          const key = url.searchParams.get("qrcode_key")
          if (key) actualKey = key
        }
      } catch {}
    })

    await page.goto(qrUrl, { waitUntil: "networkidle2", timeout: 30000 })

    const keyDeadline = Date.now() + 10000
    while (!actualKey && Date.now() < keyDeadline) {
      await sleep(200)
    }
    if (!actualKey) {
      // 再从 performance 资源里兜底找一次
      const entries = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map(item => item.name)
          .filter(name => name.includes("/qrcode/poll")),
      )
      for (const name of entries) {
        try {
          const key = new URL(name).searchParams.get("qrcode_key")
          if (key) {
            actualKey = key
            break
          }
        } catch {}
      }
    }
    if (!actualKey) throw new Error("未能获取 B站登录页实际使用的二维码 key")

    // 页面里的二维码是 data:image/png;base64 的 img 元素
    const rect = await page.evaluate(() => {
      const img = [...document.querySelectorAll("img")].find(item =>
        (item.getAttribute("src") || "").startsWith("data:image"),
      )
      if (!img) return null
      const r = img.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })

    let buffer
    if (rect) {
      const margin = 10
      buffer = await page.screenshot({
        type: "png",
        clip: {
          x: Math.max(0, rect.x - margin),
          y: Math.max(0, rect.y - margin),
          width: rect.width + margin * 2,
          height: rect.height + margin * 2,
        },
      })
    } else {
      buffer = await page.screenshot({ type: "png", fullPage: true })
    }

    return { buffer, qrcodeKey: actualKey }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function createBiliQr(e, headers) {
  const generate = await axios.get(
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
    { headers, timeout: 20000 },
  )
  const qr = generate.data?.data
  if (!qr?.url) {
    throw new Error("B站二维码生成失败")
  }

  const { buffer, qrcodeKey } = await renderBiliQrImage(qr.url)
  await e.reply(
    [
      segment.image(buffer),
      "\n请使用 B站手机客户端扫描上方二维码。\n扫码后请在手机上点击“确认登录”，机器人会自动获取 cookie。",
    ],
    true,
  )

  return { ...qr, qrcode_key: qrcodeKey }
}

export class CookieLogin extends plugin {
  constructor() {
    super({
      name: "Pixiv/B站 Cookie 登录",
      dsc: "浏览器辅助登录 Pixiv，扫码登录 B站，并写入 sakura-plugin",
      event: "message",
      priority: 50,
      rule: [
        {
          reg: /^#?(pixiv|p站)登录$/i,
          fnc: "pixivLogin",
          permission: "master",
        },
        {
          reg: /^#?(bili|b站)(扫码)?登录$/i,
          fnc: "biliLogin",
          permission: "all",
        },
      ],
    })
  }

  async pixivLogin(e) {
    if (busy.has("pixiv")) {
      await e.reply("Pixiv 登录正在进行中，请先完成当前登录窗口")
      return false
    }

    busy.add("pixiv")
    let browser
    try {
      const config = readYaml(pluginConfigPath("pixiv.yaml"))
      await e.reply(
        "即将在服务器桌面打开 Pixiv 登录窗口。\n" +
          "请手动输入账号密码并完成 reCAPTCHA，登录成功跳转到 pixiv.net 后，插件会自动抓取 cookie。\n" +
          "不需要把密码发给机器人。",
        true,
      )

      browser = await launchBrowser({ headless: false, proxy: config.proxy })
      const page = await browser.newPage()
      page.setDefaultTimeout(60000)
      await page.goto("https://accounts.pixiv.net/login?lang=zh", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      await page.bringToFront()

      const deadline = Date.now() + PIXIV_LOGIN_TIMEOUT
      let cookies = []
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error("登录窗口被关闭")

        // 登录可能在同一页跳转，也可能打开新标签页；两种都检查
        const pages = await browser.pages()
        const pixivPage = pages.find(p =>
          p.url().startsWith("https://www.pixiv.net/"),
        )
        if (pixivPage) {
          cookies = await pixivPage.cookies()
          const hasSession = cookies.some(c => c.name === "PHPSESSID" && c.value)
          if (hasSession) break
        }
        await sleep(1000)
      }

      if (!cookies.some(c => c.name === "PHPSESSID" && c.value)) {
        throw new Error("登录超时，未检测到 Pixiv 登录 cookie")
      }

      const cookie = cookieString(cookies)
      const check = await validatePixivCookie(cookie, config.proxy)
      if (!check.ok) {
        logger.warn(`[Cookie登录] Pixiv cookie 验证返回 ${check.status || check.error}`)
      }

      saveSakuraCookie("pixiv.yaml", cookie)
      await e.reply(
        `Pixiv cookie 已写入 sakura-plugin/config/pixiv.yaml。\n` +
          `验证结果：${check.ok ? "有效" : `未通过（${check.status || check.error}），请实际搜图确认`}`,
        true,
      )
      return true
    } catch (error) {
      logger.error(`[Cookie登录] Pixiv 登录失败: ${error?.message || error}`)
      await e.reply(`Pixiv 登录失败：${error?.message || error}`, true)
      return false
    } finally {
      if (browser) await browser.close().catch(() => {})
      busy.delete("pixiv")
    }
  }

  async biliLogin(e) {
    if (busy.has("bili")) {
      await e.reply("B站扫码登录正在进行中，请先完成当前扫码")
      return false
    }

    busy.add("bili")
    try {
      const headers = {
        "User-Agent": USER_AGENT,
        Referer: "https://www.bilibili.com/",
      }

      let qr = await createBiliQr(e, headers)
      let deadline = Date.now() + QR_SCAN_TIMEOUT
      let lastStatus = null
      let refreshed = false

      while (Date.now() < deadline) {
        const poll = await axios.get(
          "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
          {
            params: { qrcode_key: qr.qrcode_key },
            headers,
            timeout: 20000,
          },
        )
        const data = poll.data?.data
        const status = Number(data?.code)

        if (status !== lastStatus) {
          logger.info(`[Cookie登录] B站二维码状态：${status || "未知"}`)
        }

        const cookie = biliCookieFromResponse(data, poll.headers)
        if (status === 0 || data?.url || cookie.includes("SESSDATA=")) {
          if (!cookie) throw new Error("B站登录成功，但没解析到 cookie")

          const user = await validateBiliCookie(cookie)
          saveSakuraCookie("bilicookie.yaml", cookie)
          await e.reply(
            `B站扫码登录成功，cookie 已写入 sakura-plugin/config/bilicookie.yaml。\n账号：${user.uname || user.mid || "未知"}`,
            true,
          )
          return true
        }

        if (status === 86090 && lastStatus !== 86090) {
          await e.reply("已扫码，请在手机 B站客户端上点击“确认登录”。", true)
        }
        if (status === 86038) {
          if (!refreshed) {
            refreshed = true
            await e.reply("二维码已过期，正在刷新，请重新扫描新二维码。", true)
            qr = await createBiliQr(e, headers)
            deadline = Date.now() + QR_SCAN_TIMEOUT
            lastStatus = null
            continue
          }
          throw new Error("二维码已过期，请重新发送 #b站扫码登录")
        }
        lastStatus = status
        await sleep(2000)
      }

      throw new Error("扫码超时，请重新发送 #b站扫码登录")
    } catch (error) {
      logger.error(`[Cookie登录] B站扫码登录失败: ${error?.message || error}`)
      await e.reply(`B站扫码登录失败：${error?.message || error}`, true)
      return false
    } finally {
      busy.delete("bili")
    }
  }
}
