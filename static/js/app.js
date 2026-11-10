/* Apple Music 歌单同步 — 配置页逻辑（纯静态，无构建依赖） */
(function () {
  "use strict";

  var SP = window.SongloftPlugin || {};
  var baseHref = (function () {
    var b = document.querySelector("base");
    return b && b.href ? b.href : location.href.replace(/\/$/, "/");
  })();

  var state = {
    config: null,
    playlists: [],
    authorized: false,
    jobTimer: null,
    saving: false,
    authInfo: null
  };

  // ---------- API ----------

  // 与宿主注入的 common.js 行为保持一致：相对路径 '.' + path，
  // Authorization 头取自宿主桥接的 token（localStorage / URL 参数）。
  // 这里不依赖 SongloftPlugin.apiGet，是为了拿到 HTTP 状态码区分 401/409。
  function getToken() {
    try {
      if (SP.getAuthToken) {
        var t = SP.getAuthToken();
        if (t) return t;
      }
    } catch (e) {}
    try {
      var raw = localStorage.getItem("songloft-auth");
      if (raw) {
        var auth = JSON.parse(raw);
        if (auth && auth.accessToken) return auth.accessToken;
      }
    } catch (e) {}
    var m = (location.search || "").match(/[?&]access_token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function request(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    var token = getToken();
    if (token) headers.Authorization = "Bearer " + token;
    return fetch("." + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        if (!res.ok) {
          var msg = (data && (data.error || data.message)) || res.statusText || "HTTP " + res.status;
          var err = new Error(msg);
          err.code = data && data.code;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function apiGet(path) {
    return request("GET", path, null);
  }

  function apiPost(path, body) {
    return request("POST", path, body || {});
  }

  // ---------- utils ----------

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 2600);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) {
      return n < 10 ? "0" + n : "" + n;
    };
    return (
      d.getMonth() + 1 + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  function setSwitch(el, on) {
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function b64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  // ---------- 渲染 ----------

  function setStatus(kind, text) {
    var chip = $("statusChip");
    chip.className = "chip" + (kind ? " " + kind : "");
    $("statusText").textContent = text;
  }

  function renderAccount(cfg) {
    var authorized = !!(cfg && cfg.authorized);
    state.authorized = authorized;
    if (authorized) {
      setStatus("ok", "已授权");
      $("authLabel").textContent = "已授权 Apple Music";
      $("authSub").textContent =
        "凭证保存于 " + (fmtTime(cfg.authorizedAt) || "本地") + "，区域 " + (cfg.storefront || "").toUpperCase() +
        "。凭证失效时会提示重新登录。";
      $("loginBtn").textContent = "重新授权";
      $("logoutBtn").classList.remove("hidden");
    } else {
      setStatus("warn", "未授权");
      $("authLabel").textContent = "未授权";
      $("authSub").textContent = "点击右侧按钮，在弹窗中完成 Apple ID 登录。";
      $("loginBtn").textContent = "登录 Apple Music";
      $("logoutBtn").classList.add("hidden");
    }
    $("storefront").value = cfg.storefront || "cn";
    if (cfg.hasCustomDevToken) {
      $("devTokenDesc").textContent = "当前使用自定义开发者令牌；清空可恢复自动获取。";
      $("devTokenInputRow").classList.remove("hidden");
    }
  }

  function renderSettings(cfg) {
    setSwitch($("autoSyncSwitch"), cfg.autoSync);
    $("interval").value = cfg.intervalMinutes;
    $("prefix").value = cfg.playlistPrefix || "";
    $("threshold").value = cfg.matchThreshold;
    $("thresholdVal").textContent = Number(cfg.matchThreshold).toFixed(2);
    setSwitch($("strictSwitch"), cfg.strictMatch);
    setSwitch($("pruneSwitch"), cfg.pruneMissing);
    setSwitch($("autoNewSwitch"), cfg.autoIncludeNew);
  }

  function renderPlaylists() {
    var box = $("playlistList");
    if (!state.authorized) {
      box.innerHTML = '<div class="empty">登录 Apple Music 后，这里会列出你资料库里的歌单。</div>';
      return;
    }
    if (!state.playlists.length) {
      box.innerHTML = '<div class="empty">资料库里还没有歌单，或暂时无法读取。</div>';
      return;
    }
    var html = "";
    state.playlists.forEach(function (p) {
      var sub = [];
      var total = p.total || p.trackCount || 0;
      if (total) sub.push(total + " 首");
      if (typeof p.matched === "number" && p.lastSyncAt) sub.push("匹配 " + p.matched + " 首");
      if (p.lastSyncAt) sub.push("上次同步 " + fmtTime(p.lastSyncAt));
      else if (p.lastCheckAt) sub.push("上次检查 " + fmtTime(p.lastCheckAt));
      if (!p.lastSyncAt && !p.lastCheckAt) sub.push("尚未同步");
      if (p.lastError) sub.push('<span class="err">' + esc(p.lastError) + "</span>");
      html +=
        '<div class="pl-item" data-id="' + esc(p.id) + '">' +
        (p.coverUrl
          ? '<img class="pl-cover" src="' + esc(p.coverUrl) + '" alt="" loading="lazy">'
          : '<div class="pl-cover"></div>') +
        '<div class="pl-main"><div class="pl-name">' + esc(p.name) + '</div><div class="pl-sub">' + sub.join("<span>·</span>") + "</div></div>" +
        '<div class="pl-act">' +
        '<button class="btn sm ghost act-sync">同步</button>' +
        '<div class="sw act-toggle' + (p.enabled ? " on" : "") + '"></div>' +
        "</div></div>";
    });
    box.innerHTML = html;

    Array.prototype.forEach.call(box.querySelectorAll(".act-sync"), function (btn) {
      btn.addEventListener("click", function () {
        var item = btn.closest(".pl-item");
        syncOne(item.getAttribute("data-id"), btn);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".act-toggle"), function (el) {
      el.addEventListener("click", function () {
        var item = el.closest(".pl-item");
        var id = item.getAttribute("data-id");
        var next = !el.classList.contains("on");
        setSwitch(el, next);
        apiPost("/api/playlists/toggle", { id: id, enabled: next, name: item.querySelector(".pl-name").textContent })
          .catch(function (e) {
            setSwitch(el, !next);
            toast(e.message || "设置失败");
          });
      });
    });
  }

  function renderLogs(logs) {
    var box = $("logs");
    if (!logs || !logs.length) {
      box.textContent = "（暂无日志）";
      return;
    }
    box.innerHTML = logs
      .map(function (l) {
        return '<div class="' + (l.level === "error" ? "error" : l.level === "warn" ? "warn" : "") + '">' + esc(l.text) + "</div>";
      })
      .join("");
  }

  // ---------- 数据加载 ----------

  function loadConfig() {
    return apiGet("/api/config").then(function (res) {
      state.config = res.config;
      renderAccount(res.config);
      renderSettings(res.config);
      return res.config;
    });
  }

  function loadPlaylists(showErrors) {
    return apiGet("/api/playlists")
      .then(function (res) {
        state.authorized = !!res.authorized;
        state.playlists = res.playlists || [];
        if (res.authorized) setStatus("ok", "已授权");
        renderPlaylists();
        return res;
      })
      .catch(function (e) {
        if (showErrors) toast(e.message || "读取歌单失败");
        if (e.status === 401) {
          state.authorized = false;
          renderPlaylists();
          setStatus("warn", "授权已失效");
        }
        throw e;
      });
  }

  function loadLogs() {
    return apiGet("/api/logs?limit=120")
      .then(function (res) {
        renderLogs(res.logs);
      })
      .catch(function () {});
  }

  // ---------- 保存 ----------

  var saveTimer = null;
  function patchConfig(patch) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      apiPost("/api/config", patch)
        .then(function (res) {
          state.config = res.config;
          renderAccount(res.config);
          renderSettings(res.config);
        })
        .catch(function (e) {
          toast(e.message || "保存失败");
        });
    }, 400);
  }

  // ---------- 同步 ----------

  function startPolling() {
    if (state.jobTimer) return;
    state.jobTimer = setInterval(function () {
      apiGet("/api/job")
        .then(function (res) {
          renderJob(res.job);
          if (!res.job.running) {
            clearInterval(state.jobTimer);
            state.jobTimer = null;
            loadPlaylists(false).catch(function () {});
            loadLogs();
          }
        })
        .catch(function () {});
    }, 1500);
  }

  function renderJob(job) {
    var bar = $("jobBar");
    if (!job || (!job.running && !job.results.length)) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    var total = job.totalPlaylists || 0;
    var done = job.donePlaylists || 0;
    var pct = total ? Math.round((done / total) * 100) : job.running ? 15 : 100;
    $("jobFill").style.width = pct + "%";
    if (job.running) {
      $("jobText").textContent = total ? done + "/" + total + " 个歌单" : "准备中…";
    } else {
      var synced = 0;
      var failed = 0;
      (job.results || []).forEach(function (r) {
        if (r.status === "synced") synced++;
        if (r.status === "error") failed++;
      });
      $("jobText").textContent = job.error ? "失败" : "完成 " + synced + " 个" + (failed ? "，失败 " + failed : "");
    }
  }

  function syncOne(id, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "同步中…";
    }
    apiPost("/api/sync", { id: id, force: true })
      .then(function () {
        startPolling();
        loadLogs();
      })
      .catch(function (e) {
        toast(e.message || "同步启动失败");
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "同步";
        }
      });
  }

  function syncAll() {
    if (!state.authorized) {
      toast("请先登录 Apple Music");
      return;
    }
    var btn = $("syncAllBtn");
    btn.disabled = true;
    btn.textContent = "同步中…";
    apiPost("/api/sync", { force: true })
      .then(function () {
        startPolling();
        loadLogs();
      })
      .catch(function (e) {
        toast(e.message || "同步启动失败");
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "同步全部";
      });
  }

  // ---------- Apple 登录授权 ----------

  function startLogin() {
    state.authDone = false;
    var btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "准备中…";
    $("manualRow").classList.remove("hidden");
    $("manualInputRow").classList.remove("hidden");

    apiGet("/api/devtoken")
      .then(function (res) {
        if (!res || !res.token) throw new Error("没有拿到开发者令牌");
        var info = {
          thirdPartyIconURL: baseHref + "static/icon.svg",
          thirdPartyName: location.host,
          thirdPartyParameters: {},
          thirdPartyToken: res.token
        };
        state.authInfo = info;
        var payload = b64(JSON.stringify(info));
        var url =
          "https://authorize.music.apple.com/woa?a=" + encodeURIComponent(payload) +
          "&referrer=" + encodeURIComponent(location.href);
        var popup = window.open(url, "AppleMusicAuth", "width=580,height=800,menubar=no,toolbar=no,resizable=yes");
        if (!popup) {
          throw new Error("浏览器拦截了登录弹窗，请允许弹窗后重试，或用下方备用方式");
        }
        toast("请在弹窗中完成 Apple ID 登录");
        var closed = setInterval(function () {
          if (popup.closed) {
            clearInterval(closed);
            resetLoginButton();
            if (!state.authDone) {
              toast("没有收到授权回传，可用下方备用方式粘贴 Music-User-Token");
            }
            state.authDone = false;
          }
        }, 800);
      })
      .catch(function (e) {
        toast(e.message || "无法启动登录");
        resetLoginButton();
      });
  }

  function resetLoginButton() {
    var btn = $("loginBtn");
    btn.disabled = false;
    btn.textContent = state.authorized ? "重新授权" : "登录 Apple Music";
  }

  function reply(from, id, result, error) {
    if (!from) return;
    var msg = { jsonrpc: "2.0", id: id };
    if (error) msg.error = error;
    else msg.result = result;
    try {
      from.postMessage(msg, "*");
    } catch (e) {}
  }

  function handleAppleMessage(event) {
    if (!/^https?:\/\/(.+\.)*apple\.com(\/[\w\d]+)*$/i.test(event.origin || "")) return;
    var data = event.data;
    if (!data || data.jsonrpc !== "2.0") return;

    if (data.method === "thirdPartyInfo") {
      reply(event.source, data.id, state.authInfo ? JSON.stringify(state.authInfo) : "");
      return;
    }
    if (data.method === "authorize") {
      var params = data.params || {};
      var token = Array.isArray(params) ? params[0] : params.musicUserToken || params.userToken || "";
      var restricted = Array.isArray(params) ? params[1] : params.restricted;
      if (!token) {
        reply(event.source, data.id, false);
        toast("授权未返回有效凭证");
        return;
      }
      if (restricted === "1" || restricted === true) {
        toast("该 Apple ID 没有 Apple Music 订阅，部分资料库内容可能无法读取");
      }
      apiPost("/api/auth/token", { userToken: token })
        .then(function (res) {
          reply(event.source, data.id, true);
          state.authorized = true;
          state.authDone = true;
          toast("登录成功" + (res.storefront ? "（区域 " + res.storefront.toUpperCase() + "）" : ""));
          $("manualRow").classList.add("hidden");
          $("manualInputRow").classList.add("hidden");
          return loadConfig().then(function () {
            loadPlaylists(true).catch(function () {});
            loadLogs();
          });
        })
        .catch(function (e) {
          reply(event.source, data.id, false);
          toast(e.message || "凭证校验失败");
        })
        .then(resetLoginButton);
      return;
    }
    if (data.method === "decline") {
      reply(event.source, data.id, true);
      toast("已取消登录");
      resetLoginButton();
      return;
    }
    if (data.method === "unavailable") {
      reply(event.source, data.id, true);
      toast("当前设备无法完成 Apple 登录，请改用下方备用方式");
      resetLoginButton();
      return;
    }
    if (data.method === "close") {
      reply(event.source, data.id, true);
      resetLoginButton();
    }
  }

  // ---------- 绑定 ----------

  function bind() {
    window.addEventListener("message", handleAppleMessage, false);

    $("loginBtn").addEventListener("click", startLogin);
    $("logoutBtn").addEventListener("click", function () {
      apiPost("/api/auth/logout", {})
        .then(function () {
          state.authorized = false;
          state.playlists = [];
          toast("已退出授权");
          return loadConfig();
        })
        .then(function () {
          renderPlaylists();
        })
        .catch(function (e) {
          toast(e.message || "退出失败");
        });
    });

    $("devTokenBtn").addEventListener("click", function () {
      var btn = $("devTokenBtn");
      btn.disabled = true;
      apiGet("/api/devtoken")
        .then(function (res) {
          var d = new Date((res.expiresAt || 0) * 1000);
          toast("令牌可用，有效期至 " + d.toLocaleDateString());
        })
        .catch(function (e) {
          toast((e.message || "获取失败") + "，可在下方手动指定开发者令牌");
          $("devTokenRow").classList.remove("hidden");
          $("devTokenInputRow").classList.remove("hidden");
        })
        .then(function () {
          btn.disabled = false;
        });
    });

    $("devTokenSave").addEventListener("click", function () {
      var v = $("devTokenInput").value.trim();
      apiPost("/api/config", { devToken: v })
        .then(function () {
          $("devTokenInput").value = "";
          toast(v ? "已保存自定义开发者令牌" : "已恢复自动获取");
          return loadConfig();
        })
        .catch(function (e) {
          toast(e.message || "保存失败");
        });
    });

    $("manualSave").addEventListener("click", function () {
      var token = $("manualToken").value.trim();
      if (!token) {
        toast("请先粘贴 Music-User-Token");
        return;
      }
      apiPost("/api/auth/token", { userToken: token })
        .then(function (res) {
          $("manualToken").value = "";
          toast("已保存" + (res.storefront ? "（区域 " + res.storefront.toUpperCase() + "）" : ""));
          return loadConfig();
        })
        .then(function () {
          loadPlaylists(true).catch(function () {});
        })
        .catch(function (e) {
          toast(e.message || "凭证无效");
        });
    });

    $("storefront").addEventListener("change", function () {
      patchConfig({ storefront: this.value });
    });

    $("autoSyncSwitch").addEventListener("click", function () {
      var next = !this.classList.contains("on");
      setSwitch(this, next);
      patchConfig({ autoSync: next });
    });
    $("strictSwitch").addEventListener("click", function () {
      var next = !this.classList.contains("on");
      setSwitch(this, next);
      patchConfig({ strictMatch: next });
    });
    $("pruneSwitch").addEventListener("click", function () {
      var next = !this.classList.contains("on");
      setSwitch(this, next);
      patchConfig({ pruneMissing: next });
    });
    $("autoNewSwitch").addEventListener("click", function () {
      var next = !this.classList.contains("on");
      setSwitch(this, next);
      patchConfig({ autoIncludeNew: next });
    });

    $("interval").addEventListener("change", function () {
      var v = parseInt(this.value, 10);
      if (isNaN(v)) v = 60;
      v = Math.max(5, Math.min(1440, v));
      this.value = v;
      patchConfig({ intervalMinutes: v });
    });
    $("prefix").addEventListener("change", function () {
      patchConfig({ playlistPrefix: this.value });
    });
    $("threshold").addEventListener("input", function () {
      $("thresholdVal").textContent = Number(this.value).toFixed(2);
    });
    $("threshold").addEventListener("change", function () {
      patchConfig({ matchThreshold: Number(this.value) });
    });

    $("refreshBtn").addEventListener("click", function () {
      var btn = $("refreshBtn");
      btn.disabled = true;
      loadPlaylists(true)
        .catch(function (e) {
          toast(e.message || "刷新失败");
        })
        .then(function () {
          btn.disabled = false;
        });
    });
    $("syncAllBtn").addEventListener("click", syncAll);
    $("logsBtn").addEventListener("click", loadLogs);
  }

  function init() {
    bind();
    loadConfig()
      .then(function (cfg) {
        if (cfg.authorized) {
          setStatus("ok", "已授权");
          return loadPlaylists(false).catch(function () {});
        }
        renderPlaylists();
      })
      .then(function () {
        loadLogs();
        return apiGet("/api/job");
      })
      .then(function (res) {
        renderJob(res.job);
        if (res.job && res.job.running) startPolling();
      })
      .catch(function () {
        setStatus("bad", "加载失败");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
