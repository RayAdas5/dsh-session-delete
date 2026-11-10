/**
 * dsh-session-delete —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 三块界面：
 *   1. 会话行「⋯」菜单里的「删除会话」（order 420，紧跟「归档会话」），点了先弹确认，
 *      确认后把会话移入回收站 —— 不是不可逆的一刀；
 *   2. 左侧全局面板的一行「会话回收站」（和 插件 / 自动化任务 并列）；
 *   3. 整页回收站：列表、展开看这个会话用过的附件、复原、永久删除（含附件）。
 *
 * 菜单与面板一律走官方 slot，不碰 DOM 注入：
 *   - 菜单   sidebar.workspaces.session.menu.item
 *   - 面板行 sidebar.panellist
 *   - 整页   main（key 与面板行 id 相同）
 * 快捷键走 ctx.shortcuts，且必须用 ctx.inject 等它注册完 —— apply 时它还没起来。
 */

window.__ModuleLoader__.load({
  // 必须与包名一致：DSH 会把旧包的 client bundle 也扫进同一个模块表，
  // 两个 bundle 用同一个 id 就是 "duplicate factory registration"，整条 web boot 失败。
  id: 'dsh-session-delete-next',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var ReactDOMClient = null
    try {
      ReactDOMClient = require('react-dom/client')
    } catch (e) {
      ReactDOMClient = null
    }

    var primitives = null
    try {
      var loaded = require('@deepseek-ai/dsh-client-ui-primitives')
      if (loaded !== null && typeof loaded === 'object') primitives = loaded
    } catch (e) {
      primitives = null
    }

    /** 取一个原语组件；宿主没提供时返回 null。 */
    function primitive(name) {
      if (primitives === null) return null
      var value = primitives[name]
      return typeof value === 'function' ? value : null
    }

    var API = '/session-delete'
    var MENU_LABEL = '删除会话'
    var PANEL_ID = 'session-delete-trash'
    var PANEL_LABEL = '会话回收站'
    var SHORTCUT_ID = 'session.delete'

    // ---- 请求 -------------------------------------------------------------

    /** 读 JSON；非 2xx 一律转成带 code 的 Error。 */
    function readResponse(response) {
      return response.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (e) {
          data = null
        }
        if (data !== null && data.ok === true) return data
        var error = new Error(failureText(data, response.status))
        error.code = data !== null && data !== undefined && typeof data.code === 'string' ? data.code : 'http-' + response.status
        throw error
      })
    }

    /**
     * 给请求加超时。DSH 的自定义协议在宿主刚起来时偶尔会让请求悬着不返回，
     * 没有超时的话设置页会永远停在「正在读取」。
     */
    function withTimeout(options) {
      var next = options || {}
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        next.signal = AbortSignal.timeout(8000)
      }
      return next
    }

    function postJson(path, body) {
      return fetch(API + path, withTimeout({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        cache: 'no-store',
      })).then(readResponse)
    }

    function getJson(path) {
      return fetch(API + path, withTimeout({ cache: 'no-store' })).then(readResponse)
    }

    /** 宿主错误码 → 中文提示。 */
    function failureText(data, status) {
      var code = data !== null && data !== undefined && typeof data.code === 'string' ? data.code : ''
      if (code === 'live') return '这个会话正在运行，先停止或等它跑完再删。'
      if (code === 'unknown') return '回收站里找不到这一条了，可能已经被删除。'
      if (code === 'conflict') return '原目录里已经有同名会话，不能复原。'
      if (code === 'move') return '文件移动失败，可能被占用，请稍后再试。'
      if (code === 'rm') return '删除文件失败，可能被占用，请稍后再试。'
      if (code === 'unsupported') return '无法确认这个会话的目录，为避免误删已拒绝。'
      if (code === 'storage') return '存储服务暂时不可用，请稍后再试。'
      if (code === 'unavailable') return '宿主缺少会话存储服务。'
      if (code === 'invalid') return '会话标识无效。'
      if (code === 'origin') return '请求被跨源保护拦下了，请刷新页面重试。'
      if (data !== null && data !== undefined && typeof data.error === 'string' && data.error !== '') return data.error
      return '操作失败（HTTP ' + status + '）。'
    }

    // ---- 格式化 -----------------------------------------------------------

    function formatBytes(bytes) {
      var n = Number(bytes)
      if (!isFinite(n) || n <= 0) return '0 B'
      var units = ['B', 'KB', 'MB', 'GB', 'TB']
      var index = 0
      while (n >= 1024 && index < units.length - 1) {
        n /= 1024
        index += 1
      }
      return (index === 0 ? String(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + units[index]
    }

    function formatRelative(ms) {
      var value = Number(ms)
      if (!isFinite(value) || value <= 0) return '—'
      var delta = Date.now() - value
      if (delta < 60 * 1000) return '刚刚'
      if (delta < 3600 * 1000) return Math.floor(delta / 60000) + ' 分钟前'
      if (delta < 86400 * 1000) return Math.floor(delta / 3600000) + ' 小时前'
      if (delta < 30 * 86400 * 1000) return Math.floor(delta / 86400000) + ' 天前'
      var date = new Date(value)
      var pad = function (x) { return x < 10 ? '0' + x : String(x) }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    }

    /** 目录只显示最后一段，避免长路径撑爆行宽。 */
    function shortDir(path) {
      if (typeof path !== 'string' || path === '') return ''
      var parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : path
    }

    function mediaLabel(mediaType) {
      if (typeof mediaType !== 'string' || mediaType === '') return '文件'
      if (mediaType.indexOf('image/') === 0) return '图片'
      if (mediaType.indexOf('video/') === 0) return '视频'
      if (mediaType.indexOf('audio/') === 0) return '音频'
      if (mediaType.indexOf('text/') === 0) return '文本'
      return '文件'
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      // 通用
      '.dsd-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:24px 28px 18px;gap:14px;overflow:auto;color:var(--dsw-alias-label-primary,#eceef2);font-family:var(--dsw-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13.5px;line-height:1.6;}',
      '.dsd-page-head{display:flex;align-items:baseline;gap:12px;flex:0 0 auto;}',
      '.dsd-page-title{margin:0;font-size:20px;font-weight:650;letter-spacing:.2px;}',
      '.dsd-page-count{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#8b8f98);font-variant-numeric:tabular-nums;}',
      '.dsd-page-sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#b6bac2);flex:0 0 auto;}',
      '.dsd-refresh{margin-left:auto;font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-2,#26282d);color:var(--dsw-alias-label-primary,#eceef2);cursor:pointer;}',
      '.dsd-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,#2f3238);}',
      '.dsd-refresh:disabled{opacity:.5;cursor:default;}',
      '.dsd-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:13px;padding:40px 0;}',
      '.dsd-empty-icon{opacity:.5;}',
      '.dsd-list{display:flex;flex-direction:column;gap:10px;flex:0 0 auto;}',
      '.dsd-item{border:1px solid var(--dsw-alias-border-l1,#33363c);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1e2024);overflow:hidden;}',
      '.dsd-item-head{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:11px 14px;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
      '.dsd-item-head:hover{background:var(--dsw-alias-bg-layer-2,#26282d);}',
      '.dsd-caret{flex:0 0 auto;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8b8f98);transition:transform .15s ease;}',
      '.dsd-caret-open{transform:rotate(90deg);}',
      '.dsd-item-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13.5px;}',
      '.dsd-item-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:12px;}',
      '.dsd-badge{flex:0 0 auto;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);color:var(--dsw-alias-label-secondary,#b6bac2);}',
      '.dsd-item-body{border-top:1px solid var(--dsw-alias-border-l1,#33363c);padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2,#26282d);}',
      '.dsd-section-label{font-size:11.5px;letter-spacing:.3px;color:var(--dsw-alias-label-tertiary,#8b8f98);}',
      '.dsd-att{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1e2024);border:1px solid var(--dsw-alias-border-l1,#33363c);font-size:12px;}',
      '.dsd-att-kind{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f98);}',
      '.dsd-att-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#b6bac2);}',
      '.dsd-att-size{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#8b8f98);font-variant-numeric:tabular-nums;}',
      '.dsd-att-none{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8f98);}',
      '.dsd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dsd-btn{font:inherit;font-size:12.5px;padding:5px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-2,#26282d);color:var(--dsw-alias-label-primary,#eceef2);cursor:pointer;transition:background-color .15s ease,opacity .15s ease;}',
      '.dsd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,#2f3238);}',
      '.dsd-btn:disabled{opacity:.5;cursor:default;}',
      '.dsd-btn-danger{color:var(--dsw-alias-state-error-primary,#f26d6d);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 45%,transparent);}',
      '.dsd-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 12%,transparent);}',
      // 主按钮刻意用固定的蓝底白字：宿主的 --dsw-alias-brand-primary 在深色主题里
      // 是白色，拿它当填充色会得到「白底白字」，鼠标不放上去就是一团白。
      '.dsd-btn-primary{background:#2f6fed;border-color:#2f6fed;color:#fff;font-weight:600;}',
      '.dsd-btn-primary:hover:not(:disabled){background:#3b7bff;border-color:#3b7bff;color:#fff;}',
      '.dsd-btn-primary:disabled{color:#fff;}',
      '.dsd-footer .dsd-btn-danger{background:var(--dsw-alias-bg-layer-2,#26282d);}',
      '.dsd-notice{font-size:12.5px;padding:9px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#33363c);background:var(--dsw-alias-bg-layer-2,#26282d);color:var(--dsw-alias-label-secondary,#b6bac2);}',
      '.dsd-error{font-size:12.5px;padding:9px 12px;border-radius:9px;color:var(--dsw-alias-state-error-primary,#f26d6d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 30%,transparent);}',

      // 确认对话框
      '.dsd-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.48);padding:24px;box-sizing:border-box;}',
      // 半透明是故意的：卡片跟宿主一样浮在内容之上。但光有透明会把后面的正文
      // 透成一片糊字，所以叠一层 backdrop-filter 做毛玻璃 —— 透明保留，可读性也在。
      '.dsd-card{width:min(460px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#1e2024);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25);color:var(--dsw-alias-label-primary,#eceef2);border:1px solid var(--dsw-alias-border-l2,#3a3d44);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.5);padding:20px 20px 16px;font-family:var(--dsw-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13.5px;line-height:1.65;}',
      '.dsd-title{margin:0 0 6px;font-size:15px;font-weight:650;letter-spacing:.2px;}',
      '.dsd-body{margin:0;color:var(--dsw-alias-label-secondary,#b6bac2);}',
      '.dsd-target{margin:12px 0 0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#26282d);border:1px solid var(--dsw-alias-border-l1,#33363c);font-size:12.5px;color:var(--dsw-alias-label-primary,#eceef2);word-break:break-all;}',
      '.dsd-hint{margin:12px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b8f98);}',
      '.dsd-dialog-error{margin:12px 0 0;padding:9px 12px;border-radius:9px;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#f26d6d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 30%,transparent);}',
      '.dsd-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:16px;}',
      '.dsd-footer .dsd-btn{padding:6px 14px;}',

      // 提示条
      '.dsd-toast-host{position:fixed;top:16px;left:0;right:0;display:flex;justify-content:center;pointer-events:none;z-index:2147483001;}',
      '.dsd-toast{display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 40px));padding:9px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1e2024);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25);border:1px solid var(--dsw-alias-border-l2,#3a3d44);color:var(--dsw-alias-label-primary,#eceef2);box-shadow:0 12px 32px rgba(0,0,0,.4);font-family:var(--dsw-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);font-size:12.5px;pointer-events:auto;animation:dsd-toast-in .18s ease-out;}',
      '.dsd-toast-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary,#3fbf7f);}',
      '@keyframes dsd-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',

      // 设置页
      '.dsd-settings{display:flex;flex-direction:column;gap:16px;max-width:720px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#eceef2);font-family:var(--dsw-font-family-sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);font-size:13.5px;line-height:1.65;}',
      '.dsd-settings-head{display:flex;align-items:flex-start;gap:12px;}',
      '.dsd-settings-version{flex:0 0 auto;margin-left:auto;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);color:var(--dsw-alias-label-tertiary,#8b8f98);font-variant-numeric:tabular-nums;}',
      '.dsd-settings-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;}',
      '.dsd-settings-sub{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#b6bac2);}',
      // overflow 必须放行：保留时长的下拉是绝对定位的，面板裁剪会把菜单切掉。
      // 圆角改由表头和最后一行各自负责。
      '.dsd-panel{border:1px solid var(--dsw-alias-border-l1,#33363c);border-radius:12px;overflow:visible;background:var(--dsw-alias-bg-layer-1,#1e2024);}',
      '.dsd-panel-head{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#33363c);background:var(--dsw-alias-bg-layer-2,#26282d);border-radius:11px 11px 0 0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bac2);}',
      '.dsd-setting-row{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#33363c);}',
      '.dsd-setting-row:last-child{border-bottom:0;border-radius:0 0 11px 11px;}',
      '.dsd-setting-label{flex:1 1 auto;min-width:0;}',
      '.dsd-setting-name{font-size:13px;}',
      '.dsd-setting-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b8f98);margin-top:2px;line-height:1.5;}',
      '.dsd-setting-control{flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
      // 自绘下拉：原生 <select> 的展开层由 OS 绘制，CSS 管不到，在深色主题里就是
      // 一块灰白板子。这里用按钮 + 绝对定位列表自己画。
      '.dsd-select-wrap{position:relative;flex:0 0 auto;}',
      '.dsd-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:116px;font:inherit;font-size:12.5px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-2,#26282d);color:var(--dsw-alias-label-primary,#eceef2);cursor:pointer;transition:background-color .15s ease,border-color .15s ease;}',
      '.dsd-select-trigger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3,#2f3238);border-color:var(--dsw-alias-border-l2,#4a4d55);}',
      '.dsd-select-trigger:disabled{opacity:.5;cursor:default;}',
      '.dsd-select-caret{font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary,#8b8f98);}',
      '.dsd-select-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:60;min-width:140px;box-sizing:border-box;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-1,#1e2024);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25);box-shadow:0 16px 40px rgba(0,0,0,.5);animation:dsd-menu-in .12s ease-out;}',
      '.dsd-select-option{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:12.5px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#eceef2);cursor:pointer;}',
      '.dsd-select-option:hover{background:var(--dsw-alias-bg-layer-3,#2f3238);}',
      '.dsd-select-option-active{color:#9ec2ff;background:color-mix(in srgb,#2f6fed 22%,transparent);}',
      '@keyframes dsd-menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
      '.dsd-switch{position:relative;width:38px;height:22px;flex:0 0 auto;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-3,#2f3238);cursor:pointer;transition:background-color .16s ease,border-color .16s ease;padding:0;}',
      '.dsd-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary,#b6bac2);transition:transform .16s ease,background-color .16s ease;}',
      '.dsd-switch-on{background:#2f6fed;border-color:#2f6fed;}',
      '.dsd-switch-on::after{transform:translateX(16px);background:#fff;}',
      '.dsd-switch:disabled{opacity:.5;cursor:default;}',
      '.dsd-kbd{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d44);background:var(--dsw-alias-bg-layer-2,#26282d);color:var(--dsw-alias-label-primary,#eceef2);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);}',
      '.dsd-kbd-empty{color:var(--dsw-alias-label-tertiary,#8b8f98);font-family:inherit;}',
      '.dsd-kbd-recording{border-color:#2f6fed;color:#9ec2ff;animation:dsd-pulse 1.2s ease-in-out infinite;}',
      '@keyframes dsd-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.dsd-setting-msg{font-size:12px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1,#33363c);}',
      '.dsd-setting-msg-ok{color:var(--dsw-alias-state-success-primary,#3fbf7f);}',
      '.dsd-setting-msg-err{color:var(--dsw-alias-state-error-primary,#f26d6d);}',
      '.dsd-settings-error{margin:0;padding:10px 13px;border-radius:9px;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#f26d6d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#f26d6d) 30%,transparent);}',

      // 兜底配色（宿主没给设计令牌时）
      '@supports not (color:var(--dsw-alias-label-primary)){.dsd-card,.dsd-toast,.dsd-item{background:#1e2024;color:#eceef2;border-color:#3a3d44}.dsd-body,.dsd-att-name{color:#b6bac2}.dsd-target,.dsd-item-body,.dsd-att,.dsd-notice{background:#26282d;border-color:#33363c}.dsd-btn{background:#26282d;color:#eceef2;border-color:#3a3d44}.dsd-btn-primary{background:#4c8dff;color:#fff}.dsd-btn-danger{color:#f26d6d}}',
    ].join('')

    // ---- 宿主容器 ---------------------------------------------------------

    var dialogHost = null
    var toastHost = null
    var toastSeq = 0

    function ensureDialogHost() {
      if (ReactDOMClient === null) return null
      var existing = document.querySelectorAll('.dsd-dlg-host')
      for (var i = 1; i < existing.length; i += 1) existing[i].remove()
      if (dialogHost !== null && dialogHost.container.isConnected) return dialogHost
      var container = existing.length > 0 ? existing[0] : document.createElement('div')
      if (existing.length === 0) {
        container.className = 'dsd-dlg-host'
        document.body.appendChild(container)
      }
      dialogHost = { container: container, root: ReactDOMClient.createRoot(container) }
      return dialogHost
    }

    function ensureToastHost() {
      if (ReactDOMClient === null) return null
      var existing = document.querySelectorAll('.dsd-toast-host')
      for (var i = 1; i < existing.length; i += 1) existing[i].remove()
      if (toastHost !== null && toastHost.container.isConnected) return toastHost
      var container = existing.length > 0 ? existing[0] : document.createElement('div')
      if (existing.length === 0) {
        container.className = 'dsd-toast-host'
        document.body.appendChild(container)
      }
      toastHost = { container: container, root: ReactDOMClient.createRoot(container) }
      return toastHost
    }

    function showToast(text) {
      var host = ensureToastHost()
      if (host === null) return
      toastSeq += 1
      host.root.render(h('div', { className: 'dsd-toast', role: 'status' }, [
        h('span', { key: 'd', className: 'dsd-toast-dot', 'aria-hidden': 'true' }),
        h('span', { key: 't' }, text),
      ]))
      var mine = toastSeq
      setTimeout(function () {
        if (toastSeq !== mine) return
        host.root.render(null)
      }, 3600)
    }

    // ---- 确认对话框（移入回收站 / 直接删除） --------------------------------

    function TrashConfirmDialog(props) {
      var viewState = useState({ busy: null, error: null })
      var view = viewState[0]
      var setView = viewState[1]
      var aliveRef = useRef(true)

      useEffect(function () {
        aliveRef.current = true
        function onKey(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (view.busy === null) props.onClose()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return function () {
          aliveRef.current = false
          document.removeEventListener('keydown', onKey, true)
        }
      }, [view.busy])

      function close() {
        if (view.busy === null) props.onClose()
      }

      function confirmTrash() {
        setView({ busy: 'trash', error: null })
        postJson('/trash', { sessionId: props.sessionId, title: props.title })
          .then(function (result) {
            if (!aliveRef.current) return
            props.onDone(result)
          })
          .catch(function (error) {
            if (!aliveRef.current) return
            setView({ busy: null, error: error && error.message ? error.message : '移入回收站失败' })
          })
      }

      /**
       * 直接删除 = 移入回收站 + 立刻永久删除。
       *
       * 分两步而不是新加一个 host 路由，是为了不必重启 DSH：现有两段路由已经能
       * 完整表达「删掉它，包括只有它引用的附件」。第二步失败时会话留在回收站里，
       * 用户还能从那里再删一次，比卡在半路强。
       */
      function confirmDirect() {
        setView({ busy: 'direct', error: null })
        postJson('/trash', { sessionId: props.sessionId, title: props.title })
          .then(function (trashed) {
            return postJson('/purge', { trashId: trashed.trashId }).then(function (purged) {
              return purged
            })
          })
          .then(function (result) {
            if (!aliveRef.current) return
            props.onDirectDone(result)
          })
          .catch(function (error) {
            if (!aliveRef.current) return
            var message = error && error.message ? error.message : '直接删除失败'
            setView({
              busy: null,
              error: message + '\n若会话已经进了回收站，可以在「会话回收站」里再删一次。',
            })
          })
      }

      var title = props.title !== '' ? props.title : '未命名会话'
      var content = [
        h('h2', { key: 't', id: 'dsd-dlg-title', className: 'dsd-title' }, '删除会话'),
        h('p', { key: 'b', className: 'dsd-body' }, '选择处理方式。'),
        h('div', { key: 'n', className: 'dsd-target' }, title),
        h('p', { key: 'h1', className: 'dsd-hint' }, '移入回收站：可以随时复原，也能展开查看它用过的附件。'),
        h('p', { key: 'h2', className: 'dsd-hint', style: { marginTop: '4px' } }, '直接删除：立刻从磁盘移除（含只有它引用的附件），无法恢复。'),
      ]
      if (view.error !== null) {
        content.push(h('p', { key: 'e', className: 'dsd-dialog-error', role: 'alert' }, view.error))
      }
      content.push(h('div', { key: 'f', className: 'dsd-footer' }, [
        h('button', {
          key: 'c',
          type: 'button',
          className: 'dsd-btn',
          disabled: view.busy !== null,
          onClick: close,
        }, '取消'),
        h('button', {
          key: 'd',
          type: 'button',
          className: 'dsd-btn dsd-btn-danger',
          disabled: view.busy !== null,
          onClick: confirmDirect,
        }, view.busy === 'direct' ? '删除中…' : '直接删除'),
        h('button', {
          key: 't',
          type: 'button',
          className: 'dsd-btn dsd-btn-primary',
          disabled: view.busy !== null,
          onClick: confirmTrash,
        }, view.busy === 'trash' ? '移入中…' : '移入回收站'),
      ]))

      return h('div', {
        className: 'dsd-overlay',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) close()
        },
      }, h('div', {
        className: 'dsd-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsd-dlg-title',
      }, content))
    }

    function openTrashConfirm(sessionId, title) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      var host = ensureDialogHost()
      if (host === null) {
        var ok = typeof window.confirm === 'function'
          ? window.confirm('把会话「' + (title || '未命名会话') + '」移入回收站？')
          : false
        if (!ok) return
        postJson('/trash', { sessionId: sessionId, title: title })
          .then(function () { showToast('已移入回收站「' + (title || '未命名会话') + '」') })
          .catch(function (error) { window.alert(error && error.message ? error.message : '移入回收站失败') })
        return
      }
      host.root.render(h(TrashConfirmDialog, {
        sessionId: sessionId,
        title: typeof title === 'string' ? title : '',
        onClose: function () { host.root.render(null) },
        onDone: function (result) {
          host.root.render(null)
          showToast('已移入回收站「' + (title || '未命名会话') + '」' + (result.attachments > 0 ? '，含 ' + result.attachments + ' 个附件' : ''))
        },
        onDirectDone: function (result) {
          host.root.render(null)
          var extra = result !== null && result !== undefined && result.removedAttachments > 0
            ? '，含 ' + result.removedAttachments + ' 个附件'
            : ''
          showToast('已永久删除「' + (title || '未命名会话') + '」' + extra)
        },
      }))
    }

    // ---- 会话行菜单项 -----------------------------------------------------

    function DeleteSessionMenuItem(props) {
      var setMenuOpen = function () {}
      if (typeof props.useMenuOpenState === 'function') {
        var menuState = props.useMenuOpenState()
        if (menuState !== null && menuState !== undefined && typeof menuState[1] === 'function') {
          setMenuOpen = menuState[1]
        }
      }

      var shortcut
      if (typeof props.useShortcuts === 'function') {
        shortcut = props.useShortcuts(function (rows) {
          if (!Array.isArray(rows)) return undefined
          for (var i = 0; i < rows.length; i += 1) {
            if (rows[i] !== null && rows[i] !== undefined && rows[i].id === SHORTCUT_ID) return rows[i]
          }
          return undefined
        })
      }

      var Icon = primitive('IconTrashOutlineRegular')
      var MenuItemButton = primitive('MenuItemButton')

      function onSelect() {
        setMenuOpen(false)
        openTrashConfirm(props.sessionId, props.displayTitle)
      }

      if (MenuItemButton === null) {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          'aria-keyshortcuts': shortcut !== undefined && shortcut !== null ? shortcut.aria : undefined,
          onClick: onSelect,
          style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'transparent', border: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' },
        }, MENU_LABEL)
      }

      return h(MenuItemButton, {
        icon: Icon !== null ? h(Icon, { size: 14 }) : undefined,
        shortcut: shortcut,
        danger: true,
        onSelect: onSelect,
      }, MENU_LABEL)
    }

    // ---- 侧栏面板图标 -----------------------------------------------------

    function TrashPanelIcon(props) {
      var size = props !== null && props !== undefined && props.size ? props.size : 16
      var Icon = primitive('IconTrashOutlineRegular')
      if (Icon !== null) return h(Icon, { size: size })
      return h('span', {
        style: { display: 'inline-block', width: size, height: size, borderRadius: 2, border: '1.5px solid currentColor' },
        'aria-hidden': 'true',
      })
    }

    // ---- 回收站整页 -------------------------------------------------------

    function TrashPage() {
      var dataState = useState({ status: 'loading', error: null, entries: [], totalBytes: 0 })
      var data = dataState[0]
      var setData = dataState[1]

      var expandedState = useState({})
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]

      var busyState = useState({})
      var busy = busyState[0]
      var setBusy = busyState[1]

      var confirmState = useState({})
      var confirming = confirmState[0]
      var setConfirming = confirmState[1]

      var noticeState = useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      var aliveRef = useRef(true)

      function load() {
        setData(function (prev) { return { status: 'loading', error: null, entries: prev.entries, totalBytes: prev.totalBytes } })
        getJson('/trash')
          .then(function (result) {
            if (!aliveRef.current) return
            setData({ status: 'ready', error: null, entries: Array.isArray(result.entries) ? result.entries : [], totalBytes: result.totalBytes || 0 })
          })
          .catch(function (error) {
            if (!aliveRef.current) return
            setData({ status: 'error', error: error && error.message ? error.message : '读取回收站失败', entries: [], totalBytes: 0 })
          })
      }

      useEffect(function () {
        aliveRef.current = true
        load()
        return function () { aliveRef.current = false }
      }, [])

      function toggle(trashId) {
        setExpanded(function (prev) {
          var next = {}
          for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
          next[trashId] = !prev[trashId]
          return next
        })
      }

      function setBusyFor(trashId, value) {
        setBusy(function (prev) {
          var next = {}
          for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
          if (value === null) delete next[trashId]
          else next[trashId] = value
          return next
        })
      }

      function clearConfirm(trashId) {
        setConfirming(function (prev) {
          var next = {}
          for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
          delete next[trashId]
          return next
        })
      }

      function restore(entry) {
        setBusyFor(entry.trashId, 'restore')
        setNotice(null)
        postJson('/restore', { trashId: entry.trashId })
          .then(function () {
            if (!aliveRef.current) return
            setBusyFor(entry.trashId, null)
            setNotice('已复原「' + entry.title + '」。回到侧边栏即可看到它（若没出现，刷新一下页面）。')
            load()
          })
          .catch(function (error) {
            if (!aliveRef.current) return
            setBusyFor(entry.trashId, null)
            setNotice(null)
            setData(function (prev) {
              return { status: 'error', error: error && error.message ? error.message : '复原失败', entries: prev.entries, totalBytes: prev.totalBytes }
            })
          })
      }

      function purge(entry) {
        setBusyFor(entry.trashId, 'purge')
        setNotice(null)
        postJson('/purge', { trashId: entry.trashId })
          .then(function (result) {
            if (!aliveRef.current) return
            setBusyFor(entry.trashId, null)
            clearConfirm(entry.trashId)
            var extra = result.removedAttachments > 0
              ? '，连同 ' + result.removedAttachments + ' 个独占附件'
              : ''
            setNotice('已永久删除「' + entry.title + '」' + extra + '，释放 ' + formatBytes(result.freedBytes || 0) + '。')
            load()
          })
          .catch(function (error) {
            if (!aliveRef.current) return
            setBusyFor(entry.trashId, null)
            setNotice(null)
            setData(function (prev) {
              return { status: 'error', error: error && error.message ? error.message : '永久删除失败', entries: prev.entries, totalBytes: prev.totalBytes }
            })
          })
      }

      function renderAttachmentRow(entry, item, index) {
        return h('div', { key: entry.trashId + '-' + index, className: 'dsd-att' }, [
          h('span', { key: 'k', className: 'dsd-att-kind' }, mediaLabel(item.mediaType)),
          h('span', { key: 'n', className: 'dsd-att-name', title: item.name || '' }, item.name || '（未命名附件）'),
          h('span', { key: 's', className: 'dsd-att-size' }, formatBytes(item.bytes || 0)),
        ])
      }

      function renderEntry(entry) {
        var open = expanded[entry.trashId] === true
        var working = busy[entry.trashId]
        var asking = confirming[entry.trashId] === true
        var attachments = Array.isArray(entry.attachments) ? entry.attachments : []
        var deliverables = Array.isArray(entry.deliverables) ? entry.deliverables : []
        var totalCount = attachments.length + deliverables.length
        var countLabel = totalCount === 0
          ? '0 个文件'
          : attachments.length > 0 && deliverables.length > 0
            ? attachments.length + ' 附件 · ' + deliverables.length + ' 交付物'
            : attachments.length > 0
              ? attachments.length + ' 个附件'
              : deliverables.length + ' 个交付物'

        var head = h('button', {
          key: 'head',
          type: 'button',
          className: 'dsd-item-head',
          'aria-expanded': open,
          onClick: function () { toggle(entry.trashId) },
        }, [
          h('span', { key: 'c', className: 'dsd-caret' + (open ? ' dsd-caret-open' : ''), 'aria-hidden': 'true' }, '▸'),
          h('span', { key: 't', className: 'dsd-item-title', title: entry.title || '' }, entry.title || '未命名会话'),
          h('span', { key: 'm', className: 'dsd-item-meta', title: entry.originalDir || '' },
            formatRelative(entry.deletedAt) + ' · ' + formatBytes(entry.sizeBytes) + ' · ' + shortDir(entry.originalDir)),
          h('span', { key: 'b', className: 'dsd-badge' }, countLabel),
        ])

        var children = [head]
        if (open) {
          var body = [
            h('div', { key: 'l', className: 'dsd-section-label' }, '这个会话用过的附件'),
          ]
          if (attachments.length === 0) {
            body.push(h('div', { key: 'none', className: 'dsd-att-none' }, '没有记录到附件。'))
          } else {
            for (var i = 0; i < attachments.length; i += 1) {
              body.push(renderAttachmentRow(entry, attachments[i], i))
            }
          }
          body.push(h('div', { key: 'dl', className: 'dsd-section-label', style: { marginTop: '4px' } }, '这个会话交付过的文件'))
          if (deliverables.length === 0) {
            body.push(h('div', { key: 'nodl', className: 'dsd-att-none' }, '没有记录到交付物。'))
          } else {
            for (var d = 0; d < deliverables.length; d += 1) {
              var item = deliverables[d] || {}
              body.push(h('div', { key: 'dl' + d, className: 'dsd-att' }, [
                h('span', { key: 'k', className: 'dsd-att-kind' }, '文件'),
                h('span', {
                  key: 'n',
                  className: 'dsd-att-name',
                  title: item.path || '',
                }, item.name || item.path || '（未命名文件）'),
                h('span', { key: 's', className: 'dsd-att-size' }, item.description || ''),
              ]))
            }
            body.push(h('div', {
              key: 'dlnote',
              className: 'dsd-att-none',
              style: { marginTop: '2px' },
            }, '交付物是工作区里的普通文件，删除会话不会删除它们。'))
          }
          body.push(h('div', { key: 'a', className: 'dsd-actions' }, [
            h('button', {
              key: 'r',
              type: 'button',
              className: 'dsd-btn',
              disabled: working !== undefined,
              onClick: function () { restore(entry) },
            }, working === 'restore' ? '复原中…' : '复原'),
            asking
              ? h('span', { key: 'ask', style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, [
                  h('span', { key: 'q', style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary,#8b8f98)' } }, '连同附件一起永久删除？'),
                  h('button', {
                    key: 'yes',
                    type: 'button',
                    className: 'dsd-btn dsd-btn-danger',
                    disabled: working !== undefined,
                    onClick: function () { purge(entry) },
                  }, working === 'purge' ? '删除中…' : '确认删除'),
                  h('button', {
                    key: 'no',
                    type: 'button',
                    className: 'dsd-btn',
                    disabled: working !== undefined,
                    onClick: function () { clearConfirm(entry.trashId) },
                  }, '取消'),
                ])
              : h('button', {
                  key: 'p',
                  type: 'button',
                  className: 'dsd-btn dsd-btn-danger',
                  disabled: working !== undefined,
                  onClick: function () {
                    setConfirming(function (prev) {
                      var next = {}
                      for (var key in prev) if (Object.prototype.hasOwnProperty.call(prev, key)) next[key] = prev[key]
                      next[entry.trashId] = true
                      return next
                    })
                  },
                }, '永久删除'),
          ]))
          body.push(h('div', { key: 'path', className: 'dsd-section-label', style: { wordBreak: 'break-all' } }, entry.originalDir || ''))
          children.push(h('div', { key: 'body', className: 'dsd-item-body' }, body))
        }
        return h('article', { key: entry.trashId, className: 'dsd-item' }, children)
      }

      var content = []
      content.push(h('header', { key: 'head', className: 'dsd-page-head' }, [
        h('h1', { key: 't', className: 'dsd-page-title' }, PANEL_LABEL),
        h('span', { key: 'c', className: 'dsd-page-count' },
          data.entries.length + ' 个会话 · ' + formatBytes(data.totalBytes)),
        h('button', {
          key: 'r',
          type: 'button',
          className: 'dsd-refresh',
          disabled: data.status === 'loading',
          onClick: function () { load() },
        }, data.status === 'loading' ? '刷新中…' : '刷新'),
      ]))
      content.push(h('p', { key: 'sub', className: 'dsd-page-sub' }, '删除的会话先放在这里。展开能看到它用过的附件；只有「永久删除」才会真正释放磁盘。'))

      if (notice !== null) {
        content.push(h('div', { key: 'notice', className: 'dsd-notice' }, notice))
      }
      if (data.status === 'error' && data.error !== null) {
        content.push(h('div', { key: 'err', className: 'dsd-error', role: 'alert' }, data.error))
      }

      if (data.status === 'loading' && data.entries.length === 0) {
        content.push(h('div', { key: 'loading', className: 'dsd-empty' }, '正在读取回收站…'))
      } else if (data.entries.length === 0) {
        content.push(h('div', { key: 'empty', className: 'dsd-empty' }, [
          h('div', { key: 'i', className: 'dsd-empty-icon' }, '🗑'),
          h('div', { key: 't' }, '回收站是空的'),
          h('div', { key: 'h', style: { fontSize: '12px' } }, '在会话行「⋯」菜单里点「删除会话」，被删除的会话会出现在这里。'),
        ]))
      } else {
        content.push(h('div', { key: 'list', className: 'dsd-list' }, data.entries.map(renderEntry)))
      }

      return h('div', { className: 'dsd-page' }, content)
    }

    // ---- 快捷键 -----------------------------------------------------------

    function readService(ctx, name) {
      var value
      try {
        value = typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch (e) {
        return undefined
      }
      return value === undefined || value === null ? undefined : value
    }

    /** 主视图里当前打开的会话。 */
    function currentSession(ctx) {
      var sessions = readService(ctx, 'sessions')
      if (sessions === undefined) return null
      var list = sessions.list
      if (list === null || list === undefined || typeof list.getSnapshot !== 'function') return null
      var snapshot
      try {
        snapshot = list.getSnapshot()
      } catch (e) {
        return null
      }
      var byId = snapshot !== null && snapshot !== undefined && snapshot.byId ? snapshot.byId : {}
      var ids = Object.keys(byId)
      for (var i = 0; i < ids.length; i += 1) {
        var row = byId[ids[i]]
        if (row === null || row === undefined) continue
        var retained = row.retainedBy
        if (retained !== null && retained !== undefined && retained.mainView > 0) {
          return {
            id: typeof row.id === 'string' && row.id !== '' ? row.id : ids[i],
            title: typeof row.displayTitle === 'string' ? row.displayTitle : (typeof row.title === 'string' ? row.title : ''),
          }
        }
      }
      return null
    }

    function registerShortcut(scope, shortcuts) {
      try {
        scope.effect(function () {
          return shortcuts.register({
            id: SHORTCUT_ID,
            label: function () { return MENU_LABEL },
            aliases: ['delete session', 'delete chat'],
            defaults: {
              'desktop:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
              'desktop:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
              'desktop:linux': { code: 'KeyD', modifiers: ['primary', 'alt'] },
              'web:macos': { code: 'KeyD', modifiers: ['primary', 'alt'] },
              'web:windows': { code: 'KeyD', modifiers: ['primary', 'alt'] },
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: function () {
              var target = currentSession(scope)
              if (target === null) {
                return { status: 'blocked', reason: '请先在主视图里打开一个会话' }
              }
              return {
                status: 'handled',
                run: function () { openTrashConfirm(target.id, target.title) },
              }
            },
          })
        }, 'dsh-session-delete: shortcut')
      } catch (error) {
        console.warn('[session-delete] 注册快捷键失败（可能与已有键位冲突）：', error)
      }
    }

    // ---- 设置页 -----------------------------------------------------------

    /** 快捷键服务晚于 apply 就绪，用这个 holder 让设置页随时取到最新实例。 */
    var shortcutHolder = { service: null }

    /**
     * 宿主给的 keys 在 Windows 上已经自带 '+' 分隔符（['Ctrl','+','Alt','+','D']），
     * 再 join(' + ') 就会变成「Ctrl + + + Alt + + + D」。
     */
    function formatKeys(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return ''
      return keys.indexOf('+') >= 0 ? keys.join('') : keys.join(' + ')
    }

    /** 一组 binding → 可见键帽（catalog 没给 keys 时兜底）。 */
    function bindingKeys(binding) {
      if (binding === null || binding === undefined) return []
      var symbols = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' }
      var names = {
        Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Space: 'Space',
        Backspace: 'Backspace', Delete: 'Delete', ArrowUp: '↑', ArrowDown: '↓',
        ArrowLeft: '←', ArrowRight: '→',
      }
      var keys = []
      for (var i = 0; i < (binding.modifiers || []).length; i += 1) {
        keys.push(symbols[binding.modifiers[i]] || binding.modifiers[i])
      }
      var name = names[binding.code] || String(binding.code || '').replace(/^(Key|Digit)/, '')
      if (binding.secondCode) {
        keys.push(name + ' ' + (names[binding.secondCode] || String(binding.secondCode).replace(/^(Key|Digit)/, '')))
      } else {
        keys.push(name)
      }
      return keys
    }

    /** 从快捷键目录里找本插件那条命令。 */
    function findShortcutRow(service) {
      if (!service || !service.catalog || typeof service.catalog.getSnapshot !== 'function') return null
      var rows = service.catalog.getSnapshot()
      if (!Array.isArray(rows)) return null
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i] !== null && rows[i] !== undefined && rows[i].id === SHORTCUT_ID) return rows[i]
      }
      return null
    }

    /** 设置页里的「删除会话」快捷键行：显示当前键位 + 录制新键位。 */
    function ShortcutSettingRow(props) {
      var service = props.service
      var rowState = useState(null)
      var row = rowState[0]
      var setRow = rowState[1]
      var recordingState = useState(false)
      var recording = recordingState[0]
      var setRecording = recordingState[1]
      var messageState = useState(null)
      var message = messageState[0]
      var setMessage = messageState[1]
      var aliveRef = useRef(true)

      useEffect(function () {
        aliveRef.current = true
        if (!service || !service.catalog || typeof service.catalog.subscribe !== 'function') {
          setRow(findShortcutRow(service))
          return function () { aliveRef.current = false }
        }
        function update() {
          if (!aliveRef.current) return
          setRow(findShortcutRow(service))
        }
        update()
        var dispose = service.catalog.subscribe(update)
        return function () {
          aliveRef.current = false
          if (typeof dispose === 'function') dispose()
        }
      }, [service])

      /** 停止录制并解除原生键盘的「录制模式」。 */
      function stop() {
        setRecording(false)
        if (service && typeof service.recording === 'function') {
          service.recording(false).catch(function () {})
        }
      }

      // 录制模式下的按键捕获：capture 阶段吃掉事件，避免同时触发别的快捷键
      useEffect(function () {
        if (!recording || !service) return function () {}
        function onKey(event) {
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat) return
          if (event.key === 'Escape') {
            stop()
            return
          }
          var modifiers = []
          if (event.ctrlKey) modifiers.push('control')
          if (event.altKey) modifiers.push('alt')
          if (event.shiftKey) modifiers.push('shift')
          if (event.metaKey) modifiers.push('meta')
          var code = event.code
          if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(code)) {
            setMessage({ ok: false, text: '这个键不支持，用字母 / 数字 / F1–F24。' })
            return
          }
          setMessage({ ok: true, text: '正在保存…' })
          var config = service.config && typeof service.config.getSnapshot === 'function'
            ? service.config.getSnapshot()
            : null
          var revision = config !== null && config !== undefined ? config.revision : 0
          service.edit(
            { type: 'set', id: SHORTCUT_ID, binding: { code: code, modifiers: modifiers } },
            revision,
          ).then(function (result) {
            if (!aliveRef.current) return
            if (result.status === 'saved') {
              setMessage({ ok: true, text: '已保存' })
              stop()
            } else if (result.status === 'conflict') {
              var names = Array.isArray(result.conflicts) ? result.conflicts.join('、') : ''
              setMessage({ ok: false, text: '和已有的「' + (names || '其他命令') + '」冲突，换一个组合。' })
            } else if (result.status === 'stale') {
              setMessage({ ok: false, text: '配置刚被别处改过，关掉设置重开一次再试。' })
            } else {
              setMessage({ ok: false, text: '保存失败（' + result.status + '）。' })
            }
          }).catch(function (error) {
            if (!aliveRef.current) return
            setMessage({ ok: false, text: '保存失败：' + (error && error.message ? error.message : String(error)) })
          })
        }
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('keydown', onKey, true)
        }
      }, [recording, service])

      function start() {
        setMessage(null)
        setRecording(true)
        if (service && typeof service.recording === 'function') {
          service.recording(true).catch(function () {
            if (!aliveRef.current) return
            setMessage({ ok: false, text: '桌面键盘桥接不可用，可能录不到按键。' })
          })
        }
      }

      var keys = row !== null && row !== undefined && Array.isArray(row.keys) && row.keys.length > 0
        ? row.keys
        : bindingKeys(row !== null && row !== undefined ? row.binding : null)
      var keycap = recording
        ? '请按键…'
        : keys.length > 0
          ? formatKeys(keys)
          : '未绑定'

      return h('div', null, [
        h('div', { key: 'row', className: 'dsd-setting-row' }, [
          h('div', { key: 'l', className: 'dsd-setting-label' }, [
            h('div', { key: 'n', className: 'dsd-setting-name' }, '删除会话'),
            h('div', { key: 'd', className: 'dsd-setting-desc' }, '会话行菜单与这个快捷键共用同一个命令；录制时按 Esc 取消。'),
          ]),
          h('div', { key: 'c', className: 'dsd-setting-control' }, [
            h('span', {
              key: 'k',
              className: 'dsd-kbd' + (recording ? ' dsd-kbd-recording' : '') + (keys.length === 0 && !recording ? ' dsd-kbd-empty' : ''),
            }, keycap),
            h('button', {
              key: 'b',
              type: 'button',
              className: 'dsd-btn',
              onClick: recording ? stop : start,
            }, recording ? '取消' : '修改'),
          ]),
        ]),
        message !== null
          ? h('div', {
              key: 'msg',
              className: 'dsd-setting-msg ' + (message.ok ? 'dsd-setting-msg-ok' : 'dsd-setting-msg-err'),
              role: 'status',
            }, message.text)
          : null,
      ])
    }

    /**
     * 自绘下拉。原生 `<select>` 的展开层是 OS 画的，深色主题里一定是一块灰白板子，
     * 所以这里用按钮 + 绝对定位列表自己实现：点外面或 Esc 关闭。
     */
    function RetentionSelect(props) {
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var wrapRef = useRef(null)

      useEffect(function () {
        if (!open) return function () {}
        function onDown(event) {
          if (wrapRef.current !== null && wrapRef.current.contains(event.target)) return
          setOpen(false)
        }
        function onKey(event) {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      function label(days) {
        return days === 0 ? '永久保留' : days + ' 天'
      }

      var choices = Array.isArray(props.choices) ? props.choices : []
      var options = choices.map(function (days) {
        return h('button', {
          key: String(days),
          type: 'button',
          role: 'option',
          'aria-selected': days === props.value ? 'true' : 'false',
          className: 'dsd-select-option' + (days === props.value ? ' dsd-select-option-active' : ''),
          onClick: function () {
            setOpen(false)
            if (days !== props.value) props.onChange(days)
          },
        }, label(days))
      })

      return h('div', { className: 'dsd-select-wrap', ref: wrapRef }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsd-select-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          disabled: props.disabled === true,
          onClick: function () { setOpen(!open) },
        }, [
          h('span', { key: 'l' }, label(props.value)),
          h('span', { key: 'c', className: 'dsd-select-caret', 'aria-hidden': 'true' }, '▾'),
        ]),
        open
          ? h('div', { key: 'menu', className: 'dsd-select-menu', role: 'listbox' }, options)
          : null,
      ])
    }

    /** `settings.section` 的「删除与回收站」页。 */
    function SettingsSection(props) {
      var dataState = useState({ status: 'loading', error: null, settings: null, entries: 0, totalBytes: 0, retentionChoices: [], version: '' })
      var data = dataState[0]
      var setData = dataState[1]
      var busyState = useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var aliveRef = useRef(true)

      function load() {
        getJson('/settings').then(function (result) {
          if (!aliveRef.current) return
          setData({
            status: 'ready',
            error: null,
            settings: result.settings,
            entries: result.entries || 0,
            totalBytes: result.totalBytes || 0,
            retentionChoices: Array.isArray(result.retentionChoices) ? result.retentionChoices : [0, 7, 30, 90, 365],
            version: typeof result.version === 'string' ? result.version : '',
          })
        }).catch(function (error) {
          if (!aliveRef.current) return
          setData({
            status: 'error',
            error: error && error.message ? error.message : '读取设置失败',
            settings: null,
            entries: 0,
            totalBytes: 0,
            retentionChoices: [],
            version: '',
          })
        })
      }

      useEffect(function () {
        aliveRef.current = true
        load()
        return function () { aliveRef.current = false }
      }, [])

      // shortcuts 服务可能比设置页晚就绪：先渲染成「未绑定」也没关系，这里每隔
      // 一小会儿重渲染一次，服务一到位就自动换成真实键位。
      var probeState = useState(0)
      var probe = probeState[0]
      var setProbe = probeState[1]
      useEffect(function () {
        var service = props.getShortcuts()
        if (service !== null && service !== undefined) return function () {}
        var timer = setTimeout(function () { setProbe(probe + 1) }, 600)
        return function () { clearTimeout(timer) }
      }, [probe])

      function save(patch) {
        var current = data.settings
        if (current === null) return
        var next = { autoClean: current.autoClean, retentionDays: current.retentionDays }
        if (patch.autoClean !== undefined) next.autoClean = patch.autoClean
        if (patch.retentionDays !== undefined) next.retentionDays = patch.retentionDays
        setBusy('save')
        setNotice(null)
        postJson('/settings', next).then(function (result) {
          if (!aliveRef.current) return
          setBusy(null)
          setData(function (prev) {
            return {
              status: 'ready',
              error: null,
              settings: result.settings,
              entries: prev.entries,
              totalBytes: prev.totalBytes,
              retentionChoices: prev.retentionChoices,
            }
          })
          setNotice({ ok: true, text: '设置已保存' })
        }).catch(function (error) {
          if (!aliveRef.current) return
          setBusy(null)
          setNotice({ ok: false, text: error && error.message ? error.message : '保存失败' })
        })
      }

      function sweep() {
        setBusy('sweep')
        setNotice(null)
        postJson('/sweep', {}).then(function (result) {
          if (!aliveRef.current) return
          setBusy(null)
          var keepDays = data.settings !== null && data.settings !== undefined ? data.settings.retentionDays : 0
          var text = result.removed > 0
            ? '清理了 ' + result.removed + ' 个会话' +
              (result.removedAttachments > 0 ? '、' + result.removedAttachments + ' 个附件' : '') +
              '，释放 ' + formatBytes(result.freedBytes || 0)
            : '没有到期的会话（保留 ' + (keepDays > 0 ? keepDays + ' 天' : '永久') + '）'
          setNotice({ ok: true, text: text })
          load()
        }).catch(function (error) {
          if (!aliveRef.current) return
          setBusy(null)
          setNotice({ ok: false, text: error && error.message ? error.message : '清理失败' })
        })
      }

      // 面板永远渲染：读不到设置时用默认值占位并禁用控件，而不是整块消失。
      // 之前这里写成 `settings !== null` 才渲染，一旦 GET 没回来页面就像坏了一样。
      var loaded = data.settings !== null && data.settings !== undefined
      var settings = loaded ? data.settings : { autoClean: true, retentionDays: 30 }
      var controlsDisabled = !loaded || busy !== null
      var choices = data.retentionChoices.length > 0 ? data.retentionChoices : [0, 7, 30, 90, 365]

      var autoRow = h('div', { key: 'auto', className: 'dsd-setting-row' }, [
        h('div', { key: 'l', className: 'dsd-setting-label' }, [
          h('div', { key: 'n', className: 'dsd-setting-name' }, '自动清理'),
          h('div', { key: 'd', className: 'dsd-setting-desc' }, '按保留期自动永久删除回收站里的会话（含只有它引用的附件）。'),
        ]),
        h('div', { key: 'c', className: 'dsd-setting-control' },
          h('button', {
            type: 'button',
            className: 'dsd-switch' + (settings.autoClean ? ' dsd-switch-on' : ''),
            role: 'switch',
            'aria-checked': settings.autoClean ? 'true' : 'false',
            disabled: controlsDisabled,
            onClick: function () { save({ autoClean: !settings.autoClean }) },
          }),
        ),
      ])

      var retentionRow = h('div', { key: 'ret', className: 'dsd-setting-row' }, [
        h('div', { key: 'l', className: 'dsd-setting-label' }, [
          h('div', { key: 'n', className: 'dsd-setting-name' }, '保留时长'),
          h('div', { key: 'd', className: 'dsd-setting-desc' }, '超过这个时间的会话会在下一次自动清理时被永久删除。'),
        ]),
        h('div', { key: 'c', className: 'dsd-setting-control' },
          h(RetentionSelect, {
            value: settings.retentionDays,
            choices: choices,
            disabled: controlsDisabled,
            onChange: function (days) { save({ retentionDays: days }) },
          }),
        ),
      ])

      var statsRow = h('div', { key: 'stats', className: 'dsd-setting-row' }, [
        h('div', { key: 'l', className: 'dsd-setting-label' }, [
          h('div', { key: 'n', className: 'dsd-setting-name' }, '当前回收站'),
          h('div', { key: 'd', className: 'dsd-setting-desc' }, data.entries + ' 个会话 · 占用 ' + formatBytes(data.totalBytes)),
        ]),
        h('div', { key: 'c', className: 'dsd-setting-control' },
          h('button', {
            type: 'button',
            className: 'dsd-btn',
            disabled: controlsDisabled || data.entries === 0,
            onClick: sweep,
          }, busy === 'sweep' ? '清理中…' : '立即清理一次'),
        ),
      ])

      var content = [
        h('div', { key: 'head', className: 'dsd-settings-head' }, [
          h('div', { key: 'l', style: { flex: '1 1 auto', minWidth: '0' } }, [
            h('h2', { key: 't', className: 'dsd-settings-title' }, '删除与回收站'),
            h('p', { key: 's', className: 'dsd-settings-sub' }, '删除的会话先进回收站；这里决定它留多久，以及删除会话用哪个快捷键。'),
          ]),
          data.version !== ''
            ? h('span', { key: 'v', className: 'dsd-settings-version', title: '当前运行中的插件版本（升级后需重启 DSH 才会变）' }, 'v' + data.version)
            : null,
        ]),
      ]

      if (data.status === 'loading') {
        content.push(h('p', { key: 'loading', className: 'dsd-setting-msg' }, '正在读取设置…'))
      }
      if (data.status === 'error' && data.error !== null) {
        content.push(h('div', {
          key: 'err',
          className: 'dsd-settings-error',
          role: 'alert',
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
        }, [
          h('span', { key: 'm', style: { flex: '1 1 auto' } }, data.error),
          h('button', {
            key: 'r',
            type: 'button',
            className: 'dsd-btn',
            onClick: load,
          }, '重试'),
        ]))
      }

      content.push(h('div', { key: 'autoPanel', className: 'dsd-panel' }, [
        h('div', { key: 'h', className: 'dsd-panel-head' }, '回收站'),
        autoRow,
        retentionRow,
        statsRow,
      ]))

      content.push(h('div', { key: 'shortcutPanel', className: 'dsd-panel' }, [
        h('div', { key: 'h', className: 'dsd-panel-head' }, '快捷键'),
        h(ShortcutSettingRow, { key: 'row', service: props.getShortcuts() }),
      ]))

      if (notice !== null) {
        content.push(h('div', {
          key: 'notice',
          className: 'dsd-setting-msg ' + (notice.ok ? 'dsd-setting-msg-ok' : 'dsd-setting-msg-err'),
          role: 'status',
        }, notice.text))
      }

      return h('div', { className: 'dsd-settings' }, content)
    }

    function installShortcut(ctx) {
      if (typeof ctx.inject !== 'function') {
        var legacy = readService(ctx, 'shortcuts')
        if (legacy !== undefined && typeof legacy.register === 'function') registerShortcut(ctx, legacy)
        else console.warn('[session-delete] 快捷键服务不可用，只保留菜单入口')
        return
      }
      ctx.inject(['shortcuts'], function (sub) {
        var shortcuts = sub.shortcuts
        shortcutHolder.service = shortcuts === undefined ? null : shortcuts
        if (shortcuts === undefined || shortcuts === null || typeof shortcuts.register !== 'function') {
          console.warn('[session-delete] 快捷键服务没有 register 方法，只保留菜单入口')
          return
        }
        registerShortcut(sub, shortcuts)
      })
    }

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-session-delete-styles'
        var existing = document.getElementById(id)
        if (existing === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var element = document.getElementById(id)
          if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, 'dsh-session-delete: styles')

      // 1) 会话行菜单项：order 420 —— 「归档会话」(400) 之后、「复制 Session ID」(450) 之前
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 420,
        }, DeleteSessionMenuItem)
      })

      // 2) 左侧全局面板的一行：会话回收站
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: function () { return PANEL_LABEL },
        }, TrashPanelIcon)
      })

      // 3) 整页：key 必须与面板行 id 一致，否则 selectPanel 会拒绝
      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, TrashPage)
      })

      // 4) 设置页：账号菜单 → 设置 → 删除与回收站
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'session-delete',
          order: 47,
          label: function () { return '删除与回收站' },
          inject: function () {
            return {
              getShortcuts: function () { return shortcutHolder.service },
            }
          },
        }, SettingsSection)
      })

      installShortcut(ctx)
    }

    module.exports = {
      name: 'session-delete',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
