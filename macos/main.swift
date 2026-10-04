// Local Scrapbox の Mac アプリ（専用ウィンドウ）。
// 中身は、ログイン時から常駐しているサーバー（http://127.0.0.1:3210）を表示するだけです。
// install.sh がこのファイルを swiftc でビルドして「Local Scrapbox.app」を作ります。
import Cocoa
import WebKit

let appName = "Local Scrapbox"
let info = Bundle.main.infoDictionary ?? [:]
let homeURL = URL(string: (info["ScrapboxURL"] as? String) ?? "http://127.0.0.1:3210/")!
let notesDir = (info["ScrapboxNotesDir"] as? String) ?? (NSHomeDirectory() + "/Documents/scrapbox")
let agentLabel = (info["ScrapboxAgentLabel"] as? String) ?? "net.sugiduino.local-scrapbox"

func isLocal(_ url: URL) -> Bool {
    guard let host = url.host else {
        let scheme = (url.scheme ?? "").lowercased()
        return scheme == "about" || scheme == "blob" || scheme == "data"
    }
    return (host == "127.0.0.1" || host == "localhost") && url.port == homeURL.port
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var titleObserver: NSKeyValueObservation?
    var retries = 0
    var terminating = false

    @objc(applicationDidFinishLaunching:)
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Scrapbox記法を崩さないよう、スマート引用符・ダッシュ・自動修正を切る
        UserDefaults.standard.register(defaults: [
            "WebAutomaticQuoteSubstitutionEnabled": false,
            "WebAutomaticDashSubstitutionEnabled": false,
            "WebAutomaticTextReplacementEnabled": false,
            "WebAutomaticSpellingCorrectionEnabled": false,
            "WebContinuousSpellCheckingEnabled": false,
            "WebGrammarCheckingEnabled": false,
            "WebAutomaticLinkDetectionEnabled": false,
        ])
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "saveFile")
        config.userContentController.add(self, name: "openInBrowser")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = false
        let zoom = UserDefaults.standard.double(forKey: "pageZoom")
        if zoom > 0 { webView.pageZoom = CGFloat(zoom) }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = appName
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.minSize = NSSize(width: 420, height: 320)
        window.center()
        _ = window.setFrameAutosaveName("LocalScrapboxMain")
        window.delegate = self
        window.makeKeyAndOrderFront(nil)

        titleObserver = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            let title = view.title ?? ""
            self?.window.title = title.isEmpty ? appName : title
        }
        NSApp.activate(ignoringOtherApps: true)
        loadHome()
    }

    func loadHome() { _ = webView.load(URLRequest(url: homeURL)) }

    @objc(applicationShouldTerminateAfterLastWindowClosed:)
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @objc(applicationShouldHandleReopen:hasVisibleWindows:)
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // 終了する前に、入力中の内容を保存しきる
    @objc(applicationShouldTerminate:)
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating || webView == nil { return .terminateNow }
        terminating = true
        var replied = false
        let reply = {
            if replied { return }
            replied = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        webView.callAsyncJavaScript("if (window.scrapboxFlush) { await window.scrapboxFlush(); } return true;",
                                    arguments: [:], in: nil, in: .page) { _ in reply() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { reply() }
        return .terminateLater
    }

    // ---- メニュー ----
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
        menuItem.keyEquivalentModifierMask = mods
        menuItem.target = target
        return menuItem
    }

    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        for menuItem in items { menu.addItem(menuItem) }
        top.submenu = menu
        return top
    }

    func buildMenu() {
        let main = NSMenu()
        main.addItem(submenu(appName, [
            item("\(appName)について", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("\(appName)を隠す", #selector(NSApplication.hide(_:)), "h"),
            item("ほかを隠す", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("すべてを表示", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("\(appName)を終了", #selector(NSApplication.terminate(_:)), "q"),
        ]))
        main.addItem(submenu("ファイル", [
            item("新規ページ", #selector(newPage(_:)), "n", target: self),
            item("メモのフォルダを開く", #selector(openNotesFolder(_:)), "o", [.command, .shift], target: self),
            item("ブラウザで開く", #selector(openInBrowser(_:)), "b", [.command, .shift], target: self),
            .separator(),
            item("ウインドウを閉じる", #selector(NSWindow.performClose(_:)), "w"),
        ]))
        main.addItem(submenu("編集", [
            item("取り消す", Selector(("undo:")), "z"),
            item("やり直す", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("カット", #selector(NSText.cut(_:)), "x"),
            item("コピー", #selector(NSText.copy(_:)), "c"),
            item("ペースト", #selector(NSText.paste(_:)), "v"),
            item("すべてを選択", #selector(NSText.selectAll(_:)), "a"),
        ]))
        main.addItem(submenu("表示", [
            item("再読み込み", #selector(reloadPage(_:)), "r", target: self),
            .separator(),
            item("実際のサイズ", #selector(zoomReset(_:)), "0", target: self),
            item("拡大", #selector(zoomIn(_:)), "+", target: self),
            item("縮小", #selector(zoomOut(_:)), "-", target: self),
            .separator(),
            item("フルスクリーンにする", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]))
        let windowMenu = submenu("ウインドウ", [
            item("しまう", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("拡大／縮小", #selector(NSWindow.performZoom(_:))),
        ])
        main.addItem(windowMenu)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu.submenu
    }

    @objc func newPage(_ sender: Any?) {
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.scrapboxNewPage && window.scrapboxNewPage()", completionHandler: nil)
    }
    @objc func openNotesFolder(_ sender: Any?) {
        NSWorkspace.shared.open(URL(fileURLWithPath: notesDir, isDirectory: true))
    }
    // 今見ているページを、ふだん使いのブラウザで開く
    @objc func openInBrowser(_ sender: Any?) { openInBrowser(url: webView.url) }
    func openInBrowser(url: URL?) {
        guard let url = url, (url.scheme ?? "").lowercased() == "http", isLocal(url) else { return }
        NSWorkspace.shared.open(url)
    }
    @objc func reloadPage(_ sender: Any?) { retries = 0; if webView.url == nil || !isLocal(webView.url!) { loadHome() } else { _ = webView.reload() } }
    func setZoom(_ value: CGFloat) {
        let zoom = min(max(value, 0.5), 3.0)
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: "pageZoom")
    }
    @objc func zoomReset(_ sender: Any?) { setZoom(1.0) }
    @objc func zoomIn(_ sender: Any?) { setZoom(webView.pageZoom + 0.1) }
    @objc func zoomOut(_ sender: Any?) { setZoom(webView.pageZoom - 0.1) }

    // ---- ページの読み込み ----
    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if mainFrame && !isLocal(url) {
            // 外部リンクはふだん使いのブラウザで開く
            let scheme = (url.scheme ?? "").lowercased()
            if ["http", "https", "mailto"].contains(scheme) { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    @objc(webView:didFinishNavigation:)
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { retries = 0 }

    @objc(webView:didFailProvisionalNavigation:withError:)
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        retries += 1
        if retries == 2 { startAgent() }
        if retries <= 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.loadHome() }
        } else {
            showOffline()
        }
    }

    @objc(webViewWebContentProcessDidTerminate:)
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { _ = webView.reload() }

    // サーバーが止まっていたら起こす（常駐の設定は install.sh が行う）
    func startAgent() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "gui/\(getuid())/\(agentLabel)"]
        try? task.run()
    }

    func showOffline() {
        let html = """
        <!doctype html><meta charset="utf-8"><title>\(appName)</title>
        <body style="font:15px -apple-system,sans-serif;padding:48px;line-height:1.7;color:#222">
        <h2>サーバーに接続できません</h2>
        <p>常駐しているサーバーが止まっているようです。ターミナルで次を実行してください。</p>
        <pre style="background:#f4f4f4;padding:12px">bash ~/Documents/開発/local-scrapbox/macos/install.sh</pre>
        <p>ログ: ~/Library/Application Support/Local Scrapbox/data/server.log</p>
        <p><a href="\(homeURL.absoluteString)">もう一度読み込む</a></p></body>
        """
        _ = webView.loadHTMLString(html, baseURL: nil)
    }

    // ---- ブラウザの機能の代わり ----
    // target="_blank" や window.open
    @objc(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isLocal(url) { _ = webView.load(URLRequest(url: url)) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // <input type="file">（画像の追加・JSONの読み込み）
    @objc(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    @objc(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        _ = alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    @objc(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        _ = alert.addButton(withTitle: "OK")
        _ = alert.addButton(withTitle: "キャンセル")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    @objc(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        _ = alert.addButton(withTitle: "OK")
        _ = alert.addButton(withTitle: "キャンセル")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // 書き出し（テキスト・JSON）は保存ダイアログで保存する
    @objc(userContentController:didReceiveScriptMessage:)
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "openInBrowser" {
            if let text = message.body as? String { openInBrowser(url: URL(string: text)) }
            return
        }
        guard message.name == "saveFile",
              let body = message.body as? [String: Any],
              let content = body["content"] as? String else { return }
        let filename = (body["filename"] as? String) ?? "export.txt"
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return }
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                _ = NSAlert(error: error).runModal()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
