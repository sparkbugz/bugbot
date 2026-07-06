// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SparkBugz
//
// Client-side glue for the static demo. The live console runs under a strict
// Content-Security-Policy with no script at all — every interaction there is a
// server round-trip. The static demo has no server, so this tiny script stands
// in for the two round-trips a click-around preview actually needs:
//
//   1. the sun/moon theme toggle (normally GET /theme, which sets a cookie), and
//   2. every form/POST, which here just raises a "nothing is saved" toast.
//
// Everything else — nav links, in-page anchors, the ?/help tooltips, <details> —
// is plain HTML and needs no help.

(function () {
    var THEME_KEY = "bugbot-demo-theme";
    var root = document.documentElement;

    function applyTheme(mode) {
        if (mode === "light" || mode === "dark") {
            root.setAttribute("data-theme", mode);
            root.style.colorScheme = mode;
        } else {
            root.removeAttribute("data-theme");
            root.style.colorScheme = "light dark";
        }
    }

    try {
        var saved = localStorage.getItem(THEME_KEY);
        if (saved) {
            applyTheme(saved);
        }
    } catch (err) { /* storage blocked — stay on the browser preference */ }

    document.addEventListener("click", function (event) {
        var anchor = event.target.closest && event.target.closest("a");
        if (!anchor) {
            return;
        }

        var href = anchor.getAttribute("href") || "";
        if (href.indexOf("/theme") !== 0) {
            return;
        }

        event.preventDefault();
        var mode = (href.match(/mode=(light|dark|auto)/) || [])[1] || "auto";
        try {
            if (mode === "auto") {
                localStorage.removeItem(THEME_KEY);
            } else {
                localStorage.setItem(THEME_KEY, mode);
            }
        } catch (err) { /* ignore */ }
        applyTheme(mode);
    });

    document.addEventListener("submit", function (event) {
        event.preventDefault();
        var action = (event.target.getAttribute("action") || "");
        if (action === "/logout") {
            window.location.href = "/login";
            return;
        }
        toast();
    });

    var toastTimer;

    function toast() {
        var el = document.getElementById("demo-toast");
        if (!el) {
            el = document.createElement("div");
            el.id = "demo-toast";
            el.className = "demo-toast";
            document.body.appendChild(el);
        }

        el.innerHTML = "<strong>Demo mode</strong> — changes aren't saved here. Install BugBot to run this on your own server.";
        // Reflow so the transition replays on repeat clicks.
        void el.offsetWidth;
        el.classList.add("show");

        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.classList.remove("show");
        }, 2800);
    }
})();
