/*!
 * Jake of All Trades — Bathroom Renovation Report embed loader.
 *
 * Usage on a host page:
 *   <div data-jake-form data-src="https://your-domain.com/index.html"></div>
 *   <script src="https://your-domain.com/embed.js"></script>
 *
 * Optional attributes on the container div:
 *   data-min-height="600px"   initial height before the form reports its real size
 *   data-title="..."          accessible iframe title
 *
 * The iframe auto-resizes to fit its content via postMessage — no scrollbars,
 * no guessing a fixed height. index.html sends { type: "jake-form-resize",
 * height } to its parent   whenever its content height changes.
 *
 * Ad/campaign tracking (lead_source, campaign, ad_name, etc.) and the page
 * URL are forwarded automatically: any query params already on the host
 * page's own URL are merged onto the iframe src (without overriding params
 * data-src already sets, e.g. ?view=report), and page_url is added as the
 * host page's full URL. No per-page script needed beyond the div + this tag.
 */
(function () {
  "use strict";

  function withForwardedParams(src) {
    var url;
    try {
      url = new URL(src, window.location.href);
    } catch (e) {
      return src;
    }
    new URLSearchParams(window.location.search).forEach(function (value, key) {
      if (!url.searchParams.has(key)) { url.searchParams.set(key, value); }
    });
    if (!url.searchParams.has("page_url")) {
      url.searchParams.set("page_url", window.location.href);
    }
    return url.toString();
  }

  function createFrame(container) {
    var src = container.getAttribute("data-src");
    if (!src) {
      console.error("[jake-form] Missing data-src attribute on embed container.");
      return;
    }

    var iframe = document.createElement("iframe");
    iframe.src = withForwardedParams(src);
    iframe.title = container.getAttribute("data-title") || "Bathroom Renovation Report";
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("frameborder", "0");
    iframe.style.display = "block";
    iframe.style.width = "100%";
    iframe.style.border = "0";
    iframe.style.height = container.getAttribute("data-min-height") || "700px";
    iframe.style.transition = "height 0.2s ease";

    var targetOrigin;
    try {
      targetOrigin = new URL(src, window.location.href).origin;
    } catch (e) {
      targetOrigin = "*";
    }

    function onMessage(event) {
      if (targetOrigin !== "*" && targetOrigin !== "null" && event.origin !== targetOrigin) { return; }
      if (event.source !== iframe.contentWindow) { return; }

      var data = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (e) { return; }
      }
      if (!data || data.type !== "jake-form-resize") { return; }

      var height = parseInt(data.height, 10);
      if (height > 0) {
        iframe.style.height = height + "px";
      }
    }

    window.addEventListener("message", onMessage);
    container.appendChild(iframe);
  }

  function init() {
    var containers = document.querySelectorAll("[data-jake-form]");
    for (var i = 0; i < containers.length; i++) {
      createFrame(containers[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
